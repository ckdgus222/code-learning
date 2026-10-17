// Test-only observation of the real CLI's request. Never forwards a request to a model service.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executableCandidates, resolveLaunch, type Launch } from '../../src/core/ai/runtime';
import type { ProcessRequest } from '../../src/core/ai/process';
import { SANDBOX_EXEC } from '../../src/core/ai/fence';
import modelFixture from '../fixtures/codex-model-0.163.0.json';

interface ToolName { type: string; name: string }
class InventoryError extends Error {}
interface CodeModeInventory { source: 'exec-description'; names: string[]; declarationBlocks: number; status: 'parsed' | 'unavailable' | 'unrecognized'; exhaustive: false }
export interface RequestInventory {
  model: string; tools: ToolName[]; codeModeTools: CodeModeInventory[];
  definitionsHash: string; topLevelCount: number; locations: string[];
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);

/** Known declarations only, not examples such as tools.exec_command(...). Deferred tools may be absent. */
function codeModeInventory(description: unknown): CodeModeInventory {
  const text = typeof description === 'string' ? description : '';
  const declarationBlocks = [...text.matchAll(/^exec tool declaration:$/gm)].length;
  const names: string[] = [];
  // Codex rust-v0.162.1 code-mode-protocol/src/description.rs emits this format in Code Mode Only.
  for (const match of text.matchAll(/^exec tool declaration:\n```ts\ndeclare const tools: \{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)) {
    const heading = [...text.slice(0, match.index).matchAll(/^### `([A-Za-z_$][A-Za-z0-9_$]*)`[^\n]*$/gm)].at(-1)?.[1];
    if (heading === match[1]) names.push(match[1]);
  }
  return { source: 'exec-description', names: [...new Set(names)], declarationBlocks,
    status: !declarationBlocks ? 'unavailable' : names.length === declarationBlocks ? 'parsed' : 'unrecognized', exhaustive: false };
}

/** Missing, malformed or unknown definitions never become an empty tool inventory. */
export function requestInventory(value: unknown): RequestInventory {
  if (!value || typeof value !== 'object') throw new InventoryError('invalid-request');
  const request = value as Record<string, unknown>;
  if (!identifier(request.model)) throw new InventoryError('missing-model');
  const definitions: unknown[] = [];
  const locations: string[] = [];
  if ('tools' in request) {
    if (!Array.isArray(request.tools)) throw new InventoryError('invalid-tools-array');
    definitions.push(...request.tools);
    locations.push('tools');
  }
  // Codex 0.162.1 Responses Lite serializes tools as input additional_tools items.
  // Source: openai/codex rust-v0.162.1, core/src/client.rs build_responses_request.
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item?.type !== 'additional_tools') continue;
      if (item.role !== 'developer' || !Array.isArray(item.tools)) throw new InventoryError('invalid-additional-tools');
      definitions.push(...item.tools);
      locations.push('input.additional_tools');
    }
  }
  if (!locations.length) throw new InventoryError('missing-tools-array');
  const names: ToolName[] = [];
  const codeModeTools: CodeModeInventory[] = [];
  const visit = (entry: unknown, prefix = '', depth = 0) => {
    if (depth > 8 || !entry || typeof entry !== 'object') throw new InventoryError('invalid-tool-definition');
    const tool = entry as Record<string, unknown>;
    if (!identifier(tool.type)) throw new InventoryError('invalid-tool-type');
    if (tool.type === 'namespace') {
      if (!identifier(tool.name) || !Array.isArray(tool.tools)) throw new InventoryError('invalid-tool-namespace');
      names.push({ type: tool.type, name: `${prefix}${tool.name}` });
      for (const child of tool.tools) visit(child, `${prefix}${tool.name}.`, depth + 1);
    } else if (tool.type === 'function' || tool.type === 'custom') {
      if (!identifier(tool.name)) throw new InventoryError('invalid-tool-name');
      names.push({ type: tool.type, name: `${prefix}${tool.name}` });
      if (tool.name === 'exec' && (!prefix || prefix === 'functions.')) codeModeTools.push(codeModeInventory(tool.description));
    } else if (['web_search', 'web_search_preview', 'image_generation', 'file_search', 'computer', 'computer_use_preview', 'code_interpreter', 'mcp', 'tool_search'].includes(tool.type)) {
      names.push({ type: tool.type, name: `${prefix}${tool.type}` });
    } else {
      throw new InventoryError(`unknown-tool-definition:${tool.type}`);
    }
  };
  for (const tool of definitions) visit(tool);
  return { model: request.model, tools: names, codeModeTools, topLevelCount: definitions.length, locations,
    definitionsHash: createHash('sha256').update(JSON.stringify(definitions)).digest('hex') };
}

/** A missing/unreadable exec description cannot establish that an indirect tool is absent. */
export function observedToolNames(inventory: RequestInventory): string[] {
  const direct = inventory.tools.filter(tool => tool.type !== 'namespace').map(tool => tool.name);
  const execCount = direct.filter(name => name === 'exec' || name === 'functions.exec').length;
  if (inventory.codeModeTools.length !== execCount || inventory.codeModeTools.some(group => group.status !== 'parsed')) {
    throw new InventoryError('unparsed-code-mode-tools');
  }
  return [...new Set([...direct, ...inventory.codeModeTools.flatMap(group => group.names)])];
}

export async function findCodexLaunch(): Promise<Launch> {
  for (const candidate of executableCandidates('codex')) {
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      const launch = await resolveLaunch(executable);
      if (launch) return launch;
    } catch { /* Try the next fixed installation location, not personal configuration. */ }
  }
  throw new Error('Codex installation not found');
}

export function probeProfile(root: string, cwd: string, personalHome: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid-port');
  const forbidden = ['.codex', '.gemini', 'Library/Keychains', 'Library/Application Support/Code Learning']
    .map(part => `(subpath ${JSON.stringify(path.join(personalHome, part))})`).join(' ');
  return `(version 1)
(allow default)
(deny file-read* ${forbidden} (subpath "/Library/Keychains"))
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(cwd)}) (literal "/dev/null"))
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
(deny mach-lookup (global-name "com.apple.securityd"))
`;
}

export type CodexProbeVariant = 'app' | 'code-mode-flags-disabled' | 'direct-no-patch-catalog' | 'forced-calls';

/** The CLI version and model whose official source the fixture and the forced calls are read from. */
export const PROBE_SOURCE = { version: modelFixture.version, model: modelFixture.model.slug };

/** A tool call the forced-calls server sends as its whole answer, in the Responses output item shape. */
export interface ForcedCall { label: string; item: { type: string; call_id: string } & Record<string, unknown> }
export type ForcedOutcome = 'unavailable' | 'refused' | 'ran' | 'unclear' | 'no-output';
// Codex rust-v0.163.0 core/src/safety.rs reasons, sent as `patch rejected: {reason}` by
// core/src/apply_patch.rs before the patch runs. Only these count as a policy refusal.
const patchRejections = ['writing is blocked by read-only sandbox; rejected by user approval settings',
  'writing outside of the project; rejected by user approval settings'].map(reason => `patch rejected: ${reason}`);
// Fixed words whose presence (never the text) is recorded for an output that is not understood.
const markerWords = ['sandbox', 'denied', 'reject', 'approval', 'permission', 'read-only', 'not found', 'not allowed', 'unsupported', 'error'];

/** The text of a tool output item: a plain string, or the text parts of a content item list. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(part => typeof part?.text === 'string' ? part.text : '').join('\n');
  return '';
}

/** Whether an MCP list tool answered with nothing in every list it returns. */
export function isEmptyList(output: unknown): boolean {
  try {
    const value = JSON.parse(outputText(output));
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && Object.values(value).length > 0 && Object.values(value).every(entry => Array.isArray(entry) && entry.length === 0);
  } catch { return false; }
}

/**
 * How Codex answered one forced call. The canary in the output means the call ran. Only Codex's
 * own "no such tool" reply (registry.rs unsupported_tool_call_message) and its patch policy
 * refusal count as blocks; any other text, such as an OS or sandbox error, stays unclear.
 */
export function classifyForced(output: unknown, canary: string): { outcome: ForcedOutcome; markers: string[]; length: number } {
  if (output === undefined) return { outcome: 'no-output', markers: [], length: 0 };
  const text = outputText(output);
  const lower = text.toLowerCase();
  const markers = markerWords.filter(word => lower.includes(word));
  const outcome: ForcedOutcome = text.includes(canary) ? 'ran'
    : /^unsupported (?:custom tool )?call: [\w.:/-]{1,160}$/.test(text.trim()) ? 'unavailable'
      : patchRejections.includes(text.trim()) ? 'refused' : 'unclear';
  return { outcome, markers, length: text.length };
}

/** Additional flags/catalog variants are observations only, never production settings. */
export async function createCodexProbe(variant: CodexProbeVariant = 'app') {
  if (process.platform !== 'darwin') throw new Error('Local Codex probes require macOS sandbox-exec; no unprotected fallback');
  await access('/usr/bin/sandbox-exec', constants.X_OK);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-local-probe-')));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const agyHome = path.join(root, 'agy-home');
  const personalHome = os.homedir();
  const runId = randomUUID();
  const catalogFile = path.join(root, 'model-catalog.json');
  const catalogOverride = variant === 'direct-no-patch-catalog' ? {
    version: modelFixture.version, source: modelFixture.source, sourceSha256: modelFixture.sourceSha256,
    model: modelFixture.model.slug, overrides: { tool_mode: 'direct', apply_patch_tool_type: null },
  } : null;
  const extraRestrictions = variant === 'code-mode-flags-disabled' ? ['--disable', 'code_mode', '--disable', 'code_mode_only']
    : catalogOverride ? ['-c', `model_catalog_json=${JSON.stringify(catalogFile)}`, '-c', `model=${JSON.stringify(catalogOverride.model)}`] : [];
  const inventories: RequestInventory[] = [];
  // forced-calls only: the calls still to send, and the output Codex returned for each sent call,
  // kept in memory only. The calls are fixed by the test and point inside this probe's root.
  const forced: ForcedCall[] = [];
  const sentCalls = new Set<string>();
  const forcedOutputs = new Map<string, unknown>();
  const envelopeShapes: { fields: string[]; inputTypes: string[]; contentTypes: string[] }[] = [];
  const failures: string[] = [];
  let httpRequests = 0;
  let responseRequests = 0;
  let cliStarts = 0;
  let stageStarts = 0;
  const server = createServer(async (request, response) => {
    httpRequests++;
    // Check only presence. Never print or persist a credential or a request body.
    if (request.headers.authorization || request.headers.cookie) {
      failures.push('unexpected-authentication');
      response.writeHead(400).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      failures.push('unexpected-endpoint');
      response.writeHead(404).end();
      return;
    }
    responseRequests++;
    try {
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new InventoryError('unsupported-encoding');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new InventoryError('request-too-large');
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Protocol field/type names only, useful when this CLI uses a different wire format.
      const input = Array.isArray(parsed?.input) ? parsed.input : [];
      envelopeShapes.push({ fields: Object.keys(parsed ?? {}).filter(identifier),
        inputTypes: [...new Set<string>(input.map((item: { type?: unknown }) => item?.type).filter(identifier))],
        contentTypes: [...new Set<string>(input.flatMap((item: { content?: unknown }) => Array.isArray(item?.content)
          ? item.content.map((part: { type?: unknown }) => part?.type).filter(identifier) : []))] });
      const inventory = requestInventory(parsed);
      inventories.push(inventory);
      for (const entry of input) {
        if (typeof entry?.type === 'string' && entry.type.endsWith('_output') && sentCalls.has(entry.call_id)) {
          forcedOutputs.set(entry.call_id, entry.output ?? entry.tools);
        }
      }
      // A static assistant answer, except that the forced-calls variant first sends the calls its
      // test queued, one per answer, so that each output can be matched to its call.
      const call = forced.shift();
      if (call) sentCalls.add(call.item.call_id);
      const message = { id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: '{"probe":true}', annotations: [] }] };
      const item = call ? { id: `item_${call.item.call_id}`, ...call.item, status: 'completed' } : message;
      const result = { id: 'resp_probe', object: 'response', model: inventory.model, status: 'completed', output: [item],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (type: string, extra: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      send('response.created', { response: { ...result, status: 'in_progress', output: [] } });
      if (call) {
        send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
      } else {
        send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
        send('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text });
      }
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response: result });
      response.end();
    } catch (error) {
      // Raw JSON parse errors can contain the original body. Keep only a fixed classification.
      failures.push(error instanceof InventoryError ? error.message : 'invalid-request-inventory');
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  let port: number;
  try {
    await Promise.all([home, codexHome, agyHome].map(folder => mkdir(folder, { mode: 0o700 })));
    if (catalogOverride) await writeFile(catalogFile,
      JSON.stringify({ models: [{ ...modelFixture.model, ...catalogOverride.overrides }] }), { mode: 0o600 });
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
    root, home, codexHome, agyHome, inventories, failures, catalogOverride, forced, forcedOutputs,
    wrap(fencedRequest: ProcessRequest): ProcessRequest {
      // The app starts a stage inside its own sandbox-exec fence. A sandbox cannot be applied inside
      // another one, so the probe runs the inner command under its own test profile instead. That
      // profile limits the network and credential paths; unlike the app fence, it does not deny the home.
      // The app fence itself is checked by tests/ai-fence.test.ts.
      const request = fencedRequest.executable === SANDBOX_EXEC && fencedRequest.args[0] === '-p'
        ? { ...fencedRequest, executable: fencedRequest.args[2], args: fencedRequest.args.slice(3) } : fencedRequest;
      const selectedHome = request.env?.CODEX_HOME && path.resolve(request.env.CODEX_HOME);
      if (!selectedHome || !selectedHome.startsWith(`${root}${path.sep}`)) throw new Error('probe-requires-temporary-codex-home');
      const execAt = request.args.indexOf('exec');
      const isVersion = request.args.at(-1) === '--version';
      if (execAt < 0 && !isVersion) throw new Error('unexpected-probe-command');
      cliStarts++;
      if (execAt >= 0) stageStarts++;
      const providerArgs = ['-c', 'model_provider="code_learning_probe"', '-c', 'model_providers.code_learning_probe.name="Code Learning local probe"',
        '-c', `model_providers.code_learning_probe.base_url="http://127.0.0.1:${port}/v1"`,
        '-c', 'model_providers.code_learning_probe.wire_api="responses"', '-c', 'model_providers.code_learning_probe.requires_openai_auth=false'];
      const args = execAt < 0 ? request.args : [...request.args.slice(0, execAt + 1), ...providerArgs, ...extraRestrictions, ...request.args.slice(execAt + 1)];
      return { ...request, executable: '/usr/bin/sandbox-exec',
        args: ['-p', probeProfile(root, request.cwd, personalHome, port), request.executable, ...args],
        // Do not inherit credentials, proxies or the actual personal HOME into the test CLI.
        env: { HOME: home, CODEX_HOME: selectedHome, TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeoutMs: 30_000 };
    },
    summary() {
      return { runId, checkedAt: new Date().toISOString(), variant, extraRestrictions, catalogOverride, cliStarts, stageStarts, httpRequests, responseRequests,
        inventories, envelopeShapes, failures, authentication: 'none', transport: 'loopback-only sandbox-exec',
        scope: 'Custom provider with temporary HOME/CODEX_HOME; not evidence of the logged-in app tool inventory or C04 passage',
        conditionChanges: ['custom model provider', 'temporary HOME/CODEX_HOME/TMPDIR', 'OS network and credential-path restrictions',
          '30-second timeout', variant === 'forced-calls' ? 'fixed tool calls queued by the test, then a static response; no model'
            : 'static response, no model or tool execution', ...(catalogOverride ? ['pinned model catalog with direct mode and no apply_patch'] : [])] };
    },
    async close() {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type CodexProbe = Awaited<ReturnType<typeof createCodexProbe>>;
