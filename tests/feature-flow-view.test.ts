import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeatureChooser, featureGroups, FeatureList, FeatureOverview, recommendedFeature, FlowSteps, FlowWalk, hasFlowCode, hintSteps, summaryKey, RoutesStatus, useFeatureFlows, walkSelection } from '../src/renderer/feature-flow';
import type { Evidence, FeatureFlow, FlowNode, ProjectRoutes, ProjectView } from '../src/shared/contracts';
import { storyOf } from '../src/core/analysis/flow-story';
import type { FeatureGuide } from '../src/shared/ai';

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
  title: '삭제', codeName: '지우기 · /dogs', walk: { storyId: null, step: 0, nodeId: null, site: null },
  summary: ['', '', ''] as [string, string, string], setSummary() {},
  locked: false, stale: false, setStory() {}, setStep() {}, setNode() {}, onSite() {}, onCode() {}, onFunction() {}, onChoose() {},
};
// In the app the hook works the selection out; here it is worked out the same way from the props.
const walkOf = (props: Omit<Parameters<typeof FlowWalk>[0], 'selection'>) =>
  React.createElement(FlowWalk, { ...props, selection: walkSelection(props.flow, props.walk) });

const fullStoryFlow: FeatureFlow = { ...flow, nodes: [
  ...nodes,
  { ...nodes[2], id: 'prepare', name: 'prepare', event: null, after: [{ when: 'success', action: 'call', target: 'done',
    site: { fileId: 'f', fileHash: 'h', ...nodes[2].range, text: 'done()' } }] },
  { ...nodes[0], id: 'service', depth: 1, stores: [{ model: 'dog', action: 'delete',
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
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow, walk: { storyId: 'request', step: 0, nodeId: 'screen', site: null } }));
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
  expect(walks[0]).toEqual({ storyId: null, step: 0, nodeId: null, site: null });
  expect(walks[1]).toEqual({ storyId: null, step: 0, nodeId: 'back', site });
  expect(walks[2].site).toBeNull();
  if (change === 'step') expect(walks[2]).toMatchObject({ step: 1, nodeId: null });
  if (change === 'node') expect(walks[2]).toMatchObject({ nodeId: 'screen' });
  if (change === 'story') expect(walks[2]).toMatchObject({ storyId: 'request', step: 0, nodeId: null });
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
    { ...nodes[0], name: 'save', stores: [{ model: 'dog', action: 'upsert', site }], storesOmitted: 3 },
    { ...nodes[0], id: 'service', depth: 1, name: 'save', stores: [{ model: null, action: 'raw', site: { ...site, fileId: 'other', text: 'prisma.$queryRaw`SQL`' } }] },
  ] };
  const html = renderToStaticMarkup(walkOf({ ...walkProps, flow: changed, walk: { ...walkProps.walk, step: 2 }, locked: true }));
  expect(html).toContain('aria-label="저장소 호출"');
  expect(html.match(/<h4>save<\/h4>/g)).toHaveLength(2);
  expect(html).toContain('dog 없으면 새로 저장하고 있으면 바꾸기');
  expect(html).toContain('SQL 직접 실행');
  expect(html).toContain('<code>prisma.dog. upsert()</code>');
  expect(html).toContain('외 3개 더');
  expect(html).toContain('Prisma 호출 모양으로 찾았어요. 함수 안에서는 코드에 적힌 순서이고, 조건에 따라 일부만 실행될 수 있어요.');
  expect(html).toContain('함수끼리 어떤 순서로 실행되는지는 확인하지 않았어요.');
  expect(html.match(/<button[^>]*>이 줄 보기<\/button>/g)!.every(button => button.includes('disabled=""'))).toBe(true);
});

it('renders the sixth step button and folded outside calls with their total count', () => {
  const site = { fileId: 'f', fileHash: 'h', startUtf16: 1, endUtf16: 2, startLine: 1, endLine: 1, text: 'prisma.dog.delete()' };
  const changed: FeatureFlow = { ...flow, nodes: [...nodes,
    { ...nodes[2], id: 'prepare', name: 'prepare', event: null },
    { ...nodes[0], id: 'service', depth: 1, outside: ['external()'], outsideOmitted: 4, stores: [{ model: 'dog', action: 'delete', site }] },
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
  const html = renderToStaticMarkup(React.createElement(FeatureList, { groups, routes, selected: 0, disabled: true, search: '', setSearch() {}, onFollow() {} }));
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
  expect(recommendedFeature(groups)).toBe(groups[1].features[0]);
});
it('keeps the first feature in display order when sure counts tie', () => {
  const tied = withFeatures(() => ({ sure: 2 }));
  expect(recommendedFeature(tied)).toBe(tied[0].features[0]);
});
it('does not recommend an empty list or features without sure links', () => {
  expect(recommendedFeature([])).toBeNull();
  expect(recommendedFeature(withFeatures(() => ({ sure: 0 })))).toBeNull();
});

const chooserProps: Parameters<typeof FeatureChooser>[0] = {
  project: { ...project, warnings: ['파일별 최대 256 KiB까지만 읽어요.'] },
  state: { routes, groups, stale: false, finding: false, error: '', guide: null, search: '', selected: null,
    setSearch() {}, setGuideResult() {}, find() {}, cancelFind() {},
  } as unknown as Parameters<typeof FeatureChooser>[0]['state'],
  revision: 0, locked: false, mode: 'local-worker', running: false, checking: false, connections: null,
  onFollow() {}, async onInspect() { return null; }, onRunning() {},
};
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
  expect(html).toMatch(/<section aria-label="기능 목록"><h3>기능 고르기<\/h3><div class="feature-guide-ai"[^>]*>.*?AI로 기능 정리하기<\/button><\/div><label>/);
  expect(html).toContain('이 기능에 요청을 보내는 코드 3곳을 확실히 찾았어요. 요청을 보내는 쪽부터 서버까지 따라가 볼 수 있어요.');
  expect(html).toContain('고른 기준: 요청을 보내는 코드와 확실히 이어진 곳이 가장 많은 기능');
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
  const props = { routes, selected: null, disabled: false, search: '', setSearch() {}, onFollow() {} };
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
