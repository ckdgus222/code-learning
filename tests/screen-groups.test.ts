import { afterEach, expect, it, vi } from 'vitest';
import type { FeatureFlow, FlowNode, ProjectRoutes } from '../src/shared/contracts';
import type { FeatureGuide } from '../src/shared/ai';
import { fileUses, screenGroups } from '../src/renderer/screen-groups';
import { storyOf } from '../src/core/analysis/flow-story';
import * as stories from '../src/core/analysis/flow-story';

afterEach(() => vi.restoreAllMocks());

const node = (id: string, side: FlowNode['side'], screen: string | null = null): FlowNode => ({
  id, side, screen, depth: 0, name: id, fileId: id, fileHash: 'hash', relativePath: `${id}.tsx`,
  range: { startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1 }, event: null, control: null,
  asks: [], after: [], afterOmitted: 0, outside: [], outsideOmitted: 0, stores: [], storesOmitted: 0, stops: [], stopsOmitted: 0,
});
const flow: FeatureFlow = { projectId: 'p', routesId: 'r', routeIndex: 0, limited: false, notes: [],
  nodes: [node('b', 'front', '/b'), node('a', 'front', '/a'), node('send', 'front'), node('req', 'request'), node('back', 'back')],
  edges: [['a', 'send'], ['b', 'send'], ['send', 'req'], ['req', 'back']].map(([from, to]) => ({
    from, to, kind: 'calls', sure: from !== 'req', reasons: from === 'req' ? ['주소 추정'] : [], site: null,
  })),
};
const routes: ProjectRoutes = { projectId: 'p', routesId: 'r', prefix: null, requests: [], links: [], limited: false, notes: [],
  routes: Array.from({ length: 4 }, (_, i) => ({ method: 'POST', path: `/api/${i}`, framework: 'nest', prefix: 'known', basis: { text: 'Post', range: { fileId: 'back', fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'Post' } }, handler: {
    fileId: 'back', fileHash: 'hash', name: `Controller.save${i}`, startUtf16: 0, endUtf16: 1, startLine: 1,
  } })),
};
const guide: FeatureGuide = { summary: '', unknowns: [], groups: [{ name: 'AI 묶음', about: '', features: [{ name: '저장하기', about: '', routes: [0] }] }] };

it('keeps both shared-request screens with their own story ID and later inference, sorted by screen', () => {
  const grouped = screenGroups(routes, [flow], guide);
  expect(grouped.screens.map(group => group.screen)).toEqual(['/a', '/b']);
  for (const group of grouped.screens) {
    expect(group.rows).toHaveLength(1);
    const row = group.rows[0];
    const first = storyOf(flow, row.through)[0];
    expect(first.inferred).toBe(false);
    expect(first.nodes[0].screen).toBe(group.screen);
    expect(row).toMatchObject({ storyId: `req@${row.through}`, title: first.title, text: first.text,
      elsewhere: true, aiName: '저장하기', inferred: true, reasons: ['주소 추정'] });
    for (const word of [group.screen, 'post', '/api/0', 'controller.save0', '저장하기']) expect(row.haystack).toContain(word);
  }
});
it('uses the first story and first node for each screen and route and marks a single screen as unshared', () => {
  const graph = { ...flow, nodes: [...flow.nodes.map(item => item.screen ? { ...item, screen: '/same' } : item), node('req2', 'request')],
    edges: [...flow.edges, { ...flow.edges[2], to: 'req2' }] };
  const story = vi.spyOn(stories, 'storyOf');
  const groups = screenGroups(routes, [graph]);
  expect(story).toHaveBeenCalledTimes(1);
  expect(story).toHaveBeenCalledWith(graph, 'b');
  expect(groups.screens).toHaveLength(1);
  expect(groups.screens[0].rows).toMatchObject([{ through: 'b', storyId: 'req@b', elsewhere: false, aiName: null }]);
});
it('keeps front code, top-level fetch and unreachable screen code in noScreen, only servers in unlinked', () => {
  const flows = [
    { ...flow, nodes: [node('provider', 'front'), node('req', 'request')] },
    { ...flow, routeIndex: 1, nodes: [node('req', 'request')] },
    { ...flow, routeIndex: 2, nodes: [node('page', 'front', '/disconnected'), node('back', 'back')] },
    { ...flow, routeIndex: 3, nodes: [node('back', 'back')] },
  ].map(item => ({ ...item, edges: [] }));
  expect(screenGroups(routes, flows)).toEqual({ screens: [],
    noScreen: [0, 1, 2].map(routeIndex => ({ routeIndex, aiName: null, haystack: `post /api/${routeIndex} controller.save${routeIndex} ` })),
    unlinked: [{ routeIndex: 3, aiName: null, haystack: 'post /api/3 controller.save3 ' }],
  });
});

it('prepares AI names and searchable text for both unmatched groups', () => {
  const guide: FeatureGuide = { summary: '', unknowns: [], groups: [{ name: 'AI', about: '', features: [
    { name: '저장하기', about: '', routes: [0, 1] }, { name: '다시 저장', about: '', routes: [0] },
  ] }] };
  const groups = screenGroups(routes, [
    { ...flow, nodes: [node('req', 'request')], edges: [] },
    { ...flow, routeIndex: 1, nodes: [node('back', 'back')], edges: [] },
  ], guide);
  expect(groups.noScreen).toEqual([{ routeIndex: 0, aiName: '저장하기 · 다시 저장',
    haystack: 'post /api/0 controller.save0 저장하기 · 다시 저장' }]);
  expect(groups.unlinked).toEqual([{ routeIndex: 1, aiName: '저장하기', haystack: 'post /api/1 controller.save1 저장하기' }]);
});

it('continues to a later node on the same screen when the first has no story', () => {
  const graph = { ...flow, nodes: [node('unreachable', 'front', '/b'), ...flow.nodes] };
  const groups = screenGroups(routes, [graph]);
  expect(groups.screens.find(group => group.screen === '/b')?.rows).toMatchObject([{ through: 'b', storyId: 'req@b' }]);
  expect(groups.noScreen).toEqual([]);
});

it('finds front processing in both screens and takes inference from later steps', () => {
  expect(fileUses('send', 'hash', routes, [flow])).toEqual({ changed: false, uses: [
    { routeIndex: 0, screen: '/a', through: 'a', storyId: 'req@a', step: 1, label: '프론트 처리', nodeId: 'send', other: false, inferred: true, reasons: ['주소 추정'] },
    { routeIndex: 0, screen: '/b', through: 'b', storyId: 'req@b', step: 1, label: '프론트 처리', nodeId: 'send', other: false, inferred: true, reasons: ['주소 추정'] },
  ] });
});
it('finds a file used only by the second request from the same screen', () => {
  const graph: FeatureFlow = { ...flow, nodes: [...flow.nodes, node('second', 'front'), node('req2', 'request')],
    edges: [...flow.edges, ...[['a', 'second'], ['second', 'req2'], ['req2', 'back']].map(([from, to]) => ({
      from, to, kind: 'calls' as const, sure: true, reasons: [], site: null,
    }))] };
  expect(fileUses('second', 'hash', routes, [graph]).uses).toMatchObject([
    { screen: '/a', through: 'a', storyId: 'req2@a', step: 1, nodeId: 'second', other: false },
  ]);
});
it('uses all default stories only when no screen has a story, including inference', () => {
  const graph = { ...flow, nodes: flow.nodes.filter(node => node.screen === null), edges: flow.edges.slice(2) };
  expect(fileUses('send', 'hash', routes, [graph]).uses).toMatchObject([
    { screen: null, through: null, storyId: 'req', step: 0, label: '시작', inferred: true, reasons: ['주소 추정'] },
  ]);
  const server = { ...flow, nodes: [node('back', 'back')], edges: [] };
  expect(fileUses('back', 'hash', routes, [server]).uses).toMatchObject([
    { screen: null, through: null, storyId: 'server', step: 0, label: '서버 받는 곳' },
  ]);
  expect(fileUses('back', 'hash', routes, [{ ...server, nodes: [node('unreachable', 'front', '/lost'), ...server.nodes] }]).uses)
    .toEqual(fileUses('back', 'hash', routes, [server]).uses);
  const requests = { ...graph, nodes: [...graph.nodes, node('req2', 'request')] };
  expect(fileUses('req2', 'hash', routes, [requests]).uses).toMatchObject([{ storyId: 'req2', step: 0 }]);
});
it('marks other paths and prefers the first primary node when the file occurs more than once', () => {
  const graph = { ...flow, nodes: [node('alternate', 'front'), ...flow.nodes],
    edges: [...flow.edges, { ...flow.edges[2], from: 'alternate' }] };
  expect(fileUses('alternate', 'hash', routes, [graph]).uses).toMatchObject([
    { screen: '/a', step: 1, nodeId: 'alternate', other: true },
    { screen: '/b', step: 1, nodeId: 'alternate', other: true },
  ]);
  const shared = { ...graph, nodes: graph.nodes.map(node => ['alternate', 'send', 'req'].includes(node.id) ? { ...node, fileId: 'shared' } : node) };
  expect(fileUses('shared', 'hash', routes, [shared]).uses).toMatchObject([
    { nodeId: 'send', other: false, step: 1 }, { nodeId: 'send', other: false, step: 1 },
  ]);
});
it('omits changed rows while retaining current rows and reports changed nodes outside stories', () => {
  expect(fileUses('send', 'new', routes, [flow])).toEqual({ uses: [], changed: true });
  const current = { ...flow, routeIndex: 1, nodes: flow.nodes.map(node => node.id === 'send' ? { ...node, fileHash: 'new' } : node) };
  const mixed = fileUses('send', 'new', routes, [flow, current]);
  expect(mixed.changed).toBe(true);
  expect(mixed.uses.map(use => use.routeIndex)).toEqual([1, 1]);
  expect(fileUses('missing', 'hash', routes, [flow])).toEqual({ uses: [], changed: false });
  expect(fileUses('orphan', 'new', routes, [{ ...flow, nodes: [...flow.nodes, node('orphan', 'front')] }]))
    .toEqual({ uses: [], changed: true });
});
it('deduplicates the same screen and step using the first story and keeps more than twelve sorted uses for the view', () => {
  const graph = { ...flow, nodes: [...flow.nodes, node('req2', 'request')], edges: [...flow.edges, { ...flow.edges[2], to: 'req2' }] };
  expect(fileUses('send', 'hash', routes, [graph]).uses.map(use => use.storyId)).toEqual(['req@a', 'req@b']);
  const sameScreen = { ...graph, nodes: graph.nodes.map(node => node.screen ? { ...node, screen: '/same' } : node) };
  expect(fileUses('send', 'hash', routes, [sameScreen]).uses).toMatchObject([{ through: 'b', storyId: 'req@b' }]);
  expect(fileUses('send', 'hash', routes, [sameScreen]).uses).toHaveLength(1);
  const manyRoutes = { ...routes, routes: Array.from({ length: 7 }, () => routes.routes[0]) };
  const manyFlows = manyRoutes.routes.map((_, routeIndex) => ({ ...flow, routeIndex })).reverse();
  const uses = fileUses('send', 'hash', manyRoutes, manyFlows).uses;
  expect(uses.map(use => [use.routeIndex, use.screen])).toEqual(
    Array.from({ length: 7 }, (_, i) => [[i, '/a'], [i, '/b']]).flat());
});
it('does not offer navigation to a route absent from the current route list', () => {
  expect(fileUses('send', 'hash', { ...routes, routes: [] }, [flow])).toEqual({ uses: [], changed: false });
});
