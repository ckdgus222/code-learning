import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeatureOverview, FlowSteps, FlowStory } from '../src/renderer/feature-flow';
import type { FeatureFlow, FlowNode, ProjectRoutes, ProjectView } from '../src/shared/contracts';

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

it('renders numbered stories with collapsed details, uncertainty and function buttons only for functions', () => {
  const html = renderToStaticMarkup(React.createElement(FlowStory, { flow, locked: false, onCode() {}, onFunction() {} }));
  expect(html).toContain('화면 /dogs · onClick(버튼 등)을 눌러요');
  expect(html).toContain('훅이 돌려준 값 remove를 써요');
  expect(html).toContain('방식 모름');
  expect(html.match(/data-testid="story-step"/g)).toHaveLength(3);
  expect(html).not.toContain('<details open');
  const requestOnly = renderToStaticMarkup(React.createElement(FlowStory, {
    flow: { ...flow, nodes: [nodes[1]], edges: [] }, locked: false, onCode() {}, onFunction() {},
  }));
  expect(requestOnly).toContain('서버에 DELETE /dogs/${id} 요청을 보내요');
  expect(requestOnly).not.toContain('이 함수 흐름');
});
it('reports missing frontend and cycles, escapes names, and disables every story navigation button when locked', () => {
  const changed = { ...flow, nodes: [{ ...nodes[0], name: '<script>bad()</script>' }],
    edges: [{ from: 'back', to: 'back', kind: 'calls' as const, sure: true, reasons: [], site: null }] };
  const html = renderToStaticMarkup(React.createElement(FlowStory, { flow: changed, locked: true, onCode() {}, onFunction() {} }));
  expect(html).toContain('프론트 시작점은 찾지 못했어요');
  expect(html).toContain('서로 부르는 함수가 있어 여기서 멈췄어요');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
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
it('summarizes Next pages, routes, unique request counts, folders and the README introduction', () => {
  const html = renderToStaticMarkup(React.createElement(FeatureOverview, { project, routes }));
  expect(html).toContain('화면 1개');
  expect(html).toContain('서버 기능 2개');
  expect(html).toContain('프론트 요청 4개 · 서버와 이어짐 확실 1 · 추정 1 · 못 이음 2');
  expect(html).toContain('폴더 구성: api는 서버 · web는 화면·프론트');
  expect(html).toContain('첫 문단 그대로.');
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
