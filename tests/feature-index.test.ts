import { expect, it } from 'vitest';
import type { FeatureFlow, FlowNode, ProjectRoutes, Route } from '../src/shared/contracts';
import { featureIndex } from '../src/renderer/feature-index';
import { screenGroups } from '../src/renderer/screen-groups';

const site = { fileId: 'page', fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 5, endLine: 5, text: '<h1>목록</h1>' };
const node = (id: string, side: FlowNode['side'], extra: Partial<FlowNode> = {}): FlowNode => ({
  id, side, screen: null, depth: 0, name: id, fileId: id, fileHash: 'hash', relativePath: `${id}.tsx`,
  range: site, event: null, control: null, asks: [], after: [], afterOmitted: 0, outside: [], outsideOmitted: 0,
  stores: [], storesOmitted: 0, stops: [], stopsOmitted: 0, ...extra,
});
const route: Route = { method: 'DELETE', path: '/api/diaries/:id', framework: 'nest', prefix: 'known',
  basis: { text: 'Delete', range: site }, handler: { ...site, fileId: 'handler', name: 'Controller.remove' } };
const routes: ProjectRoutes = { projectId: 'p', routesId: 'r', prefix: null, routes: [route], requests: [], links: [], limited: false, notes: [] };
const flow: FeatureFlow = { projectId: 'p', routesId: 'r', routeIndex: 0, limited: false, notes: [], nodes: [
  node('b', 'front', { screen: '/b', screenTitle: { text: '목록', site } }),
  node('a', 'front', { screen: '/a', screenTitle: { text: '목록', site } }),
  node('event', 'front', { event: 'onClick', control: { tag: 'button', texts: ['삭제 중…', '삭제'] } }),
  node('req', 'request'), node('back', 'back'),
], edges: [['a', 'event'], ['b', 'event'], ['event', 'req'], ['req', 'back']].map(([from, to]) => ({
  from, to, kind: 'calls', sure: from !== 'req', reasons: from === 'req' ? ['주소 추정'] : [], site: null,
})) };
const pathOf = (id: string) => id === 'handler' ? 'api/diaries.controller.ts' : `web/${id}.tsx`;

it.each([
  ['nest', '/api/other', 'diaries'], ['next', '/api/diaries/:id', 'diaries'], ['express', '/api/diaries', 'diaries'],
  ['next', '/diaries', 'diaries'], ['express', '/diaries', 'diaries'], ['next', '/api', 'api'], ['express', null, '주소 모름'],
  ['next', '/', '주소 모름'],
] as const)('groups %s %s by its code name', (framework, path, key) => {
  expect(featureIndex({ ...routes, routes: [{ ...route, framework, path }] }, [flow], pathOf)[0].key).toBe(key);
});

it('prefers a shared screen title over button text for a view, retaining the first row and its inference', () => {
  const viewRoutes = { ...routes, routes: [{ ...route, method: 'GET' as const }] };
  const indexed = featureIndex(viewRoutes, [flow], pathOf)[0].features[0];
  expect(indexed).toMatchObject({ routeIndex: 0, name: '‘목록’ 화면 · 보기', basis: 'screen-title',
    screens: ['/a', '/b'], start: { through: 'a', storyId: 'req@a' }, linked: 'screen', inferred: true,
    reasons: ['주소 추정'], source: '화면 /a · web/page.tsx 5행' });
  const selected = screenGroups(viewRoutes, [flow]).screens.find(group => group.screen === '/a')!.rows[0];
  expect([indexed.inferred, indexed.reasons]).toEqual([selected.inferred, selected.reasons]);
});

it.each([
  ['다른 제목', '목록'], [null, '목록'], ['목록', null],
  [`${'가'.repeat(40)}하나`, `${'가'.repeat(40)}둘`],
])('requires every screen to have the same full title: %s / %s', (firstTitle, secondTitle) => {
  const viewRoutes = { ...routes, routes: [{ ...route, method: 'GET' as const }] };
  const graph = { ...flow, nodes: flow.nodes.map(node => {
    if (!node.screen) return node;
    const text = node.id === 'a' ? firstTitle : secondTitle;
    return { ...node, screenTitle: text === null ? null : { text, site } };
  }) };
  expect(featureIndex(viewRoutes, [graph], pathOf)[0].features[0]).toMatchObject({
    name: '‘삭제 중…’ 또는 ‘삭제’ 버튼 · 보기', basis: 'button', start: { through: 'a', storyId: 'req@a' },
  });
  const plain = { ...graph, nodes: graph.nodes.map(node => ({ ...node, control: null })) };
  expect(featureIndex(viewRoutes, [plain], pathOf)[0].features[0]).toMatchObject({
    name: '보기 · /api/diaries/:id', basis: 'address', start: { through: 'a', storyId: 'req@a' },
  });
});

it.each([40, 41, 80])('clips %s-character titles only in feature and group names for a single screen', length => {
  const text = '가'.repeat(length);
  const graph = { ...flow, nodes: flow.nodes.filter(node => node.id !== 'b').map(node => node.id === 'a'
    ? { ...node, screen: '/diaries', screenTitle: { text, site } } : node), edges: flow.edges.filter(edge => edge.from !== 'b') };
  const group = featureIndex({ ...routes, routes: [{ ...route, method: 'GET' as const }] }, [graph], pathOf)[0];
  const displayed = length > 40 ? `${'가'.repeat(40)}…` : text;
  expect(group.title).toEqual({ text: displayed, screen: '/diaries', relativePath: 'web/page.tsx', site });
  expect(group.features[0]).toMatchObject({ name: `‘${displayed}’ 화면 · 보기`, basis: 'screen-title',
    start: { through: 'a', storyId: 'req@a' } });
  expect(graph.nodes.find(node => node.id === 'a')?.screenTitle?.text).toBe(text);
});

it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'] as const)('prefers button text over a screen title for a %s action', method => {
  const indexed = featureIndex({ ...routes, routes: [{ ...route, method }] }, [flow], pathOf)[0].features[0];
  expect(indexed).toMatchObject({ basis: 'button', start: { through: 'a', storyId: 'req@a' }, source: '화면 /a · event.tsx event' });
  expect(indexed.name.startsWith('‘삭제 중…’ 또는 ‘삭제’ 버튼 · ')).toBe(true);
  const plain = { ...flow, nodes: flow.nodes.map(node => ({ ...node, control: null })) };
  expect(featureIndex({ ...routes, routes: [{ ...route, method }] }, [plain], pathOf)[0].features[0].basis).toBe('screen-title');
});

it('uses the first button row in screen order, then the address and first row when text is absent', () => {
  const untitled = { ...flow, nodes: flow.nodes.map(node => ({ ...node, screenTitle: null })) };
  expect(featureIndex(routes, [untitled], pathOf)[0].features[0]).toMatchObject({
    name: '‘삭제 중…’ 또는 ‘삭제’ 버튼 · 지우기', basis: 'button', start: { through: 'a', storyId: 'req@a' },
    source: '화면 /a · event.tsx event',
  });
  const unnamed = { ...untitled, nodes: untitled.nodes.map(node => ({ ...node, control: null })) };
  expect(featureIndex(routes, [unnamed], pathOf)[0].features[0]).toMatchObject({
    name: '지우기 · /api/diaries/:id', basis: 'address', start: { through: 'a', storyId: 'req@a' },
    source: '처리 함수 api/diaries.controller.ts Controller.remove',
  });
});

it.each(['a', 'Link'])('names %s text as a link', tag => {
  const graph = { ...flow, nodes: flow.nodes.map(node => ({ ...node, screenTitle: null,
    control: node.control ? { tag, texts: ['열기'] } : null })) };
  expect(featureIndex(routes, [graph], pathOf)[0].features[0].name).toBe('‘열기’ 링크 · 지우기');
});

it('takes button names and inference from a later named screen instead of the first unnamed screen', () => {
  const named = node('named', 'front', { event: 'onClick', control: { tag: 'button', texts: ['지우기'] } });
  const graph: FeatureFlow = { ...flow, nodes: [...flow.nodes.map(node => ({ ...node, screenTitle: null, control: null })), named],
    edges: [
      { from: 'a', to: 'event', kind: 'calls', sure: true, reasons: [], site: null },
      { from: 'b', to: 'named', kind: 'calls', sure: false, reasons: ['이 화면 연결 추정'], site: null },
      ...['named', 'event'].map(from => ({ from, to: 'req', kind: 'calls' as const, sure: true, reasons: [], site: null })),
      { from: 'req', to: 'back', kind: 'route', sure: true, reasons: [], site: null },
    ] };
  expect(featureIndex(routes, [graph], pathOf)[0].features[0]).toMatchObject({
    name: '‘지우기’ 버튼 · 지우기', basis: 'button', source: '화면 /b · named.tsx named',
    start: { through: 'b', storyId: 'req@b' }, inferred: true, reasons: ['이 화면 연결 추정'],
  });
});

it.each(['onSubmit', 'onChange'])('only uses submit text for onSubmit, including without screens: %s', event => {
  for (const hasScreens of [true, false]) {
    const graph = { ...flow, nodes: flow.nodes.filter(node => hasScreens || node.screen === null)
      .map(node => ({ ...node, screenTitle: null, event: node.event ? event : null,
        control: node.control ? { tag: 'form', texts: [], submits: ['로그인'] } : null })) };
    const indexed = featureIndex(routes, [graph], pathOf)[0].features[0];
    expect(indexed).toMatchObject({ basis: event === 'onSubmit' ? 'button' : 'address',
      name: event === 'onSubmit' ? '‘로그인’ 버튼 · 지우기' : '지우기 · /api/diaries/:id',
      start: { through: hasScreens ? 'a' : null, storyId: hasScreens ? 'req@a' : 'req' },
      inferred: true, reasons: ['주소 추정'], linked: hasScreens ? 'screen' : 'request-only' });
    if (event === 'onSubmit') expect(indexed.source).toBe(`${hasScreens ? '화면 /a · ' : ''}event.tsx event`);
  }
});

it('collects default story inference only from that story and uses no start for an unlinked server', () => {
  const graph: FeatureFlow = { ...flow, nodes: [...flow.nodes.filter(node => node.screen === null), node('req2', 'request')],
    edges: [...flow.edges, { from: 'req2', to: 'back', kind: 'route', sure: false, reasons: ['다른 이야기'], site: null }] };
  expect(featureIndex(routes, [graph], pathOf)[0].features[0]).toMatchObject({
    basis: 'button', inferred: true, reasons: ['주소 추정'], start: { through: null, storyId: 'req' },
  });
  const server = { ...flow, nodes: [node('back', 'back')], edges: [] };
  expect(featureIndex(routes, [server], pathOf)[0].features[0]).toMatchObject({
    basis: 'address', linked: 'none', start: null, inferred: false, reasons: [], screens: [],
  });
  expect(featureIndex(routes, [{ ...server, nodes: [node('req', 'request')] }], pathOf)[0].features[0])
    .toMatchObject({ linked: 'request-only', start: { through: null, storyId: 'req' } });
});

it('names groups only from the exact root screen, using the first occurrence', () => {
  const titled = (screen: string, text = '산책 일기') => ({ ...flow, nodes: [
    node('page', 'front', { screen, screenTitle: { text, site } }), ...flow.nodes,
  ] });
  expect(featureIndex(routes, [titled('/diaries/new')], pathOf)[0].title).toBeNull();
  expect(featureIndex({ ...routes, routes: [route, route] }, [titled('/diaries'), { ...titled('/diaries', '다른 제목'), routeIndex: 1 }], pathOf)
    [0].title).toEqual({ text: '산책 일기', screen: '/diaries', relativePath: 'web/page.tsx', site });
});

it('deduplicates features and screens, sorts keys and route indexes and includes searchable AI and code names', () => {
  const result = { ...routes, routes: [route, { ...route, framework: 'express' as const, path: '/api/auth' }, route] };
  const graph = { ...flow, nodes: [...flow.nodes, node('same', 'front', { screen: '/a' })],
    edges: [...flow.edges, { ...flow.edges[0], from: 'same' }] };
  const guide = { summary: '', unknowns: [], groups: [{ name: 'AI', about: '', features: [{ name: '기록 지우기', about: '', routes: [0] }] }] };
  const index = featureIndex(result, [{ ...graph, routeIndex: 2 }, graph, graph, { ...graph, routeIndex: 1 }], pathOf, guide);
  expect(index.map(group => group.key)).toEqual(['auth', 'diaries']);
  expect(index[1].features.map(feature => feature.routeIndex)).toEqual([0, 2]);
  expect(index[1].features[0].screens).toEqual(['/a', '/b']);
  expect(index[1].features[0].aiName).toBe('기록 지우기');
  for (const word of ['삭제', 'delete', '/api/diaries/:id', 'controller.remove', '/a', '/b', '기록 지우기', 'diaries']) {
    expect(index[1].features[0].haystack).toContain(word);
  }
});
