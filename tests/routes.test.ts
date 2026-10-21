import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { assertResultSize, findProjectRoutes, linkRoutes } from '../src/core/analysis/routes';
import { MAP_LIMITS } from '../src/core/analysis/project-map';

let root: string;
beforeEach(async () => { root = await mkdtemp('/private/tmp/learning-routes-'); });
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
    ['/dogs', 'elsewhere.test', 'known', null], ['/api/dogs', null, 'known', null],
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
