import { expect, it } from 'vitest';
import type { FeatureFlow, FlowEdge, FlowNode, FlowStop, FlowStore, Route, ValueSite } from '../src/shared/contracts';
import { codeNameOf, groupNameOf, storyOf } from '../src/core/analysis/flow-story';

function node(id: string, side: FlowNode['side'], depth = 0, extra: Partial<FlowNode> = {}): FlowNode {
  return { id, side, depth, name: id, fileId: id, fileHash: 'hash', relativePath: `${id}.ts`,
    range: { startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 2 }, event: null, screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0, ...extra };
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
    '화면 /dogs에서 onClick 동작이 일어나요',
    'removeDog → useDeleteDog → mutationFn 순서로 이어져요',
    'DELETE /api/dogs/${id} 요청을 보내요',
    'DogsController.remove가 요청을 받아요 → DogsService.remove에 넘겨요',
    'DogsService.remove',
  ]);
  expect(steps.map(step => step.representative)).toEqual([event, mutation, request, handler, service]);
  expect(steps[1]).toMatchObject({ inferred: true, reasons: ['훅 결과를 써요'] });
  expect(steps[3].typed).toBe(true);
  expect(steps[4].outside.items).toEqual(['tx.dog.delete']);
  expect(storyOf(example)).toEqual(steps);
});
it('starts at the request when fetch has no enclosing function', () => {
  expect(storyOf(flow([request, handler], [edge(request.id, handler.id)] )).map(step => step.kind)).toEqual(['request', 'handler']);
});
it('omits front processing when the screen sends a request directly', () => {
  const steps = storyOf(flow([screen, request, handler], [edge(screen.id, request.id), edge(request.id, handler.id)]));
  expect(steps.map(step => step.kind)).toEqual(['screen', 'request', 'handler']);
  expect(steps[0].representative).toEqual(screen);
  expect(steps[0].text).toBe('화면 /dogs에서 시작해요');
});
it('uses the file and function when there is no screen, without inventing an event', () => {
  const steps = storyOf(flow([mutation, request, handler], [edge(mutation.id, request.id)]));
  expect(steps[0].text).toBe('mutationFn.ts · mutationFn에서 시작해요');
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
  expect(steps[1].text).toBe('');
  expect(steps[1].outside.items).toEqual(['a', 'b', 'c', 'd']);
  expect(steps[1].outside.omitted).toBe(1);
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

const site = (fileId: string, startUtf16: number): ValueSite => ({ fileId, fileHash: 'hash', startUtf16,
  endUtf16: startUtf16 + 1, startLine: 1, endLine: 1, text: 'code' });
const stop = (fileId: string, start: number): FlowStop => ({ kind: 'Error', message: null, condition: null, site: site(fileId, start) });
const store = (fileId: string, start: number, action: FlowStore['action']): FlowStore => ({ model: action === 'raw' ? null : 'dog', action, site: site(fileId, start) });

it('keeps handler and service errors and omitted counts on their own steps', () => {
  const receiving = { ...handler, stops: Array.from({ length: 6 }, (_, i) => stop('handler', i)), stopsOmitted: 2 };
  const processing = { ...service, stops: [stop('service', 0)] };
  const steps = storyOf(flow([receiving, processing]));
  expect(steps[0].stops.items).toHaveLength(6);
  expect(steps[0].stops.omitted).toBe(2);
  expect(steps[1].stops.items).toEqual([{ ...processing.stops[0], nodeId: service.id }]);
  expect(steps[1].stops.omitted).toBe(0);
  expect(steps[0].stops.items.every(stop => stop.nodeId === handler.id)).toBe(true);
});

it('adds storage after backend processing, sorts calls and merges only adjacent equal labels', () => {
  const processing = { ...service, stores: [store('service', 4, 'delete'), store('service', 2, 'read'),
    store('service', 1, 'read'), store('service', 5, 'read')], storesOmitted: 3 };
  const steps = storyOf(flow([handler, processing]));
  expect(steps.map(step => step.kind)).toEqual(['handler', 'back', 'store']);
  expect(steps[2]).toMatchObject({ title: '저장소(DB)를 써요', label: '저장소',
    text: 'DogsService.remove: dog 읽기 → dog 지우기 → dog 읽기', representative: processing, nodes: [processing],
    storeGroups: { groups: [{ node: processing }], omitted: 3 }, stops: { items: [], omitted: 0 } });
  expect(steps[2].storeGroups.groups[0].items.map(store => store.site.startUtf16)).toEqual([1, 2, 4, 5]);
});

it('keeps parent deletion and helper reading in separate groups ordered by depth then flow order', () => {
  const parent = { ...service, stores: [store('parent', 1, 'delete')] };
  const helper = node('helper', 'back', 2, { stores: [store('helper', 1, 'read')] });
  const sibling = node('sibling', 'back', 2, { stores: [store('sibling', 1, 'upsert')] });
  const step = storyOf(flow([handler, helper, sibling, parent], [edge(parent.id, helper.id, { kind: 'typed', sure: false, reasons: ['근거'] })])).at(-1)!;
  expect(step.text).toBe('DogsService.remove: dog 지우기 · helper: dog 읽기 · sibling: dog 없으면 새로 저장하고 있으면 바꾸기');
  expect(step.storeGroups.groups.map(group => group.node)).toEqual([parent, helper, sibling]);
  expect(step.nodes).toEqual([parent, helper, sibling]);
  expect(step).toMatchObject({ inferred: true, reasons: ['근거'], typed: true });
});

it('keeps same-named functions separate by node id and adds storage directly after a handler', () => {
  const receiving = { ...handler, name: 'save', stores: [store('a', 2, 'raw')] };
  const single = storyOf(flow([receiving]));
  expect(single.map(step => step.kind)).toEqual(['handler', 'store']);
  expect(single[1].text).toBe('save: SQL 직접 실행');
  const processing = { ...service, name: 'save', stores: [store('b', 1, 'create')] };
  const last = storyOf(flow([receiving, processing])).at(-1)!;
  expect(last.text).toBe('save: SQL 직접 실행 · save: dog 새로 저장하기');
  expect(last.storeGroups.groups.map(group => group.node.id)).toEqual([handler.id, service.id]);
  expect(last.storeGroups.groups).toHaveLength(2);
});

it('keeps omitted counts with their lists and bounds outside text', () => {
  const receiving = { ...handler, outside: ['x'.repeat(60)], outsideOmitted: 2,
    stops: [stop('handler', 1)], stopsOmitted: 5, stores: [store('handler', 2, 'read')], storesOmitted: 2 };
  const processing = { ...service, outside: ['a', 'b', 'c', 'd'], outsideOmitted: 3,
    stops: [stop('service', 1)], stopsOmitted: 1, stores: [store('service', 2, 'delete')], storesOmitted: 4 };
  const steps = storyOf(flow([receiving, processing]));
  expect(steps[0].stops.omitted).toBe(5);
  expect(steps[1].stops.omitted).toBe(1);
  expect(steps[1].outside.items).toEqual([`${'x'.repeat(48)}…`, 'a', 'b', 'c']);
  expect(steps[1].outside.omitted).toBe(6);
  expect(steps[2].storeGroups.omitted).toBe(6);
  expect(steps.filter(step => step.kind !== 'store').every(step => !step.storeGroups.groups.length && step.storeGroups.omitted === 0)).toBe(true);
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
  expect(steps[0].text).toBe('화면 /dogs에서 onClick 동작이 일어나요');
  expect(steps[1].text).toBe('removeDog → useDeleteDog → mutationFn 순서로 이어져요');
});

it.each(['onClick', 'onMouseEnter'])('uses the actual %s event without claiming a button press', eventName => {
  const changed = { ...example, nodes: example.nodes.map(item => item.id === event.id ? { ...item, event: eventName } : item) };
  const first = storyOf(changed)[0];
  expect(first.title).toBe('화면 동작에서 시작해요');
  expect(first.title).not.toMatch(/누르|버튼/);
  expect(first.text).toBe(`화면 /dogs에서 ${eventName} 동작이 일어나요`);
  const withoutScreen = storyOf({ ...changed, nodes: changed.nodes.map(item => ({ ...item, screen: null })) })[0];
  expect(withoutScreen.text).toBe(`DogsPage.ts · DogsPage에서 ${eventName} 동작이 일어나요`);
});
it('uses factual titles and preserves category labels for each kind', () => {
  const steps = storyOf(example);
  expect(steps.map(step => step.title)).toEqual(['화면 동작에서 시작해요', '화면 쪽 코드가 요청을 준비해요', '서버에 요청을 보내요', '서버가 요청을 받아요', '서버가 일을 처리해요']);
  expect(steps.map(step => step.label)).toEqual(['화면', '프론트 처리', '요청', '서버 받는 곳', '서버 처리']);
  const noEvent = storyOf(flow([screen, request], [edge(screen.id, request.id)]))[0];
  expect(noEvent.title).toBe('화면에서 시작해요');
  const noScreen = storyOf(flow([mutation, request], [edge(mutation.id, request.id)]))[0];
  expect(noScreen.title).toBe('이 함수에서 시작해요');
  expect(noScreen.text).not.toContain('화면');
  const singleFront = storyOf(flow([event, mutation, request], [edge(event.id, mutation.id), edge(mutation.id, request.id)]))[1];
  expect(singleFront.text).toBe('mutationFn가 요청을 준비해요');
});
