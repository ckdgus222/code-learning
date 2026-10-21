import React, { useEffect, useRef, useState } from 'react';
import type { CallTarget, FeatureFlow, FlowEdge, FlowNode, ProjectRoutes, ProjectView, Request, ValueSite } from '../shared/contracts';
import { firstRows, Omitted } from './project-map';

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

export function FlowSteps({ flow, locked, onCode, onFunction }: {
  flow: FeatureFlow; locked: boolean; onCode(site: ValueSite): void; onFunction(target: CallTarget): void;
}) {
  const requests = flow.nodes.filter(node => node.side === 'request');
  const groups = requests.length ? requests : [null];
  return <section className="card" aria-label="기능 흐름 단계">
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
        <ol className="feature-steps">{nodes.map(node => <li key={node.id} data-testid="feature-step">
          <span className="path">{node.relativePath}</span> · <b>{node.name}</b>{' '}
          {node.screen !== null && <span className="tag tag--doc">화면 주소 {node.screen}</span>}{' '}
          {node.event && <span className="tag tag--doc">화면 이벤트 {node.event}</span>}
          {flow.edges.filter(edge => edge.from === node.id && nodes.some(next => next.id === edge.to)).map((edge, index) => <p key={index}>
            {!edge.sure && <span className="tag tag--unknown">추정</span>} {edgeText(edge)}
            {!edge.sure && edge.kind !== 'hook' && <> · {edge.reasons.join(' · ')}</>}
          </p>)}
          {node.outside.length > 0 && <p className="hint">바깥 호출: {node.outside.join(' · ')}{node.outsideOmitted > 0 && ` · 외 ${node.outsideOmitted}개`}</p>}
          <button className="btn btn--small" disabled={locked} onClick={() => onCode({ fileId: node.fileId, fileHash: node.fileHash,
            ...node.range, text: node.name })}>코드 보기</button>{' '}
          {node.side !== 'request' && <button className="btn btn--small" disabled={locked} onClick={() => onFunction({ fileId: node.fileId,
            fileHash: node.fileHash, ...node.range, name: node.name })}>이 함수 흐름</button>}
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
    setFinding(true); setFollowing(false); setError(''); setEntry(null); setFlow(null); setSelected(null);
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
    setSelected(routeIndex); setFollowing(true); setError(''); setFlow(null);
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
    if (!`${route.path ?? ''} ${route.handler.name}`.toLowerCase().includes(search.toLowerCase())) return;
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
    <h2 className="page__title">기능 흐름</h2>
    <p className="hint">코드 글자로 찾은 흐름이에요. 실행 순서나 실제 요청을 확인한 것은 아니에요.</p>
    <p className="hint">TS/JS의 NestJS·Next API·Express 주소와 fetch·axios 요청을 찾아요. AI에는 보내지 않아요.</p>
    {project.warnings.length > 0 && <p className="notice">{project.warnings.join(' ')}</p>}
    <div className="map-actions">{finding ? <>
      <span role="status" className="busy"><span className="spinner" aria-hidden="true" />주소를 찾는 중…</span>
      <button className="btn btn--small" onClick={() => { routesRun.current++; setFinding(false); void window.learning.cancelRoutes({ projectId: project.id }); }}>주소 찾기 취소</button>
    </> : <button className="btn btn--small" onClick={() => void find()}>다시 찾기</button>}</div>
    {error && <p role="alert" className="notice notice--warn">{error}</p>}
    {stale && <p className="notice notice--warn">다시 확인 필요: 파일이 바뀌었거나 잠자기에서 돌아왔어요. 주소를 다시 찾아 주세요.</p>}
    {routes && <>
      <label>기능 검색 <input value={search} onChange={event => setSearch(event.target.value)} placeholder="주소 또는 함수 이름" /></label>
      <section aria-label="기능 목록">
        <h3>기능 목록 · {routes.routes.length}개</h3>
        {[...groups].map(([path, entries]) => <section className="card" key={path}>
          <h4 className="path">{path}</h4>
          <ul className="map-list">{firstRows(entries).map(({ route, index }) => {
            const links = routes.links.filter(link => link.routeIndex === index);
            return <li key={index}><button className="btn btn--small" aria-pressed={selected === index} disabled={stale}
              onClick={() => void follow(index)}>{route.method} {route.path ?? '주소 모름'}</button>{' '}
              <b>{route.handler.name}</b>{' '}{route.path === null && <span className="tag tag--unknown">주소 모름</span>}{' '}
              <span className="hint">{links.length ? `프론트 요청 확실 ${links.filter(link => link.sure).length}곳 · 추정 ${links.filter(link => !link.sure).length}곳` : '프론트 요청 못 찾음'}</span>
            </li>;
          })}</ul><Omitted count={entries.length} />
        </section>)}
        {!groups.size && <p className="hint">조건에 맞는 받는 곳을 찾지 못했어요.</p>}
      </section>
      {requestList(routes.requests.filter((request, index) => !request.host && !routes.links.some(link => link.requestIndex === index)), '이을 주소를 못 찾은 요청')}
      {requestList(routes.requests.filter(request => request.host !== null), '다른 서버 주소 요청')}
      {routes.limited && <p className="notice notice--warn">일부 파일만 확인했어요.</p>}
      {routes.notes.map(note => <p key={note} className="hint">{note}</p>)}
    </>}
    {following && <div role="status">기능 흐름을 찾는 중… <button className="btn btn--small" onClick={() => {
      flowRun.current++; setFollowing(false); void window.learning.cancelFeatureFlow({ projectId: project.id });
    }}>기능 흐름 취소</button></div>}
    {flow && <FlowSteps flow={flow} locked={locked} onCode={onCode} onFunction={onFunction} />}
    <p className="hint">다른 언어·서버 방식과 app.use의 주소 연결·경로 별칭은 따라가지 않아요. 추정은 확실한 연결 수에 넣지 않아요.</p>
  </div>;
}
