import { afterEach, expect, it, vi } from 'vitest';
import type { FeatureFlow, FlowNode, ProjectRoutes } from '../src/shared/contracts';
import type { FeatureGuide } from '../src/shared/ai';
import { screenGroups } from '../src/renderer/screen-groups';
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
