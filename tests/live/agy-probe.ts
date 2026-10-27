// Test-only observation of agy in its official API key mode, against a local Gemini-compatible
// server. Never forwards a request to a model service, and never uses the user's login: the key is
// a fixed fake value and the sandbox lets agy connect out to this server only.
// Official setup: https://antigravity.google/docs/install?tab=cli (modelProvider "gemini",
// GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL). API key mode is not the logged-in path, so its results
// are never evidence about the logged-in app.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executableCandidates, resolveLaunch, type Launch } from '../../src/core/ai/runtime';
import type { ProcessRequest } from '../../src/core/ai/process';
import { SANDBOX_EXEC } from '../../src/core/ai/fence';
import { probeProfile } from './codex-probe';
import { categoryOfTool, placedKinds, placedVerdicts, type Attempt, type Category, type Place } from './isolation';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const FAKE_KEY = 'code-learning-fake-key';
// agy 1.4.3 can miss answers delivered within a few milliseconds and finish with an empty SUCCESS.
// Delay model answers like a real server so the probe can observe the response.
const MODEL_ANSWER_DELAY_MS = 500;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);

/** The shape of one request, never its text: names of the path, query, headers, body keys and tools. */
export interface RequestShape { method: string; path: string; queryNames: string[]; headerNames: string[]; bodyKeys: string[]; toolNames: string[] | null }

/** Path and names only. Numbers or names that do not look like identifiers become placeholders. */
export function requestShape(method: string, url: string, headers: Record<string, unknown>, body: unknown): RequestShape {
  const parsed = new URL(url, 'http://127.0.0.1');
  const declarations = (body as { tools?: unknown })?.tools;
  const toolNames = Array.isArray(declarations)
    ? declarations.flatMap(group => Array.isArray(group?.functionDeclarations ?? group?.function_declarations)
      ? (group.functionDeclarations ?? group.function_declarations).map((item: { name?: unknown }) => identifier(item?.name) ? item.name : '<unnamed>') : [])
    : null;
  return {
    method,
    // Only the official model call path is kept; any other path could carry a value, so it is not.
    path: /^\/v1(?:alpha|beta)?\/models\/[a-z0-9.-]{1,80}:(?:streamGenerateContent|generateContent|countTokens)$/.test(parsed.pathname)
      ? parsed.pathname : '<unrecognized-path>',
    queryNames: [...parsed.searchParams.keys()].map(name => identifier(name) ? name : '<name>'),
    // Only names: the fake key and any other value stay out of the record.
    headerNames: Object.keys(headers).filter(identifier).sort(),
    bodyKeys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter(identifier) : [],
    toolNames,
  };
}

/**
 * Tools the server may call with fixed arguments, and the only ones whose parameter shapes are kept.
 * The last seven can reach outside a file (tasks, messages, schedules, sub-agents, questions), so
 * the test gives them only harmless values (no kill or send_input).
 */
export const FORCED_CANDIDATES = ['read_file', 'write_file', 'edit_file', 'view_file', 'run_command', 'write_to_file', 'replace_file_content', 'read_url_content', 'search_web',
  'manage_task', 'send_message', 'schedule', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'ask_question'];
export interface DeclarationShape { name: string; required: string[]; properties: Record<string, string> }

/**
 * A parameter's type; for a fixed set of values, those values when they look like identifiers; for
 * a list of objects, the names and types of its fields. Descriptions and defaults are never kept.
 */
function propertyShape(value: unknown): string {
  const schema = value as { type?: unknown; enum?: unknown; items?: { properties?: unknown } };
  const type = identifier(schema?.type) ? schema.type : 'unknown';
  const values = Array.isArray(schema?.enum) ? schema.enum.filter(identifier).slice(0, 20) : [];
  const fields = schema?.items?.properties && typeof schema.items.properties === 'object'
    ? Object.entries(schema.items.properties as Record<string, unknown>).filter(([key]) => identifier(key)).map(([key, field]) => `${key}:${propertyShape(field)}`) : [];
  return `${type}${values.length ? `(${values.join('|')})` : ''}${fields.length ? `{${fields.join(',')}}` : ''}`;
}

/** Parameter names, types and the required list of the observed tools; never descriptions or defaults. */
export function declarationShapes(body: unknown): DeclarationShape[] {
  const groups = (body as { tools?: unknown })?.tools;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(group => {
    const declarations = group?.functionDeclarations ?? group?.function_declarations;
    return Array.isArray(declarations) ? declarations : [];
  }).filter(item => FORCED_CANDIDATES.includes(item?.name)).map(item => {
    const schema = item.parameters ?? item.parametersJsonSchema ?? item.parameters_json_schema ?? {};
    const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return { name: item.name,
      required: Array.isArray(schema?.required) ? schema.required.filter(identifier) : [],
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => identifier(key)).map(([key, value]) => [key, propertyShape(value)])) };
  });
}

/**
 * The Codex probe profile plus what agy needs for its own local helper: under the plain profile,
 * agy was denied network-bind and stopped before any request. Only a loopback port may be opened
 * and reached from loopback; outgoing connections stay limited to this probe's server, and name
 * lookups (mDNSResponder) and every other address stay blocked.
 */
export function agyProbeProfile(root: string, cwd: string, personalHome: string, port: number): string {
  // Signals reach only processes in this same sandbox, so no tool can stop another program. The
  // system schedulers cannot be started and no system service can be looked up (Mach), so no work
  // is handed to something that outlives the probe; agy still answered with all lookups refused.
  return `${probeProfile(root, cwd, personalHome, port)}(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(deny signal)
(allow signal (target same-sandbox))
(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at") (literal "/usr/bin/batch"))
(deny mach-lookup)
`;
}

/** The process table as numbers and start times; never command lines or environments. */
async function processTable() {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] }] : [];
  });
}

/** The installed agy from the fixed locations the app uses. */
export async function findAgyLaunch(): Promise<Launch> {
  for (const candidate of executableCandidates('agy')) {
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      const launch = await resolveLaunch(executable);
      if (launch) return launch;
    } catch { /* Try the next fixed installation location. */ }
  }
  throw new Error('agy installation not found');
}

/** A Gemini API answer with one text part, in the response shape of the official API. */
function textAnswer(text: string) {
  return { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
}

/**
 * A tool call the server sends as the model's whole answer. The arguments are fixed by the test and
 * built only when the call is sent, after agy's run folder exists.
 */
export interface AgyForcedCall { label: string; name: string; args: () => Record<string, unknown> }
/** The path a forced read_url_content call points at; a request for it means the tool ran. */
export const PROBE_URL_PATH = '/probe-url';

/** Function responses agy sent back, by call id or, without one, by name in order. Kept in memory only. */
export function functionResponses(body: unknown): { id: string | null; name: string | null; response: unknown }[] {
  const contents = (body as { contents?: unknown })?.contents;
  if (!Array.isArray(contents)) return [];
  return contents.flatMap(content => Array.isArray(content?.parts) ? content.parts : [])
    .map(part => part?.functionResponse ?? part?.function_response).filter(Boolean)
    .map(item => ({ id: identifier(item.id) ? item.id : null, name: identifier(item.name) ? item.name : null, response: item.response }));
}

/** A forced call goes out only for a tool on the fixed list that this very request declares. */
export function forcedCallAllowed(name: string, declared: string[] | null): boolean {
  return FORCED_CANDIDATES.includes(name) && !!declared?.includes(name);
}

/**
 * Which sent call each function response answers. An id must match a sent call exactly. Without
 * an id, the k-th response of a tool name answers the k-th sent call of that name, which also holds
 * when agy resends the whole history. Responses that match nothing are returned too, so that a
 * leak check still sees them.
 */
export function matchResponses(items: { id: string | null; name: string | null; response: unknown }[], sentCalls: { id: string; label: string; name: string }[]) {
  const matched = new Map<string, unknown>();
  const unmatched: unknown[] = [];
  const seenByName = new Map<string, number>();
  for (const item of items) {
    let call: { label: string } | undefined;
    if (item.id) call = sentCalls.find(sentCall => sentCall.id === item.id);
    else if (item.name) {
      const index = seenByName.get(item.name) ?? 0;
      seenByName.set(item.name, index + 1);
      call = sentCalls.filter(sentCall => sentCall.name === item.name)[index];
    }
    if (call && !matched.has(call.label)) matched.set(call.label, item.response);
    else if (!call) unmatched.push(item.response);
  }
  return { matched, unmatched };
}

/**
 * Records one request's function responses: the first answer per sent call for pairing, and every
 * response received, repeats and later changes included, for the leak check (memory only).
 */
export function collectResponses(body: unknown, sentCalls: { id: string; label: string; name: string }[],
  store: { byCall: Map<string, unknown>; all: unknown[] }): void {
  const items = functionResponses(body);
  store.all.push(...items.map(item => item.response));
  for (const [label, value] of matchResponses(items, sentCalls).matched) if (!store.byCall.has(label)) store.byCall.set(label, value);
}

/**
 * Whether a model request belongs to the conversation the forced calls drive: before any call, the
 * first request that offers tools; after that, one that offers tools and whose history holds exactly
 * the calls sent so far, ending with the last one and agy's response to it. Anything else, such as
 * a retry, a later request without tools or a sub-agent's request, is not. Sub-agents start without
 * the parent's history (https://antigravity.google/docs/subagents/). A refused call that agy never
 * answers stops the queue, which leaves later calls unsent and fails the check.
 */
export function isMainRequest(body: unknown, offersTools: boolean, sentCalls: { id: string; label: string; name: string }[], mainSeen: boolean): boolean {
  if (!offersTools) return false;
  const last = sentCalls.at(-1);
  if (!last) return !mainSeen;
  const contents = (body as { contents?: unknown })?.contents;
  const calls = (Array.isArray(contents) ? contents : []).flatMap(content => Array.isArray(content?.parts) ? content.parts : [])
    .map(part => part?.functionCall ?? part?.function_call).filter(Boolean);
  if (calls.length !== sentCalls.length) return false;
  // Every call in the history, in order, is one this server sent, and the last one has its answer.
  const inOrder = calls.every((call: { id?: unknown; name?: unknown }, index: number) =>
    call.id ? call.id === sentCalls[index].id : call.name === sentCalls[index].name);
  return inOrder && matchResponses(functionResponses(body), sentCalls).matched.has(last.label);
}

/**
 * Processes started from the probe: its roots, their descendants and members of their process groups.
 * A process counts only while its number still belongs to the same start time, so a number reused by
 * another program, or that program's children, never joins. A group is matched while its root is the
 * same process or gone (POSIX keeps a number unused while a group of that number exists).
 */
export function descendantsOf(table: { pid: number; ppid: number; pgid: number; started: string }[], roots: { pid: number; started: string }[],
  known: Map<number, string> = new Map()) {
  const byPid = new Map(table.map(row => [row.pid, row]));
  const same = (pid: number, started: string | undefined) => started !== undefined && byPid.get(pid)?.started === started;
  const found = new Map([...known].filter(([pid, started]) => same(pid, started)));
  for (const root of roots) if (same(root.pid, root.started)) found.set(root.pid, root.started);
  const groups = roots.filter(root => same(root.pid, root.started) || !byPid.has(root.pid)).map(root => root.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (found.has(row.pid)) continue;
      if (!found.has(row.ppid) && !groups.includes(row.pgid)) continue;
      found.set(row.pid, row.started);
      grew = true;
    }
  }
  return found;
}

/**
 * One verdict per kind under the API key condition. A request of unknown origin may be another
 * agent at work, so no kind can then be called blocked; a kind already shown failed stays failed.
 */
export function forcedKindSummary(completed: boolean, effects: Record<Place, Record<Category, boolean>>, attempts: Attempt[], offered: string[] | null, unknownOrigin: number) {
  const kinds = placedVerdicts(completed, effects, attempts, offered);
  // An observed failure stays; anything else cannot be called blocked or partly blocked.
  if (unknownOrigin > 0) for (const kind of placedKinds) if (kinds[kind] !== 'failed') kinds[kind] = 'undetermined';
  return { condition: 'local-api-key' as const, ...kinds };
}

/** What the probe found and stopped after a run; `unverified` because sampling can miss a detached child. */
export interface ProcessCleanup { seen: number; survivorsAfterExit: number; remaining: number; completeness: 'unverified' }

/**
 * What agy's answer to one call says, never the text. Only agy's observed refusal answer counts as the
 * app hook's refusal: one `output` field, exactly "Created At: …\nCompleted At: …\nEncountered error
 * in tool execution: tool call denied by pre-tool hook: <reason>". The sentence quoted anywhere else,
 * or with other fields, decides nothing.
 */
export function responseShape(response: unknown, hookReason: string): { source: 'app-hook' | null; markers: string[]; length: number; fields: string[] } {
  const text = response === undefined ? '' : JSON.stringify(response) ?? '';
  const record = response && typeof response === 'object' && !Array.isArray(response) ? response as Record<string, unknown> : {};
  const fields = Object.keys(record).filter(identifier).sort();
  const refusal = new RegExp(`^Created At: [^\\n]+\\nCompleted At: [^\\n]+\\nEncountered error in tool execution: tool call denied by pre-tool hook: ${escapeRegExp(hookReason)}$`);
  const source = Object.keys(record).length === 1 && typeof record.output === 'string' && refusal.test(record.output) ? 'app-hook' : null;
  const lower = text.toLowerCase();
  const markers = ['denied', 'hook', 'not supported', 'not available', 'headless', 'cancel', 'error', 'unknown', 'disabled', 'permission']
    .filter(word => lower.includes(word));
  return { source, markers, length: text.length, fields };
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The attempts a kind summary rests on: tool steps; for a call refused only in agy's answer, a refusal;
 * and every step of another kind, except one ended in an error that stands for such a refused call
 * (by its tool name, or an unnamed step for a refused call no named step stands for). A step of
 * another kind that finished stays a run.
 */
export function kindAttempts(attempts: Attempt[], results: ForcedCallResult[]): Attempt[] {
  const tool = attempts.filter(attempt => !attempt.stepType);
  const other = attempts.filter(attempt => attempt.stepType);
  const refusedInAnswer = results.filter(result => result.evidence === 'response');
  const unexplained = [...refusedInAnswer];
  const take = (match: (result: ForcedCallResult) => boolean) => {
    const index = unexplained.findIndex(match);
    return index >= 0 ? unexplained.splice(index, 1).length > 0 : false;
  };
  const named = other.filter(attempt => !attempt.name.startsWith('step:'));
  const unnamed = other.filter(attempt => attempt.name.startsWith('step:'));
  // Only a step that ended in ERROR can stand for a refused call; one still running or finished stays.
  const ended = (attempt: Attempt) => attempt.stepState === 'ERROR';
  const remaining = [
    ...named.filter(attempt => !ended(attempt) || !take(result => result.name === attempt.name)),
    ...unnamed.filter(attempt => !ended(attempt) || !take(result => !named.some(step => step.name === result.name))),
  ];
  return [...tool, ...remaining, ...refusedInAnswer.map((result): Attempt =>
    ({ category: categoryOfTool(result.name), name: result.name, outcome: 'policy-refused', refusedBy: result.refusedBy ?? undefined }))];
}

export interface ForcedCallResult {
  label: string; name: string; sent: boolean; responded: boolean;
  outcome: Attempt['outcome'] | 'no-step'; refusedBy: Attempt['refusedBy'] | null;
  /** Where the refusal was seen: agy's tool step, or only agy's answer to the model (no tool step). */
  evidence: 'step' | 'response' | null;
}

/**
 * Pairs each scheduled call with agy's tool steps in order: a step goes to the next unpaired sent
 * call of the same name, since several calls share a name. A call never sent or without a step
 * stays visible as such.
 */
export function forcedCallResults(calls: { label: string; name: string }[], sentLabels: string[], attempts: Attempt[], respondedLabels: string[],
  responseRefusals: Record<string, Attempt['refusedBy'] | null> = {}): ForcedCallResult[] {
  const paired = new Set<number>();
  return calls.map(call => {
    const sent = sentLabels.includes(call.label);
    const index = sent ? attempts.findIndex((attempt, at) => !paired.has(at) && attempt.name === call.name) : -1;
    if (index >= 0) paired.add(index);
    const step = index >= 0 ? attempts[index] : undefined;
    const base = { label: call.label, name: call.name, sent, responded: respondedLabels.includes(call.label) };
    if (step) return { ...base, outcome: step.outcome, refusedBy: step.refusedBy ?? null, evidence: 'step' as const };
    // agy reports some tools (sub-agents, questions) as other step types without the refusal, but
    // hands the model the hook's exact refusal sentence; that answer is then the evidence.
    const fromResponse = sent ? responseRefusals[call.label] ?? null : null;
    return fromResponse ? { ...base, outcome: 'policy-refused' as const, refusedBy: fromResponse, evidence: 'response' as const }
      : { ...base, outcome: 'no-step' as const, refusedBy: null, evidence: null };
  });
}

/**
 * The forced-call check passes only on a finished run where every call was sent and refused by a
 * known policy, no tool step of any kind ran or failed unclearly, and nothing shows a tool ran.
 */
export function forcedCallsPassed(results: ForcedCallResult[], attempts: Attempt[], completed: boolean, executionEvidence: boolean): boolean {
  return completed && !executionEvidence
    && results.every(result => result.sent && result.outcome === 'policy-refused' && result.refusedBy !== null)
    && attempts.every(attempt => attempt.outcome === 'policy-refused');
}

export async function createAgyProbe(answer: object, forced: AgyForcedCall[] = []) {
  if (process.platform !== 'darwin') throw new Error('Local agy probes require macOS sandbox-exec; no unprotected fallback');
  await access(SANDBOX_EXEC, constants.X_OK);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-local-probe-')));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const runId = randomUUID();
  const shapes: RequestShape[] = [];
  let declarations: DeclarationShape[] = [];
  const failures: string[] = [];
  let cliStarts = 0;
  let stageStarts = 0;
  // Forced calls still to send, the ids of those sent, and what agy answered for each (memory only).
  const queue = [...forced];
  const sentCalls: { id: string; label: string; name: string }[] = [];
  const responses = { byCall: new Map<string, unknown>(), all: [] as unknown[] };
  const roots: { pid: number; started: string }[] = [];
  const tracked = new Map<number, string>();
  let sampler: ReturnType<typeof setInterval> | undefined;
  const sample = async () => {
    try { for (const [pid, started] of descendantsOf(await processTable(), roots, tracked)) if (!tracked.has(pid)) tracked.set(pid, started); } catch { /* Next sample. */ }
  };
  const forcedResponses = responses.byCall;
  let probeUrlRequests = 0;
  // Requests of the forced conversation, the early helper requests before it, and any other model
  // request, which may be another agent at work.
  let mainSeen = false;
  let mainRequests = 0;
  let helperRequests = 0;
  let unknownOrigin = 0;
  const server = createServer(async (request, response) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname === PROBE_URL_PATH) {
      probeUrlRequests++;
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('probe');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('request-too-large');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { failures.push('non-json-body'); }
      const shape = requestShape(request.method ?? '', request.url ?? '/', request.headers, body);
      shapes.push(shape);
      if (!declarations.length) declarations = declarationShapes(body);
      collectResponses(body, sentCalls, responses);
      // A static answer for model calls; anything else is recorded and refused. Only the main model
      // request, the one that offers tools, gets the forced calls, one per answer.
      if (request.method === 'POST' && /:(?:stream)?[gG]enerateContent$/.test(shape.path)) {
        const offersTools = !!shape.toolNames?.length;
        const main = isMainRequest(body, offersTools, sentCalls, mainSeen);
        if (main) { mainSeen = true; mainRequests++; } else if (!offersTools && !mainSeen) helperRequests++; else unknownOrigin++;
        // Only the forced conversation gets the next call; any other request gets the static answer.
        let call = main ? queue.shift() : undefined;
        // Never a call to a tool outside the fixed list or not declared in this very request: that
        // would be the untested call by name. It stays unsent, which fails the check.
        if (call && !forcedCallAllowed(call.name, shape.toolNames)) {
          failures.push(`undeclared-call:${call.label}`);
          call = undefined;
        }
        if (call) sentCalls.push({ id: `call_${call.label}`, label: call.label, name: call.name });
        const result = call ? { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model',
          parts: [{ functionCall: { id: `call_${call.label}`, name: call.name, args: call.args() } }] } }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } } : textAnswer(JSON.stringify(answer));
        await new Promise(resolve => setTimeout(resolve, MODEL_ANSWER_DELAY_MS));
        if (shape.path.endsWith(':streamGenerateContent') && new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('alt') === 'sse') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify(result)}\n\n`);
        } else if (shape.path.endsWith(':streamGenerateContent')) {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([result]));
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        }
        return;
      }
      failures.push(`unexpected-endpoint:${shape.method}`);
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }));
    } catch (error) {
      failures.push(error instanceof Error && error.message === 'request-too-large' ? 'request-too-large' : 'invalid-request');
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  let port: number;
  try {
    await mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { mode: 0o700 });
    // API key mode needs only this key; the app's own restrictions are added by restrictAgy at the run.
    await writeFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), `${JSON.stringify({ modelProvider: 'gemini' })}\n`, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local-listener-unavailable');
    port = address.port;
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root, home, codexHome, shapes, failures, forcedResponses, baseUrl: `http://127.0.0.1:${port}`,
    // The test adds its calls after it has made its files inside this probe's root.
    forced: queue, sentLabels: () => sentCalls.map(call => call.label), probeUrlRequests: () => probeUrlRequests,
    requestOrigins: () => ({ main: mainRequests, helper: helperRequests, unknownOrigin }),
    /** Follows every process started from this pid, sampling the process table (numbers and start times only). */
    /** What endProcesses found, once it has run. */
    processes: undefined as ProcessCleanup | undefined,
    tracking: () => roots.length > 0,
    track(pid: number) {
      // The start time is read at once, so the root is recognised only as this very process.
      const started = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      roots.push({ pid, started });
      sampler ??= setInterval(() => { void sample(); }, 100);
      void sample();
    },
    /**
     * Once agy has ended: which processes it left behind, then stops them (only those whose start time
     * still matches, so a reused number is never touched) and checks that none remain.
     */
    async endProcesses(): Promise<ProcessCleanup> {
      if (sampler) { clearInterval(sampler); sampler = undefined; }
      await sample();
      const alive = async () => { const now = await processTable(); return [...tracked].filter(([pid, started]) => now.some(row => row.pid === pid && row.started === started)); };
      // Each signal goes only to a process whose start time is checked again just before it, so a
      // number reused by another program is left alone; a short race between the two remains.
      const stop = async (signal: NodeJS.Signals) => {
        for (const [pid] of await alive()) {
          if ((await alive()).some(([live]) => live === pid)) { try { process.kill(pid, signal); } catch { /* Already gone. */ } }
        }
      };
      const survivors = await alive();
      await stop('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      await sample();
      await stop('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 200));
      // Sampling can miss a child that left its parent's session between two looks, so a clean
      // result here does not prove that nothing at all was left (the user accepted this limit).
      return { seen: tracked.size, survivorsAfterExit: survivors.length, remaining: (await alive()).length, completeness: 'unverified' };
    },
    /** Every response agy sent back, repeats and unmatched ones included, for leak checks in memory. */
    allResponses: () => responses.all,
    wrap(fencedRequest: ProcessRequest): ProcessRequest {
      // The app fence cannot hold another sandbox, so the probe runs the CLI under its own test
      // profile: outgoing connections to this server only (agy may open a loopback port of its own),
      // no credential paths, writes in the probe only.
      const request = fencedRequest.executable === SANDBOX_EXEC && fencedRequest.args[0] === '-p'
        ? { ...fencedRequest, executable: fencedRequest.args[2], args: fencedRequest.args.slice(3) } : fencedRequest;
      const selectedHome = request.env?.HOME && path.resolve(request.env.HOME);
      if (selectedHome !== home) throw new Error('probe-requires-temporary-agy-home');
      const isVersion = request.args.at(-1) === '--version';
      if (!isVersion && !request.args.includes('stream-json')) throw new Error('unexpected-probe-command');
      cliStarts++;
      if (!isVersion) stageStarts++;
      return { ...request, executable: SANDBOX_EXEC,
        args: ['-p', agyProbeProfile(root, request.cwd, os.homedir(), port), request.executable, ...request.args],
        // Nothing from the user's environment: the home, the fake key and this server only.
        env: { HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GEMINI_API_KEY: FAKE_KEY,
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` }, timeoutMs: 60_000 };
    },
    summary() {
      return { runId, checkedAt: new Date().toISOString(), cliStarts, stageStarts, requests: shapes.length, shapes, declarations, failures,
        authentication: 'fake API key', transport: 'loopback-only sandbox-exec',
        scope: 'agy API key mode with a temporary HOME; not evidence of the logged-in app or of C04 passage',
        conditionChanges: ['API key mode (modelProvider gemini)', 'custom Gemini endpoint', 'temporary HOME/TMPDIR',
          'OS network and credential-path restrictions', '60-second timeout',
          sentCalls.length || queue.length ? 'fixed tool calls queued by the test, then a static answer; no model' : 'static answer, no model and no tool call'] };
    },
    async close() {
      if (sampler) clearInterval(sampler);
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type AgyProbe = Awaited<ReturnType<typeof createAgyProbe>>;
