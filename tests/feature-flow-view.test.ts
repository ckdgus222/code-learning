import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { expect, it, vi } from 'vitest';
import * as ReactHooks from 'react';
import { edgeLabel, FlowBoxNode, FlowDiagram, SIDE_HANDLE_TOP, pickNode, evidenceView, FeatureChooser, featureGroups, FeatureList, FeatureOverview, recommendedFeature, FlowLimits, FlowSteps, FlowWalk, hasFlowCode, hintSteps, stepQuestion, summaryKey, RoutesStatus, useFeatureFlows, walkSelection } from '../src/renderer/feature-flow';
import type { FlowEdge, SourceView, Evidence, FeatureFlow, FlowNode, ProjectRoutes, ProjectView } from '../src/shared/contracts';
import { Snippet } from '../src/renderer/flow';
import { storyOf } from '../src/core/analysis/flow-story';
import type { FeatureGuide } from '../src/shared/ai';
import * as indexes from '../src/renderer/feature-index';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, ReactFlow: vi.fn((props: React.ComponentProps<typeof actual.ReactFlow>) => React.createElement(actual.ReactFlow, props)) };
});

const nodes: FlowNode[] = [
  { id: 'back', side: 'back', depth: 0, name: 'Controller.remove' },
  { id: 'request', side: 'request', depth: 0, name: 'DELETE /dogs/${id}' },
  { id: 'event', side: 'front', depth: 1, name: 'onClick 함수', event: 'onClick' },
  { id: 'screen', side: 'front', depth: 2, name: 'DogsPage', screen: '/dogs' },
].map(node => ({ fileId: 'f', fileHash: 'h', relativePath: 'src/example.ts', range: { startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1 },
  event: null, control: null, asks: [], after: [], afterOmitted: 0, screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0, ...node } as FlowNode));
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
  title: '삭제', codeName: '지우기 · /dogs', walk: { through: null, storyId: null, step: 0, nodeId: null, site: null },
  summary: ['', '', ''] as [string, string, string], setSummary() {}, async readCode() { return null; },
  locked: false, stale: false, setStory() {}, setStep() {}, setNode() {}, onSite() {}, onCode() {}, onFunction() {}, onChoose() {}, onAsk() {},
};
// In the app the hook works the selection out; here it is worked out the same way from the props.
const walkOf = (props: Omit<Parameters<typeof FlowWalk>[0], 'selection'>) =>
  React.createElement(FlowWalk, { ...props, selection: walkSelection(props.flow, props.walk) });

const fullStoryFlow: FeatureFlow = { ...flow, nodes: [
  ...nodes,
  { ...nodes[2], id: 'prepare', name: 'prepare', event: null, after: [{ when: 'success', action: 'call', target: 'done',
    site: { fileId: 'f', fileHash: 'h', ...nodes[2].range, text: 'done()' } }] },
  { ...nodes[0], id: 'service', depth: 1, stores: [{ model: 'dog', action: 'delete', basis: 'shape',
    site: { fileId: 'f', fileHash: 'h', ...nodes[0].range, text: 'db.dog.delete()' } }] },
], edges: [flow.edges[0], { ...flow.edges[1], to: 'prepare' }, { ...flow.edges[1], from: 'prepare' }, flow.edges[2],
  { ...flow.edges[0], from: 'back', to: 'service', kind: 'calls' }] };

it.each([
  [0, '화면', '화면 쪽'], [1, '프론트 처리', '화면 쪽'], [2, '요청', '부탁(요청)이 가는 중'],
  [3, '서버 받는 곳', '서버 쪽'], [4, '서버 처리', '서버 쪽'], [5, '저장소', '저장소(DB)'], [6, '화면 결과', '화면 쪽'],
])('marks the current location and names step %s', (index, label, location) => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: fullStoryFlow, walk: { ...walkProps.walk, step: index as number } }));
  const picture = html.match(/<ol[^>]*aria-label="지금 여기">(.*?)<\/ol>/)![1];
  const current = picture.match(/<li[^>]*aria-current="location"[^>]*>(.*?)<\/li>/g)!;
  expect(current).toHaveLength(1);
  expect(current[0]).toContain(location);
  expect(current[0]).toContain(index === 2 ? 'class="picture__arrow"' : 'class="picture__box"');
  expect(html).toContain(`aria-label="${Number(index) + 1}단계 ${label}"`);
  expect(html).toContain(`지금 여기: 삭제 기능의 ${Number(index) + 1}번째 단계 · ${label}`);
  expect(picture).toContain('<span class="tag tag--unknown">추정 연결</span> 방식 모름');
  expect(picture.match(/<[^>]+aria-hidden="true"[^>]*>.*?<\/[^>]+>/g)).toEqual([
    '<span aria-hidden="true">→</span>', '<span aria-hidden="true">→</span>',
  ]);
  if (index === 6) expect(html).toContain('응답이 돌아와 화면 쪽으로 다시 왔어요');
});

it('draws only the locations found in the story', () => {
  const server = renderToStaticMarkup(walkOf({ ...walkProps, flow: { ...flow, nodes: [nodes[0]], edges: [] } }));
  const picture = server.match(/<ol[^>]*aria-label="지금 여기">(.*?)<\/ol>/)![1];
  expect(picture.match(/<li /g)).toHaveLength(1);
  expect(picture).toContain('서버 쪽');
  expect(picture).not.toMatch(/화면 쪽|요청을 보내는 코드|picture__arrow|저장소/);
  const requestOnly = renderToStaticMarkup(walkOf({ ...walkProps, flow: { ...flow, nodes: [nodes[1]], edges: [] } }));
  const requestPicture = requestOnly.match(/<ol[^>]*aria-label="지금 여기">(.*?)<\/ol>/)![1];
  expect(requestPicture).toContain('요청을 보내는 코드');
  expect(requestPicture).not.toMatch(/<b>서버 쪽|저장소/);
});

it('uses code wording throughout the navigation and location without screen or event evidence', () => {
  const changed = { ...fullStoryFlow, nodes: fullStoryFlow.nodes.map(node => ({ ...node, screen: null, event: null })) };
  const steps = storyOf(changed);
  for (const index of [0, 1, steps.length - 1]) {
    const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: index } }));
    expect(html.match(/<nav.*?<\/nav>/)![0]).not.toContain('화면');
    expect(html.match(/<ol[^>]*aria-label="지금 여기">.*?<\/ol>/)![0]).not.toContain('화면');
    expect(html.match(/<p>지금 여기:.*?<\/p>/)![0]).not.toContain('화면');
    expect(html).toContain('요청을 보내는 코드');
    if (index === steps.length - 1) expect(html).toContain('요청 뒤 처리 코드를 보고 있어요');
  }
});

it('shows the summary only at the end, with bounded named inputs and a completed sentence', () => {
  const first = renderToStaticMarkup(walkOf({ ...walkProps, flow }));
  expect(first).not.toContain('aria-label="한 문장으로 정리"');
  const last = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { ...walkProps.walk, step: 2 }, summary: ['요청', '조건', '결과'] }));
  expect(last.indexOf('aria-label="한 문장으로 정리"')).toBeGreaterThan(last.indexOf('</article>'));
  expect(last).toContain('내 말로 적어 보는 칸이에요. 맞는지 채점하지 않아요. 이 프로젝트를 닫으면 사라져요.');
  for (const [label, value] of [['받는 것', '요청'], ['확인하는 것', '조건'], ['돌려주는 것', '결과']]) {
    expect(last).toContain(`<input aria-label="${label}" maxLength="120" value="${value}"/>`);
  }
  expect(last).not.toContain('placeholder=');
  expect(last).toContain('<p data-testid="summary-sentence">이 기능은 요청을(를) 받아서, 조건을(를) 확인하고, 결과을(를) 돌려줘요.</p>');
  expect(last).toContain('<h3 tabindex="-1">서버가 요청을 받아요</h3>');
});

it.each([['', '', ''], ['요청', '조건', ''], ['요청', ' ', '결과']])('omits the completed sentence for incomplete values %j', (takes, checks, returns) => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { ...walkProps.walk, step: 2 }, summary: [takes, checks, returns] }));
  expect(html).not.toContain('data-testid="summary-sentence"');
});

it.each([{ locked: true }, { stale: true }])('disables summary hints but keeps notes editable for %o', status => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, ...status, flow, walk: { ...walkProps.walk, step: 2 } }));
  const hints = html.match(/<button[^>]*>힌트 단계 보기<\/button>/g)!;
  expect(hints).toHaveLength(3);
  expect(hints.every(button => button.includes('disabled=""'))).toBe(true);
  expect(html.match(/<input[^>]*>/g)!.every(input => !/disabled|readonly/.test(input))).toBe(true);
});

it('omits hint buttons when the story has no check or return step', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: { ...flow, nodes: [nodes[1]], edges: [] } }));
  expect(html.match(/>힌트 단계 보기<\/button>/g)).toHaveLength(1);
});

it('chooses hints in priority order and counts omitted alternatives', () => {
  const steps = storyOf(fullStoryFlow);
  expect(hintSteps(steps)).toEqual({ takes: 2, checks: 4, returns: 6 });
  const alternatives = steps.map((step, index) => index === 0 ? { ...step, asks: { items: [], omitted: 1 } } : step);
  expect(hintSteps(alternatives).checks).toBe(0);
  expect(hintSteps(steps.map((step, index) => index === 1 ? { ...step, stops: { items: [], omitted: 1 } } : step)).checks).toBe(1);
  expect(hintSteps(steps.filter(step => step.kind !== 'result')).returns).toBe(5);
  expect(hintSteps(steps.filter(step => !['store', 'result'].includes(step.kind))).returns).toBe(4);
  expect(hintSteps([steps[3]])).toEqual({ takes: 0, checks: 0, returns: 0 });
  expect(hintSteps([steps[0]])).toEqual({ takes: 0, checks: null, returns: null });
  expect(hintSteps([])).toEqual({ takes: null, checks: null, returns: null });
  const confirmation = { message: null, nodeId: 'event', site: { fileId: 'f', fileHash: 'h', ...nodes[2].range, text: 'confirm()' } };
  expect(hintSteps(steps.map((step, index) => index === 0 ? { ...step, asks: { items: [confirmation], omitted: 0 } } : step)).checks).toBe(0);
});

it('keys summaries by code name and source locations, independent of discovery identifiers', () => {
  const key = summaryKey(walkProps.codeName, nodes[0], nodes[1]);
  expect(key).toBe('지우기 · /dogs|src/example.ts:0|src/example.ts:0');
  const foundAgain = { ...flow, routesId: 'new-routes', routeIndex: 20,
    nodes: nodes.map(node => ({ ...node, id: `new-${node.id}`, fileId: 'new-file' })) };
  expect(summaryKey(walkProps.codeName, foundAgain.nodes[0], foundAgain.nodes[1])).toBe(key);
  expect(summaryKey(walkProps.codeName, nodes[0], { ...nodes[1], range: { ...nodes[1].range, startUtf16: 20 } })).not.toBe(key);
  const serverKey = summaryKey(walkProps.codeName, nodes[0], null);
  expect(serverKey).toBe('지우기 · /dogs|src/example.ts:0|server');
  expect(serverKey).not.toBe(key);
  expect(summaryKey(walkProps.codeName, { ...nodes[0], relativePath: 'other.ts' }, null)).not.toBe(serverKey);
  expect(summaryKey(walkProps.codeName, { ...nodes[0], range: { ...nodes[0].range, startUtf16: 20 } }, null)).not.toBe(serverKey);
  expect(summaryKey('지우기 · /pets', nodes[0], null)).not.toBe(serverKey);
});
it('shows one of three steps, disables previous at the start, and marks the current numbered step', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow }));
  expect(html).toContain('화면 /dogs에서 onClick 동작이 일어나요');
  expect(html).toContain('훅이 돌려준 값 remove를 써요');
  expect(html.match(/data-testid="story-step"/g)).toHaveLength(1);
  expect(html).toContain('1 / 3');
  expect(html).toMatch(/disabled="">◀ 이전/);
  expect(html).toMatch(/<button class="btn">다음 ▶/);
  expect(html.match(/>[①②③] [^<]+<\/button>/g)).toHaveLength(3);
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
  expect(html.match(/<button[^>]*>/g)!.filter(button => !button.includes('react-flow__controls-button')).every(button => button.includes('disabled=""'))).toBe(true);
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
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { through: null, storyId: 'request', step: 0, nodeId: 'screen', site: null } }));
  expect(html).toMatch(/aria-pressed="true">DogsPage/);
  const last = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { ...walkProps.walk, step: 2 } }));
  expect(last).toMatch(/disabled="">다음 ▶/);
  const stale = renderToStaticMarkup(walkOf({ ...walkProps, flow, stale: true }));
  expect(stale).toMatch(/disabled="">다음 ▶/);
});
it.each([false, true])('shows the selected function location only while the story is current (stale=%s)', stale => {
  for (const nodeId of ['screen', 'event']) {
    const node = nodes.find(node => node.id === nodeId)!;
    const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, stale,
      walk: { ...walkProps.walk, storyId: 'request', nodeId } }));
    expect(html).toContain('data-testid="story-step"');
    expect(html.includes('data-testid="story-function-location"')).toBe(!stale);
    const location = `${node.name} · ${node.relativePath} ${node.range.startLine}–${node.range.endLine}행`;
    expect(html.includes(location)).toBe(!stale);
  }
});
it('omits the function location when the story has no current node', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: { ...flow, nodes: [], edges: [] } }));
  expect(html).not.toContain('data-testid="story-function-location"');
});
it('shows a failure with an enabled retry and escapes the message', () => {
  const state = { finding: false, error: '<failed>', stale: false, find() {}, cancelFind() {} } as unknown as Parameters<typeof RoutesStatus>[0]['state'];
  const html = renderToStaticMarkup(React.createElement(RoutesStatus, { state, retry() {} }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('&lt;failed&gt;');
  expect(html).toContain('>다시 시도</button>');
  expect(html).not.toContain('disabled');
});
it('shows code only for the exact node range, file and hash', () => {
  const node = { ...nodes[0], range: { startUtf16: 10, endUtf16: 100, startLine: 2, endLine: 10 } };
  const source = { fileId: node.fileId, hash: node.fileHash };
  const evidence: Evidence = { id: 'e', projectId: 'p', fileId: node.fileId, fileHash: node.fileHash, ...node.range };
  expect(hasFlowCode(source, evidence, node)).toBe(true);
  expect(hasFlowCode(null, evidence, node)).toBe(false);
  expect(hasFlowCode(source, null, node)).toBe(false);
  expect(hasFlowCode({ ...source, fileId: 'other' }, evidence, node)).toBe(false);
  expect(hasFlowCode({ ...source, hash: 'other' }, evidence, node)).toBe(false);
  expect(hasFlowCode(source, { ...evidence, startUtf16: 20, endUtf16: 50, startLine: 3, endLine: 5 }, node)).toBe(false);
  for (const change of [{ fileId: 'other' }, { fileHash: 'other' }, { startUtf16: 9 }, { endUtf16: 101 },
    { startLine: 1 }, { endLine: 11 }, { startUtf16: 11 }, { endUtf16: 99 }, { startLine: 3 }, { endLine: 9 }, { startUtf16: 101, endUtf16: 110 }, { startUtf16: 1, endUtf16: 9 }]) {
    expect(hasFlowCode(source, { ...evidence, ...change }, node)).toBe(false);
  }
});

it('shows a selected site only when every evidence coordinate, file and hash matches', () => {
  const node = { ...nodes[0], range: { startUtf16: 10, endUtf16: 100, startLine: 2, endLine: 10 } };
  const source = { fileId: node.fileId, hash: node.fileHash };
  const site = { fileId: node.fileId, fileHash: node.fileHash, startUtf16: 20, endUtf16: 50, startLine: 3, endLine: 5, text: 'throw' };
  const evidence: Evidence = { id: 'e', projectId: 'p', ...site };
  expect(hasFlowCode(source, evidence, node)).toBe(false);
  expect(hasFlowCode(source, evidence, node, site)).toBe(true);
  expect(hasFlowCode(source, { ...evidence, ...node.range }, node, site)).toBe(false);
  expect(hasFlowCode(null, evidence, node, site)).toBe(false);
  expect(hasFlowCode(source, null, node, site)).toBe(false);
  expect(hasFlowCode({ ...source, fileId: 'other' }, evidence, node, site)).toBe(false);
  expect(hasFlowCode({ ...source, hash: 'other' }, evidence, node, site)).toBe(false);
  for (const change of [{ fileId: 'other' }, { fileHash: 'other' }, { startUtf16: 21 }, { endUtf16: 49 },
    { startLine: 4 }, { endLine: 4 }]) {
    expect(hasFlowCode(source, { ...evidence, ...change }, node, site)).toBe(false);
  }
});

it('hides inner function evidence after selecting its enclosing function', () => {
  const inner = { ...nodes[2], range: { startUtf16: 20, endUtf16: 50, startLine: 3, endLine: 5 } };
  const outer = { ...nodes[3], range: { startUtf16: 10, endUtf16: 100, startLine: 2, endLine: 10 } };
  const nested = { ...flow, nodes: [nodes[0], nodes[1], inner, outer] };
  const source = { fileId: inner.fileId, hash: inner.fileHash };
  const evidence: Evidence = { id: 'e', projectId: 'p', fileId: inner.fileId, fileHash: inner.fileHash, ...inner.range };
  const selected = walkSelection(nested, { ...walkProps.walk, nodeId: inner.id });
  expect(hasFlowCode(source, evidence, selected.currentNode!)).toBe(true);
  const changed = walkSelection(nested, { ...walkProps.walk, nodeId: outer.id });
  expect(changed.currentNode).toBe(outer);
  expect(hasFlowCode(source, evidence, changed.currentNode!, null)).toBe(false);
});

it.each(['step', 'node', 'story'] as const)('clears the selected site when changing the %s', change => {
  const site = { fileId: 'f', fileHash: 'h', startUtf16: 1, endUtf16: 2, startLine: 1, endLine: 1, text: 'throw' };
  const walks: ReturnType<typeof useFeatureFlows>['walk'][] = [];
  function Harness() {
    const features = useFeatureFlows(null, 0);
    const [phase, setPhase] = React.useState(0);
    walks.push(features.walk);
    if (phase === 0) {
      features.setSite('back', site);
      setPhase(1);
    }
    if (phase === 1) {
      if (change === 'step') features.setStep(1);
      if (change === 'node') features.setNode('screen');
      if (change === 'story') features.setStory('request');
      setPhase(2);
    }
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  expect(walks).toHaveLength(3);
  expect(walks[0]).toEqual({ through: null, storyId: null, step: 0, nodeId: null, site: null });
  expect(walks[1]).toEqual({ through: null, storyId: null, step: 0, nodeId: 'back', site });
  expect(walks[2].site).toBeNull();
  if (change === 'step') expect(walks[2]).toMatchObject({ step: 1, nodeId: null });
  if (change === 'node') expect(walks[2]).toMatchObject({ nodeId: 'screen' });
  if (change === 'story') expect(walks[2]).toMatchObject({ through: null, storyId: 'request', step: 0, nodeId: null });
});

it('renders written errors, easy names, conditions and omitted counts without claiming execution stopped', () => {
  const site = { fileId: 'f', fileHash: 'h', startUtf16: 1, endUtf16: 2, startLine: 1, endLine: 1, text: 'throw' };
  const kinds = ['NotFoundException', 'BadRequestException', 'UnauthorizedException', 'ForbiddenException',
    'ConflictException', 'UnprocessableEntityException', 'InternalServerErrorException', 'CustomError', 'toString'];
  const backend = { ...nodes[0], stops: kinds.map((kind, index) => ({ kind,
    message: index === 0 ? '<찾지 못함>' : null, condition: index === 0 ? '!dog' : null, site: { ...site, startUtf16: index } })), stopsOmitted: 2 };
  const changed = { ...flow, nodes: [backend], edges: [] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed }));
  expect(html).toContain('aria-label="다른 경우"');
  expect(html).toContain('다른 경우 11개');
  expect(html).toContain('“&lt;찾지 못함&gt;” 오류를 내요 (찾을 수 없음)');
  for (const label of ['잘못된 요청', '로그인 필요', '권한 없음', '충돌', '처리할 수 없는 내용', '서버 오류']) expect(html).toContain(`(${label})`);
  expect(html).toContain('CustomError 오류를 내요');
  expect(html).not.toContain('CustomError 오류를 내요 (');
  expect(html).not.toContain('toString 오류를 내요 (');
  expect(html.match(/조건\(코드\):/g)).toHaveLength(1);
  expect(html).toContain('<code>!dog</code>');
  expect(html).toContain('외 2개 더');
  expect(html).toContain('코드에 적힌 오류예요. 다른 곳에서 이 오류를 잡아 계속 진행하는지는 확인하지 않았어요.');
  expect(html).not.toContain('멈춰요');
  expect(html.match(/>이 줄 보기<\/button>/g)).toHaveLength(kinds.length);
  const locked = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, locked: true }));
  expect(locked.match(/<button[^>]*>이 줄 보기<\/button>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});

it('shows storage groups with the same name separately and explains code order and omissions', () => {
  const site = { fileId: 'f', fileHash: 'h', startUtf16: 1, endUtf16: 2, startLine: 1, endLine: 1, text: 'prisma.dog.\nupsert()' };
  const changed: FeatureFlow = { ...flow, edges: [], nodes: [
    { ...nodes[0], name: 'save', stores: [{ model: 'dog', action: 'upsert', basis: 'shape', site }], storesOmitted: 3 },
    { ...nodes[0], id: 'service', depth: 1, name: 'save', stores: [{ model: null, action: 'raw', basis: 'shape', site: { ...site, fileId: 'other', text: 'prisma.$queryRaw`SQL`' } }] },
  ] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: 2 }, locked: true }));
  expect(html).toContain('aria-label="저장소 호출"');
  expect(html.match(/<h4>save<\/h4>/g)).toHaveLength(2);
  expect(html).toContain('dog 없으면 새로 저장하고 있으면 바꾸기');
  expect(html).toContain('SQL 직접 실행');
  expect(html).toContain('<code>prisma.dog. upsert()</code>');
  expect(html).toContain('외 3개 더');
  expect(html).toContain('Prisma 호출 모양과, 흔한 DB 클라이언트·Repository 이름(db·prisma…·…Repository)으로 찾았어요. 이름으로 찾은 것은 추정이에요. 함수 안에서는 코드에 적힌 순서이고, 조건에 따라 일부만 실행될 수 있어요.');
  expect(html).toContain('함수끼리 어떤 순서로 실행되는지는 확인하지 않았어요.');
  expect(html.match(/<button[^>]*>이 줄 보기<\/button>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});

it('shows name-inferred storage in the flow with its uncertainty label', () => {
  const changed: FeatureFlow = { ...fullStoryFlow, nodes: fullStoryFlow.nodes.map(node => ({ ...node,
    stores: node.stores.map(store => ({ ...store, basis: 'name' })),
  })) };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: 5 } }));
  expect(html).toContain('aria-label="저장소 호출"');
  expect(html).toContain('dog 지우기 (이름으로 추정)');
});

it('renders the sixth step button and folded outside calls with their total count', () => {
  const site = { fileId: 'f', fileHash: 'h', startUtf16: 1, endUtf16: 2, startLine: 1, endLine: 1, text: 'prisma.dog.delete()' };
  const changed: FeatureFlow = { ...flow, nodes: [...nodes,
    { ...nodes[2], id: 'prepare', name: 'prepare', event: null },
    { ...nodes[0], id: 'service', depth: 1, outside: ['external()'], outsideOmitted: 4, stores: [{ model: 'dog', action: 'delete', basis: 'shape', site }] },
  ], edges: [flow.edges[0], { ...flow.edges[1], to: 'prepare' }, { ...flow.edges[1], from: 'prepare' }, flow.edges[2],
    { ...flow.edges[0], from: 'back', to: 'service' }] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: 4 } }));
  expect(html).toContain('5 / 6 · 서버 처리');
  expect(html).toContain('aria-label="6단계 저장소">⑥ 저장소</button>');
  expect(html).toContain('<details><summary>코드에서 부르는 다른 것 5개</summary>');
  expect(html).toContain('외 4개 더');
  expect(html).not.toContain('<details open');
  const last = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: 5 } }));
  expect(last).toContain('6 / 6 · 저장소');
  expect(last).toContain('aria-label="6단계 저장소" aria-current="step">⑥ 저장소</button>');
  expect(last).not.toContain('함수끼리 어떤 순서로 실행되는지는 확인하지 않았어요.');
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
const overviewOf = (r: ProjectRoutes, p: ProjectView = project, guide?: FeatureGuide) =>
  renderToStaticMarkup(React.createElement(FeatureOverview, { project: p, routes: r, guide }));
it('draws found screens, local requests, servers and unique links, leaving the README to its own card', () => {
  const html = overviewOf(routes);
  expect(html).toContain('aria-label="큰 그림"');
  expect(html).toContain('이 프로젝트는 이렇게 나뉘어요');
  for (const text of ['화면 1개', '요청 4개', '기능 2개', 'web 폴더', 'api 폴더',
    '확실히 이어짐 1개 · 추정 1개', '서버 주소를 찾지 못한 요청 2개', '사람이 보고 누르는 곳',
    '서버에 부탁(요청)을 보내는 코드', '부탁을 받아 일을 하는 곳']) expect(html).toContain(text);
  expect(html.match(/class="picture__box"/g)).toHaveLength(3);
  expect(html.match(/class="picture__arrow"/g)).toHaveLength(1);
  expect(html.indexOf('<b>요청을 보내는 코드</b>')).toBeLessThan(html.indexOf('class="picture__arrow"'));
  expect(html.indexOf('class="picture__arrow"')).toBeLessThan(html.indexOf('<b>서버</b>'));
  expect(html).not.toContain('aria-hidden');
  expect(html).toContain('<span class="tag">일반 설명</span>');
  expect(html).toContain('웹 프로그램은 보통 이렇게 움직여요. 사람이 화면에서 버튼을 누르면, 화면 쪽 코드가 서버에 요청(부탁)을 보내고, 서버가 일을 한 뒤 결과를 돌려줘요. 이 프로젝트에서 실제로 어떻게 이어지는지는 기능을 하나 골라 따라가 보면 확인할 수 있어요.');
  expect(html).not.toContain('첫 문단 그대로.');
});
it('draws request code without claiming a screen for non-Next projects', () => {
  const nonNext = { ...project, files: project.files.filter(file => file.id !== 'config') };
  const html = overviewOf(routes, nonNext);
  expect(html).not.toContain('<b>화면</b>');
  expect(html).toContain('<b>요청을 보내는 코드</b>');
  expect(html).toContain('화면은 찾지 못했어요. 지금은 Next.js 화면만 알아봐요.');
});
it('omits the server, arrow, general explanation and the repeated no-server sentence when no routes were found', () => {
  const html = overviewOf({ ...routes, routes: [], links: [] });
  expect(html).not.toContain('<b>서버</b>');
  expect(html).not.toContain('picture__arrow');
  expect(html).not.toContain('일반 설명');
  expect(html).not.toContain('서버 주소를 찾지 못한 요청');
  // The chooser's notice right below says this; the picture does not repeat it.
  expect(html).not.toContain('서버 코드(요청을 받는 곳)');
});
it('does not connect screens to servers when no requests were found', () => {
  const html = overviewOf({ ...routes, requests: [], links: [] });
  expect(html).toContain('<b>화면</b>');
  expect(html).toContain('<b>서버</b>');
  expect(html).not.toContain('<b>요청을 보내는 코드</b>');
  expect(html).not.toContain('picture__arrow');
  expect(html).not.toContain('일반 설명');
});
it('counts external requests separately without drawing a local request box or arrow', () => {
  const external = { ...routes, requests: routes.requests.map(request => ({ ...request, host: 'example.com' })), links: [] };
  const html = overviewOf(external);
  expect(html).toContain('다른 서버로 보내는 요청 4개');
  expect(html).not.toContain('<b>요청을 보내는 코드</b>');
  expect(html).not.toContain('picture__arrow');
  expect(html).not.toContain('일반 설명');
  expect(html).not.toContain('서버 주소를 찾지 못한 요청');
});
it('uses only local request folders and excludes external requests from unlinked counts', () => {
  const mixed = { ...routes, requests: [...routes.requests, { ...routes.requests[0], fileId: 'server', host: 'example.com' }] };
  const html = overviewOf(mixed);
  expect(html).toContain('web 폴더');
  expect(html).toContain('요청 4개');
  expect(html).toContain('다른 서버로 보내는 요청 1개');
  expect(html).toContain('서버 주소를 찾지 못한 요청 2개');
});
it('does not assign a single folder when local requests span folders or the folder is unknown', () => {
  for (const fileId of ['server', 'missing']) {
    const mixed = { ...routes, requests: [...routes.requests, { ...routes.requests[0], fileId }] };
    const html = overviewOf(mixed);
    expect(html).not.toContain('web 폴더');
    expect(html).toContain('api 폴더');
  }
});
it('reports missing links without drawing an arrow or general explanation', () => {
  const html = overviewOf({ ...routes, links: [] });
  expect(html).toContain('<b>요청을 보내는 코드</b>');
  expect(html).toContain('<b>서버</b>');
  expect(html).toContain('요청을 보내는 코드와 서버 사이의 연결은 확인하지 못했어요.');
  expect(html).toContain('서버 주소를 찾지 못한 요청 4개');
  expect(html).not.toContain('picture__arrow');
  expect(html).not.toContain('일반 설명');
});
it('draws inferred links without a general explanation when there are no sure links', () => {
  const inferred = { ...routes, links: routes.links.map(link => ({ ...link, sure: false })) };
  const html = overviewOf(inferred);
  expect(html).toContain('picture__arrow');
  expect(html).toContain('확실히 이어짐 0개 · 추정 2개');
  expect(html).not.toContain('일반 설명');
});
it('places the escaped AI summary above the picture', () => {
  const guide = { summary: '<script>요약</script>', groups: [], unknowns: [] };
  const html = overviewOf(routes, project, guide);
  expect(html).toContain('AI 정리');
  expect(html).toContain('&lt;script&gt;요약&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html.indexOf('요약')).toBeLessThan(html.indexOf('class="picture"'));
});

it('provides a follow button per feature and disables every route action when locked', () => {
  const groups = [{ name: 'dogs', about: '', features: [
    { name: '삭제', about: '삭제 요청', routes: [0, 1], ai: false, sure: 1, inferred: 0, haystack: '삭제' },
    { name: '조회', about: '', routes: [1], ai: false, sure: 0, inferred: 1, haystack: '조회' },
  ] }];
  const html = renderToStaticMarkup(React.createElement(FeatureList, { flows: null, groups, routes, selected: 0, disabled: true, search: '', setSearch() {}, onFollow() {} }));
  expect(html.match(/>이 기능 따라가기<\/button>/g)).toHaveLength(2);
  expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});

const groups: ReturnType<typeof featureGroups> = [
  { name: 'dogs', about: '', features: [
    { name: '조회', about: '', routes: [1], ai: false, sure: 0, inferred: 5, haystack: '조회' },
    { name: '삭제', about: '삭제 요청', routes: [0], ai: false, sure: 2, inferred: 0, haystack: '삭제' },
  ] },
  { name: 'other', about: '', features: [
    { name: '추가', about: '', routes: [1], ai: false, sure: 3, inferred: 0, haystack: '추가' },
    { name: '수정', about: '', routes: [0], ai: false, sure: 1, inferred: 0, haystack: '수정' },
  ] },
];
const withFeatures = (patch: (feature: ReturnType<typeof featureGroups>[number]['features'][number]) => object) =>
  groups.map(group => ({ ...group, features: group.features.map(feature => ({ ...feature, ...patch(feature) })) }));
it('recommends the feature with the most sure links across all groups', () => {
  expect(recommendedFeature(groups, routes)).toBe(groups[1].features[0]);
});
it('keeps the first feature in display order when sure counts tie', () => {
  const tied = withFeatures(() => ({ sure: 2 }));
  expect(recommendedFeature(tied, routes)).toBe(tied[0].features[0]);
  const nonGet = { ...routes, routes: routes.routes.map(route => ({ ...route, method: 'DELETE' as const })) };
  expect(recommendedFeature(tied, nonGet)).toBe(tied[0].features[0]);
  const allGet = { ...routes, routes: routes.routes.map(route => ({ ...route, method: 'GET' as const })) };
  expect(recommendedFeature(tied, allGet)).toBe(tied[0].features[0]);
});
it('does not recommend an empty list or features without sure links', () => {
  expect(recommendedFeature([], routes)).toBeNull();
  expect(recommendedFeature(withFeatures(() => ({ sure: 0 })), routes)).toBeNull();
});

const chooserProps: Parameters<typeof FeatureChooser>[0] = {
  project: { ...project, warnings: ['파일별 최대 256 KiB까지만 읽어요.'] },
  state: { routes, groups, stale: false, finding: false, error: '', guide: null, search: '', selected: null,
    groupingProps: { flows: null, grouping: false, groupError: '', onRegroup() {}, onCancelGrouping() {} },
    setSearch() {}, setGuideResult() {}, find() {}, cancelFind() {},
  } as unknown as Parameters<typeof FeatureChooser>[0]['state'],
  revision: 0, locked: false, mode: 'local-worker', running: false, checking: false, connections: null,
  onFollow() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onRunning() {},
};
it.each([
  { grouped: false, deleteLinks: 1, expected: 2 },
  { grouped: false, deleteLinks: 2, expected: 0 },
  { grouped: true, deleteLinks: 1, expected: 2 },
  { grouped: true, deleteLinks: 2, expected: 0 },
])('prefers GET only for tied first-route links and opens that recommendation: %o', ({ grouped, deleteLinks, expected }) => {
  const addresses: ProjectRoutes = { ...routes,
    routes: ['DELETE', 'GET', 'GET'].map((method, index) => ({ ...routes.routes[0], method: method as 'DELETE' | 'GET', path: `/dogs/${index}` })),
    links: [...Array.from({ length: deleteLinks }, (_, requestIndex) => ({ requestIndex, routeIndex: 0, sure: true, reasons: [] })),
      { requestIndex: 3, routeIndex: 2, sure: true, reasons: [] }],
  };
  const guide: FeatureGuide | undefined = grouped ? { summary: '', unknowns: [], groups: [{ name: '묶음', about: '',
    features: [{ name: '삭제와 조회', about: '', routes: [1, 0] }] }] } : undefined;
  const features = featureGroups(project, addresses, guide);
  if (grouped) expect(features[0].features[0].routes).toEqual([0, 1]);
  expect(recommendedFeature(features, addresses)?.routes[0]).toBe(expected);
  const onFollow = vi.fn();
  let follow: (() => void) | undefined;
  function Probe() {
    const tree = FeatureChooser({ ...chooserProps, onFollow, state: { ...chooserProps.state, routes: addresses, groups: features } });
    const pending: React.ReactNode[] = [tree];
    while (pending.length) {
      const item = pending.pop();
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(item)) continue;
      if (item.type === 'button' && item.props.children === '이 기능부터 따라가기') follow = item.props.onClick;
      pending.push(...React.Children.toArray(item.props.children));
    }
    return tree;
  }
  const html = renderToStaticMarkup(React.createElement(Probe));
  expect(html).toContain('같으면 정보를 보기만 하는 GET 기능 먼저');
  expect(follow).toBeTypeOf('function');
  follow!();
  expect(onFollow).toHaveBeenCalledExactlyOnceWith(expected, undefined);
  expect(addresses.routes[onFollow.mock.calls[0][0]].method).toBe(deleteLinks === 1 ? 'GET' : 'DELETE');
});
it('offers start files instead of recommendation, feature list and AI controls when there are no routes', () => {
  const state = { ...chooserProps.state, routes: { ...routes, routes: [], links: [] }, groups: [] };
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps, state }));
  expect(html).toContain('서버 코드(요청을 받는 곳)를 찾지 못해서 기능별로 따라갈 수 없어요. 아래 ‘어디부터 읽을까요?’에서 시작 파일을 골라 읽어 보세요.');
  expect(html).not.toContain('기능 고르기');
  expect(html).not.toContain('처음 따라갈 기능');
  expect(html).not.toContain('AI로 기능 정리하기');
});
it('places the recommendation before the list, moves AI controls inside the list and omits duplicate warnings', () => {
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, chooserProps));
  expect(html.indexOf('aria-label="큰 그림"')).toBeLessThan(html.indexOf('aria-label="처음 따라갈 기능"'));
  expect(html.indexOf('aria-label="처음 따라갈 기능"')).toBeLessThan(html.indexOf('<h3>기능 고르기</h3>'));
  expect(html).toMatch(/<section aria-label="기능 목록"><h3>기능 고르기<\/h3>.*<details open=""><summary hidden=""><\/summary><div class="feature-guide-ai"[^>]*>.*?AI로 기능 정리하기<\/button><\/div><p>기능 목록/);
  expect(html).toContain('이 기능에 요청을 보내는 코드 3곳을 확실히 찾았어요. 요청을 보내는 쪽부터 서버까지 따라가 볼 수 있어요.');
  expect(html).toContain('고른 기준: 요청을 보내는 코드와 확실히 이어진 곳이 가장 많은 기능(같으면 정보를 보기만 하는 GET 기능 먼저)');
  expect(html).toMatch(/<button class="btn">이 기능부터 따라가기<\/button>/);
  expect(html).not.toContain(chooserProps.project.warnings[0]);
});
it.each([{ locked: true, stale: false }, { locked: false, stale: true }])('disables the recommendation for %o', ({ locked, stale }) => {
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps, locked, state: { ...chooserProps.state, stale } }));
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 기능부터 따라가기<\/button>/);
});
it.each([{ finding: true, error: '' }, { finding: false, error: '주소 찾기 실패' }])('does not mistake unavailable routes for an empty result: %o', status => {
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps,
    state: { ...chooserProps.state, ...status, routes: undefined },
  }));
  expect(html).not.toContain('서버 코드(요청을 받는 곳)를 찾지 못해서');
  expect(html).not.toContain('처음 따라갈 기능');
  expect(html).toContain(status.finding ? '주소를 찾는 중' : '주소 찾기 실패');
});
it('keeps the same recommendation while searching and renders current AI names from groups', () => {
  const named = withFeatures(feature => ({ name: `AI ${feature.name}`, about: 'AI 설명', ai: true }));
  const state = { ...chooserProps.state, groups: named, search: 'missing' };
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps, state }));
  expect(html).toContain('<b>AI 추가</b>');
  expect(html).toContain('<p class="hint">AI 설명</p>');
  expect(html).toContain('검색어와 맞는 기능이 없어요.');
  expect(html).toContain('이 기능부터 따라가기');
});
it('omits the recommendation when routes exist but no feature has sure links', () => {
  const state = { ...chooserProps.state, groups: withFeatures(() => ({ sure: 0 })) };
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps, state }));
  expect(html).not.toContain('처음 따라갈 기능');
  expect(html).toContain('기능 고르기');
  expect(html).toContain('AI로 기능 정리하기');
});
it('distinguishes missing server code from a search with no matching features', () => {
  const props = { flows: null, routes, selected: null, disabled: false, search: '', setSearch() {}, onFollow() {} };
  const empty = renderToStaticMarkup(React.createElement(FeatureList, { ...props, routes: { ...routes, routes: [], links: [] }, groups: [] }));
  expect(empty).toContain('서버 코드(요청을 받는 곳)를 찾지 못했어요.');
  expect(empty).not.toContain('검색어와 맞는 기능이 없어요.');
  const filtered = renderToStaticMarkup(React.createElement(FeatureList, { ...props, groups, search: 'missing' }));
  expect(filtered).toContain('검색어와 맞는 기능이 없어요.');
  expect(filtered).not.toContain('서버 코드(요청을 받는 곳)를 찾지 못했어요.');
});

it.each([null, '삭제?'])('renders confirmation wording without the server-error disclaimer: %s', message => {
  const changed = { ...flow, nodes: nodes.map(node => node.id === 'event' ? { ...node,
    control: { tag: 'button', texts: ['삭제'] }, asks: [{ message, site: { fileId: 'f', fileHash: 'h', ...node.range, text: 'if (!confirm(message)) return;' } }],
  } : node) };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, locked: true }));
  expect(html).toContain('화면 /dogs에서 ‘삭제’ 버튼을 누르면 시작해요');
  expect(html).toContain('aria-label="다른 경우"');
  expect(html).toContain('다른 경우 1개');
  expect(html).toContain(`${message === null ? '' : '‘삭제?’ '}확인 창에서 취소하면 여기서 멈춰요`);
  expect(html).not.toContain('코드에 적힌 오류예요');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 줄 보기<\/button>/);
});

it('adds stops and confirmations to the same count and keeps the error disclaimer for stops', () => {
  const changed = { ...flow, nodes: nodes.map(node => node.id === 'back' ? { ...node,
    stops: [{ kind: 'Error', message: '실패', condition: null, site: { fileId: 'f', fileHash: 'h', ...node.range, text: 'throw new Error();' } }], stopsOmitted: 2,
  } : node) };
  const walk = { ...walkProps.walk, step: 2 };
  const selection = walkSelection(changed, walk);
  const step = { ...selection.step!, asks: { items: [{ nodeId: 'back', message: '계속?', site: { fileId: 'f', fileHash: 'h', ...nodes[0].range, startUtf16: 2, text: 'confirm()' } }], omitted: 0 } };
  const html = renderToStaticMarkup(React.createElement(FlowWalk, { ...walkProps, flow: changed, walk, selection: { ...selection, step } }));
  expect(html).toContain('다른 경우 4개');
  expect(html).toContain('코드에 적힌 오류예요');
  expect(html).toContain('외 2개 더');
});

it.each([{ locked: true, stale: false }, { locked: false, stale: true }])('renders grouped result actions and disables line buttons for %o', status => {
  const changed = { ...flow, nodes: nodes.map(node => {
    const site = { fileId: 'f', fileHash: 'h', ...node.range, text: 'action()' };
    if (node.id === 'screen') return { ...node, after: [{ when: 'success' as const, action: 'cancel' as const, target: null, site }], afterOmitted: 1 };
    if (node.id !== 'event') return node;
    return { ...node, after: [
      { when: 'success' as const, action: 'navigate' as const, target: '/', site },
      { when: 'error' as const, action: 'state' as const, target: 'error', site: { ...site, startUtf16: 2 } },
      { when: 'settled' as const, action: 'notify' as const, target: null, site: { ...site, startUtf16: 4 } },
    ], afterOmitted: 2 };
  }) };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, ...status, flow: changed, walk: { ...walkProps.walk, step: 3 } }));
  for (const text of ['aria-label="응답 뒤 화면"', '화면 결과', '<h4>DogsPage</h4>', '<h4>onClick 함수</h4>',
    '<h5>성공하면</h5>', '<h5>실패하면</h5>', '<h5>끝나면</h5>', '하던 불러오기 멈추기', '화면 /로 이동하기',
    '화면 값 error 바꾸기', '알림 보여 주기', '외 3개 더', '코드 모양(onSuccess, await 다음 줄, catch)으로 찾았어요.',
    '실제로 실행되는 순서와 여부는 확인하지 않았어요.', '함수끼리 어떤 순서로 실행되는지는 확인하지 않았어요.']) expect(html).toContain(text);
  expect(html).not.toContain('aria-label="다른 경우"');
  const lineButtons = html.match(/<button[^>]*>이 줄 보기<\/button>/g)!;
  expect(lineButtons).toHaveLength(4);
  expect(lineButtons.every(button => button.includes('disabled=""'))).toBe(true);
});

it('prepares the exact step question and caps each title at 80 characters', () => {
  const ending = '무엇을 받아서, 무엇을 확인하고, 무엇을 돌려주거나 바꾸는지 알려 주고, 실패하거나 멈추는 경우도 적어 주세요.';
  expect(stepQuestion('로그인', 4, '서버가 받아요')).toBe(
    '‘로그인’ 기능의 4번째 단계 ‘서버가 받아요’에서 이 함수가 하는 일을 쉽게 설명해 주세요. ' + ending);
  for (const length of [0, 79, 80, 81, 3000]) {
    const feature = '가'.repeat(length);
    const title = '나'.repeat(length);
    const question = stepQuestion(feature, 1, title);
    expect(question).toBe(`‘${feature.slice(0, 80)}’ 기능의 1번째 단계 ‘${title.slice(0, 80)}’에서 이 함수가 하는 일을 쉽게 설명해 주세요. ` + ending);
    expect(question.length).toBeLessThanOrEqual(2000);
  }
});

it.each([
  { step: 0, locked: false, stale: false, shown: true, disabled: false },
  { step: 1, locked: false, stale: false, shown: false, disabled: false },
  { step: 2, locked: false, stale: false, shown: true, disabled: false },
  { step: 2, locked: true, stale: false, shown: true, disabled: true },
  { step: 2, locked: false, stale: true, shown: true, disabled: true },
])('offers step questions only for functions and locks them with the flow: %o', ({ step, locked, stale, shown, disabled }) => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, locked, stale, walk: { ...walkProps.walk, step } }));
  const button = html.match(/<button[^>]*>AI에게 쉽게 물어보기<\/button>/);
  expect(button !== null).toBe(shown);
  if (shown) expect(button![0].includes('disabled=""')).toBe(disabled);
});

it.each([
  { finding: false, error: '', stale: false, found: true, button: null },
  { finding: false, error: '', stale: false, found: false, button: '주소 찾기' },
  { finding: false, error: '실패', stale: false, found: false, button: '다시 찾기' },
  { finding: false, error: '실패', stale: false, found: true, button: '다시 찾기' },
  { finding: false, error: '', stale: true, found: true, button: '다시 찾기' },
  { finding: true, error: '', stale: false, found: false, button: '주소 찾기 취소' },
])('offers only the route action needed for %o', ({ found, button, ...status }) => {
  const state = { ...status, routes: found ? routes : undefined, find() {}, cancelFind() {} } as unknown as Parameters<typeof RoutesStatus>[0]['state'];
  const html = renderToStaticMarkup(React.createElement(RoutesStatus, { state }));
  const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1]);
  expect(buttons).toEqual(button ? [button] : []);
  expect(html.includes('주소를 찾는 중…')).toBe(status.finding);
});

it.each([
  { sure: 2, inferred: 3, tag: '요청 코드와 이어짐', className: 'tag tag--ok' },
  { sure: 0, inferred: 3, tag: '추정 연결', className: 'tag tag--unknown' },
  { sure: 0, inferred: 0, tag: '요청 코드를 못 찾음', className: 'tag' },
])('keeps connection counts and code names folded behind the $tag tag', ({ sure, inferred, tag, className }) => {
  const groups = [{ name: 'dogs', about: '', features: [
    { name: '삭제', about: 'DogsController.remove', routes: [0], ai: false, sure, inferred, haystack: '삭제' },
  ] }];
  const html = renderToStaticMarkup(React.createElement(FeatureList, { flows: null, groups, routes, selected: null, disabled: false, search: '', setSearch() {}, onFollow() {} }));
  const counts = `프론트 요청 확실 ${sure}곳 · 추정 ${inferred}곳`;
  expect(html).toContain(`<span class="${className}" title="${counts}">${tag}</span>`);
  expect(html).toContain(`<details class="feature-more"><summary>코드 이름·연결 근거</summary><p class="hint">DogsController.remove</p><p class="hint">${counts}</p></details>`);
  expect(html.match(/DogsController.remove/g)).toHaveLength(1);
  expect(html).toContain('>이 기능 따라가기</button>');
});

it.each([0, 1])('shows one server-only notice only when the entire project has no requests: %s', requestCount => {
  const addresses = { ...routes, requests: routes.requests.slice(0, requestCount), links: [] };
  const html = renderToStaticMarkup(React.createElement(FeatureList, { flows: null,
    groups: withFeatures(() => ({ sure: 0, inferred: 0 })), routes: addresses, selected: null,
    disabled: false, search: '', setSearch() {}, onFollow() {} }));
  const notice = '이 프로젝트에서는 서버에 요청을 보내는 코드를 찾지 못했어요. 서버 쪽 흐름만 따라갈 수 있어요.';
  expect(html.split(notice).length - 1).toBe(requestCount === 0 ? 1 : 0);
  expect(html.match(/요청 코드를 못 찾음/g) ?? []).toHaveLength(requestCount === 0 ? 0 : 4);
  if (requestCount === 0) expect(html.indexOf(notice)).toBeLessThan(html.indexOf('class="map-list"'));
});

it('keeps AI feature descriptions and addresses outside the folded connection evidence', () => {
  const groups = [{ name: 'dogs', about: '', features: [
    { name: '삭제', about: '반려견 정보를 지워요.', routes: [0, 1], ai: true, sure: 1, inferred: 0, haystack: '삭제' },
  ] }];
  const addresses = { ...routes, routes: routes.routes.map((route, index) => ({ ...route, method: index ? 'GET' as const : 'DELETE' as const, path: '/dogs' })) };
  const html = renderToStaticMarkup(React.createElement(FeatureList, { flows: null, groups, routes: addresses, selected: null, disabled: false, search: '', setSearch() {}, onFollow() {} }));
  const beforeDetails = html.slice(0, html.indexOf('<details class="feature-more"'));
  expect(beforeDetails).toContain('반려견 정보를 지워요.');
  expect(beforeDetails).toContain('DELETE /dogs · GET /dogs');
  expect(beforeDetails).toContain('>DELETE /dogs</button>');
  expect(beforeDetails).toContain('>GET /dogs</button>');
  expect(html.match(/반려견 정보를 지워요./g)).toHaveLength(1);
});

it.each([undefined, { ...routes, requests: [], links: [] }, {
  ...routes, requests: [{ ...nodes[1].range, fileId: 'client', fileHash: 'h', text: 'fetch("/dogs")', host: null,
    methods: ['GET'], prefix: 'known', path: '/dogs', args: [], inTest: false, inFunction: null }], links: [{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }],
}] as (ProjectRoutes | undefined)[])('omits empty request lists in the folded flow limits', routes => {
  const html = renderToStaticMarkup(React.createElement(FlowLimits, { project, routes, flow, locked: false, onCode() {} }));
  expect(html).toMatch(/^<details class="card"><summary>이 흐름을 찾은 방법과 한계<\/summary><p class="hint">코드 글자로 찾은 흐름이에요/);
  expect(html).toContain('찾은 범위와 한계');
  expect(html).toContain('app.use의 주소 연결은 따라가지 않아요. tsconfig 경로 별칭은 따라가요.');
  expect(html).toContain('저장소는 Prisma 모양과 흔한 DB 클라이언트·TypeORM Repository 이름으로 찾아요(이름으로 찾은 것은 추정, Mongoose·Drizzle 등은 아직 못 찾아요)');
  expect(html).not.toContain('이을 주소를 못 찾은 요청');
  expect(html).not.toContain('다른 서버 주소 요청');
  expect(html.match(/<details/g)).toHaveLength(1);
});

it.each([null, 'https://example.com'])('nests only the nonempty request list inside the flow limits: %s', host => {
  const request: ProjectRoutes['requests'][number] = { ...nodes[1].range, fileId: 'client', fileHash: 'h', text: 'fetch("/dogs")', host,
    methods: ['GET'], prefix: 'known', path: '/dogs', args: [], inTest: false, inFunction: null };
  const html = renderToStaticMarkup(React.createElement(FlowLimits, { project,
    routes: { ...routes, requests: [request], links: [], limited: true, notes: ['한도'] }, flow, locked: true, onCode() {} }));
  expect(html).toMatch(/^<details class="card"><summary>이 흐름을 찾은 방법과 한계<\/summary>/);
  expect(html).toContain(`<details class="card"><summary>${host ? '다른 서버 주소 요청' : '이을 주소를 못 찾은 요청'} 1개</summary>`);
  expect(html).not.toContain(host ? '이을 주소를 못 찾은 요청' : '다른 서버 주소 요청');
  expect(html).toContain('web/request.ts 1행');
  expect(html).toContain('disabled="">코드 보기</button>');
  expect(html).toContain('일부 흐름만 확인했어요.');
  expect(html).toContain('한도');
  expect(html.match(/<details/g)).toHaveLength(2);
  expect(html).toMatch(/<\/details><\/details>$/);
});

it('renders screen rows, folded unmatched groups and the intact AI server list with a limited-flow notice', () => {
  const result = { ...routes, routesId: flow.routesId, routes: routes.routes.map((route, index) => ({ ...route,
    method: 'DELETE' as const, path: `/api/dogs/${index}`, handler: { ...route.handler, name: 'remove' },
  })) };
  const guide: FeatureGuide = { summary: '', unknowns: [], groups: [{ name: '반려견 관리', about: 'AI 묶음 설명', features: [
    { name: '반려견 삭제', about: 'AI 기능 설명', routes: [0, 1] },
  ] }] };
  const html = renderToStaticMarkup(React.createElement(FeatureList, { groups: featureGroups(project, result, guide), routes: result,
    flows: [{ ...flow, limited: true }], guide,
    search: '', selected: null, disabled: false, setSearch() {}, onFollow() {}, children: 'AI로 기능 정리하기' }));
  expect(html).toContain('aria-label="화면 /dogs"');
  expect(html).toContain('title="훅이 돌려준 값 remove를 써요 · 방식 모름"');
  expect(html).toContain('AI 해석 · 반려견 삭제');
  for (const text of ['화면은 못 정했지만 요청 코드는 찾은 기능 0개', '화면과 연결을 찾지 못한 서버 기능 0개',
    '서버 주소 기준 목록 (AI 정리 포함)']) expect(html).toContain(`<details class="card"><summary>${text}</summary>`);
  expect(html).toContain('일부 기능은 분석 한도 때문에 흐름의 일부만 확인했어요.');
  for (const text of ['AI 묶음 설명', 'AI 기능 설명', 'AI로 기능 정리하기', 'DELETE /api/dogs/0', 'DELETE /api/dogs/1']) expect(html).toContain(text);
});
it.each(['grouping', 'failure', 'unavailable'] as const)('keeps the server list visible for %s', state => {
  const html = renderToStaticMarkup(React.createElement(FeatureList, { routes, groups, selected: null, disabled: false,
    search: '', setSearch() {}, onFollow() {}, grouping: state === 'grouping', groupError: state === 'failure' ? '취소했어요' : '',
    flows: null }));
  expect(html).toContain('삭제 요청');
  expect(html).not.toContain('서버 주소 기준 목록 (AI 정리 포함)');
  if (state === 'grouping') { expect(html).toContain('화면별로 묶는 중…'); expect(html).toContain('>취소</button>'); }
  if (state === 'failure') { expect(html).toContain('서버 주소 기준으로 보여 줘요.'); expect(html).toContain('>다시 묶기</button>'); }
});

const indexRoutes: ProjectRoutes = { ...routes, routes: Array.from({ length: 5 }, (_, index) => ({
  method: 'DELETE', path: index === 4 ? '/api/auth' : `/api/dogs/${index}`, framework: 'express', prefix: 'known',
  basis: { text: '', range: { ...nodes[0].range, fileId: 'server', fileHash: 'h', text: '' } },
  handler: { ...nodes[0].range, fileId: 'server', fileHash: 'h', name: `remove${index}` },
})) };
const indexFlows: FeatureFlow[] = indexRoutes.routes.map((_, routeIndex) => ({ ...flow, routeIndex,
  nodes: nodes.map(node => ({ ...node,
    screen: node.screen ? routeIndex === 4 ? '/auth' : '/dogs' : null,
    screenTitle: node.screen && routeIndex === 0 ? { text: '내 반려견', site: {
      ...node.range, fileId: node.fileId, fileHash: node.fileHash, text: '<h1>내 반려견</h1>',
    } } : null,
    control: node.event && routeIndex === 1 ? { tag: 'button', texts: ['삭제'] } : null,
  })),
}));
const indexPathOf = (fileId: string) => project.files.find(file => file.id === fileId)?.relativePath ?? 'src/example.ts';
const indexProps: Parameters<typeof FeatureList>[0] = { routes: indexRoutes, groups: featureGroups(project, indexRoutes),
  flows: indexFlows, index: indexes.featureIndex(indexRoutes, indexFlows, indexPathOf),
  search: '', selected: 0, disabled: false, setSearch() {}, onFollow() {} };

it('places the folded index before screen and server lists, with three previews and naming evidence', () => {
  const html = renderToStaticMarkup(React.createElement(FeatureList, indexProps));
  const index = html.slice(html.indexOf('<section aria-label="기능 목차">'), html.indexOf('<details><summary>화면별로 보기'));
  expect(index).toContain('기능 목차 · 묶음 2개 · 서버 기능 5개');
  expect(index).toContain('서버 코드에서 찾은 기능만 보여요. 앱의 모든 기능이라고 단정하지는 않아요.');
  expect(index).toContain('<summary>내 반려견 · dogs · 기능 4개 — ‘내 반려견’ 화면 · 지우기, ‘삭제’ 버튼 · 지우기, 지우기 · /api/dogs/2, …</summary>');
  expect(index).toContain('묶음 이름: 주소 이름이 같은 화면 /dogs의 제목 · src/example.ts 1행 · 추정');
  for (const text of ['버튼 문구', '화면 제목', '주소 이름']) expect(index).toContain(`>${text}</span>`);
  expect(index).toContain('title="화면 /dogs · src/example.ts 1행">화면 제목</span>');
  expect(index).toContain('화면 /dogs · src/example.ts onClick 함수 · DELETE /api/dogs/1 · 쓰는 화면 /dogs');
  expect(index).toContain('title="훅이 돌려준 값 remove를 써요 · 방식 모름">추정 연결</span>');
  expect(index).not.toContain('<details class="card" open');
  expect(html.indexOf('기능 목차')).toBeLessThan(html.indexOf('화면별로 보기'));
  expect(html.indexOf('화면별로 보기')).toBeLessThan(html.indexOf('서버 주소 기준 목록 (AI 정리 포함)'));
  expect(index).toContain('aria-pressed="true"');
});

it.each([
  ['삭제', 1, '‘삭제’ 버튼'], ['AUTH', 1, 'auth · 기능 1개'], ['내 반려견', 4, 'dogs · 기능 4개'],
  ['remove2', 1, '/api/dogs/2'], ['없는 기능', 0, ''],
])('filters index features and groups and opens matching groups for %s', (search, count, text) => {
  const html = renderToStaticMarkup(React.createElement(FeatureList, { ...indexProps, search }));
  const index = html.slice(html.indexOf('<section aria-label="기능 목차">'), html.indexOf('<details open=""><summary>화면별로 보기'));
  expect(index.match(/>이 기능 따라가기<\/button>/g) ?? []).toHaveLength(count);
  expect(index).toContain(text);
  expect(index).not.toContain('<details class="card"><summary>');
  if (count > 0) expect(index).toContain('<details class="card" open=""><summary>');
  if (search !== 'AUTH') expect(index).not.toContain('<summary>auth');
});

it('shows unmatched index labels and AI names, limits screen hints and disables all index actions', () => {
  const extraScreens = Array.from({ length: 4 }, (_, i) => ({ ...nodes[3], id: `screen${i}`, screen: `/other${i}` }));
  const flows = [
    { ...flow, nodes: [...nodes, ...extraScreens], edges: [...flow.edges, ...extraScreens.map(node => ({ ...flow.edges[0], from: node.id }))] },
    { ...flow, routeIndex: 1, nodes: nodes.filter(node => node.screen === null), edges: flow.edges.slice(1) },
    { ...flow, routeIndex: 2, nodes: [nodes[0]], edges: [] },
  ];
  const guide: FeatureGuide = { summary: '', unknowns: [], groups: [{ name: 'AI', about: '', features: [{ name: '이름 해석', about: '', routes: [1] }] }] };
  const html = renderToStaticMarkup(React.createElement(FeatureList, { ...indexProps, flows, guide,
    index: indexes.featureIndex(indexRoutes, flows, indexPathOf, guide), disabled: true }));
  const index = html.slice(html.indexOf('<section aria-label="기능 목차">'), html.indexOf('<details><summary>화면별로 보기'));
  expect(index).toContain('쓰는 화면 /dogs, /other0, /other1 외 2개');
  expect(index).toContain('화면은 못 정했지만 요청 코드는 찾았어요');
  expect(index).toContain('화면과 연결을 찾지 못했어요');
  expect(index).toContain('AI 해석 · 이름 해석');
  expect(index.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  const missing = renderToStaticMarkup(React.createElement(FeatureList, { ...indexProps, flows: null, index: null }));
  expect(missing).not.toContain('aria-label="기능 목차"');
  expect(missing).not.toContain('화면별로 보기');
});

it.each([undefined, null])('shows no index and does not compute one when the supplied index is %s', index => {
  const compute = vi.spyOn(indexes, 'featureIndex');
  try {
    const html = renderToStaticMarkup(React.createElement(FeatureList, { ...indexProps, index }));
    expect(html).not.toContain('aria-label="기능 목차"');
    expect(html).toContain('화면별로 보기');
    expect(compute).not.toHaveBeenCalled();
  } finally { compute.mockRestore(); }
});

it('recommends the supplied indexed name and evidence and follows the same named screen without recomputing', () => {
  const secondScreen = { ...nodes[3], id: 'z', screen: '/z', screenTitle: { text: '제목 있는 화면', site: {
    ...nodes[3].range, fileId: 'page', fileHash: 'h', text: '<h1>제목 있는 화면</h1>',
  } } };
  const namedEvent = { ...nodes[2], id: 'z-event', control: { tag: 'button', texts: ['지우기'] } };
  const graph = { ...flow, nodes: [...nodes, secondScreen, namedEvent], edges: [...flow.edges,
    { ...flow.edges[0], from: 'z', to: 'z-event' }, { ...flow.edges[1], from: 'z-event' }] };
  const onFollow = vi.fn();
  const suppliedIndex = indexes.featureIndex(indexRoutes, [graph], indexPathOf);
  const index = vi.spyOn(indexes, 'featureIndex');
  let follow: (() => void) | undefined;
  function Probe() {
    const tree = FeatureChooser({ ...chooserProps, onFollow, state: { ...chooserProps.state, routes: indexRoutes,
      groups: featureGroups(project, indexRoutes), groupingProps: { ...chooserProps.state.groupingProps, flows: [graph], index: suppliedIndex } } });
    const pending: React.ReactNode[] = [tree];
    while (pending.length) {
      const item = pending.pop();
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(item)) continue;
      if (item.type === 'button' && item.props.children === '이 기능부터 따라가기') follow = item.props.onClick;
      pending.push(...React.Children.toArray(item.props.children));
    }
    return tree;
  }
  try {
    const html = renderToStaticMarkup(React.createElement(Probe));
    const card = html.slice(html.indexOf('aria-label="처음 따라갈 기능"'), html.indexOf('aria-label="기능 목록"'));
    expect(card).toContain('<b>‘지우기’ 버튼 · 지우기</b>');
    expect(card).toContain('title="화면 /z · src/example.ts onClick 함수">버튼 문구</span>');
    expect(card).toContain('<p class="hint">화면 /z · src/example.ts onClick 함수</p>');
    expect(card).toContain('<p class="hint">지우기 · /api/dogs/0</p>');
    expect(card).toContain('title="훅이 돌려준 값 remove를 써요 · 방식 모름">추정 연결</span>');
    expect(index).not.toHaveBeenCalled();
    expect(follow).toBeTypeOf('function');
    follow!();
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(0, { through: 'z', storyId: 'request@z' });
  } finally { index.mockRestore(); }
});

it('follows the index row with its chosen start and defaults only for unlinked features', () => {
  const onFollow = vi.fn();
  const starts: (() => void)[] = [];
  const flows = [indexFlows[0], { ...indexFlows[1], nodes: [nodes[0]], edges: [] }];
  function Probe() {
    const tree = FeatureList({ ...indexProps, onFollow, flows, index: indexes.featureIndex(indexRoutes, flows, indexPathOf) });
    const pending: React.ReactNode[] = [tree];
    while (pending.length) {
      const item = pending.shift();
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void; 'aria-label'?: string }>(item)) continue;
      if (item.type === 'button' && item.props.children === '이 기능 따라가기') starts.push(item.props.onClick!);
      if (item.type === 'details' && item.props.children && renderToStaticMarkup(item).includes('화면별로 보기')) continue;
      if (item.type === 'details' && renderToStaticMarkup(item).includes('서버 주소 기준 목록')) continue;
      pending.push(...React.Children.toArray(item.props.children));
    }
    return tree;
  }
  renderToStaticMarkup(React.createElement(Probe));
  expect(starts).toHaveLength(2);
  starts.forEach(start => start());
  expect(onFollow.mock.calls).toEqual([[0, { through: 'screen', storyId: 'request@screen' }], [1, undefined]]);
});
it('names two through stories from their request steps and preserves the screen when changing stories', () => {
  const second = { ...nodes[1], id: 'request2', name: 'second request', relativePath: 'second.ts' };
  const graph = { ...flow, nodes: [...flow.nodes, second], edges: [...flow.edges, { ...flow.edges[1], to: second.id }] };
  const walk = { ...walkProps.walk, through: 'screen', storyId: 'request@screen' };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: graph, walk }));
  expect(html).toContain('aria-label="요청 고르기"');
  expect(html).toContain('second.ts 1행 · second request');
  const changed = walkSelection(graph, { ...walk, storyId: 'request2@screen' });
  expect(changed.stories).toEqual(['request@screen', 'request2@screen']);
  expect(changed.steps[0].nodes[0].id).toBe('screen');
});

it.each(['current', 'other-routes', 'other-revision', 'stale', 'no-routes', 'ungrouped'] as const)(
  'uses the same available flows for the index, list and following: %s', async state => {
    const revision = 2;
    const currentRoutes = { ...routes, routesId: flow.routesId };
    const entry = state === 'no-routes' ? null : { result: currentRoutes, revision: state === 'stale' ? 1 : revision };
    const cached = { status: 'done', routesId: state === 'other-routes' ? 'old' : currentRoutes.routesId,
      revision: state === 'other-revision' ? 1 : revision, flows: [flow] };
    // Seed the stored guide, route result and batch result; leave the remaining React hooks intact.
    const useState = vi.mocked(ReactHooks.useState)
      .mockImplementationOnce(() => [null, vi.fn()])
      .mockImplementationOnce(() => [entry, vi.fn()])
      .mockImplementationOnce(() => [state === 'ungrouped' ? { status: 'idle' } : cached, vi.fn()]);
    const featureFlow = vi.fn().mockResolvedValue({ ok: true, value: flow });
    vi.stubGlobal('window', { learning: { featureFlow } });
    let features!: ReturnType<typeof useFeatureFlows>;
    function Probe() {
      features = useFeatureFlows(project, revision);
      return React.createElement(FeatureList, { ...features.groupingProps, routes: currentRoutes, groups: features.groups,
        selected: null, disabled: features.stale, search: '', setSearch() {}, onFollow() {} });
    }
    try {
      const html = renderToStaticMarkup(React.createElement(Probe));
      const current = state === 'current';
      expect(features.groupingProps.flows).toBe(current ? cached.flows : null);
      expect(features.groupingProps.index).toEqual(current
        ? indexes.featureIndex(currentRoutes, cached.flows, fileId => project.files.find(file => file.id === fileId)?.relativePath ?? '')
        : null);
      expect(html.includes('aria-label="기능 목차"')).toBe(current);
      expect(html.includes('aria-label="화면 /dogs"')).toBe(current);
      await features.follow(0, { through: 'screen', storyId: 'request@screen' });
      const needsRequest = state === 'other-routes' || state === 'other-revision' || state === 'ungrouped';
      expect(featureFlow).toHaveBeenCalledTimes(needsRequest ? 1 : 0);
      if (needsRequest) expect(featureFlow).toHaveBeenCalledWith({ projectId: project.id, routesId: currentRoutes.routesId, routeIndex: 0 });
    } finally {
      useState.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it('keeps the shared index when only search and the selected step change', () => {
  const useState = vi.mocked(ReactHooks.useState)
    .mockImplementationOnce(() => React.useState<unknown>(null))
    .mockImplementationOnce(() => React.useState<unknown>({ result: indexRoutes, revision: 2 }))
    .mockImplementationOnce(() => React.useState<unknown>({ status: 'done', routesId: indexRoutes.routesId, revision: 2, flows: indexFlows }));
  const compute = vi.spyOn(indexes, 'featureIndex');
  const results: ReturnType<typeof useFeatureFlows>['groupingProps']['index'][] = [];
  function Probe() {
    const features = useFeatureFlows(project, 2);
    results.push(features.groupingProps.index);
    if (!features.search) {
      features.setSearch('삭제');
      features.setStep(1);
    }
    return null;
  }
  try {
    renderToStaticMarkup(React.createElement(Probe));
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBe(results[0]);
    expect(compute).toHaveBeenCalledExactlyOnceWith(indexRoutes, indexFlows, expect.any(Function), undefined);
    expect(compute.mock.calls[0][2]('server')).toBe('api/dogs.controller.ts');
    expect(compute.mock.calls[0][2]('missing')).toBe('');
  } finally {
    useState.mockRestore();
    compute.mockRestore();
  }
});

it('selects a requested node found only in the step other paths', () => {
  const alternate: FlowNode = { ...nodes[2], id: 'alternate', event: null, fileId: 'other-file' };
  const graph = { ...flow, nodes: [...nodes, alternate], edges: [...flow.edges, { ...flow.edges[1], from: alternate.id }] };
  const selection = walkSelection(graph, { ...walkProps.walk, through: 'screen', storyId: 'request@screen', nodeId: alternate.id });
  expect(selection.step?.nodes.some(node => node.id === alternate.id)).toBe(false);
  expect(selection.step?.others).toContain(alternate);
  expect(selection.currentNode).toBe(alternate);
});

it.each([null, 'screen'])('opens the requested cached story, step and node with through=%s', async through => {
  const currentRoutes = { ...routes, routesId: flow.routesId };
  const setWalk = vi.fn();
  const useState = vi.mocked(ReactHooks.useState)
    .mockImplementationOnce(() => [null, vi.fn()])
    .mockImplementationOnce(() => [{ result: currentRoutes, revision: 2 }, vi.fn()])
    .mockImplementationOnce(() => [{ status: 'done', routesId: flow.routesId, revision: 2, flows: [flow] }, vi.fn()])
    .mockImplementationOnce(() => [null, vi.fn()])
    .mockImplementationOnce(() => [walkProps.walk, setWalk]);
  const featureFlow = vi.fn();
  vi.stubGlobal('window', { learning: { featureFlow } });
  let features!: ReturnType<typeof useFeatureFlows>;
  function Probe() { features = useFeatureFlows(project, 2); return null; }
  try {
    renderToStaticMarkup(React.createElement(Probe));
    const start = { through, storyId: through === null ? 'request' : 'request@screen', step: 1, nodeId: 'request' };
    expect(await features.follow(0, start)).toBe(nodes[1]);
    expect(setWalk).toHaveBeenLastCalledWith({ ...walkProps.walk, ...start });
    expect(featureFlow).not.toHaveBeenCalled();
  } finally {
    useState.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each([null, 'api.example.com'])('renders both conditional request rows with unique keys and shared code navigation: %s', host => {
  const requests: ProjectRoutes['requests'] = (['consequence', 'alternative'] as const).map((branch, index) => ({
    ...nodes[1].range, fileId: 'client', fileHash: 'h', text: 'fetch(isNew ? "/api/a" : "/api/b")', host,
    methods: [index ? 'PUT' : 'POST'], prefix: 'known', path: index ? '/api/b' : '/api/a', branch,
    args: [], inTest: false, inFunction: null,
  }));
  const onCode = vi.fn();
  const keys: (string | null)[] = [];
  const open: (() => void)[] = [];
  function Probe() {
    const tree = FlowLimits({ project, routes: { ...routes, requests, links: [] }, flow, locked: false, onCode });
    const pending: React.ReactNode[] = [tree];
    while (pending.length) {
      const item = pending.shift();
      // Preserve raw keys: React.Children.toArray rewrites them with positional prefixes.
      if (Array.isArray(item)) { pending.push(...item); continue; }
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(item)) continue;
      if (item.type === 'li') keys.push(item.key);
      if (item.type === 'button') open.push(item.props.onClick!);
      pending.push(item.props.children);
    }
    return tree;
  }
  const html = renderToStaticMarkup(React.createElement(Probe));
  const prefix = host ? `//${host}` : '';
  expect(html).toContain(`<summary>${host ? '다른 서버 주소 요청' : '이을 주소를 못 찾은 요청'} 2개</summary>`);
  expect(html).toContain(`<code>POST ${prefix}/api/a</code>`);
  expect(html).toContain(`<code>PUT ${prefix}/api/b</code>`);
  expect(html).not.toContain('isNew');
  expect(keys).toHaveLength(2);
  expect(keys.every(key => key !== null)).toBe(true);
  expect(new Set(keys).size).toBe(2);
  expect(open).toHaveLength(2);
  open.forEach(click => click());
  expect(onCode.mock.calls).toEqual([[requests[0]], [requests[1]]]);
  expect(requests[0].startUtf16).toBe(requests[1].startUtf16);
});

it.each([null, ['POST', 'PATCH']])('shows unknown and candidate methods for conditional request rows: %s', methods => {
  const request: ProjectRoutes['requests'][number] = { ...nodes[1].range, fileId: 'client', fileHash: 'h', text: 'original call', host: null,
    methods, prefix: 'known', path: '/api/a', branch: 'consequence', args: [], inTest: false, inFunction: null };
  const html = renderToStaticMarkup(React.createElement(FlowLimits, { project, routes: { ...routes, requests: [request], links: [] },
    flow, locked: false, onCode() {} }));
  expect(html).toContain(`<code>${methods ? 'POST / PATCH' : '방식 모름'} /api/a</code>`);
});

it('keeps the original text for request rows without a branch', () => {
  const request: ProjectRoutes['requests'][number] = { ...nodes[1].range, fileId: 'client', fileHash: 'h', text: 'fetch("/dogs")', host: null,
    methods: ['GET'], prefix: 'known', path: '/dogs', args: [], inTest: false, inFunction: null };
  const html = renderToStaticMarkup(React.createElement(FlowLimits, { project, routes: { ...routes, requests: [request], links: [] },
    flow, locked: false, onCode() {} }));
  expect(html).toContain('<code>fetch(&quot;/dogs&quot;)</code>');
});


it.each([
  ['calls', 'remove 부름'], ['typed', 'remove 부름'], ['event', '화면 이벤트'], ['placed', '화면에 놓음'],
  ['inside', '안쪽 함수'], ['hook', '훅 값'], ['route', '요청 보냄'],
] as const)('labels %s edges with their meaning and optional source line', (kind, label) => {
  const edge: FlowEdge = { ...flow.edges[0], kind, site: { ...nodes[0].range, fileId: 'f', fileHash: 'h', text: 'remove', startLine: 12 } };
  expect(edgeLabel(edge)).toBe(`${label} · 12행`);
  expect(edgeLabel({ ...edge, site: null })).toBe(kind === 'calls' || kind === 'typed' ? '부름' : label);
});

it.each(['calls', 'typed'] as const)('truncates %s names only beyond 20 UTF-16 characters', kind => {
  const edge: FlowEdge = { ...flow.edges[0], kind, site: { ...nodes[0].range, fileId: 'f', fileHash: 'h', text: 'a'.repeat(20) } };
  expect(edgeLabel(edge)).toBe(`${'a'.repeat(20)} 부름 · 1행`);
  expect(edgeLabel({ ...edge, site: { ...edge.site!, text: 'a'.repeat(21) } })).toBe(`${'a'.repeat(20)}… 부름 · 1행`);
});

it.each(['calls', 'typed', 'event', 'placed', 'inside', 'hook', 'route'] as const)(
  'omits only the call name from short %s labels', kind => {
    const edge: FlowEdge = { ...flow.edges[0], kind,
      site: { ...nodes[0].range, fileId: 'f', fileHash: 'h', text: 'remove()', startLine: 12 } };
    expect(edgeLabel(edge, { name: false })).toBe(kind === 'calls' || kind === 'typed' ? '부름 · 12행' : edgeLabel(edge));
    expect(edgeLabel(edge, { name: true })).toBe(edgeLabel(edge));
    expect(edgeLabel(edge, {})).toBe(edgeLabel(edge));
    expect(edgeLabel({ ...edge, site: null }, { name: false })).toBe(edgeLabel({ ...edge, site: null }));
  },
);

it('labels adjacent arrows but leaves crowded cross-lane arrows, skipped rows, upward arrows and self-calls unlabelled', () => {
  vi.mocked(ReactFlow).mockImplementationOnce(() => React.createElement(React.Fragment));
  const input: FeatureFlow = { ...flow, nodes: [...nodes, { ...nodes[2], id: 'last', depth: 0 }], edges: [
    ...[['screen', 'event'], ['screen', 'last'], ['last', 'screen'], ['event', 'event'],
      ['last', 'request'], ['request', 'back']].map(([from, to]): FlowEdge => ({ from, to, kind: 'calls',
      sure: true, reasons: [], site: { ...nodes[0].range, fileId: 'f', fileHash: 'h', text: 'remove()', startLine: 12 } })),
    { ...flow.edges[0], from: 'event', to: 'back', kind: 'typed' },
  ] };
  renderToStaticMarkup(React.createElement(FlowDiagram, { flow: input, selectedNodeId: null, onSelect() {} }));
  const drawn = vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges!;
  expect(drawn.map(edge => edge.label)).toEqual(['remove() 부름 · 12행', undefined, undefined, undefined,
    undefined, '부름 · 12행', undefined]);
  expect(drawn.map(edge => edge.type)).toEqual(['straight', 'smoothstep', 'smoothstep', 'smoothstep',
    'smoothstep', 'straight', 'smoothstep']);
  expect(drawn.map(edge => [edge.source, edge.target])).toEqual(input.edges.map(edge => [edge.from, edge.to]));
  const steps = renderToStaticMarkup(React.createElement(FlowSteps, { flow: input, locked: false, onCode() {}, onFunction() {} }));
  expect(steps).toContain('remove()를 불러요 (12행)');
});

it('passes route options to the canvas and keeps a lone cross-lane label short', () => {
  vi.mocked(ReactFlow).mockImplementationOnce(() => React.createElement(React.Fragment));
  const input: FeatureFlow = { ...flow, edges: [
    { ...flow.edges[1], kind: 'calls', site: { ...nodes[0].range, fileId: 'f', fileHash: 'h', text: 'remove()' } },
    { ...flow.edges[0], from: 'event', to: 'screen' },
    { ...flow.edges[0], from: 'event', to: 'event' },
    flow.edges[0],
  ] };
  renderToStaticMarkup(React.createElement(FlowDiagram, { flow: input, selectedNodeId: null, onSelect() {} }));
  const drawn = vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges!;
  expect(drawn.map(edge => edge.label)).toEqual(['부름 · 1행', undefined, undefined, '안쪽 함수']);
  expect(drawn.map(edge => 'pathOptions' in edge ? edge.pathOptions : undefined)).toEqual([
    { offset: 20, stepPosition: 0.5 }, { offset: 34 }, { offset: 20 }, undefined,
  ]);
  expect(drawn.map(edge => [edge.sourceHandle, edge.targetHandle])).toEqual([
    ['out-right', 'in-left'], ['out-right', 'in-right'], ['out-right', 'in-top'], ['out-bottom', 'in-top'],
  ]);
});

it('keeps all side handles at the same fixed height with and without event and screen tags', () => {
  expect(SIDE_HANDLE_TOP).toBe(24);
  for (const tagged of [false, true]) {
    const node = { ...nodes[2], event: tagged ? 'onClick' : null, screen: tagged ? '/dogs' : null };
    const html = renderToStaticMarkup(React.createElement(ReactFlowProvider, null,
      React.createElement(FlowBoxNode, { id: node.id, data: { node }, type: 'flowBox', selected: false, dragging: false,
        draggable: false, selectable: true, deletable: false, isConnectable: false, zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0 })));
    expect(html.includes('화면 이벤트 onClick')).toBe(tagged);
    expect(html.includes('화면 주소 /dogs')).toBe(tagged);
    const handles = [...html.matchAll(/<div[^>]*data-handleid="([^"]+)"[^>]*>/g)];
    expect(handles.map(([, id]) => id)).toEqual(['in-left', 'in-top', 'in-right', 'out-right', 'out-bottom']);
    for (const [tag, id] of handles) {
      if (id === 'in-top' || id === 'out-bottom') {
        expect(tag).not.toContain('style=');
        continue;
      }
      expect(tag).toContain(`style="top:${SIDE_HANDLE_TOP}px"`);
    }
  }
});

it.each([[0, 240], [8, 1010], [12, 1450], [13, 1560], [14, 1600], [30, 1600]])(
  'sizes the diagram for %i rows with a 1600px cap', (count, height) => {
    vi.mocked(ReactFlow).mockImplementationOnce(() => React.createElement(React.Fragment));
    const input = { ...flow, edges: [], nodes: Array.from({ length: count }, (_, i) => ({ ...nodes[2], id: `node${i}` })) };
    const html = renderToStaticMarkup(React.createElement(FlowDiagram, { flow: input, selectedNodeId: null, onSelect() {} }));
    expect(html).toContain(`data-testid="feature-flow-canvas" style="height:${height}px"`);
    const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    expect(props.zoomOnScroll).toBe(false);
    expect(props.preventScrolling).toBe(false);
    expect(props.fitViewOptions?.maxZoom).toBe(1);
  },
);

it('opens the diagram, evidence strip and steps from the start', () => {
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow }));
  expect(html).toContain('<details class="card" open=""><summary>전체 그림과 단계 보기</summary>');
  expect(html).toContain('aria-label="기능 흐름 지도"');
  expect(html).toContain('aria-label="선택한 연결의 근거"');
  expect(html).toContain('지도에서 상자를 누르면 그 코드가 여기 보여요.');
  expect(html).toContain('aria-label="기능 흐름 단계"');
});

it('keeps the current box during a read or a lane click', () => {
  expect(pickNode(null, 'a', false)).toBe('a');
  expect(pickNode('a', 'b', false)).toBe('b');
  expect(pickNode('a', 'b', true)).toBe('a');
  expect(pickNode(null, 'b', true)).toBeNull();
  for (const side of ['front', 'request', 'back']) expect(pickNode('a', `lane:${side}`, false)).toBe('a');
});

const evidenceSource: SourceView = { projectId: 'p', fileId: 'f', relativePath: 'src/example.ts', hash: 'h',
  text: 'const result = remove();', analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] }, guide: null };
const pickedEvidence = { nodeId: nodes[0].id, result: { ok: true as const, value: evidenceSource } };

it('shows only the matching node result with the original file hash', () => {
  expect(evidenceView(null, null, false)).toEqual({ kind: 'empty', message: '지도에서 상자를 누르면 그 코드가 여기 보여요.' });
  expect(evidenceView(nodes[0], null, false)).toEqual({ kind: 'loading', message: '코드를 읽는 중…' });
  expect(evidenceView(nodes[0], pickedEvidence, false)).toEqual({ kind: 'code', source: evidenceSource });
  expect(evidenceView(nodes[0], { ...pickedEvidence, nodeId: nodes[1].id }, false))
    .toEqual({ kind: 'loading', message: '코드를 읽는 중…' });
  expect(evidenceView(nodes[0], { ...pickedEvidence, result: { ok: true, value: { ...evidenceSource, hash: 'changed' } } }, false))
    .toEqual({ kind: 'changed', message: '흐름을 찾은 뒤 이 파일이 바뀌어 코드를 보여 주지 않았어요. 주소를 다시 찾아 주세요.' });
});

it('hides cached and late-arriving code whenever the flow is stale', () => {
  for (const picked of [null, pickedEvidence, { ...pickedEvidence, nodeId: nodes[1].id }]) {
    expect(evidenceView(nodes[0], picked, true)).toEqual({ kind: 'stale',
      message: '다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.' });
  }
});

it('reports the read failure message without code', () => {
  expect(evidenceView(nodes[0], { nodeId: nodes[0].id, result: { ok: false, code: 'IO', message: '읽기 실패' } }, false))
    .toEqual({ kind: 'error', message: '읽기 실패' });
});


it.each([false, true])('renders the selected code and connections with locked=%s', locked => {
  const text = Array.from({ length: 14 }, (_, index) => `line${index + 1}`).join('\n');
  const selected = { ...nodes[0], range: { startUtf16: 0, endUtf16: text.length, startLine: 1, endLine: 14 } };
  const source = { ...evidenceSource, text };
  const useState = vi.mocked(ReactHooks.useState)
    .mockImplementationOnce(() => [true, vi.fn()])
    .mockImplementationOnce(() => [selected.id, vi.fn()])
    .mockImplementationOnce(() => [{ nodeId: selected.id, result: { ok: true, value: source } }, vi.fn()]);
  try {
    const html = renderToStaticMarkup(walkOf({ ...walkProps, locked, flow: { ...flow, nodes: [selected, ...nodes.slice(1)] } }));
    const strip = html.slice(html.indexOf('<section aria-label="선택한 연결의 근거"'), html.indexOf('<section class="card" aria-label="기능 흐름 단계"'));
    expect(strip).toContain('선택한 연결의 근거 · src/example.ts');
    expect(strip).toContain('서버 쪽 · Controller.remove · 1–14줄');
    expect(strip.match(/class="snippet__line"/g)).toHaveLength(12);
    expect(strip).toContain('이어지는 2줄은 ‘코드 보기’에서 볼 수 있어요.');
    expect(strip).not.toContain('line13');
    expect(strip).toContain('DELETE /dogs/${id} → 이 상자');
    expect(strip).toContain('요청을 보내요 · 주소 글자로 이었어요');
    expect(strip.match(/<button[^>]*>/g)).toHaveLength(2);
    expect(strip.match(/<button[^>]*>/g)!.every(button => button.includes('disabled=""') === locked)).toBe(true);
  } finally { useState.mockRestore(); }
});

it('uses the original snippet button name by default and respects UTF-16 ranges', () => {
  const text = `😀 before\n${Array.from({ length: 13 }, (_, index) => `line${index}`).join('\n')}\nafter`;
  const html = renderToStaticMarkup(React.createElement(Snippet, { source: { ...evidenceSource, text },
    evidence: { startUtf16: text.indexOf('line0'), endUtf16: text.indexOf('\nafter'), startLine: 2, endLine: 14 } }));
  expect(html).toContain('이어지는 1줄은 ‘코드 크게 보기’에서 볼 수 있어요.');
  expect(html).toContain('aria-hidden="true">2</span>line0');
  expect(html).not.toContain('before');
  expect(html).not.toContain('after');
});


it('keeps a changed saved guide visible and deletable when no server routes remain', () => {
  const empty = { ...routes, routes: [], requests: [], links: [] };
  const state = { ...chooserProps.state, routes: empty, groups: [], guide: {
    jobId: 'job', projectId: project.id, routesId: empty.routesId, mode: 'codex' as const, review: 'AI 대조 없음' as const,
    guide: { summary: '예전 요약', groups: [{ name: '예전 묶음', about: '설명', features: [] }], unknowns: [] },
    limitations: [], models: [], savedAt: '2026-10-30T00:00:00.000Z', changed: true,
  }, deleteGuide: async () => {} };
  const html = renderToStaticMarkup(React.createElement(FeatureChooser, { ...chooserProps, state }));
  expect(html).toContain('서버 코드(요청을 받는 곳)를 찾지 못해서');
  expect(html).toContain('기능 정리를 만든 뒤 서버 주소나 그 코드가 바뀌었어요');
  expect(html).toContain('예전 요약'); expect(html).toContain('저장됨 ·');
  expect(html).not.toContain('예전 묶음');
  expect(html).toContain('<button class="btn btn--small">지우기</button>');
  expect(html).toMatch(/<button[^>]*disabled="">AI로 기능 정리하기<\/button>/);
});
