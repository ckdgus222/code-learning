import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeatureList, FeatureOverview, FlowSteps, FlowWalk, hasFlowCode, RoutesStatus, walkSelection } from '../src/renderer/feature-flow';
import type { Evidence, FeatureFlow, FlowNode, ProjectRoutes, ProjectView } from '../src/shared/contracts';

const nodes: FlowNode[] = [
  { id: 'back', side: 'back', depth: 0, name: 'Controller.remove' },
  { id: 'request', side: 'request', depth: 0, name: 'DELETE /dogs/${id}' },
  { id: 'event', side: 'front', depth: 1, name: 'onClick 함수', event: 'onClick' },
  { id: 'screen', side: 'front', depth: 2, name: 'DogsPage', screen: '/dogs' },
].map(node => ({ fileId: 'f', fileHash: 'h', relativePath: 'src/example.ts', range: { startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1 },
  event: null, screen: null, outside: [], outsideOmitted: 0, ...node } as FlowNode));
const flow: FeatureFlow = { projectId: 'p', routesId: 'r', routeIndex: 0, nodes, limited: false, notes: [], edges: [
  { from: 'screen', to: 'event', kind: 'inside', sure: true, reasons: [], site: null },
  { from: 'event', to: 'request', kind: 'hook', sure: false, reasons: ['훅이 돌려준 값 remove를 써요'], site: null },
  { from: 'request', to: 'back', kind: 'route', sure: false, reasons: ['방식 모름'], site: null },
] };
it('renders screen-to-server order, uncertainty, chips and navigation buttons', () => {
  const html = renderToStaticMarkup(React.createElement(FlowSteps, { flow, locked: false, onCode() {}, onFunction() {} }));
  const steps = [...html.matchAll(/<b>(.*?)<\/b>/g)].map(match => match[1]);
  expect(steps).toEqual(['DogsPage', 'onClick 함수', 'DELETE /dogs/${id}', 'Controller.remove']);
  expect(html).toContain('화면 주소 /dogs');
  expect(html).toContain('화면 이벤트 onClick');
  expect(html).toContain('훅이 돌려준 값 remove를 써요');
  expect(html).toContain('방식 모름');
  expect(html.match(/>추정<\/span>/g)).toHaveLength(2);
  expect(html.match(/>코드 보기<\/button>/g)).toHaveLength(4);
  expect(html.match(/>이 함수 흐름<\/button>/g)).toHaveLength(3);
});
it('escapes code text, reports omissions and disables navigation during reads', () => {
  const changed = { ...flow, limited: true, notes: ['한도'], nodes: nodes.map(node => node.side === 'back'
    ? { ...node, outside: ['<script>alert(1)</script>'], outsideOmitted: 3 } : node) };
  const html = renderToStaticMarkup(React.createElement(FlowSteps, { flow: changed, locked: true, onCode() {}, onFunction() {} }));
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('외 3개');
  expect(html).toContain('일부 흐름만 확인했어요.');
  expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});
it('shows backend-only flows even when no frontend request was found', () => {
  const html = renderToStaticMarkup(React.createElement(FlowSteps, { flow: { ...flow, nodes: [nodes[0]], edges: [] }, locked: false, onCode() {}, onFunction() {} }));
  expect(html).toContain('Controller.remove');
  expect(html.match(/data-testid="feature-step"/g)).toHaveLength(1);
});
it('highlights the selected node in each request group without marking other steps', () => {
  const shared = { ...flow, nodes: [...nodes, { ...nodes[1], id: 'request-2' }], edges: [...flow.edges,
    { ...flow.edges[1], to: 'request-2' }, { ...flow.edges[2], from: 'request-2' }] };
  const html = renderToStaticMarkup(React.createElement(FlowSteps, {
    flow: shared, locked: false, selectedNodeId: 'back', onCode() {}, onFunction() {},
  }));
  expect(html.match(/aria-current="step"/g)).toHaveLength(2);
  expect(html.match(/data-node-id="back" aria-current="step"/g)).toHaveLength(2);
});

const walkProps = {
  title: '삭제', codeName: '지우기 · /dogs', walk: { storyId: null, step: 0, nodeId: null },
  locked: false, stale: false, setStory() {}, setStep() {}, setNode() {}, onCode() {}, onFunction() {}, onChoose() {},
};
// In the app the hook works the selection out; here it is worked out the same way from the props.
const walkOf = (props: Omit<Parameters<typeof FlowWalk>[0], 'selection'>) =>
  React.createElement(FlowWalk, { ...props, selection: walkSelection(props.flow, props.walk) });
it('shows one of three steps, disables previous at the start, and marks the current numbered step', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow }));
  expect(html).toContain('화면 /dogs에서 onClick 동작이 일어나요');
  expect(html).toContain('훅이 돌려준 값 remove를 써요');
  expect(html.match(/data-testid="story-step"/g)).toHaveLength(1);
  expect(html).toContain('1 / 3');
  expect(html).toMatch(/disabled="">◀ 이전/);
  expect(html).toMatch(/<button class="btn">다음 ▶/);
  expect(html.match(/>[①②③]<\/button>/g)).toHaveLength(3);
  expect(html).toContain('aria-current="step">①');
  expect(html).not.toContain('<details open');
  const requestStep = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { ...walkProps.walk, step: 1 } }));
  expect(requestStep).toContain('방식 모름');
  expect(requestStep).not.toContain('이 함수 안 순서');
  const requestOnly = renderToStaticMarkup(walkOf({ ...walkProps, flow: { ...flow, nodes: [nodes[1]], edges: [] } }));
  expect(requestOnly).toContain('DELETE /dogs/${id} 요청을 보내요');
  expect(requestOnly).not.toContain('이 함수 안 순서');
  expect(requestOnly).toMatch(/disabled="">◀ 이전/);
  expect(requestOnly).toMatch(/disabled="">다음 ▶/);
});
it('reports missing frontend and cycles, escapes names, and disables every story navigation button when locked', () => {
  const changed = { ...flow, nodes: [{ ...nodes[0], name: '<script>bad()</script>' }],
    edges: [{ from: 'back', to: 'back', kind: 'calls' as const, sure: true, reasons: [], site: null }] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, locked: true }));
  expect(html).toContain('프론트 시작점은 찾지 못했어요');
  expect(html).toContain('서로 부르는 함수가 있어 여기서 멈췄어요');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});
it('chooses between requests and folds other callers into the same story', () => {
  const changed = { ...flow, nodes: [...nodes, { ...nodes[1], id: 'request-2' }, { ...nodes[2], id: 'other', name: 'otherCaller', depth: 0 }],
    edges: [...flow.edges, { ...flow.edges[1], to: 'request-2' }, { ...flow.edges[1], from: 'other' }] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed }));
  expect(html).toContain('aria-label="요청 고르기"');
  expect(html.match(/행 · DELETE/g)).toHaveLength(2);
  expect(html).toContain('<summary>다른 곳에서도 불러요</summary>');
  expect(html).toContain('otherCaller');
});
it('shows the selected function and disables next on the last step', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { storyId: 'request', step: 0, nodeId: 'screen' } }));
  expect(html).toMatch(/aria-pressed="true">DogsPage/);
  const last = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { ...walkProps.walk, step: 2 } }));
  expect(last).toMatch(/disabled="">다음 ▶/);
  const stale = renderToStaticMarkup(walkOf({ ...walkProps, flow, stale: true }));
  expect(stale).toMatch(/disabled="">다음 ▶/);
});
it('shows a failure with an enabled retry and escapes the message', () => {
  const state = { finding: false, error: '<failed>', stale: false, find() {}, cancelFind() {} } as unknown as Parameters<typeof RoutesStatus>[0]['state'];
  const html = renderToStaticMarkup(React.createElement(RoutesStatus, { state, retry() {} }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('&lt;failed&gt;');
  expect(html).toContain('>다시 시도</button>');
  expect(html).not.toContain('disabled');
});
it('shows code only for an exactly matching file, hash and evidence range', () => {
  const node = nodes[0];
  const source = { fileId: node.fileId, hash: node.fileHash };
  const evidence: Evidence = { id: 'e', projectId: 'p', fileId: node.fileId, fileHash: node.fileHash, ...node.range };
  expect(hasFlowCode(source, evidence, node)).toBe(true);
  expect(hasFlowCode(null, evidence, node)).toBe(false);
  expect(hasFlowCode(source, null, node)).toBe(false);
  expect(hasFlowCode({ ...source, fileId: 'other' }, evidence, node)).toBe(false);
  expect(hasFlowCode({ ...source, hash: 'other' }, evidence, node)).toBe(false);
  for (const field of ['fileId', 'fileHash', 'startUtf16', 'endUtf16', 'startLine', 'endLine'] as const) {
    expect(hasFlowCode(source, { ...evidence, [field]: typeof evidence[field] === 'number' ? Number(evidence[field]) + 1 : 'other' }, node)).toBe(false);
  }
});
const project = {
  files: [
    { id: 'server', relativePath: 'api/dogs.controller.ts' },
    { id: 'client', relativePath: 'web/request.ts' },
    { id: 'config', relativePath: 'web/next.config.ts' },
    { id: 'page', relativePath: 'web/app/dogs/page.tsx' },
    { id: 'layout', relativePath: 'web/app/layout.tsx' },
    { id: 'not-next', relativePath: 'other/app/page.tsx' },
  ],
  // The overview already keeps only the README's first prose paragraph (overview.ts readIntro).
  overview: { intro: { text: '첫 문단 그대로.' } },
} as ProjectView;
const routes = {
  routes: [{ handler: { fileId: 'server' } }, { handler: { fileId: 'server' } }],
  requests: Array.from({ length: 4 }, () => ({ fileId: 'client' })),
  links: [
    { requestIndex: 0, routeIndex: 0, sure: true },
    { requestIndex: 0, routeIndex: 1, sure: false },
    { requestIndex: 1, routeIndex: 0, sure: false },
    { requestIndex: 1, routeIndex: 1, sure: false },
  ],
} as ProjectRoutes;
it('summarizes Next pages, routes, unique request counts and folders, leaving the README introduction to its own card', () => {
  const html = renderToStaticMarkup(React.createElement(FeatureOverview, { project, routes }));
  expect(html).toContain('화면 1개');
  expect(html).toContain('서버 기능 2개');
  expect(html).toContain('프론트 요청 4개 · 서버와 이어짐 확실 1 · 추정 1 · 못 이음 2');
  expect(html).toContain('폴더 구성: api는 서버 · web는 화면·프론트');
  expect(html).not.toContain('첫 문단 그대로.');
});
it('omits screen counts for non-Next projects and folder roles when shared or unknown', () => {
  const nonNext = { ...project, files: project.files.filter(file => file.id !== 'config') };
  const shared = { ...routes, requests: [{ ...routes.requests[0], fileId: 'server' }], links: [] };
  const html = renderToStaticMarkup(React.createElement(FeatureOverview, { project: nonNext, routes: shared }));
  expect(html).not.toContain('화면 0개');
  expect(html).not.toContain('폴더 구성:');
  const noRoutes = renderToStaticMarkup(React.createElement(FeatureOverview, { project, routes: { ...routes, routes: [], links: [] } }));
  expect(noRoutes).not.toContain('폴더 구성:');
  expect(noRoutes).toContain('못 이음 4');
});

it('places the AI summary above the factual overview, with the AI card inside it', () => {
  const guide = { summary: '<script>요약</script>', groups: [], unknowns: [] };
  const html = renderToStaticMarkup(React.createElement(FeatureOverview, { project, routes, guide }, React.createElement('button', null, 'AI 카드')));
  expect(html).toContain('AI 정리'); expect(html).toContain('&lt;script&gt;요약&lt;/script&gt;');
  expect(html.indexOf('요약')).toBeLessThan(html.indexOf('서버 기능'));
  expect(html).toContain('AI 카드');
});

it('provides a follow button per feature and disables every route action when locked', () => {
  const groups = [{ name: 'dogs', about: '', features: [
    { name: '삭제', about: '삭제 요청', routes: [0, 1], ai: false, sure: 1, inferred: 0, haystack: '삭제' },
    { name: '조회', about: '', routes: [1], ai: false, sure: 0, inferred: 1, haystack: '조회' },
  ] }];
  const html = renderToStaticMarkup(React.createElement(FeatureList, { groups, routes, selected: 0, disabled: true, search: '', setSearch() {}, onFollow() {} }));
  expect(html.match(/>이 기능 따라가기<\/button>/g)).toHaveLength(2);
  expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});
