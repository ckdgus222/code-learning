import { expect, it } from 'vitest';
import type { FeatureFlow, FlowEdge, FlowNode, Route } from '../src/shared/contracts';
import { codeNameOf, groupNameOf, storyOf } from '../src/core/analysis/flow-story';

function node(id: string, side: FlowNode['side'], depth = 0, extra: Partial<FlowNode> = {}): FlowNode {
  return { id, side, depth, name: id, fileId: id, fileHash: 'hash', relativePath: `${id}.ts`,
    range: { startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 2 }, event: null, screen: null, outside: [], outsideOmitted: 0, ...extra };
}
function edge(from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge {
  return { from, to, kind: 'calls', sure: true, reasons: [], site: null, ...extra };
}
function flow(nodes: FlowNode[], edges: FlowEdge[] = []): FeatureFlow {
  return { projectId: 'p', routesId: 'r', routeIndex: 0, nodes, edges, limited: false, notes: [] };
}
const screen = node('DogsPage', 'front', 5, { screen: '/dogs' });
const event = node('onClick 함수', 'front', 4, { event: 'onClick' });
const remove = node('removeDog', 'front', 3);
const hook = node('useDeleteDog', 'front', 2);
const mutation = node('mutationFn', 'front', 1);
const request = node('DELETE /api/dogs/${id}', 'request');
const handler = node('DogsController.remove', 'back');
const service = node('DogsService.remove', 'back', 1, { outside: ['tx.dog.delete'] });
const example = flow([handler, service, request, mutation, hook, remove, event, screen], [
  edge(screen.id, event.id), edge(event.id, remove.id),
  edge(remove.id, hook.id, { kind: 'hook', sure: false, reasons: ['훅 결과를 써요'] }),
  edge(hook.id, mutation.id), edge(mutation.id, request.id), edge(request.id, handler.id, { kind: 'route' }),
  edge(handler.id, service.id, { kind: 'typed' }),
]);

it('turns a dog-walk shaped graph into five readable steps and exact code targets', () => {
  const steps = storyOf(example);
  expect(steps.map(step => step.text)).toEqual([
    '화면 /dogs · onClick(버튼 등)을 눌러요',
    'removeDog → useDeleteDog → mutationFn',
    '서버에 DELETE /api/dogs/${id} 요청을 보내요',
    'DogsController.remove가 요청을 받아요 → DogsService.remove에 넘겨요',
    'DogsService.remove · 바깥 호출: tx.dog.delete',
  ]);
  expect(steps.map(step => step.representative)).toEqual([event, mutation, request, handler, service]);
  expect(steps[1]).toMatchObject({ inferred: true, reasons: ['훅 결과를 써요'] });
  expect(steps[3].typed).toBe(true);
  expect(storyOf(example)).toEqual(steps);
});
it('starts at the request when fetch has no enclosing function', () => {
  expect(storyOf(flow([request, handler], [edge(request.id, handler.id)] )).map(step => step.kind)).toEqual(['request', 'handler']);
});
it('omits front processing when the screen sends a request directly', () => {
  const steps = storyOf(flow([screen, request, handler], [edge(screen.id, request.id), edge(request.id, handler.id)]));
  expect(steps.map(step => step.kind)).toEqual(['screen', 'request', 'handler']);
  expect(steps[0].representative).toEqual(screen);
  expect(steps[0].text).toBe('화면 /dogs');
});
it('uses the file and function when there is no screen, without inventing an event', () => {
  const steps = storyOf(flow([mutation, request, handler], [edge(mutation.id, request.id)]));
  expect(steps[0].text).toBe('시작: mutationFn.ts · mutationFn');
  expect(steps[0].text).not.toContain('눌러요');
});
it('starts at the handler without any requests and includes a service without outside calls', () => {
  expect(storyOf(flow([handler])).map(step => step.kind)).toEqual(['handler']);
  const steps = storyOf(flow([handler, { ...service, outside: [] }], [edge(handler.id, service.id)]));
  expect(steps.map(step => step.kind)).toEqual(['handler', 'back']);
  expect(steps[1].text).toBe(service.name);
  expect(steps[1].representative).toEqual({ ...service, outside: [] });
});
it('shows up to four outside calls, including the handler, and uses the handler if there is no service', () => {
  const withCalls = { ...handler, outside: ['a', 'b', 'c', 'd', 'e'] };
  const steps = storyOf(flow([withCalls]));
  expect(steps[1].text).toBe('바깥 호출: a · b · c · d …');
  expect(steps[1].representative).toEqual(withCalls);
});
it('makes one independent story for every request', () => {
  const second = { ...request, id: 'second' };
  const steps = storyOf({ ...example, nodes: [...example.nodes, second], edges: [...example.edges,
    edge(mutation.id, second.id), edge(second.id, handler.id)] });
  expect(steps).toHaveLength(10);
  expect(steps.slice(0, 5).every(step => step.storyId === request.id)).toBe(true);
  expect(steps.slice(5).every(step => step.storyId === second.id)).toBe(true);
});
it('chooses larger depth, then a sure arrow, then creation order; other callers stay in details', () => {
  const a = node('a', 'front', 2);
  const b = node('b', 'front', 3);
  const graph = flow([request, a, b], [edge(a.id, request.id), edge(b.id, request.id, { sure: false, reasons: ['추정 근거'] })]);
  expect(storyOf(graph)[0]).toMatchObject({ representative: b, others: [a], inferred: true, reasons: ['추정 근거'] });
  const tied = { ...graph, nodes: [request, a, { ...b, depth: 2 }] };
  expect(storyOf(tied)[0].representative).toEqual(a);
  const bothSure = { ...tied, edges: [edge(b.id, request.id), edge(a.id, request.id)] };
  expect(storyOf(bothSure)[0].representative.id).toBe('b');
});
it.each(['self', 'mutual'] as const)('stops a %s frontend cycle, keeps unique nodes and explains the stop', kind => {
  const a = node('a', 'front', 2);
  const b = node('b', 'front', 3);
  const graph = flow([a, b, request, handler], [edge(a.id, request.id),
    ...(kind === 'self' ? [edge(a.id, a.id)] : [edge(b.id, a.id), edge(a.id, b.id)])]);
  const steps = storyOf(graph);
  expect(steps.length).toBeLessThanOrEqual(5);
  expect(steps.some(step => step.stopped)).toBe(true);
  const fronts = steps.flatMap(step => step.nodes).filter(node => node.side === 'front');
  expect(new Set(fronts.map(node => node.id)).size).toBe(fronts.length);
});
it.each(['self', 'mutual'] as const)('also reports a %s backend cycle', kind => {
  const steps = storyOf(flow([handler, service], [edge(handler.id, service.id),
    kind === 'self' ? edge(service.id, service.id) : edge(service.id, handler.id)]));
  expect(steps).toHaveLength(2);
  expect(steps.find(step => step.kind === 'back')?.stopped).toBe(true);
});
it('does not mistake shared callers for a cycle and keeps them out of unrelated stories', () => {
  const a = node('a', 'front', 3);
  const b = node('b', 'front', 2);
  const c = node('c', 'front', 2);
  const unrelated = node('unrelated', 'front', 9);
  const steps = storyOf(flow([a, b, c, request, unrelated], [edge(a.id, b.id), edge(a.id, c.id), edge(b.id, request.id), edge(c.id, request.id)]));
  expect(steps.every(step => !step.stopped)).toBe(true);
  expect(steps.flatMap(step => step.others)).toEqual([c]);
});
it('keeps route uncertainty on the request step', () => {
  expect(storyOf(flow([request, handler], [edge(request.id, handler.id, { sure: false, reasons: ['방식 모름'] })]))[0])
    .toMatchObject({ kind: 'request', inferred: true, reasons: ['방식 모름'] });
});

const route: Route = { method: 'GET', path: '/api/dogs/:id', prefix: 'known', framework: 'nest',
  handler: { fileId: 'f', fileHash: 'h', name: 'DogsController.remove', ...handler.range },
  basis: { text: 'decorator', range: { fileId: 'f', fileHash: 'h', text: '', ...handler.range } } };
it.each([
  ['GET', '보기'], ['POST', '만들기·보내기'], ['PUT', '바꾸기'], ['PATCH', '고치기'], ['DELETE', '지우기'], ['ALL', '받기'],
] as const)('gives %s a code-based name', (method, name) => {
  expect(codeNameOf({ ...route, method })).toBe(`${name} · /api/dogs/:id`);
});
it('names file groups and first path segments without guessing unknown paths', () => {
  expect(groupNameOf(route, 'api/dogs.controller.ts')).toBe('dogs');
  expect(groupNameOf(route, 'api/auth.route.js')).toBe('auth');
  expect(groupNameOf(route, 'api/auth.routes.ts')).toBe('auth');
  expect(groupNameOf(route, 'api/dogs.ts')).toBe('dogs');
  expect(groupNameOf({ ...route, framework: 'next' }, 'web/app/api/dogs/route.ts')).toBe('api');
  expect(groupNameOf({ ...route, framework: 'express', path: '/dogs/:id' }, 'server.ts')).toBe('dogs');
  expect(groupNameOf({ ...route, framework: 'next', path: null }, 'route.ts')).toBe('주소 모름');
  expect(codeNameOf({ ...route, path: null })).toBe('보기 · 주소 모름');
});

it('follows the click path even when a deeper component only sets the hook up', () => {
  // The real dog-walk shape: DogList calls useDeleteDog directly and is deeper than the click path.
  const list = node('DogList', 'front', 6);
  const page = node('DogsPage', 'front', 7, { screen: '/dogs' });
  const mapped = node('map에 넘긴 함수', 'front', 5);
  const click = node('onClick 함수', 'front', 4, { event: 'onClick' });
  const real = flow([handler, request, mutation, hook, remove, click, mapped, list, page], [
    edge(page.id, list.id, { kind: 'placed' }), edge(list.id, hook.id), edge(list.id, mapped.id, { kind: 'inside' }),
    edge(mapped.id, click.id, { kind: 'inside' }), edge(click.id, remove.id, { kind: 'event' }),
    edge(remove.id, hook.id, { kind: 'hook', sure: false, reasons: ['훅 결과를 써요'] }),
    edge(hook.id, mutation.id), edge(mutation.id, request.id), edge(request.id, handler.id, { kind: 'route' }),
  ]);
  const steps = storyOf(real);
  expect(steps[0].text).toBe('화면 /dogs · onClick(버튼 등)을 눌러요');
  expect(steps[1].text).toBe('removeDog → useDeleteDog → mutationFn');
});
