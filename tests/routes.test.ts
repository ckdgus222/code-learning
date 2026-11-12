import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { assertResultSize, findProjectRoutes, linkRoutes } from '../src/core/analysis/routes';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { Route } from '../src/shared/contracts';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-routes-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(name: string, text: string) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}
async function find(limits = MAP_LIMITS) {
  const project = await scanProject(root, randomUUID());
  return findProjectRoutes(root, project.id, project.files, limits);
}
const server = "@Controller('dogs') export class DogsController { @Get() list() {} @Delete(':id') remove() {} }";

describe('receiving routes', () => {
  it.each([
    ["'dogs'", "'x'", ['/dogs/x']],
    ["['dogs', 'pets']", "['a', 'b']", ['/dogs/a', '/dogs/b', '/pets/a', '/pets/b']],
    ["{ path: 'dogs' }", '', ['/dogs']],
    ['', '', ['/']],
    ['variable', '', [null]],
    ["['dogs', variable]", '', [null]],
    ["'dogs'", 'variable', [null]],
  ])('reads Nest controller %s and method %s', async (controller, method, paths) => {
    await put('controller.ts', `@Controller(${controller}) export class C { @Get(${method}) list() {} }`);
    expect((await find()).routes.map(route => route.path)).toEqual(paths);
  });
  it.each([
    ["app.setGlobalPrefix('api')", '/api/dogs', 'known'],
    ["app.setGlobalPrefix('api'); other.setGlobalPrefix('api')", '/api/dogs', 'known'],
    ["app.setGlobalPrefix('api'); other.setGlobalPrefix('v2')", '/dogs', 'unknown'],
    ["app.setGlobalPrefix('api', {})", '/dogs', 'unknown'],
    ['app.setGlobalPrefix(prefix)', '/dogs', 'unknown'],
    ['app.enableVersioning()', '/dogs', 'unknown'],
    ['', '/dogs', 'known'],
  ])('uses a conservative app prefix: %s', async (setup, address, prefix) => {
    await put('setup.ts', setup); await put('controller.ts', server);
    const result = await find();
    expect(result.routes[0]).toMatchObject({ path: address, prefix });
    if (address === '/api/dogs') expect(result.prefix?.site.fileId).toBeTruthy();
  });
  it('marks versioned methods and classes unknown', async () => {
    await put('controller.ts', "@Controller('dogs') @Version('1') class C { @Get() list() {} }\n@Controller('cats') class D { @Version('1') @Get() list() {} }");
    expect((await find()).routes.map(route => route.prefix)).toEqual(['unknown', 'unknown']);
  });
  it('reuses Next roots, groups, slots, params and pages API exports', async () => {
    await put('web/next.config.ts', 'export default {};');
    await put('web/app/(group)/@slot/dogs/[id]/route.ts', 'export async function DELETE() {} export const GET = () => {};');
    await put('web/pages/api/[...parts].ts', 'export default function api() {}');
    await put('other/app/dogs/route.ts', 'export function GET() {}');
    const result = await find();
    expect(result.routes.map(route => [route.method, route.path, route.prefix])).toEqual([
      ['DELETE', '/dogs/:id', 'known'], ['GET', '/dogs/:id', 'known'], ['ALL', '/api/:parts*', 'known'],
    ]);
  });
  it('does not interpret Next basePath', async () => {
    await put('next.config.ts', "export default {basePath: '/site'}");
    await put('app/dogs/route.ts', 'export function GET() {}');
    await put('client.ts', "fetch('/site/dogs')");
    expect((await find()).links[0]).toMatchObject({ sure: false, reasons: ['앞부분 모름'] });
  });
  it('requires an imported Express app/router and a stable receiver', async () => {
    await put('routes.ts', `import express, { Router } from 'express';
const app = express(); const router = express.Router(); const r = Router();
function load() {} app.get('/dogs', load); router.post('/cats', () => {}); r.all('/pets', load);
const cache = fake(); cache.get('/wrong', load);
const changed = express(); changed = other; changed.get('/wrong', load);`);
    expect((await find()).routes.map(route => [route.path, route.prefix])).toEqual([['/dogs', 'known'], ['/cats', 'unknown'], ['/pets', 'unknown']]);
  });
});

describe('requests and wrappers', () => {
  it('ignores non-request calls and all test files', async () => {
    await put('client.ts', "cache.get('/api/x'); readFile('/api/x'); fetch('/dogs');");
    await put('client.test.ts', "fetch('/test'); app.setGlobalPrefix('test');");
    await put('__tests__/routes.ts', server);
    expect((await find()).requests.map(request => request.path)).toEqual(['/dogs']);
    expect((await find()).routes).toEqual([]);
  });
  it.each([
    "const fetch = custom; fetch('/dogs')",
    "import fetch from 'other'; fetch('/dogs')",
    "function x(fetch) { fetch('/dogs') }",
  ])('excludes a shadowed fetch: %s', async code => {
    await put('client.ts', code); expect((await find()).requests).toEqual([]);
  });
  it.each([
    ["fetch('/dogs')", ['GET']],
    ["fetch('/dogs', {method:'delete'})", ['DELETE']],
    ["fetch('/dogs', {method: yes ? 'GET' : 'POST'})", ['GET', 'POST']],
    ["fetch('/dogs', {...options})", null],
    ["fetch('/dogs', options)", null],
    ["fetch('/dogs', {method})", null],
    ["fetch('/dogs', {[key]: value})", null],
    ["fetch('/dogs', {get method() { return 'POST'; }})", null],
    ["fetch('/dogs', {method: value})", null],
  ])('reads method conservatively: %s', async (code, methods) => {
    await put('client.ts', code); expect((await find()).requests[0].methods).toEqual(methods);
  });
  it.each([
    ['(path, init) => fetch(path, init)', ['DELETE']],
    ['(path, init = {}) => fetch(path, init)', ['DELETE']],
    ["(path, init = {method: 'POST'}) => fetch(path, init)", null],
    ["(path, init) => { init.method = 'POST'; return fetch(path, init); }", null],
    ["function(path, init) { arguments[1].method = 'POST'; return fetch(path, init); }", null],
    ["(path, init) => { const x = init; x.method = 'POST'; return fetch(path, init); }", null],
    ['(path, init) => fetch(path)', null],
    ['(path, init) => fetch(path, {...init, headers})', ['DELETE']],
    ["(path, init) => fetch(path, {method: 'GET', ...init})", null],
    ['(path, init) => fetch(path, {...init, ...other})', null],
    ['(path, init) => fetch(path, {...init, method})', null],
    ['(path, init) => fetch(path, {...init, [key]: value})', null],
    ['(path, init) => { init.headers.x = 1; return fetch(path, init); }', null],
    ['(path, init) => { delete init.method; return fetch(path, init); }', null],
    ['(path, init) => { init.headers(); return fetch(path, init); }', null],
    ['(path, init) => { const headers = new Headers(init.headers); fetch(path, {...init, headers}); return fetch(path, {...init, headers}); }', ['DELETE']],
  ])('wrapper options safety: %s', async (wrapper, methods) => {
    await put('client.ts', `const request = ${wrapper}; request('/dogs', {method:'DELETE'});`);
    expect((await find()).requests[0]?.methods).toEqual(methods);
  });
  it('follows two same-name imported wrappers and preserves default GET', async () => {
    await put('base.ts', 'export function apiFetch(path, init = {}) { const headers = new Headers(init.headers); return fetch(path, {...init, headers}); }');
    await put('api.ts', "import {apiFetch} from './base'; export const apiRequest = (path, init) => apiFetch(path, init);");
    await put('client.ts', "import {apiRequest} from './api'; apiRequest('/dogs'); apiRequest('/dogs/1', {method:'DELETE'});");
    expect((await find()).requests.map(request => request.methods)).toEqual([['GET'], ['DELETE']]);
  });
  it('excludes destructured and reassigned first parameters, renamed imports and ambiguous files', async () => {
    await put('api.ts', 'export const request = (path, init) => fetch(path, init);');
    await put('client.ts', `import {request as send} from './api'; send('/dogs');
const a = ({path}, init) => fetch(path, init); a('/dogs');
const b = (path, init) => { path = '/other'; return fetch(path, init); }; b('/dogs');`);
    expect((await find()).requests).toEqual([]);
    await put('api.js', 'export const request = (path, init) => fetch(path, init);');
    await put('client.ts', "import {request} from './api'; request('/dogs');");
    expect((await find()).requests).toEqual([]);
  });
  it('normalizes templates, unknown prefixes, query, slash and remote hosts', async () => {
    await put('client.ts', "fetch(`/dogs/${id}?x=1#top`); fetch(`${API}/dogs/`); fetch('https://example.test/dogs'); fetch('/has space');");
    expect((await find()).requests.map(request => [request.path, request.prefix, request.host])).toEqual([
      ['/dogs/*', 'known', null], ['/dogs', 'unknown', null], ['/dogs', 'known', 'example.test'],
    ]);
  });
  it.each([
    ['{}', '/dogs', 'known', null],
    ["{baseURL:'/api'}", '/api/dogs', 'known', null],
    ["{baseURL:'https://example.test/api'}", '/api/dogs', 'known', 'example.test'],
    ['{baseURL:env}', '/dogs', 'unknown', null],
    ['{baseURL}', '/dogs', 'unknown', null],
    ['{[key]: value}', '/dogs', 'unknown', null],
    ['{...config}', '/dogs', 'unknown', null],
    ['config', '/dogs', 'unknown', null],
  ])('axios instance baseURL: %s', async (config, address, prefix, host) => {
    await put('api.ts', `import axios from 'axios'; export const api = axios.create(${config});`);
    await put('client.ts', "import {api} from './api'; api.delete('/dogs');");
    expect((await find()).requests[0]).toMatchObject({ path: address, prefix, host, methods: ['DELETE'] });
  });
  it('axios defaults writes affect all requests; per-call configs affect only their request', async () => {
    await put('client.ts', "import axios from 'axios'; axios.get('/dogs', {baseURL:'/api'}); axios('/dogs', {method:'POST'}); axios.request('/dogs', {...options});");
    expect((await find()).requests.map(request => [request.path, request.methods, request.prefix])).toEqual([
      ['/api/dogs', ['GET'], 'known'], ['/dogs', ['POST'], 'known'], ['/dogs', null, 'unknown'],
    ]);
    await put('setup.ts', "import axios from 'axios'; axios.defaults.baseURL = '/x';");
    expect((await find()).requests.every(request => request.prefix === 'unknown')).toBe(true);
  });
  it('instance defaults writes are unknown', async () => {
    await put('client.ts', "import axios from 'axios'; const api = axios.create({}); api.defaults.headers = x; api.get('/dogs');");
    expect((await find()).requests[0].prefix).toBe('unknown');
  });
});

describe('linking', () => {
  it('keeps ambiguity, wildcard values, method candidates and remote hosts separate', async () => {
    await put('server.ts', "@Controller('dogs') class C { @Get('me') me() {} @Get(':id') one() {} @Post() create() {} @All('all/*') all() {} }");
    await put('client.ts', "fetch('/dogs/me'); fetch(`/dogs/${id}`); fetch('/dogs/3', {method:'DELETE'}); fetch('/dogs', {method: yes ? 'GET':'POST'}); fetch('/dogs/all/a/b'); fetch('https://elsewhere.test/dogs/me');");
    const result = await find();
    expect(result.links.filter(link => link.requestIndex === 0).map(link => link.reasons)).toEqual([['후보 여럿'], ['후보 여럿']]);
    expect(result.links.filter(link => link.requestIndex === 1).map(link => link.reasons)).toEqual([['경로 값 모름', '후보 여럿'], ['후보 여럿'], ['경로 값 모름', '후보 여럿']]);
    expect(result.links.some(link => link.requestIndex === 2 || link.requestIndex === 5)).toBe(false);
    expect(result.links.find(link => link.requestIndex === 3)?.reasons).toEqual(['방식 후보 둘']);
    expect(result.links.find(link => link.requestIndex === 4)?.sure).toBe(true);
  });
  it('a single fixed candidate still needs a dynamic path warning', async () => {
    await put('server.ts', server); await put('client.ts', 'fetch(`/${name}`); fetch(`/dogs/${id}`, {method:"DELETE"}); fetch("/dogs", options);');
    const result = await find();
    expect(result.links.map(link => [link.sure, link.reasons])).toEqual([[false, ['경로 값 모름']], [true, []], [false, ['방식 모름']]]);
  });
  it('required and optional Next catch-all segments differ at their root', async () => {
    await put('next.config.ts', 'export default {}');
    await put('app/a/[...x]/route.ts', 'export function GET() {}');
    await put('app/b/[[...x]]/route.ts', 'export function GET() {}');
    await put('client.ts', "fetch('/a'); fetch('/a/one/two'); fetch('/b');");
    expect((await find()).links.map(link => link.requestIndex)).toEqual([1, 2]);
  });
  it.each(['files', 'bytes', 'nodesPerFile'])('makes incomplete reads conservative: %s budget', async budget => {
    await put('a-controller.ts', server);
    await put('b-client.ts', "import axios from 'axios'; axios.get('/dogs');");
    await put('z-setup.ts', "app.setGlobalPrefix('api'); axios.defaults.baseURL = '/api';" + 'x();'.repeat(200));
    const limits = { ...MAP_LIMITS, [budget]: budget === 'files' ? 2 : budget === 'bytes' ? Buffer.byteLength(server) + 60 : 100 };
    const result = await find(limits);
    expect(result.limited).toBe(true);
    expect(result.routes[0].prefix).toBe('unknown');
    expect(result.requests[0].prefix).toBe('unknown');
    expect(result.links[0]).toMatchObject({ sure: false, reasons: ['앞부분 모름'] });
  });
  it('unreadable files block certainty and cancellation stops the job', async () => {
    await put('controller.ts', server);
    const project = await scanProject(root, randomUUID());
    project.files.push({ ...project.files[0], id: randomUUID(), relativePath: 'missing.ts' });
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes[0].prefix).toBe('unknown');
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

it('preserves axios base URLs written inside wrappers, including remote servers', async () => {
  await put('client.ts', `import axios from 'axios';
const remote = (path, init) => axios.get(path, {baseURL:'https://elsewhere.test'});
const local = (path, init) => axios.get(path, {baseURL:'/api'});
const forwarding = (path, init) => axios.get(path, init);
const mixed = (path, init) => axios.get(path, {...init, baseURL:'/api'});
remote('/dogs', {method:'GET'}); local('/dogs', {method:'GET'});
forwarding('/dogs', {baseURL:'/other'}); mixed('/dogs', {});`);
  const requests = (await find()).requests;
  expect(requests.map(request => [request.path, request.host, request.prefix, request.methods])).toEqual([
    ['/dogs', 'elsewhere.test', 'known', ['GET']], ['/api/dogs', null, 'known', ['GET']],
    ['/other/dogs', null, 'known', ['GET']], ['/dogs', null, 'unknown', ['GET']],
  ]);
});

describe('partly parsed files', () => {
  it('keeps the global prefix when a broken file never mentions it, and drops it when it might hide one', async () => {
    await put('setup.ts', "app.setGlobalPrefix('api');");
    await put('controller.ts', server);
    await put('broken.ts', 'export function broken( { return 1; }');
    let result = await find();
    expect(result.routes.map(route => [route.path, route.prefix])).toEqual([['/api/dogs', 'known'], ['/api/dogs/:id', 'known']]);
    expect(result.limited).toBe(true);
    await put('broken.ts', "export function broken( { app.setGlobalPrefix('v2'); }");
    result = await find();
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
    expect(result.notes).toContain('모든 파일을 읽지 못해 앞 경로를 확정하지 않았어요');
  });
});

describe('result limits', () => {
  it('caps routes that multiply from path arrays and says so', async () => {
    const paths = `[${Array.from({ length: 100 }, (_, index) => `'p${index}'`).join(', ')}]`;
    await put('controller.ts', `@Controller(${paths}) export class C { @Get(${paths}) list() {} }`);
    const result = await find();
    expect(result.routes).toHaveLength(1000);
    expect(result.limited).toBe(true);
    expect(result.notes.some(note => note.startsWith('주소·요청·연결이 너무 많아 일부는 생략했어요'))).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(3 * 1024 * 1024);
  });
});

describe('long paths', () => {
  it('treats over-long route and request paths as unreadable instead of copying them into the result', async () => {
    const long = 'x'.repeat(400);
    const paths = `[${Array.from({ length: 50 }, (_, index) => `'p${index}'`).join(', ')}]`;
    await put('controller.ts', `@Controller('${long}') export class C { @Get(${paths}) list() {} @Get('${'a/'.repeat(40)}') deep() {} }`);
    await put('client.ts', `fetch('/${long}'); fetch('/dogs');`);
    const result = await find();
    expect(result.routes.every(route => route.path === null)).toBe(true);
    expect(result.requests.map(request => request.path)).toEqual(['/dogs']);
    expect(result.limited).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(200 * 1024);
  });

  it('checks for a stop inside the matching loop', () => {
    const route = (index: number) => ({ method: 'GET' as const, path: `/r${index}`, prefix: 'unknown' as const, framework: 'express' as const,
      handler: { fileId: 'f', fileHash: 'h', startUtf16: 0, endUtf16: 1, startLine: 1, name: 'h' },
      basis: { text: '', range: { fileId: 'f', fileHash: 'h', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: '' } } });
    const request = { fileId: 'f', fileHash: 'h', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: '', args: [], inTest: false,
      inFunction: null, path: '/' + Array.from({ length: 30 }, () => 'a').join('/'), host: null, prefix: 'unknown' as const, methods: ['GET'] };
    let checks = 0;
    expect(() => linkRoutes(Array.from({ length: 100 }, (_, index) => route(index)), [request], () => ++checks > 10)).toThrow('주소 연결을 취소했어요.');
    expect(checks).toBe(11);
  });
});

describe('long names', () => {
  it('cuts long names, keeps a few arguments, and refuses a result over the size limit', async () => {
    const name = 'C'.repeat(60000);
    const paths = `[${Array.from({ length: 40 }, (_, index) => `'p${index}'`).join(', ')}]`;
    await put('controller.ts', `@Controller(${paths}) export class ${name} { @Get(${paths}) list() {} }`);
    await put('client.ts', `function ${name}x() { fetch('/dogs', ${Array.from({ length: 50 }, () => 'a').join(', ')}); }`);
    const result = await find();
    expect(result.routes[0].handler.name.length).toBeLessThanOrEqual(201 + '.list'.length);
    expect(result.requests[0].inFunction!.name.length).toBeLessThanOrEqual(201);
    expect(result.requests[0].args).toHaveLength(5);
    expect(JSON.stringify(result).length).toBeLessThan(4 * 1024 * 1024);
    expect(() => assertResultSize({ text: 'x'.repeat(2 * 1024 * 1024) })).toThrow('결과가 너무 커서 보여 주지 않았어요.');
    // Shared objects count each time they would be sent, without building the JSON.
    const shared = { text: 'y'.repeat(100 * 1024) };
    expect(() => assertResultSize(Array.from({ length: 100 }, () => shared))).toThrow('결과가 너무 커서 보여 주지 않았어요.');
    expect(() => assertResultSize(Array.from({ length: 5 }, () => shared))).not.toThrow();
  });
});

describe('wrapper search work', () => {
  it('finds wrappers in a file of thousands of pass-through functions quickly, and stops when asked', async () => {
    await put('many.ts', Array.from({ length: 6000 }, (_, index) => `function f${index}(p) { other(p); }`).join('\n')
      + "\nfunction request(path) { return fetch(path); }\nrequest('/dogs');");
    const started = performance.now();
    const result = await find();
    expect(performance.now() - started).toBeLessThan(15000);
    expect(result.requests.map(request => request.path)).toEqual(['/dogs']);
    const project = await scanProject(root, randomUUID());
    let checks = 0;
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => ++checks > 2000)).rejects.toThrow('주소 찾기를 취소했어요.');
  }, 30000);

  it('says so when the wrapper chain is longer than the work budget', async () => {
    const chain = Array.from({ length: 3000 }, (_, index) => index === 0 ? 'function w0(p) { return fetch(p); }' : `function w${index}(p) { return w${index - 1}(p); }`);
    await put('chain.ts', `${chain.join('\n')}\nw2999('/dogs');`);
    const result = await find();
    expect(result.notes.includes('감싼 요청 함수가 너무 많아 일부만 찾았어요.') || result.requests.length === 1).toBe(true);
  }, 60000);
});

describe('request collection work', () => {
  it('stops collecting at the request cap and answers a stop quickly with many variables and fetches', async () => {
    for (let file = 0; file < 4; file++) {
      await put(`client${file}.ts`, Array.from({ length: 6000 }, (_, index) => `const v${index} = 1; fetch('/a${index}');`).join('\n'));
    }
    const started = performance.now();
    const result = await find();
    expect(performance.now() - started).toBeLessThan(20000);
    expect(result.requests).toHaveLength(1000);
    expect(result.limited).toBe(true);
    const project = await scanProject(root, randomUUID());
    let stopAt = 0;
    const stop = () => { if (!stopAt && performance.now() - started > 0) stopAt = performance.now(); return performance.now() - stopAt > 200; };
    const cancelled = performance.now();
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, stop)).rejects.toThrow('주소 찾기를 취소했어요.');
    expect(performance.now() - cancelled).toBeLessThan(5000);
  }, 60000);
});

describe('fixed methods in request wrappers', () => {
  it.each([
    'const postJson = (path, body) => fetch(path, {method: "POST", body});',
    'function postJson(path) { fetch(path, {method: "post"}); return fetch(path, {"method": "POST"}); }',
    'import axios from "axios"; const postJson = path => axios.post(path);',
    'import axios from "axios"; const client = axios.create({}); const postJson = path => client.post(path);',
    'import axios from "axios"; const postJson = path => axios(path, {method: "POST"});',
  ])('confirms a single method from direct senders: %s', async wrapper => {
    await put('server.ts', "@Controller('dogs') class C { @Post() create() {} }");
    await put('client.ts', `${wrapper} postJson('/dogs');`);
    const result = await find();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].methods).toEqual(['POST']);
    expect(result.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
  });
  it.each([
    '{method: "POST", ...rest}', '{method}', '{method: m}', '{method: "POST", [k]: "DELETE"}',
    '{method: "POST", get cache() {return true;}}', '{method: "POST", method: "DELETE"}',
    '{method: "POST", __proto__: proto}', '{method: "POST", cache() {}}', '{}',
  ])('keeps the method unknown for unsupported options: %s', async options => {
    await put('server.ts', "@Controller('dogs') class C { @Post() create() {} }");
    await put('client.ts', `const send = path => fetch(path, ${options}); send('/dogs');`);
    const result = await find();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].methods).toBeNull();
    expect(result.links[0]).toMatchObject({ sure: false, reasons: expect.arrayContaining(['방식 모름']) });
  });
  it.each([
    'function send(path) { fetch(path, {method: "POST"}); return fetch(path, {method: "DELETE"}); }',
    'function send(path) { fetch(path, {method: "POST"}); return other(path); } function other(path) { return fetch(path, {method: "POST"}); }',
    'function other(path) { return fetch(path, {method: "POST"}); } function send(path) { fetch(path, {method: "POST"}); return other(path); }',
    'function send(path) { return other(path); } function other(path) { return fetch(path, {method: "POST"}); }',
    'function send(path) { other(path); return fetch(path, {method: "POST"}); }',
    'function send(path) { arguments[0] = "/other"; return fetch(path, {method: "POST"}); }',
    'var unrelated = 1; function send(path) { return fetch(path, {method: "POST"}); }',
  ])('does not confirm conflicting, indirect or unusual wrappers: %s', async wrapper => {
    await put('server.ts', "@Controller('dogs') class C { @Post() create() {} }");
    await put('client.ts', `${wrapper} send('/dogs');`);
    const result = await find();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].methods).toBeNull();
    expect(result.links[0].sure).toBe(false);
  });
});

describe('conditional request addresses', () => {
  it('pairs forwarded methods with const conditions and preserves the shared call site', async () => {
    await put('request.ts', 'export function apiRequest<T>(path, init) { return fetch(path, init); }');
    await put('client.ts', `import {apiRequest} from './request';
export function useSaveDiary(id) {
  const isNew = id === undefined;
  return apiRequest<Diary>(isNew ? "/api/diaries" : \`/api/diaries/\${id}\`, {
    method: isNew ? "POST" : "PATCH", body,
  });
}`);
    await put('server.ts', "@Controller('api/diaries') class C { @Post() create() {} @Patch(':id') update() {} }");
    const result = await find();
    expect(result.requests.map(({ path, methods, branch, host, prefix }) => ({ path, methods, branch, host, prefix }))).toEqual([
      { path: '/api/diaries', methods: ['POST'], branch: 'consequence', host: null, prefix: 'known' },
      { path: '/api/diaries/*', methods: ['PATCH'], branch: 'alternative', host: null, prefix: 'known' },
    ]);
    const sites = result.requests.map(({ path, methods, branch, ...site }) => site);
    expect(sites[0]).toEqual(sites[1]);
    expect(result.links).toEqual([
      { requestIndex: 0, routeIndex: 0, sure: true, reasons: [] },
      { requestIndex: 1, routeIndex: 1, sure: true, reasons: [] },
    ]);
  });

  it.each([
    ['const isNew = true;', 'isNew', 'isNew', '', true],
    ['', 'isNew', 'isNew', '', true],
    ['const isNew = () => true;', 'isNew', 'isNew', '', true],
    ['function isNew() {}', 'isNew', 'isNew', '', false],
    ['let isNew = () => true;', 'isNew', 'isNew', '', false],
    ['const isNew = true;', '((isNew))', '(isNew)', '', true],
    ['const isNew = true; const other = false;', 'isNew', 'other', '', false],
    ['let isNew = true;', 'isNew', 'isNew', 'isNew = false;', false],
    ['let isNew = true;', 'isNew', 'isNew', '', false],
    ['', 'isNew', 'isNew', 'isNew = false;', false],
    ['const isNew = true;', 'isNew', 'isNew', 'function mutate() { isNew = false; }', false],
    ['const isNew = true;', 'a.b', 'a.b', '', false],
    ['const isNew = true;', 'f()', 'f()', '', false],
    ['const isNew = true; var unrelated = 0;', 'isNew', 'isNew', '', false],
    ['const isNew = true; const isNew = false;', 'isNew', 'isNew', '', false],
    ['const other = true;', 'missing', 'missing', '', false],
  ])('pairs only stable supported declarations: %s / %s / %s / %s', async (setup, urlCondition, methodCondition, after, paired) => {
    await put('client.ts', `function send(${setup ? '' : 'isNew'}) {
      ${setup}
      fetch((${urlCondition} ? ('/a') : ('/b')), { method: ${methodCondition} ? 'POST' : 'PUT' });
      ${after}
    }`);
    await put('server.ts', "@Controller() class C { @Post('a') create() {} @Put('b') update() {} }");
    const result = await find();
    expect(result.requests.map(request => request.methods)).toEqual(paired ? [['POST'], ['PUT']] : [['POST', 'PUT'], ['POST', 'PUT']]);
    expect(result.links).toEqual([
      { requestIndex: 0, routeIndex: 0, sure: paired, reasons: paired ? [] : ['방식 후보 둘'] },
      { requestIndex: 1, routeIndex: 1, sure: paired, reasons: paired ? [] : ['방식 후보 둘'] },
    ]);
  });

  it('uses the nearest declaration when an inner let shadows an outer const', async () => {
    await put('client.ts', `const isNew = true; function send() { let isNew = false;
      fetch(isNew ? '/a' : '/b', {method: isNew ? 'POST' : 'PUT'}); }`);
    expect((await find()).requests.map(request => request.methods)).toEqual([['POST', 'PUT'], ['POST', 'PUT']]);
  });

  it.each([
    ["fetch(isNew ? '/a' : '/b', {method: 'POST'})", ['POST']],
    ["fetch(isNew ? '/a' : '/b')", ['GET']],
    ["fetch(isNew ? '/a' : '/b', options)", null],
    ["fetch(isNew ? '/a' : '/b', {method: isNew ? 'POST' : unknown})", null],
    ["axios(isNew ? '/a' : '/b')", null],
    ["axios.post(isNew ? '/a' : '/b', body, {method: isNew ? 'GET' : 'PUT'})", ['POST']],
    ["postJson(isNew ? '/a' : '/b', {method: isNew ? 'GET' : 'PUT'})", ['POST']],
  ])('preserves literal, default, unknown and fixed methods: %s', async (call, methods) => {
    await put('client.ts', `import axios from 'axios'; const isNew = true;
      function postJson(path, body) { return fetch(path, {method: 'POST', body}); } ${call};`);
    expect((await find()).requests.map(request => request.methods)).toEqual([methods, methods]);
  });

  it.each([
    "isNew ? '/a' : url", "isNew ? url : '/b'", "isNew ? '/a' : other ? '/b' : '/c'",
    "isNew ? '/a' : '/b\\n'", "isNew ? '/a b' : '/b'", "isNew ? 'relative' : '/b'",
    "isNew && '/a'", "isNew || '/a'", 'url',
  ])('does not record partial or unsupported addresses: %s', async address => {
    await put('client.ts', `fetch(${address});`);
    expect((await find()).requests).toEqual([]);
  });

  it('applies base URLs, hosts, template segments and query removal to each branch', async () => {
    await put('client.ts', `import axios from 'axios'; const isNew = true;
      axios(isNew ? '/diaries' : \`/diaries/\${id}?view=full#top\`, {baseURL: 'https://api.example.com/api', method: isNew ? 'POST' : 'PATCH'});
      axios(isNew ? 'https://other.example.com/a' : '/b', {baseURL: '/api', method: 'POST'});
      fetch(isNew ? \`\${base}/a\` : '/b');`);
    expect((await find()).requests.map(({ path, host, prefix }) => ({ path, host, prefix }))).toEqual([
      { path: '/api/diaries', host: 'api.example.com', prefix: 'known' },
      { path: '/api/diaries/*', host: 'api.example.com', prefix: 'known' },
      { path: '/a', host: 'other.example.com', prefix: 'known' },
      { path: '/api/b', host: null, prefix: 'known' },
      { path: '/a', host: null, prefix: 'unknown' },
      { path: '/b', host: null, prefix: 'known' },
    ]);
  });

  it('counts each branch against the request limit', async () => {
    await put('client.ts', `${Array.from({ length: 999 }, () => "fetch('/existing');").join('\n')}
      fetch(isNew ? '/a' : '/b');`);
    const result = await find();
    expect(result.requests).toHaveLength(1000);
    expect(result.requests.at(-1)).toMatchObject({ path: '/a', branch: 'consequence' });
    expect(result.limited).toBe(true);
    expect(result.notes).toContainEqual(expect.stringContaining('요청 1000개'));
  });

  it.each(['/' + 'a'.repeat(300), '/' + Array(31).fill('a').join('/')])('bounds each branch path: %s', async address => {
    await put('client.ts', `fetch(isNew ? '/a' : '${address}');`);
    const result = await find();
    expect(result.requests.map(request => request.path)).toEqual(['/a']);
    expect(result.limited).toBe(true);
  });
});

it('follows an imported request wrapper through an alias', async () => {
  await put('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
  await put('src/api.ts', 'export function request(path, init) { return fetch(path, init); }');
  await put('client.ts', "import {request} from '@/api'; request('/dogs', {method:'DELETE'});");
  expect((await find()).requests.map(request => [request.path, request.methods])).toEqual([['/dogs', ['DELETE']]]);
  await put('src/api.js', 'export function request() {}');
  expect((await find()).requests).toEqual([]);
});

it('does not recognize internal aliases named axios or express as packages', async () => {
  await put('client.ts', "import axios from 'axios'; axios.get('/dogs');");
  await put('server.ts', "import express from 'express'; const app = express(); app.get('/dogs', (req, res) => res.send('ok'));");
  await put('src/fake-axios.ts', 'export default function axios() {}');
  await put('src/fake-express.ts', 'export default function express() {}');
  const before = await find();
  expect(before.requests.map(item => item.path)).toEqual(['/dogs']);
  expect(before.routes.map(item => item.path)).toEqual(['/dogs']);
  await put('tsconfig.json', '{"compilerOptions":{"paths":{"axios":["./src/fake-axios.ts"],"express":["./src/fake-express.ts"]}}}');
  const after = await find();
  expect(after.requests).toEqual([]);
  expect(after.routes).toEqual([]);
});

const fastapi = 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/users/{user_id}")\nasync def read_user(user_id: int):\n    return user_id\n';

describe('FastAPI project routes', () => {
  it('connects literal and template requests, preserving methods and Python-only projects', async () => {
    await put('server/main.py', fastapi);
    let result = await find();
    expect(result.routes).toHaveLength(1);
    expect(result.requests).toEqual([]);
    expect(result.limited).toBe(false);
    await put('web/app.ts', "fetch('/users/1'); fetch(`/users/${id}`); fetch('/users/1', {method:'DELETE'});");
    result = await find();
    expect(result.links).toEqual([
      { requestIndex: 0, routeIndex: 0, sure: true, reasons: [] },
      { requestIndex: 1, routeIndex: 0, sure: true, reasons: [] },
    ]);
    expect(result.notes).toEqual([]);
  });
  it('infers router prefixes and emits the router note once', async () => {
    await put('server/users.py', 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/users")\n@router.get("/{id}")\n@router.post("/{id}")\ndef h(): pass');
    await put('web/app.ts', "fetch('/api/users/1');");
    const result = await find();
    expect(result.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: false, reasons: ['앞부분 모름'] }]);
    expect(result.notes.filter(note => note.includes('APIRouter'))).toHaveLength(1);
    expect(result.notes.some(note => note.includes('Blueprint'))).toBe(false);
  });
  it.each([
    ['/files/{p:path}', '/files/a/b', true], ['/files/{p:path}', '/files/', true], ['/files/{p:path}', '/files', true],
    ['/files/{p:path}/meta', '/files/a/b/meta', false], ['/files/{p:path}/', '/files', false],
    ['/v{n}', '/unrelated', false], ['/users/{id:int}', '/users/alice', true],
    ['/files/:name', '/files/alice', false], ['/files/report*', '/files/unrelated/a', false],
    ['/users//me', '/users/me', false], ['/users/{사용자}', '/users/alice', false], ['', '/', false], ['/', '/', true],
  ])('links only expressible route paths: %s -> %s', async (address, request, linked) => {
    await put('main.py', fastapi.replace('/users/{user_id}', address));
    await put('web.ts', `fetch('${request}')`);
    const result = await find();
    expect(result.routes[0].path).toBe(address);
    if (address === '/users/{id:int}') expect(result.links[0]).toMatchObject({ sure: false, reasons: ['값 모양 모름'] });
    expect(result.links).toHaveLength(linked ? 1 : 0);
    expect(result.notes.filter(note => note.includes('정확히 맞춰'))).toHaveLength(linked ? 0 : 1);
  });
  it.each([
    ['FastAPI(redirect_slashes=False)', '@app.get("/users/")', '/users'],
    ['FastAPI(redirect_slashes=False)', '@app.get("/files/{p:path}")', '/files'],
    ['FastAPI()', '@app.api_route("/users", **options)', '/users'],
    ['FastAPI()', '@app.api_route("/users", methods=unknown)', '/users'],
  ])('does not confirm unknown methods or slash behavior: %s %s', async (create, decorator, request) => {
    await put('main.py', `from fastapi import FastAPI\napp = ${create}\n${decorator}\ndef h(): pass`);
    await put('web.ts', `fetch('${request}'); fetch('${request}', {method:'DELETE'});`);
    const result = await find();
    expect(result.routes).toHaveLength(1);
    expect(result.links).toEqual([]);
  });
  it('does not link unusual files, while ordinary Python files still link', async () => {
    await put('odd.py', fastapi + '\nimport fastapi as f\nf.FastAPI = other_factory');
    await put('web.ts', "fetch('/users/1'); fetch('/normal/1');");
    let result = await find();
    expect(result.routes).toHaveLength(1);
    expect(result.links).toEqual([]);
    expect(result.notes.filter(note => note.includes('실행 중에 이름'))).toHaveLength(1);
    expect(result.notes.some(note => note.includes('정확히 맞춰'))).toBe(false);
    await put('tool.py', 'exec(code)');
    expect((await find()).notes.filter(note => note.includes('실행 중에 이름'))).toEqual(['odd.py: 실행 중에 이름·속성이나 주소 규칙을 바꿀 수 있는 코드가 있어, 이 파일의 Python 서버 주소는 요청과 잇지 않았어요.']);
    await put('normal.py', fastapi.replace('/users/', '/normal/'));
    result = await find();
    expect(result.links).toEqual([{ requestIndex: 1, routeIndex: 0, sure: true, reasons: [] }]);
  });
  it.each([
    ['fastapi.py', true], ['libs/fastapi/__init__.py', true], ['FastAPI/__init__.py', true], ['FastAPI/x.py', false], ['examples/fastapi/main.py', false], ['ｆａｓｔａｐｉ.py', true],
    ['docs/fastapi.md', false], ['fastapi.json', false], ['fastapi/README.md', false],
    ['env/lib/python3.12/site-packages/fastapi/__init__.py', false], ['env/dist-packages/fastapi.py', false],
    ['fastapi_utils.py', false], ['my_fastapi/x.py', false],
  ])('uses only Python paths from scanProject to detect package shadowing: %s', async (name, shadow) => {
    await put(name, 'from flask import Flask as FastAPI');
    await put('main.py', fastapi.replace('FastAPI()', 'FastAPI(__name__)'));
    await put('web.ts', "fetch('/users/1');");
    const project = await scanProject(root, randomUUID());
    expect(project.files.some(file => file.relativePath === name)).toBe(true);
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    expect(result.links).toHaveLength(shadow ? 0 : 1);
    expect(result.notes.filter(note => note.includes('Python 모듈이 있어'))).toEqual(shadow
      ? [`프로젝트 안에 fastapi라는 이름의 Python 모듈이 있어(${name}), FastAPI 주소를 요청과 잇지 않았어요.`] : []);
    expect(result.notes.some(note => note.includes('정확히 맞춰'))).toBe(false);
    if (shadow) { expect(result.routes[0].unmatched).toBe(true); expect(result.routes[0].segments).toBeUndefined(); }
  });
  it('reports the first shadow path once and suppresses per-file warnings', async () => {
    await put('a/fastapi.py', ''); await put('z/fastapi.py', '');
    await put('main.py', fastapi + '\napp.get = other');
    await put('typed.py', fastapi.replace('{user_id}', '{user_id:int}'));
    const note = '프로젝트 안에 fastapi라는 이름의 Python 모듈이 있어(a/fastapi.py), FastAPI 주소를 요청과 잇지 않았어요.';
    expect((await find()).notes).toEqual([note]);
    const project = await scanProject(root, randomUUID());
    expect((await findProjectRoutes(root, project.id, project.files.toReversed())).notes).toEqual([note]);
  });
  it('preserves TS/JS lists and nonoverlapping links and keeps Nest prefixes off Python routes', async () => {
    await put('server.ts', "@Controller('dogs') class Dogs { @Get() list() {} }");
    await put('setup.ts', "app.setGlobalPrefix('api');");
    await put('web.ts', "fetch('/api/dogs'); fetch('/users/1');");
    await put('main.py', fastapi);
    const project = await scanProject(root, randomUUID());
    const before = await findProjectRoutes(root, project.id, project.files.filter(file => !file.relativePath.endsWith('.py')));
    const after = await findProjectRoutes(root, project.id, project.files);
    expect(after.routes.filter(route => route.framework !== 'fastapi')).toEqual(before.routes);
    expect(after.requests).toEqual(before.requests);
    expect(after.links.filter(link => link.requestIndex === 0)).toEqual(before.links);
    expect(after.routes.at(-1)?.path).toBe('/users/{user_id}');
    expect(after.links.at(-1)).toMatchObject({ requestIndex: 1, sure: true });
  });
  it('retains every overlapping server as an uncertain candidate', async () => {
    await put('server.ts', "@Controller('users') class Users { @Get(':id') read() {} }");
    await put('main.py', fastapi);
    await put('web.ts', "fetch('/users/1');");
    const result = await find();
    expect(result.links).toHaveLength(2);
    expect(result.links.every(link => !link.sure && link.reasons.includes('후보 여럿'))).toBe(true);
  });
  it('shares the link limit in request order and reports omitted later TS links', async () => {
    await put('server.ts', "@Controller('health') class Health { @Get() read() {} }");
    await put('web.ts', "fetch('/users/1');\n".repeat(6) + "fetch('/health');");
    const before = await find();
    const many = 'from fastapi import FastAPI\napp = FastAPI()\n' + Array.from({ length: 900 }, (_, i) => `@app.get('/users/{id}')\ndef h${i}(): pass`).join('\n');
    await put('main.py', many);
    const full = await find();
    expect(full.links).toHaveLength(5000);
    expect(full.links.some(link => link.requestIndex === 6)).toBe(false);
    expect(full.notes).toContainEqual(expect.stringContaining('연결 5000개'));
    await put('main.py', fastapi);
    const small = await find();
    expect(small.links.filter(link => link.requestIndex === 6)).toEqual(before.links);
  });
  it('excludes Python test helpers and collects normal files', async () => {
    for (const name of ['tests/test_api.py', 'test_main.py', 'conftest.py', 'test/helper.py', 'other_test.py', '__tests__/api.py']) await put(name, fastapi);
    await put('main.py', fastapi);
    expect((await find()).routes).toHaveLength(1);
  });
  it('shares file and byte budgets, reports unreadable files and incomplete syntax walks', async () => {
    await put('client.ts', "fetch('/users/1');");
    await put('main.py', fastapi);
    expect((await find({ ...MAP_LIMITS, files: 1 }))).toMatchObject({ limited: true, routes: [] });
    expect((await find({ ...MAP_LIMITS, bytes: Buffer.byteLength("fetch('/users/1');") })))
      .toMatchObject({ limited: true, routes: [], notes: ['읽기 한도에 닿아 Python 파일 일부는 확인하지 못했어요.'] });
    await put('main.py', fastapi + '\nx = 1\n'.repeat(30));
    const partial = await find({ ...MAP_LIMITS, nodesPerFile: 40 });
    expect(partial.limited).toBe(true);
    expect(partial.notes).toContain('main.py: 일부만 확인했어요.');
    expect(partial.routes).toHaveLength(1);
    expect(partial.routes.every(route => route.unmatched)).toBe(true);
    const project = await scanProject(root, randomUUID());
    project.files.push({ id: 'missing', relativePath: 'missing.py', size: 1 });
    const missing = await findProjectRoutes(root, project.id, project.files);
    expect(missing.notes).toContainEqual(expect.stringMatching(/^missing.py:/));
  });
  it('caps Python routes and notices cancellation during Python processing', async () => {
    await put('main.py', 'from fastapi import FastAPI\napp = FastAPI()\n' + Array.from({ length: 1005 }, (_, i) => `@app.get('/x${i}')\ndef h${i}(): pass`).join('\n'));
    const result = await find();
    expect(result.routes).toHaveLength(1000);
    expect(result.notes).toContainEqual(expect.stringContaining('받는 곳 1000개'));
    const project = await scanProject(root, randomUUID());
    let checks = 0;
    await expect(findProjectRoutes(root, project.id, project.files, MAP_LIMITS, () => ++checks > 5)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

const flask = 'from flask import Flask\napp = Flask(__name__)\n@app.route("/users/<user_id>")\ndef read_user(user_id):\n    return user_id\n';

describe('unknown route prefixes without literal segments', () => {
  const note = '앞부분을 모르고 글자 칸도 없는 주소(/, /:id 등)는 맞춰 볼 근거가 없어 요청과 잇지 않았어요.';

  it('keeps Flask app links certain when a Blueprint root is present', async () => {
    await put('app.py', flask + '\n@app.route("/health")\ndef health(): pass');
    await put('blog.py', 'from flask import Blueprint\nbp = Blueprint("blog", __name__)\n@bp.route("/")\ndef index(): pass');
    await put('web.ts', "fetch('/users/1'); fetch('/health'); fetch('/a/b/c');");
    const result = await find();
    expect(result.routes.map(route => route.path)).toEqual(['/users/<user_id>', '/health', '/']);
    expect(result.routes[2]).toMatchObject({ prefix: 'unknown', framework: 'flask' });
    expect(result.links).toEqual([
      { requestIndex: 0, routeIndex: 0, sure: true, reasons: [] },
      { requestIndex: 1, routeIndex: 1, sure: true, reasons: [] },
    ]);
    expect(result.notes.filter(value => value === note)).toHaveLength(1);
  });

  it('skips Express router roots and parameters but keeps literal suffixes', async () => {
    await put('server.ts', "import { Router } from 'express'; const router = Router(); router.get('/', () => {}); router.get('/:id', () => {}); router.get('/dogs/:id', () => {});");
    await put('web.ts', "fetch('/dogs'); fetch('/dogs/1'); fetch('/'); fetch('/api/dogs/1');");
    const result = await find();
    expect(result.routes.map(route => route.path)).toEqual(['/', '/:id', '/dogs/:id']);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
    expect(result.links).toEqual([1, 3].map(requestIndex => ({ requestIndex, routeIndex: 2, sure: false, reasons: ['앞부분 모름'] })));
    expect(result.notes).toEqual([note]);
  });

  it.each([
    ['server.ts', "import express from 'express'; const app = express(); app.get('/', () => {});"],
    ['main.py', fastapi.replace('/users/{user_id}', '/')],
    ['main.py', flask.replace('/users/<user_id>', '/')],
    ['app/route.ts', 'export function GET() {}'],
  ])('preserves known app roots without a note: %s %s', async (file, source) => {
    await put('next.config.ts', 'export default {}');
    await put(file, source);
    await put('web.ts', "fetch('/');");
    const result = await find();
    expect(result.routes[0]).toMatchObject({ path: '/', prefix: 'known' });
    expect(result.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
    expect(result.notes).toEqual([]);
  });

  it.each([
    ['from fastapi import APIRouter\nrouter = APIRouter()', 'router.get', ['/{id}', '/{id}/{sub}', '/{p:path}'], '/{id}/edit', '/x/1/edit', ['앞부분 모름']],
    ['from flask import Blueprint\nrouter = Blueprint("blog", __name__)', 'router.route', ['/<int:id>', '/<path:p>'], '/<int:id>/update', '/blog/1/update', ['앞부분 모름', '값 모양 모름']],
  ])('requires a literal segment in Python router paths: %s', async (setup, decorator, paths, literal, request, reasons) => {
    await put('main.py', setup + '\n' + [...paths, literal].map((address, index) => `@${decorator}("${address}")\ndef h${index}(): pass`).join('\n'));
    await put('web.ts', `fetch('/'); fetch('/1'); fetch('/1/2'); fetch('/a/b/c'); fetch('${request}');`);
    const result = await find();
    expect(result.routes.map(route => route.path)).toEqual([...paths, literal]);
    expect(result.routes.every(route => route.prefix === 'unknown')).toBe(true);
    expect(result.links).toEqual([{ requestIndex: 4, routeIndex: paths.length, sure: false, reasons }]);
    expect(result.notes.filter(value => value === note)).toHaveLength(1);
  });

  it.each([
    "import { Router } from 'express'; const router = Router(); router.get('/dogs/:id', () => {});",
    'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get(address)\ndef h(): pass',
    "import { Router } from 'express'; const router = Router(); router.get('/" + 'x'.repeat(400) + "', () => {});",
    'from fastapi import APIRouter\nrouter = APIRouter()\n@router.api_route("/", methods=unknown)\ndef h(): pass',
    'from flask import Blueprint\nbp = Blueprint("blog", __name__)\n@bp.route("/", subdomain="api")\ndef h(): pass',
  ])('does not warn for literal, unreadable or unmatched routes: %s', async source => {
    await put(source.startsWith('import ') ? 'server.ts' : 'main.py', source);
    const result = await find();
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].prefix).toBe('unknown');
    expect(result.routes[0].path === null || result.routes[0].unmatched || result.routes[0].path === '/dogs/:id').toBe(true);
    expect(result.notes).not.toContain(note);
  });

  it.each<Pick<Route, 'path' | 'segments'>>([
    { path: '/' }, { path: '/:id' }, { path: '/:id/:sub' }, { path: '/*' }, { path: '/rest*' },
    { path: '/:id/*' }, { path: '/literal', segments: [] },
    { path: '/literal', segments: [{ param: 'id' }] },
    { path: '/literal', segments: [{ catchAll: 'rest', optional: true }] },
  ])('excludes unsupported evidence before ambiguity and link limits: %j', async shape => {
    await put('server.ts', "import express from 'express'; const app = express(); app.get('/health', () => {});");
    await put('web.ts', "fetch('/health'); fetch('/health');");
    const result = await find();
    const routes: Route[] = [{ ...result.routes[0], ...shape, prefix: 'unknown' }, result.routes[0]];
    expect(linkRoutes(routes, result.requests, undefined, 2)).toEqual([0, 1].map(requestIndex => ({ requestIndex, routeIndex: 1, sure: true, reasons: [] })));
  });

  it('uses structured text segments and preserves unknown request prefixes', async () => {
    await put('server.ts', "import express from 'express'; const app = express(); app.get('/', () => {});");
    await put('web.ts', "fetch('/api/health'); fetch(`${base}/`);");
    const result = await find();
    expect(linkRoutes([{ ...result.routes[0], prefix: 'unknown', segments: [{ text: 'health' }] }], result.requests))
      .toEqual([{ requestIndex: 0, routeIndex: 0, sure: false, reasons: ['앞부분 모름'] }]);
    expect(result.links).toEqual([{ requestIndex: 1, routeIndex: 0, sure: false, reasons: ['앞부분 모름'] }]);
    expect(result.notes).toEqual([]);
  });
});

describe('Flask project routes and typed links', () => {
  it('links requests with supported methods and handles Python-only projects', async () => {
    await put('server/app.py', flask);
    let result = await find();
    expect(result).toMatchObject({ routes: [{ framework: 'flask' }], requests: [], limited: false, notes: [] });
    await put('web/app.ts', "fetch('/users/1'); fetch('/users/1', {method:'POST'}); fetch('/users/1', {method:'DELETE'});");
    result = await find();
    expect(result.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
    await put('server/app.py', flask.replace('"/users/<user_id>"', '"/users/<user_id>", methods=["GET", "POST"]'));
    expect((await find()).links).toEqual([
      { requestIndex: 0, routeIndex: 0, sure: true, reasons: [] },
      { requestIndex: 1, routeIndex: 1, sure: true, reasons: [] },
    ]);
  });
  it.each([
    ['Flask', flask.replace('<user_id>', '<int:user_id>')],
    ['FastAPI', fastapi.replace('{user_id}', '{user_id:int}')],
  ])('always marks %s typed links as guesses, even for incompatible values', async (_framework, source) => {
    await put('server/app.py', source);
    await put('web/app.ts', "fetch('/users/1'); fetch(`/users/${id}`); fetch('/users/alice');");
    const result = await find();
    expect(result.links).toEqual([0, 1, 2].map(requestIndex => ({ requestIndex, routeIndex: 0, sure: false, reasons: ['값 모양 모름'] })));
    expect(result.notes).toEqual([]);
    expect(result.routes[0].typed).toBe(true);
  });
  it('treats str like a plain parameter and retains every overlapping candidate', async () => {
    await put('main.py', fastapi.replace('{user_id}', '{user_id:str}'));
    await put('web.ts', "fetch('/users/1');");
    expect((await find()).links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }]);
    await put('other.py', fastapi);
    expect((await find()).links).toEqual([0, 1].map(routeIndex => ({ requestIndex: 0, routeIndex, sure: false, reasons: ['후보 여럿'] })));
    await put('flask_app.py', flask);
    expect((await find()).links).toHaveLength(3);
    expect((await find()).links.every(link => !link.sure && link.reasons.includes('후보 여럿'))).toBe(true);
  });
  it('requires at least one value for Flask path converters', async () => {
    await put('main.py', flask.replace('/users/<user_id>', '/files/<path:p>'));
    await put('web.ts', "fetch('/files/a/b'); fetch('/files/a'); fetch('/files');");
    expect((await find()).links).toEqual([0, 1].map(requestIndex => ({ requestIndex, routeIndex: 0, sure: true, reasons: [] })));
  });
  it.each(['<id>', '<int:id>'])('keeps Blueprint prefixes uncertain and emits a single note: %s', async param => {
    await put('users.py', `from flask import Blueprint\nbp = Blueprint('users', __name__, url_prefix='/users')\n@bp.route('/${param}')\n@bp.post('/${param}')\ndef h(): pass`);
    await put('web.ts', "fetch('/api/users/1');");
    const result = await find();
    expect(result.links).toEqual([{ requestIndex: 0, routeIndex: 0, sure: false,
      reasons: param === '<id>' ? ['앞부분 모름'] : ['앞부분 모름', '값 모양 모름'] }]);
    expect(result.notes).toEqual(['Flask의 Blueprint는 register_blueprint로 붙이거나 바꾸는 앞 경로를 따라가지 않아, 그 주소는 앞부분을 모르는 것으로 봤어요.']);
  });
  it.each([
    ['Flask(__name__)', '@app.route("/v<int:n>")', '/v1'],
    ['Flask(__name__)', '@app.route("/<any(a,b):x>")', '/a'],
    ['Flask(__name__)', '@app.route("/users//me")', '/users/me'],
    ['Flask(__name__)', '@app.route("")', '/'],
    ['Flask(__name__)', '@app.route("/users", subdomain="api")', '/users'],
    ['Flask(__name__, None, None, None, True)', '@app.route("/users")', '/users'],
    ['Flask(__name__)', '@app.get("/x", methods=["POST"])', '/x'],
  ])('never links unsupported Flask declarations: %s %s', async (create, decorator, request) => {
    await put('main.py', `from flask import Flask\napp = ${create}\n${decorator}\ndef h(): pass`);
    await put('web.ts', `fetch('${request}'); fetch('${request}', {method:'POST'});`);
    const result = await find();
    expect(result.routes).toHaveLength(1);
    expect(result.links).toEqual([]);
    expect(result.notes).toEqual(['Python 서버 주소 가운데 정확히 맞춰 볼 수 없는 것(특수 글자나 글이 섞인 칸, 읽지 못한 방식, 받는 요청을 바꾸는 설정)은 요청과 잇지 않았어요.']);
  });
  it.each([
    flask.replace('Flask(__name__)', 'Flask(__name__, host_matching=True, static_host="x")'),
    flask + "\napp.url_map.converters['default'] = X",
  ])('emits only the unusual-file note and preserves ordinary files', async source => {
    await put('odd.py', source);
    await put('normal.py', flask.replace('/users/', '/normal/'));
    await put('web.ts', "fetch('/users/1'); fetch('/normal/1');");
    const result = await find();
    expect(result.routes).toHaveLength(2);
    expect(result.links).toEqual([{ requestIndex: 1, routeIndex: 0, sure: true, reasons: [] }]);
    expect(result.notes).toEqual(['odd.py: 실행 중에 이름·속성이나 주소 규칙을 바꿀 수 있는 코드가 있어, 이 파일의 Python 서버 주소는 요청과 잇지 않았어요.']);
  });
  it.each([
    ['flask.py', true], ['libs/flask/__init__.py', true], ['Flask/__init__.py', true], ['ｆｌａｓｋ.py', true],
    ['flask/app.py', false], ['examples/flask/main.py', false], ['docs/flask.md', false],
    ['env/lib/python3.12/site-packages/flask/__init__.py', false], ['env/dist-packages/flask.py', false], ['flask_utils.py', false],
    ['flask/sub/__init__.py', false],
  ])('checks actual project module files, not just directory names: %s', async (name, shadow) => {
    await put(name, '');
    await put('main.py', flask.replace('<user_id>', '<int:user_id>'));
    await put('web.ts', "fetch('/users/1');");
    const project = await scanProject(root, randomUUID());
    expect(project.files.some(file => file.relativePath === name)).toBe(true);
    const result = await findProjectRoutes(root, project.id, project.files);
    expect(result.routes).toHaveLength(1);
    expect(result.links).toHaveLength(shadow ? 0 : 1);
    expect(result.notes).toEqual(shadow ? [`프로젝트 안에 flask라는 이름의 Python 모듈이 있어(${name}), Flask 주소를 요청과 잇지 않았어요.`] : []);
    expect(result.routes[0].typed).toBe(shadow ? undefined : true);
    expect(result.routes[0].unmatched).toBe(shadow ? true : undefined);
    expect(result.routes[0].segments).toEqual(shadow ? undefined : [{ text: 'users' }, { param: 'user_id' }]);
  });
  it.each(['flask', 'fastapi'])('shadows only %s and reports both when both modules exist', async framework => {
    await put('flask_app.py', flask.replace('/users/', '/flask-users/'));
    await put('fastapi_app.py', fastapi);
    await put('web.ts', "fetch('/users/1'); fetch('/flask-users/1');");
    await put(`${framework}.py`, '');
    let result = await find();
    expect(result.links).toHaveLength(1);
    expect(result.routes[result.links[0].routeIndex].framework).toBe(framework === 'flask' ? 'fastapi' : 'flask');
    expect(result.links[0].sure).toBe(true);
    await put(`${framework === 'flask' ? 'fastapi' : 'flask'}.py`, '');
    result = await find();
    expect(result.links).toEqual([]);
    expect(result.notes.filter(note => note.includes('Python 모듈이 있어'))).toHaveLength(2);
  });
  it('reports the first Flask shadow once and suppresses fully shadowed file notes', async () => {
    await put('z/flask.py', ''); await put('a/flask.py', '');
    await put('main.py', flask + '\napp.route = other');
    await put('typed.py', flask.replace('<user_id>', '<int:user_id>'));
    const project = await scanProject(root, randomUUID());
    const result = await findProjectRoutes(root, project.id, project.files.toReversed());
    expect(result.notes).toEqual(['프로젝트 안에 flask라는 이름의 Python 모듈이 있어(a/flask.py), Flask 주소를 요청과 잇지 않았어요.']);
    await put('mixed.py', fastapi + '\nfrom flask import Flask\nother = Flask(__name__, host_matching=True)');
    expect((await find()).notes.filter(note => note.includes('실행 중에 이름'))).toEqual([
      'mixed.py: 실행 중에 이름·속성이나 주소 규칙을 바꿀 수 있는 코드가 있어, 이 파일의 Python 서버 주소는 요청과 잇지 않았어요.',
    ]);
  });
  it('preserves TS/JS route and request lists and ignores Flask test helpers', async () => {
    await put('server.ts', "@Controller('health') class Health { @Get() read() {} }");
    await put('web.ts', "fetch('/health'); fetch('/users/1');");
    for (const name of ['tests/test_api.py', 'test_main.py', 'conftest.py', 'test/helper.py', 'other_test.py', '__tests__/api.py']) await put(name, flask);
    await put('main.py', flask);
    const project = await scanProject(root, randomUUID());
    const before = await findProjectRoutes(root, project.id, project.files.filter(file => !file.relativePath.endsWith('.py')));
    const after = await findProjectRoutes(root, project.id, project.files);
    expect(after.routes.filter(route => route.framework !== 'flask')).toEqual(before.routes);
    expect(after.requests).toEqual(before.requests);
    expect(after.routes.filter(route => route.framework === 'flask')).toHaveLength(1);
  });
  it('keeps uncertainty reasons in the declared order', async () => {
    await put('users.py', 'from flask import Blueprint\nbp = Blueprint("users", __name__)\n@bp.route("/users/<int:id>")\n@bp.route("/users/<int:id>")\ndef h(): pass');
    await put('web.ts', 'fetch(`/api/${part}/1`, options);');
    expect((await find()).links[0].reasons).toEqual(['앞부분 모름', '경로 값 모름', '값 모양 모름', '방식 모름', '후보 여럿']);
  });
});
