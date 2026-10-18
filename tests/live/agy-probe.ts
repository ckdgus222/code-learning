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

const FAKE_KEY = 'code-learning-fake-key';
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
 * The Codex probe profile plus what agy needs for its own local helper: under the plain profile,
 * agy was denied network-bind and stopped before any request. Only a loopback port may be opened
 * and reached from loopback; outgoing connections stay limited to this probe's server, and name
 * lookups (mDNSResponder) and every other address stay blocked.
 */
export function agyProbeProfile(root: string, cwd: string, personalHome: string, port: number): string {
  return `${probeProfile(root, cwd, personalHome, port)}(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
`;
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

export async function createAgyProbe(answer: object) {
  if (process.platform !== 'darwin') throw new Error('Local agy probes require macOS sandbox-exec; no unprotected fallback');
  await access(SANDBOX_EXEC, constants.X_OK);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-local-probe-')));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const runId = randomUUID();
  const shapes: RequestShape[] = [];
  const failures: string[] = [];
  let cliStarts = 0;
  let stageStarts = 0;
  const server = createServer(async (request, response) => {
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
      // A static answer for model calls; anything else is recorded and refused.
      if (request.method === 'POST' && /:(?:stream)?[gG]enerateContent$/.test(shape.path)) {
        const result = textAnswer(JSON.stringify(answer));
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
    root, home, codexHome, shapes, failures,
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
      return { runId, checkedAt: new Date().toISOString(), cliStarts, stageStarts, requests: shapes.length, shapes, failures,
        authentication: 'fake API key', transport: 'loopback-only sandbox-exec',
        scope: 'agy API key mode with a temporary HOME; not evidence of the logged-in app or of C04 passage',
        conditionChanges: ['API key mode (modelProvider gemini)', 'custom Gemini endpoint', 'temporary HOME/TMPDIR',
          'OS network and credential-path restrictions', '60-second timeout', 'static answer, no model and no tool call'] };
    },
    async close() {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type AgyProbe = Awaited<ReturnType<typeof createAgyProbe>>;
