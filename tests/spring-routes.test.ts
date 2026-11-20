import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { springRoutes } from '../src/core/analysis/spring-routes';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findProjectRoutes, linkRoutes, ROUTE_LIMITS } from '../src/core/analysis/routes';
import { buildFeatureFlow, buildFeatureFlows } from '../src/core/analysis/feature-flow';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { scanProject } from '../src/core/project/files';

const web = 'org.springframework.web.bind.annotation';
const imports = `import ${web}.*;\n`;
const file = { id: 'java', relativePath: 'server/OrderController.java', size: 0 };
const handler = '@GetMapping("/orders/{id}")\npublic String get() {\n  return helper();\n}\nString helper() { return "ok"; }';
const controller = (body = handler, annotation = '@RestController') => `${annotation}\nclass OrderController {\n${body}\n}`;
const find = (text = imports + controller(), shadows: string[] = [], nodes = 100_000, routes = 1000) =>
  springRoutes(file, text, 'hash', nodes, routes, new Set(shadows));

describe('Spring MVC declarations', () => {
  it('keeps analyzer handler ranges and the whole mapping range with its first line as text, in UTF-16', () => {
    const text = '// 한글 😀\n' + imports + controller('@GetMapping(\n path = "/orders/{id}"\n)\npublic String get() { return "ok"; }');
    const result = find(text);
    const symbol = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: 'hash' }).symbols[0];
    expect(result).toMatchObject({ complete: true, cut: false, skipped: 0, shadowed: false });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ framework: 'spring', method: 'GET', path: '/orders/{id}', prefix: 'unknown',
      segments: [{ text: 'orders' }, { param: 'id' }], handler: { name: symbol.name, fileId: file.id, fileHash: 'hash',
        startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16, startLine: symbol.evidence.startLine } });
    const { basis } = result.routes[0];
    // Like the other frameworks, the shown text is the first line; the range still covers the whole annotation.
    expect(basis.text).toBe('@GetMapping( …');
    expect(text.slice(basis.range.startUtf16, basis.range.endUtf16)).toBe('@GetMapping(\n path = "/orders/{id}"\n)');
    expect(basis.range.endLine - basis.range.startLine).toBe(2);
  });

  it.each(['Get', 'Post', 'Put', 'Patch', 'Delete'])('reads @%sMapping', method => {
    expect(find(imports + controller(`@${method}Mapping("orders") void run() {}`)).routes[0])
      .toMatchObject({ method: method.toUpperCase(), path: '/orders' });
  });

  it.each([
    [`import ${web}.RestController; import ${web}.GetMapping;`, '@RestController', '@GetMapping', 1],
    [imports, '@RestController', '@GetMapping', 1],
    ['', `@${web}.RestController`, `@${web}.GetMapping`, 1],
    [`import org.springframework.stereotype.Controller; import ${web}.GetMapping;`, '@Controller', '@GetMapping', 1],
    [`import org.springframework.stereotype.*; ${imports}`, '@Controller', '@GetMapping', 1],
    ['', '@RestController', '@GetMapping', 0],
    [imports + 'import other.GetMapping;', '@RestController', '@GetMapping', 0],
    [imports + 'import other.RestController;', '@RestController', '@GetMapping', 0],
    [imports, '@Controller', '@GetMapping', 0],
    [imports, '@RestController', '@other.GetMapping', 0],
    [`import ${web}.RestController; import other.GetMapping;`, '@RestController', '@GetMapping', 0],
    [`import ${web}.RestController; import static ${web}.GetMapping;`, '@RestController', '@GetMapping', 0],
  ])('requires the Spring annotation import: %s %s %s', (source, owner, mapping, count) => {
    expect(find(source + controller(`${mapping}("/orders") void run() {}`, owner)).routes).toHaveLength(count);
  });

  it.each(['@interface GetMapping {}', 'class GetMapping {}', 'class Other { interface GetMapping {} }',
    'enum GetMapping { A }', 'record GetMapping(int x) {}'])('rejects same-file shadowing, including later declarations: %s', declaration => {
    expect(find(imports + controller() + declaration)).toMatchObject({ routes: [], shadowed: true });
  });

  it.each(['GetMapping', 'RestController'])('rejects a project type named %s and keeps fully qualified annotations', name => {
    expect(find(imports + controller(), [name])).toMatchObject({ routes: [], shadowed: true });
    const text = controller(`@${web}.GetMapping("/orders") void run() {}`, `@${web}.RestController`);
    expect(find(text, [name]).routes).toHaveLength(1);
    expect(find(imports + controller(), [name.toLowerCase()]).routes).toHaveLength(1);
  });

  it('recognizes nested concrete controllers but not interfaces, abstract classes, constructors or anonymous methods', () => {
    const text = imports + `
      @RestController interface Contract { @GetMapping("/interface") default void run() {} }
      @RestController abstract class Base { @GetMapping("/abstract") void run() {} }
      class Outer { @RestController class Inner { @GetMapping("/inner") void run() {} } }
      @RestController class Concrete {
        @GetMapping("/constructor") Concrete() {}
        @GetMapping("/bodyless") native void missing();
        Object inner = new Object() { @GetMapping("/anonymous") void run() {} };
        @GetMapping("/concrete") void run() {}
      }
      class Plain { @GetMapping("/plain") void run() {} }
    `;
    expect(find(text).routes.map(route => [route.path, route.handler.name])).toEqual([
      ['/inner', 'Inner.run'], ['/concrete', 'Concrete.run'],
    ]);
  });

  it('omits erroneous methods while retaining valid methods and reports a partial parse', () => {
    const result = find(imports + controller('@GetMapping("/bad") void bad() { return +; } @GetMapping("/good") void good() {}'));
    expect(result.complete).toBe(false);
    expect(result.routes.map(route => route.path)).toEqual(['/good']);
  });
});

describe('Spring paths and HTTP methods', () => {
  it('expands all class paths, method paths and method unions', () => {
    const result = find(imports + controller('@RequestMapping(path={"", "/{id}"}, method={RequestMethod.POST, RequestMethod.PUT}) void run() {}',
      '@RestController @RequestMapping(value={"/orders/", "v1/orders"}, method=RequestMethod.GET)'));
    expect(result.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /orders', 'POST /orders', 'PUT /orders', 'GET /orders/{id}', 'POST /orders/{id}', 'PUT /orders/{id}',
      'GET /v1/orders', 'POST /v1/orders', 'PUT /v1/orders', 'GET /v1/orders/{id}', 'POST /v1/orders/{id}', 'PUT /v1/orders/{id}',
    ]);
  });

  it.each([
    ['', '@RequestMapping', ['ALL']],
    ['method=RequestMethod.GET', '@RequestMapping', ['GET']],
    ['method=RequestMethod.GET', '@PostMapping', ['GET', 'POST']],
    ['method=RequestMethod.GET', '@GetMapping', ['GET']],
    ['', '@RequestMapping(method={RequestMethod.POST, RequestMethod.DELETE})', ['POST', 'DELETE']],
    ['', '@RequestMapping(method={RequestMethod.HEAD, RequestMethod.GET, RequestMethod.OPTIONS})', ['GET']],
    ['', '@RequestMapping(method=RequestMethod.TRACE)', []],
    ['', '@RequestMapping(method=RequestMethod.HEAD)', []],
    ['', '@RequestMapping(method=RequestMethod.OPTIONS)', []],
    ['', '@RequestMapping(method={})', ['ALL']],
  ])('combines method restrictions: %s / %s', (base, method, expected) => {
    const result = find(imports + controller(`${method} void run() {}`, `@RestController @RequestMapping(path="/orders"${base ? ', ' + base : ''})`));
    expect(result.routes.map(route => route.method)).toEqual(expected);
    expect(result.routes.every(route => route.path === '/orders')).toBe(true);
  });

  it.each(['"/orders"', 'value="/orders"', 'path="/orders"', '{"/orders"}', 'path={"/orders"}'])('reads literal path %s', argument => {
    expect(find(imports + controller(`@GetMapping(${argument}) void run() {}`)).routes[0].path).toBe('/orders');
  });

  it.each(['@GetMapping', '@GetMapping()', '@GetMapping("")', '@GetMapping({})'])('keeps the root for %s', mapping => {
    expect(find(imports + controller(`${mapping} void run() {}`)).routes[0]).toMatchObject({ path: '/', segments: [] });
  });

  it('reads a doubled backslash in a regex constraint', () => {
    expect(find(imports + controller('@GetMapping("/orders/{id:\\\\d+}") void run() {}')).routes[0])
      .toMatchObject({ path: '/orders/{id:\\d+}', typed: true });
  });

  it.each(['"/ord\\u0065rs"', '"/ord\\145rs"', '"/ord\\sers"'])('leaves other Java string escapes unread in %s', written => {
    const result = find(imports + controller(`@GetMapping(${written}) void run() {}`));
    expect(result.skipped).toBe(1);
    expect(result.routes[0]).toMatchObject({ path: null, unmatched: true });
  });

  it('reports the existing Java grammar error for a repeated-u Unicode escape', () => {
    expect(find(imports + controller('@GetMapping("/ord\\uu0065rs") void run() {}')))
      .toMatchObject({ complete: false, routes: [] });
  });

  it('preserves known HTTP methods when a path cannot be read', () => {
    const result = find(imports + controller('@PostMapping(PATH) void run() {}', '@RestController @RequestMapping(method=RequestMethod.GET)'));
    expect(result.skipped).toBe(1);
    expect(result.routes.map(route => [route.method, route.path, route.unmatched])).toEqual([
      ['GET', null, true], ['POST', null, true],
    ]);
  });

  it.each(['PATH', '"/orders" + SUFFIX', 'path={"/orders", OTHER}', 'path="""\n/orders\n"""', 'path="/orders", value="/other"',
    'path="/orders", method=VERB'])('does not link unreadable path or method: %s', argument => {
    const result = find(imports + controller(`@RequestMapping(${argument}) void run() {}`, '@RestController @RequestMapping("/base")'));
    expect(result).toMatchObject({ skipped: 1, routes: [{ path: null, unmatched: true }] });
    expect(result.routes).toHaveLength(1);
  });

  it('does not fall back to a method path when the class path or method is unreadable', () => {
    for (const base of ['@RequestMapping(BASE)', '@RequestMapping(method=VERB)']) {
      expect(find(imports + controller(handler, '@RestController ' + base)))
        .toMatchObject({ skipped: 1, routes: [{ path: null, unmatched: true }] });
    }
  });

  it('requires a genuine RequestMethod name, even if the mapping itself is qualified', () => {
    for (const extra of ['import other.RequestMethod;', 'class RequestMethod {}']) {
      expect(find(imports + extra + controller('@RequestMapping(path="/orders", method=RequestMethod.GET) void run() {}')).routes[0])
        .toMatchObject({ unmatched: true });
    }
    expect(find(imports + controller('@RequestMapping(path="/orders", method=RequestMethod.GET) void run() {}'), ['RequestMethod']))
      .toMatchObject({ shadowed: true, routes: [{ unmatched: true }] });
    expect(find(imports + controller(`@RequestMapping(path="/orders", method=${web}.RequestMethod.GET) void run() {}`), ['RequestMethod']).routes[0])
      .toMatchObject({ method: 'GET', path: '/orders' });
  });

  it('lists multiple mapping annotations only once without a matchable path', () => {
    const result = find(imports + controller('@GetMapping("/orders") @PostMapping("/orders") void run() {}'));
    expect(result).toMatchObject({ skipped: 1, routes: [{ path: null, unmatched: true }] });
    expect(result.routes).toHaveLength(1);
  });

  it.each(['/orders/*', '/orders/**', '/orders/{*rest}', '/orders/a{id}', '/orders/{id}.json'])('does not match wildcard or mixed segment %s', route => {
    const found = find(imports + controller(`@GetMapping("${route}") void run() {}`)).routes[0];
    expect(found).toMatchObject({ path: route, unmatched: true });
    expect(found.segments).toBeUndefined();
  });

  it('marks constrained variables as typed, preserving regex quantifier braces', () => {
    const found = find(imports + controller('@GetMapping("/orders/{id:[0-9]{1,3}}") void run() {}')).routes[0];
    expect(found).toMatchObject({ typed: true, segments: [{ text: 'orders' }, { param: 'id' }] });
    expect(found.unmatched).toBeUndefined();
  });

  it('does not interpret out-of-scope request conditions', () => {
    expect(find(imports + controller('@GetMapping(path="/orders", params="id", headers="X-A", consumes="text/plain", produces="text/plain") void run() {}')).routes[0])
      .toMatchObject({ method: 'GET', path: '/orders' });
  });

  it('bounds nodes, route multiplication and path length', () => {
    expect(find(undefined, [], 2)).toMatchObject({ complete: false, routes: [] });
    expect(find(undefined, [], 100_000, 0)).toMatchObject({ cut: true, routes: [] });
    const text = imports + controller('@GetMapping({"/a", "/b", "/c"}) void run() {}', '@RestController @RequestMapping({"/one", "/two"})');
    const result = find(text, [], 100_000, 4);
    expect(result.cut).toBe(true);
    expect(result.routes.map(route => route.path)).toEqual(['/one/a', '/one/b', '/one/c', '/two/a']);
    expect(find(imports + controller(`@GetMapping("/${'x'.repeat(ROUTE_LIMITS.pathLength)}") void run() {}`)))
      .toMatchObject({ skipped: 1, routes: [{ path: null, unmatched: true }] });
  });

  it('does not emit routes before checking type shadows beyond the node limit', () => {
    expect(find(imports + controller() + 'class GetMapping {}', [], 25)).toMatchObject({ complete: false, routes: [] });
  });
});

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function project(entries: Record<string, string>) {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-spring-')));
  for (const [name, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return (await scanProject(root, 'p')).files;
}

describe('Spring project requests and feature flows', () => {
  it('links fetch and axios requests with an unknown prefix and stops at the Java handler', async () => {
    const text = '// 한글 😀\n' + imports + controller();
    const files = await project({ 'web/api.ts': `import axios from 'axios';
      export function load() { return fetch('/orders/1'); }
      export function prefixed() { return axios.get('/api/orders/2/'); }`, [file.relativePath]: text });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.routes).toHaveLength(1);
    expect(routes.links).toHaveLength(2);
    expect(routes.links.every(link => !link.sure && link.reasons.includes('앞부분 모름'))).toBe(true);
    expect(routes.notes.some(note => note.startsWith('Spring 주소의 앞부분을 확인하지 못해 추정으로 표시했어요.'))).toBe(true);
    const flow = await buildFeatureFlow(root, 'p', files, routes, 0);
    expect(flow.nodes.filter(node => node.side === 'back').map(node => node.name)).toEqual(['OrderController.get']);
    expect(flow.nodes.filter(node => node.side === 'request')).toHaveLength(2);
    expect(flow.nodes.filter(node => node.side === 'front').map(node => node.name)).toEqual(['load', 'prefixed']);
    expect(flow.edges.filter(edge => edge.kind === 'route').every(edge => !edge.sure)).toBe(true);
    expect(flow.notes.filter(note => note === 'Java 처리 함수 안에서 부르는 함수는 아직 따라가지 않아요.')).toHaveLength(1);
    const back = flow.nodes.find(node => node.side === 'back')!;
    expect(back.range).toMatchObject({ startLine: 5, endLine: 8 });
    expect(text.slice(back.range.startUtf16, back.range.endUtf16)).toBe(handler.slice(0, handler.indexOf('\nString helper')));
    expect(await buildFeatureFlows(root, 'p', files, routes)).toHaveLength(1);
    await writeFile(path.join(root, file.relativePath), text + '\n// changed');
    await expect(buildFeatureFlow(root, 'p', files, routes, 0)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('does not link POST to a class-only GET restriction, unreadable paths or ambiguous methods', async () => {
    const files = await project({ 'web/api.ts': "fetch('/orders', {method: 'POST'}); fetch('/orders'); fetch('/bad');",
      'OrderController.java': imports + controller('@RequestMapping void run() {}', '@RestController @RequestMapping(path="/orders", method=RequestMethod.GET)'),
      'BadController.java': imports + controller('@GetMapping(PATH) void bad() {} @GetMapping("/bad") @PostMapping("/bad") void ambiguous() {}'),
    });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.links).toHaveLength(1);
    expect(routes.requests[routes.links[0].requestIndex].methods).toEqual(['GET']);
    expect(routes.notes).toContain('Spring 매핑 2개는 경로를 글자로 읽지 못해(상수·연결식 등) 요청과 잇지 않았어요.');
  });

  it('keeps root and parameter-only paths in the list without matching requests', async () => {
    const files = await project({ 'web/api.ts': "fetch('/'); fetch('/1'); fetch('/orders/1');",
      'OrderController.java': imports + controller('@GetMapping({"", "/{id}"}) void run() {}') });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.routes).toHaveLength(2);
    expect(routes.links).toEqual([]);
    expect(routes.notes.some(note => note.includes('맞춰 볼 근거가 없어'))).toBe(true);
  });

  it('does not link wildcard paths and treats regex paths as guesses', async () => {
    const files = await project({ 'web/api.ts': "fetch('/orders/1');", 'OrderController.java': imports + controller(
      '@GetMapping("/orders/**") void wildcard() {} @GetMapping("/orders/{id:[0-9]+}") void typed() {}') });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.links).toHaveLength(1);
    expect(routes.routes[routes.links[0].routeIndex].handler.name).toBe('OrderController.typed');
    expect(routes.links[0].sure).toBe(false);
    expect(linkRoutes(routes.routes, routes.requests)).toEqual(routes.links);
  });

  it('excludes Java test paths and sorts production Java files', async () => {
    const entries = Object.fromEntries(['z/Z.java', 'a/A.JAVA', 'Latest.java', 'src/test/java/C.java', 'module/src/test/java/C.java',
      'OrderTest.java', 'OrderTests.java', 'OrderIT.java', '__tests__/C.java', 'Order.test.java'].map(name => [name, imports + controller()]));
    const files = await project(entries);
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.routes.map(route => files.find(file => file.id === route.handler.fileId)!.relativePath)).toEqual(['a/A.JAVA', 'Latest.java', 'z/Z.java']);
  });

  it('uses the project file list to block same-name types without reading their declarations', async () => {
    const files = await project({ 'server/OrderController.java': 'package api;\n' + imports + controller(),
      'server/GetMapping.java': 'package api; public @interface GetMapping {}',
      'other/Qualified.java': controller(`@${web}.GetMapping("/qualified") void run() {}`, `@${web}.RestController`) });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.routes.map(route => route.path)).toEqual(['/qualified']);
    expect(routes.notes).toContain('프로젝트 안에 Spring과 같은 이름의 타입(GetMapping 등)이 있어, 그 이름으로 적은 매핑은 주소로 보지 않았어요.');
  });

  it.each(['files', 'bytes', 'nodesPerFile'] as const)('shares the existing %s budget', async budget => {
    const files = await project({ 'a.ts': 'export const value = 1;', 'OrderController.java': imports + controller() });
    const routes = await findProjectRoutes(root, 'p', files, { ...MAP_LIMITS, [budget]: budget === 'files' ? 1 : 2 });
    expect(routes.limited).toBe(true);
    expect(routes.routes).toEqual([]);
    expect(routes.notes.some(note => note.includes('Java') || note.includes('OrderController.java'))).toBe(true);
  });

  it('shares the route cap and reports skipped combinations', async () => {
    const paths = Array.from({ length: 33 }, (_, index) => `"/p${index}"`).join(',');
    const files = await project({ 'OrderController.java': imports + controller(`@GetMapping({${paths}}) void run() {}`,
      `@RestController @RequestMapping({${paths}})`) });
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.routes).toHaveLength(ROUTE_LIMITS.routes);
    expect(routes.limited).toBe(true);
    expect(routes.notes.some(note => note.includes('주소·요청·연결이 너무 많아'))).toBe(true);
  });

  it('reports partial syntax and read failures and honors cancellation', async () => {
    const files = await project({ 'Broken.java': imports + controller('@GetMapping("/bad") void bad() { return +; }'),
      'Missing.java': imports + controller() });
    await rm(path.join(root, 'Missing.java'));
    const routes = await findProjectRoutes(root, 'p', files);
    expect(routes.limited).toBe(true);
    expect(routes.notes).toContain('Broken.java: 일부만 확인했어요.');
    expect(routes.notes.some(note => note.startsWith('Missing.java:'))).toBe(true);
    await expect(findProjectRoutes(root, 'p', files, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
