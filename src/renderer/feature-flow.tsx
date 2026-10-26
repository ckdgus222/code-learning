import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position, type Edge, type Node } from '@xyflow/react';
import type { Evidence, SourceView, CallTarget, FeatureFlow, FlowEdge, FlowNode, ProjectRoutes, ProjectView, Request, ValueSite } from '../shared/contracts';
import { ARROW_MARKER, firstRows, MapCanvas, Omitted } from './project-map';
import { screenGroups, type RouteRow } from './screen-groups';
import { featureIndex, type IndexFeature, type IndexGroup } from './feature-index';
import { layoutFlow } from './flow-layout';
import { isNextConfig, nextRouteOf } from '../core/analysis/next-routes';
import type { ConnectionReport, FeatureGuide, FeatureGuideResult, LearningMode } from '../shared/ai';
import { FeatureGuideCard } from './feature-guide';
import { afterText, afterWhen, byWhen, codeNameOf, groupNameOf, stopText, storeText, storyOf, routeLabel, zoneOf, type StoryStep } from '../core/analysis/flow-story';

export const AFTER_FLOW_NOTE = '코드 모양(onSuccess, await 다음 줄, catch)으로 찾았어요. 실제로 실행되는 순서와 여부는 확인하지 않았어요.';
export const STORE_FLOW_NOTE = 'Prisma 호출 모양으로 찾았어요. 함수 안에서는 코드에 적힌 순서이고, 조건에 따라 일부만 실행될 수 있어요.';
export const FLOW_ORDER_NOTE = '함수끼리 어떤 순서로 실행되는지는 확인하지 않았어요.';

export const siteOf = (node: FlowNode): ValueSite => ({ fileId: node.fileId, fileHash: node.fileHash, ...node.range, text: node.name });
const targetOf = (node: FlowNode): CallTarget => ({ fileId: node.fileId, fileHash: node.fileHash, ...node.range, name: node.name });

export function stepQuestion(feature: string, stepNumber: number, stepTitle: string): string {
  return `‘${feature.slice(0, 80)}’ 기능의 ${stepNumber}번째 단계 ‘${stepTitle.slice(0, 80)}’에서 이 함수가 하는 일을 쉽게 설명해 주세요. `
    + '무엇을 받아서, 무엇을 확인하고, 무엇을 돌려주거나 바꾸는지 알려 주고, 실패하거나 멈추는 경우도 적어 주세요.';
}

/** The two ways out of a step: the code range itself, and that function's own flow (a request is not a function). */
function NodeButtons({ node, locked, onCode, onFunction }: {
  node: FlowNode; locked: boolean; onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
}) {
  return <>
    <button className="btn btn--small" disabled={locked} onClick={() => onCode(siteOf(node))}>코드 보기</button>{' '}
    {node.side !== 'request' && <button className="btn btn--small" disabled={locked}
      onClick={() => onFunction(targetOf(node))}>이 함수 흐름</button>}
  </>;
}

export interface Walk {
  through: string | null;
  storyId: string | null;
  step: number;
  nodeId: string | null;
  site: ValueSite | null;
}
const firstWalk: Walk = { through: null, storyId: null, step: 0, nodeId: null, site: null };

export function summaryKey(codeName: string, handler: FlowNode, request: FlowNode | null): string {
  return `${codeName}|${handler.relativePath}:${handler.range.startUtf16}|${request ? `${request.relativePath}:${request.range.startUtf16}` : 'server'}`;
}

const otherCountOf = (step: StoryStep) => step.stops.items.length + step.stops.omitted + step.asks.items.length + step.asks.omitted;

export function hintSteps(steps: StoryStep[]): { takes: number | null; checks: number | null; returns: number | null } {
  const request = steps.findIndex(step => step.kind === 'request');
  const other = steps.findIndex(step => otherCountOf(step) > 0);
  const back = steps.findIndex(step => step.kind === 'back');
  const handler = steps.findIndex(step => step.kind === 'handler');
  const result = steps.findIndex(step => step.kind === 'result');
  const store = steps.findIndex(step => step.kind === 'store');
  const lastServer = steps.findLastIndex(step => step.kind === 'handler' || step.kind === 'back');
  return {
    takes: request >= 0 ? request : steps.length ? 0 : null,
    checks: other >= 0 ? other : back >= 0 ? back : handler >= 0 ? handler : null,
    returns: result >= 0 ? result : store >= 0 ? store : lastServer >= 0 ? lastServer : null,
  };
}

export type WalkSelection = ReturnType<typeof walkSelection>;
export function walkSelection(flow: FeatureFlow | null, walk: Walk) {
  const all = flow ? storyOf(flow, walk.through) : [];
  const stories = [...new Set(all.map(step => step.storyId))];
  const storyId = walk.storyId ?? stories[0];
  const steps = all.filter(step => step.storyId === storyId);
  const step = steps[walk.step];
  const currentNode = step?.nodes.find(node => node.id === walk.nodeId)
    ?? step?.others.find(node => node.id === walk.nodeId) ?? step?.representative ?? null;
  return { stories, storyId, steps, step, currentNode, all };
}

export function hasFlowCode(source: Pick<SourceView, 'fileId' | 'hash'> | null, evidence: Evidence | null,
  node: FlowNode, site: ValueSite | null = null): boolean {
  const target = site ?? siteOf(node);
  return !!source && !!evidence && source.fileId === target.fileId && source.hash === target.fileHash
    && evidence.fileId === target.fileId && evidence.fileHash === target.fileHash
    && evidence.startUtf16 === target.startUtf16 && evidence.endUtf16 === target.endUtf16
    && evidence.startLine === target.startLine && evidence.endLine === target.endLine;
}

const codeHint = (site: ValueSite) => <code>{site.text.replace(/\s+/g, ' ')}</code>;

function SiteList({ items, omitted, disabled, onSite }: {
  items: { nodeId: string; site: ValueSite; text: string; hint: React.ReactNode }[];
  omitted: number; disabled: boolean; onSite(nodeId: string, site: ValueSite): void;
}) {
  return <>
    <ul className="map-list">{items.map(item => <li key={`${item.nodeId}:${item.site.fileId}:${item.site.startUtf16}`}>
      {item.text}{' '}
      <button className="btn btn--small" disabled={disabled} onClick={() => onSite(item.nodeId, item.site)}>이 줄 보기</button>
      {item.hint !== null && <p className="hint">{item.hint}</p>}
    </li>)}</ul>
    {omitted > 0 && <p className="hint">외 {omitted}개 더</p>}
  </>;
}

export function FlowWalk({ flow, title, about, codeName, walk, selection, setStory, setStep, setNode, locked, stale,
  summary, setSummary, onFunction, onCode, onSite, onChoose, onAsk, children }: {
  flow: FeatureFlow; title: string; about?: string; codeName: string; walk: Walk; selection: WalkSelection;
  setStory(id: string): void; setStep(index: number): void; setNode(id: string): void;
  summary: [string, string, string]; setSummary(index: 0 | 1 | 2, value: string): void;
  locked: boolean; stale: boolean; onFunction(target: CallTarget): void; onCode(site: ValueSite): void;
  onSite(nodeId: string, site: ValueSite): void;
  onAsk(node: FlowNode, question: string, topic: string): void;
  onChoose(): void; children?: React.ReactNode;
}) {
  const { stories, storyId, steps, step, currentNode } = selection;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [picks, setPicks] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusHint = useRef(false);
  useLayoutEffect(() => {
    if (!focusHint.current) return;
    stepHeading.current?.focus();
    focusHint.current = false;
  }, [step]);
  const disabled = locked || stale;
  const otherCount = step ? otherCountOf(step) : 0;
  const screenEvidence = steps[0]?.screenEvidence ?? false;
  const zones = new Set(steps.map(item => zoneOf[item.kind]));
  // A request alone still has code that sent it, so the front box shows with the arrow.
  const front = zones.has('front') || zones.has('arrow');
  const server = zones.has('server');
  const store = zones.has('store');
  const here = step && zoneOf[step.kind];
  const request = steps.find(item => item.kind === 'request');
  const hints = hintSteps(steps);
  const fields = [
    { label: '받는 것', hint: hints.takes, suffix: '을(를) 받아서, ' },
    { label: '확인하는 것', hint: hints.checks, suffix: '을(를) 확인하고, ' },
    { label: '돌려주는 것', hint: hints.returns, suffix: '을(를) 돌려줘요.' },
  ];
  function showHint(index: number) {
    if (disabled) return;
    if (index === walk.step) { stepHeading.current?.focus(); return; }
    focusHint.current = true;
    setStep(index);
  }
  return <section aria-label="기능 따라가기">
    <div className="map-actions"><h3>{title}</h3><button className="btn" disabled={locked} onClick={onChoose}>다른 기능 고르기</button></div>
    {(about || codeName !== title) && <p>{about && `${about} · `}{codeName !== title && codeName}</p>}
    {!flow.nodes.some(node => node.side === 'request') && <p>프론트 시작점은 찾지 못했어요</p>}
    {stories.length > 1 && <div role="group" aria-label="요청 고르기">요청 고르기: {stories.map(id => {
      const request = selection.all.find(step => step.storyId === id && step.kind === 'request')!.representative;
      return <button key={id} className="btn btn--small" aria-pressed={storyId === id} disabled={disabled}
        onClick={() => setStory(id)}>{request.relativePath} {request.range.startLine}행 · {request.name}</button>;
    })}</div>}
    {step && currentNode && <>
      {/* Above the step: the code below it can be long, and the way on should stay in view. */}
      <nav aria-label="이야기 단계" className="flow-nav">
        <button className="btn" disabled={disabled || walk.step === 0} onClick={() => setStep(walk.step - 1)}>◀ 이전</button>
        <div className="flow-nav__steps">{steps.map((item, index) => <button key={item.kind} className="btn" disabled={disabled}
          aria-label={`${index + 1}단계 ${item.label}`} aria-current={index === walk.step ? 'step' : undefined}
          onClick={() => setStep(index)}>{String.fromCodePoint(0x2460 + index)} {item.label}</button>)}</div>
        <button className="btn" disabled={disabled || walk.step === steps.length - 1} onClick={() => setStep(walk.step + 1)}>다음 ▶</button>
      </nav>
      <ol className="picture picture--mini" aria-label="지금 여기">
        {front && <li className="picture__box" aria-current={here === 'front' ? 'location' : undefined}>
          <b>{screenEvidence ? '화면 쪽' : '요청을 보내는 코드'}</b>
          <p>{screenEvidence ? '사람이 보고 누르는 곳' : '서버에 부탁(요청)을 보내는 코드'}</p>
        </li>}
        {request && <li className="picture__arrow" aria-current={here === 'arrow' ? 'location' : undefined}>
          <span aria-hidden="true">→</span>
          {step.kind === 'request' && <p>부탁(요청)이 가는 중</p>}
          {request.inferred && <p><span className="tag tag--unknown">추정 연결</span> {request.reasons.join(' · ')}</p>}
        </li>}
        {server && <li className="picture__box" aria-current={here === 'server' ? 'location' : undefined}>
          <b>서버 쪽</b><p>부탁을 받아 일을 하는 곳</p>
        </li>}
        {server && store && <li className="picture__arrow"><span aria-hidden="true">→</span></li>}
        {store && <li className="picture__box" aria-current={here === 'store' ? 'location' : undefined}>
          <b>저장소(DB)</b><p>정보를 오래 보관하는 곳</p>
        </li>}
      </ol>
      <p>지금 여기: {title} 기능의 {walk.step + 1}번째 단계 · {step.label}
        {step.kind === 'result' && ` · ${screenEvidence ? '응답이 돌아와 화면 쪽으로 다시 왔어요' : '요청 뒤 처리 코드를 보고 있어요'}`}</p>
      <article className="card" data-testid="story-step" data-kind={step.kind}>
        <p>{walk.step + 1} / {steps.length} · {step.label}</p>
        <h3 ref={stepHeading} tabIndex={-1}>{step.title}</h3><p>{step.text}</p>
        {otherCount > 0 && <section aria-label="다른 경우">
          <h4>다른 경우 {otherCount}개</h4>
          <SiteList items={[...step.stops.items.map(stop => ({ nodeId: stop.nodeId, site: stop.site, text: stopText(stop),
            hint: stop.condition !== null ? <>조건(코드): <code>{stop.condition}</code></> : null })),
            ...step.asks.items.map(ask => ({ nodeId: ask.nodeId, site: ask.site,
              text: `${ask.message === null ? '' : `‘${ask.message}’ `}확인 창에서 취소하면 여기서 멈춰요`,
              hint: codeHint(ask.site) }))]}
            omitted={step.stops.omitted + step.asks.omitted} disabled={disabled} onSite={onSite} />
          {step.stops.items.length + step.stops.omitted > 0 && <p className="hint">코드에 적힌 오류예요. 다른 곳에서 이 오류를 잡아 계속 진행하는지는 확인하지 않았어요.</p>}
        </section>}
        {step.afterGroups.groups.length > 0 && <section aria-label="응답 뒤 화면">
          {step.afterGroups.groups.map(group => <section key={group.node.id}>
            <h4>{group.node.name}</h4>
            {byWhen(group.items).map(({ when, items }) => <section key={when}>
              <h5>{afterWhen[when]}</h5>
              <SiteList items={items.map(item => ({ nodeId: group.node.id,
                site: item.site, text: afterText(item), hint: codeHint(item.site) }))}
                omitted={0} disabled={disabled} onSite={onSite} />
            </section>)}
          </section>)}
          {step.afterGroups.omitted > 0 && <p className="hint">외 {step.afterGroups.omitted}개 더</p>}
          <p className="hint">{AFTER_FLOW_NOTE}</p>
          {step.afterGroups.groups.length > 1 && <p className="hint">{FLOW_ORDER_NOTE}</p>}
        </section>}
        {step.storeGroups.groups.length > 0 && <section aria-label="저장소 호출">
          {step.storeGroups.groups.map((group, index) => <section key={group.node.id}>
            <h4>{group.node.name}</h4>
            <SiteList items={group.items.map(store => ({ nodeId: group.node.id, site: store.site, text: storeText(store),
              hint: codeHint(store.site) }))}
              omitted={index === step.storeGroups.groups.length - 1 ? step.storeGroups.omitted : 0} disabled={disabled} onSite={onSite} />
          </section>)}
          <p className="hint">{STORE_FLOW_NOTE}</p>
          {step.storeGroups.groups.length > 1 && <p className="hint">{FLOW_ORDER_NOTE}</p>}
        </section>}
        {step.outside.items.length > 0 && <details><summary>코드에서 부르는 다른 것 {step.outside.items.length + step.outside.omitted}개</summary>
          <ul className="map-list">{step.outside.items.map((text, index) => <li key={index}><code>{text}</code></li>)}</ul>
          {step.outside.omitted > 0 && <p className="hint">외 {step.outside.omitted}개 더</p>}
        </details>}
        {step.inferred && <p><span className="tag tag--unknown">추정</span> {step.reasons.join(' · ')}</p>}
        {step.typed && <p><span className="tag tag--doc">타입으로 찾음</span></p>}
        {step.stopped && <p>서로 부르는 함수가 있어 여기서 멈췄어요</p>}
        {step.nodes.length > 1 && <div role="group" aria-label="이 단계의 함수">이 단계의 함수: {step.nodes.map(node =>
          <button key={node.id} className="btn btn--small" aria-pressed={node.id === currentNode.id} disabled={disabled}
            onClick={() => setNode(node.id)}>{node.name}</button>)}</div>}
        <p>근거: {currentNode.relativePath} · {currentNode.name}{' '}
          {currentNode.side !== 'request' && <>
            <button className="btn btn--small" disabled={disabled}
              onClick={() => onFunction(targetOf(currentNode))}>이 함수 안 순서</button>{' '}
            <button className="btn btn--small" disabled={disabled}
              onClick={() => onAsk(currentNode, stepQuestion(title, walk.step + 1, step.title), title)}>AI에게 쉽게 물어보기</button>
          </>}
        </p>
        {children}
      </article>
      {walk.step === steps.length - 1 && <section className="card flow-summary" aria-label="한 문장으로 정리">
        <h3>한 문장으로 정리해 보기</h3>
        <p>내 말로 적어 보는 칸이에요. 맞는지 채점하지 않아요. 이 프로젝트를 닫으면 사라져요.</p>
        <p>이 기능은 {fields.map((field, index) => <React.Fragment key={field.label}>
          <span className="flow-summary__field">
            <input aria-label={field.label} maxLength={120} value={summary[index]}
              onChange={event => setSummary(index as 0 | 1 | 2, event.currentTarget.value)} />
            {field.hint !== null && <button className="btn btn--small" disabled={disabled}
              onClick={() => showHint(field.hint!)}>힌트 단계 보기</button>}
          </span>{field.suffix}
        </React.Fragment>)}</p>
        {summary.every(value => value.trim().length > 0) && <p data-testid="summary-sentence">
          이 기능은 {fields.map((field, index) => summary[index] + field.suffix).join('')}
        </p>}
      </section>}
      {step.others.length > 0 && <details className="card"><summary>다른 곳에서도 불러요</summary>
        <ul className="map-list">{step.others.map(node => <li key={node.id}>
          <span className="path">{node.relativePath}</span> · <b>{node.name}</b>{' '}
          <NodeButtons node={node} locked={disabled} onCode={onCode} onFunction={onFunction} />
        </li>)}</ul>
      </details>}
    </>}
    <FoldedDetails key={`${flow.routesId}:${flow.routeIndex}`} summary="전체 그림과 단계 보기">
      <FlowDiagram flow={flow} selectedNodeId={selectedNodeId} onSelect={id => { setSelectedNodeId(id); setPicks(count => count + 1); }} />
      <FlowSteps flow={flow} locked={disabled} onCode={onCode} onFunction={onFunction} selectedNodeId={selectedNodeId} picks={picks} />
    </FoldedDetails>
  </section>;
}

export function FeatureOverview({ project, routes, guide }: { project: ProjectView; routes: ProjectRoutes; guide?: FeatureGuide }) {
  // The page re-renders on every search keystroke; these read every project file, so they are worked out once.
  const summary = useMemo(() => {
    const paths = project.files.map(file => file.relativePath);
    const pathById = new Map(project.files.map(file => [file.id, file.relativePath]));
    const next = paths.some(isNextConfig);
    const screens = next ? paths.filter(path => /\/page\.(?:tsx|jsx|ts|js)$/.test(path) && nextRouteOf(path, paths)?.kind === 'page').length : 0;
    const sure = new Set(routes.links.filter(link => link.sure).map(link => link.requestIndex));
    const inferred = new Set(routes.links.filter(link => !link.sure && !sure.has(link.requestIndex)).map(link => link.requestIndex));
    const local = routes.requests.filter(request => !request.host);
    const topFolder = (ids: string[]) => {
      const folders = new Set(ids.map(id => {
        const path = pathById.get(id);
        return path?.includes('/') ? path.split('/')[0] : null;
      }));
      return folders.size === 1 ? [...folders][0] : null;
    };
    return { screens, local: local.length, external: routes.requests.length - local.length,
      sure: sure.size, inferred: inferred.size,
      // Counted like FlowLimits' '이을 주소를 못 찾은 요청' so both screens show the same number.
      unlinked: routes.requests.filter((request, index) => !request.host && !sure.has(index) && !inferred.has(index)).length,
      server: topFolder(routes.routes.map(route => route.handler.fileId)), front: topFolder(local.map(request => request.fileId)) };
  }, [project.files, routes]);
  const { screens, local, external, sure, inferred, unlinked, server, front } = summary;
  const routeCount = routes.routes.length;
  // Links exist only between local requests and routes (routes.ts), so a link already means both boxes are drawn.
  const linked = sure + inferred > 0;
  // With no routes the chooser's notice says what is missing and where to go instead.
  return <section className="card" aria-label="큰 그림">
    <h3>이 프로젝트는 이렇게 나뉘어요</h3>
    {guide && <p><span className="tag tag--unknown">AI 정리</span> {guide.summary}</p>}
    <ol className="picture">
      {screens > 0 && <li className="picture__box">
        <b>화면</b><p>화면 {screens}개</p><p>사람이 보고 누르는 곳</p>
      </li>}
      {local > 0 && <li className="picture__box">
        <b>요청을 보내는 코드</b><p>요청 {local}개</p>{front && <p>{front} 폴더</p>}<p>서버에 부탁(요청)을 보내는 코드</p>
      </li>}
      {linked && <li className="picture__arrow">
        <span>→</span><p>확실히 이어짐 {sure}개 · 추정 {inferred}개</p>
      </li>}
      {routeCount > 0 && <li className="picture__box">
        <b>서버</b><p>기능 {routeCount}개</p>{server && <p>{server} 폴더</p>}<p>부탁을 받아 일을 하는 곳</p>
      </li>}
    </ol>
    {unlinked > 0 && routeCount > 0 && <p>서버 주소를 찾지 못한 요청 {unlinked}개</p>}
    {local > 0 && routeCount > 0 && !linked && <p>요청을 보내는 코드와 서버 사이의 연결은 확인하지 못했어요.</p>}
    {external > 0 && <p>다른 서버로 보내는 요청 {external}개</p>}
    {screens === 0 && <p>화면은 찾지 못했어요. 지금은 Next.js 화면만 알아봐요.</p>}
    {sure > 0 && <p><span className="tag">일반 설명</span> 웹 프로그램은 보통 이렇게 움직여요. 사람이 화면에서 버튼을 누르면, 화면 쪽 코드가 서버에 요청(부탁)을 보내고, 서버가 일을 한 뒤 결과를 돌려줘요. 이 프로젝트에서 실제로 어떻게 이어지는지는 기능을 하나 골라 따라가 보면 확인할 수 있어요.</p>}
  </section>;
}

/** Starts folded and draws its contents only once opened: a canvas laid out while folded has no size, and its fit leaves the boxes out of view. */
function FoldedDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && children}
  </details>;
}

function FlowDiagram({ flow, selectedNodeId, onSelect }: {
  flow: FeatureFlow; selectedNodeId: string | null; onSelect(id: string): void;
}) {
  // The search box and step clicks re-render the page; the canvas only needs new boxes when these change.
  const nodes = useMemo((): Node[] => layoutFlow(flow).map(({ node, x, y }) => ({
    id: node.id, position: { x, y }, sourcePosition: Position.Right, targetPosition: Position.Left,
    className: `map-box feature-box feature-box--${node.side}`, selected: selectedNodeId === node.id,
    ariaLabel: `${node.relativePath} · ${node.name}`,
    data: { label: <span className="map-box__label">
      <small className="feature-box__file" title={node.relativePath}>{node.relativePath.split('/').at(-1)}</small>
      <b className="feature-box__name" title={node.name}>{node.name}</b>
      {node.event && <span className="tag tag--doc">화면 이벤트 {node.event}</span>}
      {node.screen !== null && <span className="tag tag--doc" title={`화면 주소 ${node.screen}`}>화면 주소 {node.screen}</span>}
    </span> },
  })), [flow, selectedNodeId]);
  const edges = useMemo((): Edge[] => flow.edges.map((edge, index) => ({
    id: `flow-edge:${index}`, source: edge.from, target: edge.to,
    label: edge.site ? `${edge.site.startLine}행` : undefined,
    className: `map-arrow${!edge.sure ? ' feature-arrow--inferred' : edge.kind === 'typed' ? ' feature-arrow--typed' : ''}`,
    markerEnd: ARROW_MARKER,
  })), [flow]);
  return <section aria-label="기능 흐름 지도">
    <p className="hint">왼쪽 화면 → 오른쪽 서버 · 점선은 추정·타입으로 찾음</p>
    <MapCanvas testId="feature-flow-canvas" nodes={nodes} edges={edges} onNodeClick={onSelect} />
  </section>;
}

function edgeText(edge: FlowEdge): string {
  const line = edge.site ? ` (${edge.site.startLine}행)` : '';
  switch (edge.kind) {
    case 'placed': return `${edge.site?.text ?? '컴포넌트'}로 화면에 놓아요${line}`;
    case 'inside': return `바깥 함수 안에 있어요${line}`;
    case 'hook': return `${edge.reasons.join(' · ')}${line}`;
    case 'event': return `화면 이벤트에서 ${edge.site?.text ?? '함수'}를 불러요${line}`;
    case 'typed': return `${edge.site?.text ?? '함수'}를 불러요 · 타입으로 찾음${line}`;
    case 'route': return `요청을 보내요 · 주소 글자로 이었어요${line}`;
    case 'calls': return `${edge.site?.text ?? '함수'}를 불러요${line}`;
  }
}

export function FlowSteps({ flow, locked, onCode, onFunction, selectedNodeId = null, picks = 0 }: {
  flow: FeatureFlow; locked: boolean; onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
  selectedNodeId?: string | null;
  /** Counts picks on the diagram, so choosing the same box again scrolls back to its step. */
  picks?: number;
}) {
  const requests = flow.nodes.filter(node => node.side === 'request');
  const groups = requests.length ? requests : [null];
  const section = useRef<HTMLElement>(null);
  // A box chosen on the diagram brings its step into view before the screen is drawn; the list knows where its steps are.
  useLayoutEffect(() => {
    if (selectedNodeId) section.current?.querySelector(`[data-node-id="${CSS.escape(selectedNodeId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [selectedNodeId, picks]);
  return <section ref={section} className="card" aria-label="기능 흐름 단계">
    <h3>기능 흐름 단계</h3>
    {groups.map(request => {
      const upstream = new Set<string>();
      const collect = (id: string) => {
        if (upstream.has(id)) return;
        upstream.add(id);
        flow.edges.filter(edge => edge.to === id).forEach(edge => collect(edge.from));
      };
      if (request) collect(request.id);
      const rank = (node: FlowNode) => node.side === 'front' ? -node.depth : node.side === 'request' ? 0 : node.depth + 1;
      const nodes = flow.nodes.filter(node => node.side === 'back' || upstream.has(node.id)).sort((a, b) => rank(a) - rank(b));
      return <div key={request?.id ?? 'back'}>
        {request && <h4>{request.name} · {request.relativePath} {request.range.startLine}행</h4>}
        <ol className="feature-steps">{nodes.map(node => <li key={node.id} data-testid="feature-step" data-node-id={node.id}
          aria-current={selectedNodeId === node.id ? 'step' : undefined}>
          <span className="path">{node.relativePath}</span> · <b>{node.name}</b>{' '}
          {node.screen !== null && <span className="tag tag--doc">화면 주소 {node.screen}</span>}{' '}
          {node.event && <span className="tag tag--doc">화면 이벤트 {node.event}</span>}
          {flow.edges.filter(edge => edge.from === node.id && nodes.some(next => next.id === edge.to)).map((edge, index) => <p key={index}>
            {!edge.sure && <span className="tag tag--unknown">추정</span>} {edgeText(edge)}
            {!edge.sure && edge.kind !== 'hook' && <> · {edge.reasons.join(' · ')}</>}
          </p>)}
          {node.outside.length > 0 && <p className="hint">바깥 호출: {node.outside.join(' · ')}{node.outsideOmitted > 0 && ` · 외 ${node.outsideOmitted}개`}</p>}
          <NodeButtons node={node} locked={locked} onCode={onCode} onFunction={onFunction} />
        </li>)}</ol>
      </div>;
    })}
    {flow.limited && <p className="notice notice--warn">일부 흐름만 확인했어요.</p>}
    {flow.notes.map(note => <p key={note} className="hint">{note}</p>)}
  </section>;
}

type GuideFeature = { name: string; about: string; routes: number[]; ai: boolean; sure: number; inferred: number; haystack: string };
/**
 * AI groups and unmentioned routes share one list; every feature still opens one existing route flow. Counts and
 * the search text are worked out here once, as the list re-renders on every search keystroke.
 */
export function featureGroups(project: ProjectView, routes: ProjectRoutes, guide?: FeatureGuide) {
  const groups: { name: string; about: string; features: GuideFeature[] }[] = [];
  const pathById = new Map(project.files.map(file => [file.id, file.relativePath]));
  const counts = new Map<number, { sure: number; inferred: number }>();
  for (const link of routes.links) {
    const count = counts.get(link.routeIndex) ?? { sure: 0, inferred: 0 };
    if (link.sure) count.sure++; else count.inferred++;
    counts.set(link.routeIndex, count);
  }
  const feature = (name: string, about: string, indexes: number[], ai: boolean): GuideFeature => {
    const sorted = [...indexes].sort((a, b) => (counts.get(b)?.sure ?? 0) - (counts.get(a)?.sure ?? 0) || a - b);
    return { name, about, ai, routes: sorted,
      sure: sorted.reduce((sum, index) => sum + (counts.get(index)?.sure ?? 0), 0),
      inferred: sorted.reduce((sum, index) => sum + (counts.get(index)?.inferred ?? 0), 0),
      haystack: `${name} ${sorted.map(index => `${routeLabel(routes.routes[index])} ${routes.routes[index].handler.name}`).join(' ')}`.toLowerCase() };
  };
  const mentioned = new Set<number>();
  for (const group of guide?.groups ?? []) {
    group.features.forEach(item => item.routes.forEach(index => mentioned.add(index)));
    groups.push({ name: group.name, about: group.about, features: group.features.map(item => feature(item.name, item.about, item.routes, true)) });
  }
  const left = routes.routes.map((route, index) => ({ route, index })).filter(({ index }) => !mentioned.has(index));
  if (guide) {
    if (left.length) groups.push({ name: '정리되지 않은 기능', about: '', features: left.map(({ route, index }) => feature(codeNameOf(route), route.handler.name, [index], false)) });
    return groups;
  }
  const byFile = new Map<string, typeof groups[number]>();
  for (const { route, index } of left) {
    const path = pathById.get(route.handler.fileId) ?? '';
    let group = byFile.get(path);
    if (!group) { group = { name: groupNameOf(route, path), about: path, features: [] }; byFile.set(path, group); groups.push(group); }
    group.features.push(feature(codeNameOf(route), route.handler.name, [index], false));
  }
  return groups;
}

export type FlowStart = { through: string | null; storyId: string; step?: number; nodeId?: string };
type GroupingState = { status: 'idle' } | { status: 'running' } | { status: 'failed'; message: string }
  | { status: 'done'; routesId: string; revision: number; flows: FeatureFlow[] };

export function useFeatureFlows(project: ProjectView | null, revision: number) {
  const [guideResult, setGuideResult] = useState<FeatureGuideResult | null>(null);
  const [entry, setEntry] = useState<{ result: ProjectRoutes; revision: number } | null>(null);
  const [grouping, setGrouping] = useState<GroupingState>({ status: 'idle' });
  const [flow, setFlow] = useState<FeatureFlow | null>(null);
  const [walk, setWalk] = useState<Walk>(firstWalk);
  const [summaries, setSummaries] = useState<Map<string, [string, string, string]>>(() => new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const started = useRef(false);
  const routesRun = useRef(0);
  const flowRun = useRef(0);
  const flowsRun = useRef(0);
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const stale = !!entry && entry.revision !== revision;
  const flows = !stale && grouping.status === 'done' && grouping.routesId === entry?.result.routesId
    && grouping.revision === revision ? grouping.flows : null;
  const guide = !stale && guideResult?.routesId === entry?.result.routesId ? guideResult : null;
  useEffect(() => {
    started.current = false;
    setEntry(null); setGuideResult(null); setFlow(null); setWalk(firstWalk); setSelected(null);
    setSummaries(new Map());
    setFinding(false); setFollowing(false); setError(''); setSearch('');
    resetGrouping();
    return () => {
      routesRun.current++; flowRun.current++; flowsRun.current++;
      if (project) void window.learning.cancelRoutes({ projectId: project.id });
    };
  }, [project]);
  useEffect(() => {
    resetGrouping(stale ? '파일이 바뀌었어요. 주소를 다시 찾아 주세요' : '');
    if (stale) {
      if (project) void window.learning.cancelFeatureFlows({ projectId: project.id });
      return;
    }
    if (entry?.result.routes.length) void groupFlows();
  }, [entry, revision]);
  function resetGrouping(message = '') {
    flowsRun.current++;
    setGrouping(message ? { status: 'failed', message } : { status: 'idle' });
  }
  async function groupFlows() {
    if (!project || !entry || stale || !entry.result.routes.length) return;
    const run = ++flowsRun.current;
    const atRevision = revision;
    const routesId = entry.result.routesId;
    setGrouping({ status: 'running' });
    const result = await window.learning.featureFlows({ projectId: project.id, routesId });
    if (run !== flowsRun.current) return;
    if (atRevision !== currentRevision.current) { resetGrouping('파일이 바뀌었어요. 주소를 다시 찾아 주세요'); return; }
    if (!result.ok) { resetGrouping(result.message); return; }
    setGrouping({ status: 'done', routesId, revision: atRevision, flows: result.value });
  }
  function cancelGrouping() {
    resetGrouping('화면별로 묶기를 취소했어요');
    if (project) void window.learning.cancelFeatureFlows({ projectId: project.id });
  }
  async function find() {
    if (!project) return;
    const run = ++routesRun.current;
    flowRun.current++;
    const atRevision = revision;
    setFinding(true); setFollowing(false); setError(''); setEntry(null); setFlow(null); setSelected(null); setWalk(firstWalk);
    const result = await window.learning.routes({ projectId: project.id });
    if (run !== routesRun.current) return;
    setFinding(false);
    if (!result.ok) { setError(result.message); return; }
    if (atRevision !== currentRevision.current) { setError('프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.'); return; }
    setEntry({ result: result.value, revision: atRevision });
  }
  function start() {
    if (!project || started.current) return;
    started.current = true;
    void find();
  }
  async function follow(routeIndex: number, start?: FlowStart) {
    if (!project || !entry || stale) return null;
    const run = ++flowRun.current;
    const atRevision = revision;
    setSelected(routeIndex); setFollowing(true); setError(''); setFlow(null); setWalk(firstWalk);
    const cached = flows?.[routeIndex];
    if (cached) {
      const next = { ...firstWalk, ...start };
      setFlow(cached); setWalk(next); setFollowing(false);
      return walkSelection(cached, next).currentNode;
    }
    const result = await window.learning.featureFlow({ projectId: project.id, routesId: entry.result.routesId, routeIndex });
    if (run !== flowRun.current) return null;
    setFollowing(false);
    if (!result.ok) { setError(result.message); return null; }
    if (atRevision !== currentRevision.current) { setError('프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.'); return null; }
    setFlow(result.value);
    return walkSelection(result.value, firstWalk).currentNode;
  }
  function cancelFind() {
    routesRun.current++; setFinding(false);
    if (project) void window.learning.cancelRoutes({ projectId: project.id });
  }
  function cancelFollow() {
    flowRun.current++; setFollowing(false);
    if (project) void window.learning.cancelFeatureFlow({ projectId: project.id });
  }
  function clearFlow() {
    cancelFollow(); setFlow(null); setSelected(null); setError(''); setWalk(firstWalk);
  }
  function changeWalk(next: Walk) {
    setWalk(next);
    return walkSelection(flow, next).currentNode;
  }
  const routes = entry?.result;
  const groups = useMemo(() => project && routes ? featureGroups(project, routes, guide?.guide) : [], [project, routes, guide]);
  const selection = useMemo(() => walkSelection(flow, walk), [flow, walk]);
  const handler = selection.steps.find(step => step.kind === 'handler')?.representative;
  const request = selection.steps.find(step => step.kind === 'request')?.representative ?? null;
  const route = flow && routes?.routes[flow.routeIndex];
  const key = handler && route ? summaryKey(codeNameOf(route), handler, request) : null;
  const summary: [string, string, string] = key === null ? ['', '', ''] : summaries.get(key) ?? ['', '', ''];
  function setSummary(index: 0 | 1 | 2, value: string) {
    if (key === null) return;
    setSummaries(previous => {
      const next = new Map(previous);
      const values: [string, string, string] = [...(previous.get(key) ?? ['', '', ''])];
      values[index] = value.slice(0, 120);
      next.set(key, values);
      return next;
    });
  }
  // Only an AI-named feature has a name and sentence of its own; a route alone is shown by its code name.
  const selectedFeature = useMemo(() => flow ? groups.flatMap(group => group.features).find(feature => feature.ai && feature.routes.includes(flow.routeIndex)) : undefined,
    [flow, groups]);
  return { routes, finding, stale, error, groupingProps: { flows, guide: guide?.guide,
    grouping: grouping.status === 'running', groupError: grouping.status === 'failed' ? grouping.message : '',
    onRegroup: groupFlows, onCancelGrouping: cancelGrouping }, search, setSearch, guide, setGuideResult, groups, flow, following, selected, walk,
    selection, currentNode: selection.currentNode, selectedFeature, summary, setSummary,
    start, find, cancelFind, follow, cancelFollow, clearFlow,
    setStory: (storyId: string) => changeWalk({ through: walk.through, storyId, step: 0, nodeId: null, site: null }),
    setStep: (step: number) => changeWalk({ ...walk, step, nodeId: null, site: null }),
    setSite: (nodeId: string, site: ValueSite) => changeWalk({ ...walk, nodeId, site }),
    setNode: (nodeId: string) => changeWalk({ ...walk, nodeId, site: null }),
  };
}

type FeatureFlows = ReturnType<typeof useFeatureFlows>;

export function recommendedFeature(groups: ReturnType<typeof featureGroups>): GuideFeature | null {
  let recommended: GuideFeature | null = null;
  for (const feature of groups.flatMap(group => group.features)) {
    if (feature.sure > (recommended?.sure ?? 0)) recommended = feature;
  }
  return recommended;
}

/** How surely a feature's requests were found, in one short tag; the counts stay in its title. */
function LinkTag({ feature }: { feature: GuideFeature }) {
  const [className, label] = feature.sure > 0 ? ['tag tag--ok', '요청 코드와 이어짐']
    : feature.inferred > 0 ? ['tag tag--unknown', '추정 연결'] : ['tag', '요청 코드를 못 찾음'];
  return <span className={className} title={`프론트 요청 확실 ${feature.sure}곳 · 추정 ${feature.inferred}곳`}>{label}</span>;
}

function IndexTags({ feature }: { feature: IndexFeature }) {
  return <>
    <span className="tag" title={feature.source}>{feature.basis === 'button' ? '버튼 문구' : feature.basis === 'screen-title' ? '화면 제목' : '주소 이름'}</span>{' '}
    {feature.inferred && <span className="tag tag--unknown" title={feature.reasons.join(' · ')}>추정 연결</span>}
  </>;
}

export function FeatureList({ groups, routes, selected, disabled, onFollow, search, setSearch, children, flows, guide, index, grouping = false, groupError = '', onRegroup, onCancelGrouping }: {
  groups: ReturnType<typeof featureGroups>; routes: ProjectRoutes; selected: number | null;
  disabled: boolean; onFollow(routeIndex: number, start?: FlowStart): void; search: string; setSearch(value: string): void;
  children?: React.ReactNode; flows: FeatureFlow[] | null; guide?: FeatureGuide; grouping?: boolean; groupError?: string;
  index?: IndexGroup[] | null;
  onRegroup?(): void; onCancelGrouping?(): void;
}) {
  const query = search.toLowerCase();
  const visible = groups.map(group => ({ ...group, features: group.features.filter(feature => feature.haystack.includes(query)) }))
    .filter(group => group.features.length);
  const grouped = useMemo(() => flows ? screenGroups(routes, flows, guide) : null, [routes, flows, guide]);
  const contents = useMemo(() => {
    if (index !== undefined) return index;
    if (!flows) return null;
    const paths = new Map(flows.flatMap(flow => flow.nodes.map(node => [node.fileId, node.relativePath] as const)));
    return featureIndex(routes, flows, fileId => paths.get(fileId) ?? '', guide);
  }, [index, routes, flows, guide]);
  const visibleContents = contents?.map(group => ({ ...group, features: group.features.filter(feature => feature.haystack.includes(query)) }))
    .filter(group => group.features.length);
  const serverList = <>
    <p>기능 목록 · {groups.reduce((count, group) => count + group.features.length, 0)}개</p>
    {visible.map((group, groupIndex) => <section className="card" key={groupIndex}>
      <h4>{group.name}</h4>
      {group.about && <p className="hint">{group.about}</p>}
      <ul className="map-list">{firstRows(group.features).map((feature, featureIndex) => <li key={featureIndex}>
        <b>{feature.name}</b>{' '}
        <button className="btn btn--small" aria-pressed={selected !== null && feature.routes.includes(selected)} disabled={disabled}
          onClick={() => onFollow(feature.routes[0])}>이 기능 따라가기</button>
        {feature.ai && <>
          <p className="hint">{feature.about}</p>
          <p className="hint">{feature.routes.map(index => routeLabel(routes.routes[index])).join(' · ')}</p>
        </>}
        {feature.routes.length > 1 && <div className="map-actions">{feature.routes.map(index => <button key={index} className="btn btn--small"
          aria-pressed={selected === index} disabled={disabled} onClick={() => onFollow(index)}>{routeLabel(routes.routes[index])}</button>)}</div>}
        <LinkTag feature={feature} />
        <details className="feature-more"><summary>코드 이름·연결 근거</summary>
          {!feature.ai && <p className="hint">{feature.about}</p>}
          <p className="hint">프론트 요청 확실 {feature.sure}곳 · 추정 {feature.inferred}곳</p>
        </details>
      </li>)}</ul><Omitted count={group.features.length} />
    </section>)}
    {!visible.length && <p className="hint">{routes.routes.length ? '검색어와 맞는 기능이 없어요.' : '서버 코드(요청을 받는 곳)를 찾지 못했어요.'}</p>}
  </>;
  const unmatched = (rows: RouteRow[], title: string) => <details className="card"><summary>{title} {rows.length}개</summary>
    <ul className="map-list">{rows.filter(row => row.haystack.includes(query)).map(row => <li key={row.routeIndex}>{routeLabel(routes.routes[row.routeIndex])}{' '}
      {row.aiName && <span className="tag">AI 해석 · {row.aiName}</span>}{' '}
      <button className="btn btn--small" disabled={disabled} onClick={() => onFollow(row.routeIndex)}>이 기능 따라가기</button>
    </li>)}</ul>
  </details>;
  return <section aria-label="기능 목록">
    <h3>기능 고르기</h3>
    {grouping && <p role="status">화면별로 묶는 중… <button className="btn btn--small" onClick={onCancelGrouping}>취소</button></p>}
    {groupError && <p role="alert">화면별로 묶지 못했어요: {groupError.replace(/[.。]$/, '')}. 서버 주소 기준으로 보여 줘요.{' '}
      <button className="btn btn--small" disabled={disabled} onClick={onRegroup}>다시 묶기</button></p>}
    <label>기능 검색 <input value={search} onChange={event => setSearch(event.target.value)} placeholder="화면·기능 이름·주소·함수 이름" /></label>
    {grouped && <>
      {flows?.some(flow => flow.limited) && <p className="notice">일부 기능은 분석 한도 때문에 흐름의 일부만 확인했어요.</p>}
      {contents && <section aria-label="기능 목차">
        <h4>기능 목차 · 묶음 {contents.length}개 · 서버 기능 {contents.reduce((count, group) => count + group.features.length, 0)}개</h4>
        <p className="hint">서버 코드에서 찾은 기능만 보여요. 앱의 모든 기능이라고 단정하지는 않아요.</p>
        {visibleContents?.map(group => <details className="card" key={group.key} open={!!query}>
          <summary>{group.title?.text ?? group.key}{group.title ? ` · ${group.key}` : ''} · 기능 {group.features.length}개 — {group.features.slice(0, 3).map(feature => feature.name).join(', ')}{group.features.length > 3 ? ', …' : ''}</summary>
          {group.title && <p className="hint">묶음 이름: 주소 이름이 같은 화면 {group.title.screen}의 제목 · {group.title.relativePath} {group.title.site.startLine}행 · 추정</p>}
          <ul className="map-list">{group.features.map(feature => <li key={feature.routeIndex}>
            <b>{feature.name}</b>{' '}<IndexTags feature={feature} />{' '}
            {feature.aiName && <span className="tag">AI 해석 · {feature.aiName}</span>}{' '}
            <button className="btn btn--small" aria-pressed={selected === feature.routeIndex} disabled={disabled}
              onClick={() => onFollow(feature.routeIndex, feature.start ?? undefined)}>이 기능 따라가기</button>
            <p className="hint">{feature.source} · {routeLabel(routes.routes[feature.routeIndex])} · {feature.linked === 'screen'
              ? `쓰는 화면 ${feature.screens.slice(0, 3).join(', ')}${feature.screens.length > 3 ? ` 외 ${feature.screens.length - 3}개` : ''}`
              : feature.linked === 'request-only' ? '화면은 못 정했지만 요청 코드는 찾았어요' : '화면과 연결을 찾지 못했어요'}</p>
          </li>)}</ul>
        </details>)}
      </section>}
      <details open={!!query}><summary>화면별로 보기</summary>
      {grouped.screens.map(group => ({ ...group, rows: group.rows.filter(row => row.haystack.includes(query)) }))
        .filter(group => group.rows.length).map(group => <section className="card" aria-label={`화면 ${group.screen}`} key={group.screen}>
          <h4>화면 {group.screen}</h4>
          <ul className="map-list">{group.rows.map(row => <li key={row.routeIndex}>
            <b>{row.title}</b> · {row.text} → {routeLabel(routes.routes[row.routeIndex])}{' '}
            {row.elsewhere && <span className="tag">다른 화면에서도 써요</span>}{' '}
            {row.inferred && <span className="tag tag--unknown" title={row.reasons.join(' · ')}>추정 연결</span>}{' '}
            {row.aiName && <span className="tag">AI 해석 · {row.aiName}</span>}{' '}
            <button className="btn btn--small" aria-pressed={selected === row.routeIndex} disabled={disabled}
              onClick={() => onFollow(row.routeIndex, { through: row.through, storyId: row.storyId })}>이 기능 따라가기</button>
          </li>)}</ul>
        </section>)}
      {unmatched(grouped.noScreen, '화면은 못 정했지만 요청 코드는 찾은 기능')}
      {unmatched(grouped.unlinked, '화면과 연결을 찾지 못한 서버 기능')}
      </details>
    </>}
    {/* Keep AI controls mounted while grouping finishes, so an in-flight guide is not cancelled. */}
    <details className={grouped?.screens.length ? 'card' : undefined} open={!grouped?.screens.length}>
      <summary hidden={!grouped?.screens.length}>{grouped?.screens.length ? '서버 주소 기준 목록 (AI 정리 포함)' : null}</summary>
      {children}{serverList}
    </details>
  </section>;
}

export function FeatureChooser({ project, state, revision, locked, onFollow, mode, running, checking, connections, onInspect, onRunning }: {
  project: ProjectView; state: FeatureFlows; revision: number; locked: boolean; onFollow(routeIndex: number, start?: FlowStart): void;
  mode: LearningMode; running: boolean; checking: boolean; connections: ConnectionReport | null;
  onInspect(): Promise<string | null>; onRunning(value: boolean): void;
}) {
  const { routes, stale, guide, setGuideResult } = state;
  const feature = recommendedFeature(state.groups);
  const disabled = locked || stale;
  const index = useMemo(() => {
    if (!routes || !state.groupingProps.flows) return null;
    const paths = new Map(project.files.map(file => [file.id, file.relativePath]));
    return featureIndex(routes, state.groupingProps.flows, fileId => paths.get(fileId) ?? '', guide?.guide);
  }, [project.files, routes, state.groupingProps.flows, guide]);
  const indexed = index?.flatMap(group => group.features).find(item => item.routeIndex === feature?.routes[0]);
  return <div className="card--wide">
    <RoutesStatus state={state} />
    {routes && <>
      <FeatureOverview project={project} routes={routes} guide={guide?.guide} />
      {routes.routes.length === 0 ? <p className="notice">서버 코드(요청을 받는 곳)를 찾지 못해서 기능별로 따라갈 수 없어요. 아래 ‘어디부터 읽을까요?’에서 시작 파일을 골라 읽어 보세요.</p> : <>
        {feature && <section className="card" aria-label="처음 따라갈 기능">
          <h3>처음이라면 이 기능부터 따라가 보세요</h3>
          <b>{indexed?.name ?? feature.name}</b>
          {indexed && <>{' '}<IndexTags feature={indexed} />
            <p className="hint">{indexed.source}</p>
            <p className="hint">{feature.name}</p>
          </>}
          {feature.about && <p className="hint">{feature.about}</p>}
          <p>이 기능에 요청을 보내는 코드 {feature.sure}곳을 확실히 찾았어요. 요청을 보내는 쪽부터 서버까지 따라가 볼 수 있어요.</p>
          <p className="hint">고른 기준: 요청을 보내는 코드와 확실히 이어진 곳이 가장 많은 기능</p>
          <button className="btn" disabled={disabled} onClick={() => onFollow(feature.routes[0], indexed?.start ?? undefined)}>이 기능부터 따라가기</button>
        </section>}
        <FeatureList {...state.groupingProps} index={index} search={state.search} setSearch={state.setSearch} groups={state.groups} routes={routes} selected={state.selected} disabled={disabled} onFollow={onFollow}>
          <FeatureGuideCard key={`${routes.routesId}:${revision}`} projectId={project.id} routesId={routes.routesId}
            result={guide} mode={mode} locked={disabled} running={running} checking={checking} connections={connections}
            onInspect={onInspect} onResult={setGuideResult} onRunning={onRunning} />
        </FeatureList>
      </>}
    </>}
  </div>;
}

/** Finding the routes, its error and whether it is out of date: the same on the overview and the flow page. */
export function RoutesStatus({ state, retry, retryDisabled = false }: { state: FeatureFlows; retry?: () => void; retryDisabled?: boolean }) {
  return <>
    <div className="map-actions">{state.finding ? <>
      <span role="status" className="busy"><span className="spinner" aria-hidden="true" />주소를 찾는 중…</span>
      <button className="btn btn--small" onClick={state.cancelFind}>주소 찾기 취소</button>
    </> : (state.error || state.stale || !state.routes) && <button className="btn btn--small" onClick={() => void state.find()}>
      {state.error || state.stale ? '다시 찾기' : '주소 찾기'}
    </button>}</div>
    {state.error && <div><p role="alert" className="notice notice--warn">{state.error}</p>
      {retry && <button className="btn" disabled={retryDisabled} onClick={retry}>다시 시도</button>}
    </div>}
    {state.stale && <p className="notice notice--warn">다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.</p>}
  </>;
}

export function FlowLimits({ project, routes, flow, locked, onCode }: {
  project: ProjectView; routes: ProjectRoutes | undefined; flow: FeatureFlow | null; locked: boolean; onCode(site: ValueSite): void;
}) {
  const pathById = useMemo(() => new Map(project.files.map(file => [file.id, file.relativePath])), [project.files]);
  const pathOf = (fileId: string) => pathById.get(fileId) ?? '';
  const requestList = (items: Request[], title: string) => items.length > 0 && <details className="card"><summary>{title} {items.length}개</summary>
    <ul className="map-list">{firstRows(items).map(request => <li key={`${request.fileId}:${request.startUtf16}`}>
      <code>{request.text}</code> · <span className="path">{pathOf(request.fileId)} {request.startLine}행</span>{' '}
      <button className="btn btn--small" disabled={locked} onClick={() => onCode(request)}>코드 보기</button>
    </li>)}</ul><Omitted count={items.length} />
  </details>;
  return <details className="card"><summary>이 흐름을 찾은 방법과 한계</summary>
    <p className="hint">코드 글자로 찾은 흐름이에요. 실행 순서나 실제 요청을 확인한 것은 아니에요. AI 정리는 동의한 목록만 보내요.</p>
    <section aria-label="찾은 범위와 한계">
      <h3>찾은 범위와 한계</h3>
      <p>TS/JS의 NestJS·Next API·Express 주소와 fetch·axios 요청을 찾아요. 다른 언어·서버 방식과 app.use의 주소 연결·경로 별칭은 따라가지 않아요. 추정은 확실한 연결 수에 넣지 않아요. 실패는 throw new …만, 저장소는 Prisma 모양만 찾아요.</p>
      {(routes?.limited || flow?.limited) && <p>일부 흐름만 확인했어요.</p>}
      {[...new Set([...(routes?.notes ?? []), ...(flow?.notes ?? [])])].map(note => <p key={note} className="hint">{note}</p>)}
    </section>
    {routes && <>
      {requestList(routes.requests.filter((request, index) => !request.host && !routes.links.some(link => link.requestIndex === index)), '이을 주소를 못 찾은 요청')}
      {requestList(routes.requests.filter(request => request.host !== null), '다른 서버 주소 요청')}
    </>}
  </details>;
}
