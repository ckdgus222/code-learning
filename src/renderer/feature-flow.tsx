import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position, type Edge, type Node } from '@xyflow/react';
import type { CallTarget, FeatureFlow, FlowEdge, FlowNode, ProjectRoutes, ProjectView, Request, ValueSite } from '../shared/contracts';
import { ARROW_MARKER, firstRows, MapCanvas, Omitted } from './project-map';
import { layoutFlow } from './flow-layout';
import { isNextConfig, nextRouteOf } from '../core/analysis/next-routes';
import { codeNameOf, groupNameOf, storyOf, type StoryStep } from '../core/analysis/flow-story';

/** The two ways out of a step: the code range itself, and that function's own flow (a request is not a function). */
function NodeButtons({ node, locked, onCode, onFunction }: {
  node: FlowNode; locked: boolean; onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
}) {
  return <>
    <button className="btn btn--small" disabled={locked}
      onClick={() => onCode({ fileId: node.fileId, fileHash: node.fileHash, ...node.range, text: node.name })}>코드 보기</button>{' '}
    {node.side !== 'request' && <button className="btn btn--small" disabled={locked}
      onClick={() => onFunction({ fileId: node.fileId, fileHash: node.fileHash, ...node.range, name: node.name })}>이 함수 흐름</button>}
  </>;
}

export function FlowStory({ flow, locked, onCode, onFunction }: {
  flow: FeatureFlow; locked: boolean; onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
}) {
  const stories = useMemo(() => {
    const byStory = new Map<string, StoryStep[]>();
    for (const step of storyOf(flow)) byStory.set(step.storyId, [...byStory.get(step.storyId) ?? [], step]);
    return [...byStory];
  }, [flow]);
  const buttons = (node: FlowNode) => <NodeButtons node={node} locked={locked} onCode={onCode} onFunction={onFunction} />;
  const detailsOf = (nodes: FlowNode[]) => <ul className="map-list">{nodes.map(node => <li key={node.id}>
    <span className="path">{node.relativePath}</span> · <b>{node.name}</b>{' '}{buttons(node)}
  </li>)}</ul>;
  return <section className="card" aria-label="기능 따라가기">
    <h3>기능 따라가기</h3>
    {!flow.nodes.some(node => node.side === 'request') && <p>프론트 시작점은 찾지 못했어요</p>}
    {stories.map(([storyId, steps]) => {
      const head = flow.nodes.find(node => node.id === storyId);
      return <div key={storyId}>
        {stories.length > 1 && head && <h4>{head.name} · {head.relativePath}</h4>}
        <ol className="feature-steps story-steps">{steps.map(step => <li key={step.kind} data-testid="story-step" data-kind={step.kind}>
          <b>{step.title}</b>
          <p>{step.text}</p>
          {step.inferred && <p><span className="tag tag--unknown">추정</span> {step.reasons.join(' · ')}</p>}
          {step.typed && <p><span className="tag tag--doc">타입으로 찾음</span></p>}
          <button className="btn btn--small" disabled={locked} onClick={() => onCode({ fileId: step.representative.fileId,
            fileHash: step.representative.fileHash, ...step.representative.range, text: step.representative.name })}>코드 보기</button>
          <details><summary>자세히</summary>
            {step.stopped && <p>서로 부르는 함수가 있어 여기서 멈췄어요</p>}
            {detailsOf(step.nodes)}
            {step.others.length > 0 && <><p>다른 곳에서도 불러요</p>{detailsOf(step.others)}</>}
          </details>
        </li>)}</ol>
      </div>;
    })}
  </section>;
}

export function FeatureOverview({ project, routes }: { project: ProjectView; routes: ProjectRoutes }) {
  // The page re-renders on every search keystroke; these read every project file, so they are worked out once.
  const summary = useMemo(() => {
    const paths = project.files.map(file => file.relativePath);
    const pathById = new Map(project.files.map(file => [file.id, file.relativePath]));
    const next = paths.some(isNextConfig);
    const screens = next ? paths.filter(path => /\/page\.(?:tsx|jsx|ts|js)$/.test(path) && nextRouteOf(path, paths)?.kind === 'page').length : 0;
    const sure = new Set(routes.links.filter(link => link.sure).map(link => link.requestIndex));
    const inferred = new Set(routes.links.filter(link => !link.sure && !sure.has(link.requestIndex)).map(link => link.requestIndex));
    const topFolder = (ids: string[]) => {
      const folders = new Set(ids.map(id => {
        const path = pathById.get(id);
        return path?.includes('/') ? path.split('/')[0] : null;
      }));
      return folders.size === 1 ? [...folders][0] : null;
    };
    return { next, screens, sure: sure.size, inferred: inferred.size,
      server: topFolder(routes.routes.map(route => route.handler.fileId)), front: topFolder(routes.requests.map(request => request.fileId)) };
  }, [project.files, routes]);
  const { next, screens, sure, inferred, server, front } = summary;
  const intro = project.overview.intro?.text;
  return <section className="card" aria-label="프로젝트 파악">
    <h3>프로젝트 파악</h3>
    {intro && <p>{intro}</p>}
    {next && <p>화면 {screens}개</p>}
    <p>서버 기능 {routes.routes.length}개</p>
    <p>프론트 요청 {routes.requests.length}개 · 서버와 이어짐 확실 {sure} · 추정 {inferred} · 못 이음 {routes.requests.length - sure - inferred}</p>
    {server && front && server !== front && <p>폴더 구성: {server}는 서버 · {front}는 화면·프론트</p>}
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

export function FeatureFlowView({ project, active, revision, locked, onCode, onFunction }: {
  project: ProjectView; active: boolean; revision: number; locked: boolean;
  onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
}) {
  const [entry, setEntry] = useState<{ result: ProjectRoutes; revision: number } | null>(null);
  const [flow, setFlow] = useState<FeatureFlow | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [picks, setPicks] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const started = useRef(false);
  const routesRun = useRef(0);
  const flowRun = useRef(0);
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const stale = !!entry && entry.revision !== revision;
  useEffect(() => {
    if (active && !started.current) { started.current = true; void find(); }
  }, [active]);
  useEffect(() => () => {
    routesRun.current++; flowRun.current++;
    void window.learning.cancelRoutes({ projectId: project.id });
  }, [project]);
  async function find() {
    const run = ++routesRun.current;
    flowRun.current++;
    const atRevision = revision;
    setFinding(true); setFollowing(false); setError(''); setEntry(null); setFlow(null); setSelected(null); setSelectedNodeId(null);
    const result = await window.learning.routes({ projectId: project.id });
    if (run !== routesRun.current) return;
    setFinding(false);
    if (!result.ok) { setError(result.message); return; }
    if (atRevision !== currentRevision.current) { setError('프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.'); return; }
    setEntry({ result: result.value, revision: atRevision });
  }
  async function follow(routeIndex: number) {
    if (!entry || stale) return;
    const run = ++flowRun.current;
    const atRevision = revision;
    setSelected(routeIndex); setFollowing(true); setError(''); setFlow(null); setSelectedNodeId(null);
    const result = await window.learning.featureFlow({ projectId: project.id, routesId: entry.result.routesId, routeIndex });
    if (run !== flowRun.current) return;
    setFollowing(false);
    if (!result.ok) { setError(result.message); return; }
    if (atRevision !== currentRevision.current) { setError('프로젝트가 바뀌었어요. 주소를 다시 찾아 주세요.'); return; }
    setFlow(result.value);
  }
  const routes = entry?.result;
  const pathOf = (fileId: string) => project.files.find(file => file.id === fileId)?.relativePath ?? '';
  const groups = new Map<string, { route: ProjectRoutes['routes'][number]; index: number }[]>();
  routes?.routes.forEach((route, index) => {
    if (!`${codeNameOf(route)} ${route.method} ${route.handler.name}`.toLowerCase().includes(search.toLowerCase())) return;
    const path = pathOf(route.handler.fileId);
    groups.set(path, [...groups.get(path) ?? [], { route, index }]);
  });
  const requestList = (items: Request[], title: string) => <details className="card"><summary>{title} {items.length}개</summary>
    <ul className="map-list">{firstRows(items).map(request => <li key={`${request.fileId}:${request.startUtf16}`}>
      <code>{request.text}</code> · <span className="path">{pathOf(request.fileId)} {request.startLine}행</span>{' '}
      <button className="btn btn--small" disabled={locked} onClick={() => onCode(request)}>코드 보기</button>
    </li>)}</ul><Omitted count={items.length} />
  </details>;
  if (!active) return null;
  return <div className="page feature-page">
    <h2 className="page__title">기능별 안내</h2>
    {project.warnings.length > 0 && <p className="notice">{project.warnings.join(' ')}</p>}
    <div className="map-actions">{finding ? <>
      <span role="status" className="busy"><span className="spinner" aria-hidden="true" />주소를 찾는 중…</span>
      <button className="btn btn--small" onClick={() => { routesRun.current++; setFinding(false); void window.learning.cancelRoutes({ projectId: project.id }); }}>주소 찾기 취소</button>
    </> : <button className="btn btn--small" onClick={() => void find()}>다시 찾기</button>}</div>
    {error && <p role="alert" className="notice notice--warn">{error}</p>}
    {stale && <p className="notice notice--warn">다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.</p>}
    {routes && <FeatureOverview project={project} routes={routes} />}
    {/* The list and the chosen feature side by side: below a long list, the story it opens was out of sight. */}
    <div className="feature-guide">
    {routes && <div className="feature-guide__list">
      <label>기능 검색 <input value={search} onChange={event => setSearch(event.target.value)} placeholder="기능 이름·주소·함수 이름" /></label>
      <section aria-label="기능 목록">
        <h3>기능 목록 · {routes.routes.length}개</h3>
        {[...groups].map(([path, entries]) => <section className="card" key={path}>
          <h4>{groupNameOf(entries[0].route, path)}</h4>
          <p className="path hint">{path}</p>
          <ul className="map-list">{firstRows(entries).map(({ route, index }) => {
            const links = routes.links.filter(link => link.routeIndex === index);
            return <li key={index}><button className="btn btn--small" aria-pressed={selected === index} disabled={stale}
              onClick={() => void follow(index)}>{codeNameOf(route)}</button>
              <p className="hint">{route.handler.name}</p>
              <span className="hint">프론트 요청 확실 {links.filter(link => link.sure).length}곳 · 추정 {links.filter(link => !link.sure).length}곳</span>
            </li>;
          })}</ul><Omitted count={entries.length} />
        </section>)}
        {!groups.size && <p className="hint">조건에 맞는 받는 곳을 찾지 못했어요.</p>}
      </section>
    </div>}
    <div className="feature-guide__story">
    {routes && !flow && !following && <p className="hint">왼쪽 목록에서 기능을 고르면 화면부터 서버까지 따라가요.</p>}
    {following && <div role="status">기능 흐름을 찾는 중… <button className="btn btn--small" onClick={() => {
      flowRun.current++; setFollowing(false); void window.learning.cancelFeatureFlow({ projectId: project.id });
    }}>기능 흐름 취소</button></div>}
    {flow && <>
      <h3>{routes && codeNameOf(routes.routes[flow.routeIndex])}</h3>
      <FlowStory flow={flow} locked={locked} onCode={onCode} onFunction={onFunction} />
      <FoldedDetails key={`${flow.routesId}:${flow.routeIndex}`} summary="그림과 전체 단계 보기">
        <FlowDiagram flow={flow} selectedNodeId={selectedNodeId} onSelect={id => { setSelectedNodeId(id); setPicks(count => count + 1); }} />
        <FlowSteps flow={flow} locked={locked} onCode={onCode} onFunction={onFunction} selectedNodeId={selectedNodeId} picks={picks} />
      </FoldedDetails>
    </>}
    </div>
    </div>
    <p className="hint">코드 글자로 찾은 흐름이에요. 실행 순서나 실제 요청을 확인한 것은 아니에요. AI에는 보내지 않아요.</p>
    <details className="card"><summary>찾은 범위와 한계</summary>
      <p>TS/JS의 NestJS·Next API·Express 주소와 fetch·axios 요청을 찾아요. 다른 언어·서버 방식과 app.use의 주소 연결·경로 별칭은 따라가지 않아요. 추정은 확실한 연결 수에 넣지 않아요.</p>
      {(routes?.limited || flow?.limited) && <p>일부 흐름만 확인했어요.</p>}
      {[...new Set([...(routes?.notes ?? []), ...(flow?.notes ?? [])])].map(note => <p key={note} className="hint">{note}</p>)}
    </details>
    {routes && <>
      {requestList(routes.requests.filter((request, index) => !request.host && !routes.links.some(link => link.requestIndex === index)), '이을 주소를 못 찾은 요청')}
      {requestList(routes.requests.filter(request => request.host !== null), '다른 서버 주소 요청')}
    </>}
  </div>;
}
