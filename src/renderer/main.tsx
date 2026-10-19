import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CallSite, ValueSite, CodeSymbol, Evidence, MapFunction, MapImport, ProjectView, SourceView, StartCandidate } from '../shared/contracts';
import { useSelection, type View } from './selection';
import { Reader, type ReaderHandle } from './reader';
import { AiPanel } from './ai-panel';
import { Flow } from './flow';
import { ProjectMapView, type MapEntry } from './project-map';
import { matchCallStep, matchFunction, matchImport } from './map-layout';
import { CallsFacts, type CallFunction, type CallsState } from './calls';
import { ValuesFacts } from './values';
import { COMPLEXITY_NOTE, ComplexityTags, overLimit } from './complexity';
import './styles.css';

const views: { id: View; label: string }[] = [
  { id: 'overview', label: '한눈에 보기' }, { id: 'map', label: '프로젝트 지도' }, { id: 'flow', label: '흐름 따라가기' },
  { id: 'code', label: '코드 읽기' }, { id: 'changes', label: '달라진 내용' },
];
const candidateReasons: Record<StartCandidate['reason'], string> = {
  'package-main': 'package.json의 main이 가리키는 파일',
  'package-bin': 'package.json의 bin(명령)이 가리키는 파일',
  'entry-name': '이름이 index·main·app인 파일',
  exported: '다른 파일에서 쓰도록 내보낸(export) 함수',
};
// Plan v2.3 C-1: the AI is only asked; the app never changes the code.
const SIMPLER_QUESTION = '이 함수를 더 단순하고 읽기 쉽게 쓸 수 있을까요? 바꾼다면 어디를 어떻게 바꾸면 좋을지 알려 주세요.';
// Code text size in px (plan 7.3: 14–16px to start, adjustable).
const CODE_SIZE = { min: 12, start: 15, max: 20 };

function App() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [evidence, setReaderEvidence] = useState<Evidence | null>(null);
  const [questionEvidence, setQuestionEvidence] = useState<Evidence | null>(null);
  function setEvidence(next: Evidence | null) { setReaderEvidence(next); setQuestionEvidence(next); }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  // The overview is computed when the folder opens, so re-reading one file does not refresh it.
  const [overviewStale, setOverviewStale] = useState(false);
  const [watchError, setWatchError] = useState(false);
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'explain' | 'ask'>('explain');
  const [panelOpen, setPanelOpen] = useState(true);
  const [draft, setDraft] = useState<{ text: string; id: number } | null>(null);
  // Reading settings live as long as the window: they stay across files and views, not across restarts.
  const [codeSize, setCodeSize] = useState(CODE_SIZE.start);
  const [wrap, setWrap] = useState(false);
  const reader = useRef<ReaderHandle>(null);
  const request = useRef(0);
  const revision = useRef(0);
  // A second notice changes no other state (stale is already set), so this redraws the screen for the map.
  const [, setRevisionShown] = useState(0);
  // The map is drawn by its own worker, so it has its own request counter: reads may go on meanwhile.
  const [projectMap, setProjectMap] = useState<MapEntry | null>(null);
  const [mapping, setMapping] = useState(false);
  const mapRequest = useRef(0);
  // The call search for the function chosen in the flow view (plan v2.3 F), kept per function and file hash.
  const [calls, setCalls] = useState<{ key: string; state: CallsState; revision: number } | null>(null);
  const callsRequest = useRef(0);
  const { view, setView, symbolId, stepId, selectSymbol, selectStep } = useSelection();
  const symbol = source?.analysis.symbols.find(item => item.id === symbolId);
  const step = symbol?.steps.find(item => item.id === stepId);

  useEffect(() => window.learning.onProjectEvent(event => {
    if (event.projectId === project?.id) {
      revision.current++;
      setRevisionShown(revision.current);
      setStale(true);
      setOverviewStale(true);
      setEvidence(null);
      if (event.kind === 'watch-error') setWatchError(true);
    }
  }), [project?.id]);

  // A newly opened project starts from its overview, not the previous project's view.
  useEffect(() => setView('overview'), [project?.id, setView]);
  // Choosing a function in the flow view searches its calls; coming back to it reuses what was found.
  useEffect(() => {
    if (view === 'flow' && source && symbol && calls?.key !== callsKey(source, symbol)) void findCalls(source, symbol);
  }, [view, source, symbol]);
  // The map is drawn the first time it is looked at after a folder opens.
  useEffect(() => {
    if (view === 'map' && project && !projectMap && !mapping) void buildMap();
  }, [view, project]);

  async function openProject() {
    const current = ++request.current;
    setBusy(true); setError(''); setNotice('');
    const result = await window.learning.openProject();
    if (current !== request.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.message); setProject(null); setSource(null); setEvidence(null); selectSymbol(null); forgetMap(); forgetCalls(); return;
    }
    if (!result.value) return;
    // Reopening the same folder keeps the project ID but gives every file a new ID, so the map goes too.
    forgetMap(); forgetCalls();
    setProject(result.value); setSource(null); setEvidence(null); setStale(false); setOverviewStale(false); setWatchError(false); setSearch(''); selectSymbol(null);
  }

  async function readFile(fileId: string): Promise<SourceView | null> {
    if (!project) return null;
    const current = ++request.current;
    const atRevision = revision.current;
    setBusy(true); setError(''); setNotice(''); setEvidence(null); selectSymbol(null);
    const result = await window.learning.readSource({ projectId: project.id, fileId });
    if (current !== request.current) return null;
    setBusy(false);
    if (!result.ok) { setError(result.message); setSource(null); return null; }
    setSource(result.value); setStale(revision.current !== atRevision);
    return result.value;
  }

  // Candidates were found when the folder opened. Only a file whose hash is unchanged is trusted
  // to still hold the same function at the same place; otherwise the reader chooses again.
  async function startFrom(candidate: StartCandidate) {
    setView('flow');
    const opened = await readFile(candidate.fileId);
    if (!opened || candidate.name === null) return;
    const match = opened.hash === candidate.fileHash
      ? opened.analysis.symbols.find(item => item.name === candidate.name && item.evidence.startUtf16 === candidate.startUtf16)
      : undefined;
    if (match) selectSymbol(match.id);
    else setNotice('파일이 폴더를 열 때와 달라 후보 위치를 다시 확인해야 해요. 왼쪽에서 함수를 직접 골라 주세요.');
  }

  /** Whether the evidence was checked against the file and is now shown. */
  async function showEvidence(next: Evidence, nextStep: string | null, fromAnswer = false): Promise<boolean> {
    if (!project || stale) return false;
    const current = ++request.current;
    const atRevision = revision.current;
    setBusy(true); setError(''); setNotice('');
    const result = await window.learning.readEvidence({ projectId: project.id, evidenceId: next.id });
    if (current !== request.current) return false;
    setBusy(false);
    if (revision.current !== atRevision) { setStale(true); setEvidence(null); return false; }
    if (!result.ok) { setError(result.message); setEvidence(null); if (result.code === 'CHANGED' || result.code === 'NOT_ALLOWED') setStale(true); return false; }
    setSource(result.value.source);
    if (fromAnswer) { setReaderEvidence(result.value.evidence); selectSymbol(null); }
    else setEvidence(result.value.evidence);
    selectStep(nextStep);
    return true;
  }

  // The question is about the whole function, so it becomes the question's code even when a step inside it was chosen.
  async function askSimpler(target: CodeSymbol) {
    if (!await showEvidence(target.evidence, null)) return;
    setPanel('ask'); setPanelOpen(true);
    setDraft(current => ({ text: SIMPLER_QUESTION, id: (current?.id ?? 0) + 1 }));
  }

  function forgetMap() { mapRequest.current++; setProjectMap(null); setMapping(false); }
  async function buildMap() {
    if (!project) return;
    const current = ++mapRequest.current;
    const atRevision = revision.current;
    setMapping(true); setError('');
    const result = await window.learning.projectMap({ projectId: project.id });
    if (current !== mapRequest.current) return;
    setMapping(false);
    if (!result.ok) { if (result.code !== 'CANCELLED') setError(result.message); return; }
    // A change notice that arrived while the map was drawn keeps it marked for a re-check.
    setProjectMap({ map: result.value, revision: atRevision, build: current });
  }
  async function cancelMap() {
    if (!project) return;
    mapRequest.current++;
    setMapping(false);
    const result = await window.learning.cancelProjectMap({ projectId: project.id });
    if (!result.ok) setError(result.message);
  }
  // Like a start candidate: the import is highlighted only while the file has the hash it had for the map.
  async function showImport(item: MapImport) {
    // Reading now would drop a folder that is still opening, as the file list's busy lock prevents.
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(item.fromFileId);
    // A change notice during the read (a wake from sleep included) leaves the code to be checked again.
    if (!opened || revision.current !== atRevision) return;
    const found = matchImport(opened, item);
    if (found.status === 'found') setEvidence(found.evidence);
    else setNotice(found.status === 'changed' ? '지도를 만든 뒤 이 파일이 바뀌어 import 위치를 강조하지 않았어요. 지도를 다시 만들어 주세요.'
      : `이 import(${item.startLine}행)는 코드 분석 범위 밖이라 강조하지 못했어요.`);
  }

  // Like showImport: the function is chosen only while the file has the hash it had for the map.
  async function showFunction(item: MapFunction) {
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(item.fileId);
    if (!opened || revision.current !== atRevision) return;
    const found = matchFunction(opened, item);
    if (found.status === 'found') { selectSymbol(found.symbol.id); setEvidence(found.symbol.evidence); }
    else setNotice(found.status === 'changed' ? '지도를 만든 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 지도를 다시 만들어 주세요.'
      : `이 함수(${item.startLine}행)는 코드 분석 범위 밖이라 고르지 못했어요.`);
  }

  const callsKey = (from: SourceView, item: CodeSymbol) => `${from.fileId}:${from.hash}:${item.evidence.startUtf16}:${item.evidence.endUtf16}`;
  function forgetCalls() { callsRequest.current++; setCalls(null); }
  async function findCalls(from: SourceView, item: CodeSymbol) {
    if (!project) return;
    const current = ++callsRequest.current;
    const atRevision = revision.current;
    const key = callsKey(from, item);
    setCalls({ key, state: { status: 'finding' }, revision: atRevision });
    // Main replaces a search still running for another function.
    const result = await window.learning.functionCalls({ projectId: project.id, fileId: from.fileId, fileHash: from.hash,
      startUtf16: item.evidence.startUtf16, endUtf16: item.evidence.endUtf16 });
    if (current !== callsRequest.current) return;
    setCalls({ key, revision: atRevision, state: result.ok ? { status: 'done', result: result.value } : { status: 'failed', message: result.message } });
  }
  async function cancelCalls() {
    if (!project) return;
    callsRequest.current++;
    setCalls(previous => previous && { ...previous, state: { status: 'failed', message: '호출 찾기를 취소했어요.' } });
    const result = await window.learning.cancelFunctionCalls({ projectId: project.id });
    if (!result.ok) setError(result.message);
  }
  // Like showImport: the call is highlighted only while its file has the hash it had for the search.
  async function showCallSite(site: CallSite) {
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(site.fileId);
    if (!opened || revision.current !== atRevision) return;
    const found = matchCallStep(opened, site);
    if (found.status === 'found') { selectSymbol(found.symbol.id); selectStep(found.step.id); setEvidence(found.step.evidence); }
    else if (found.status === 'changed') setNotice('호출을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 다시 찾아 주세요.');
    else {
      // A call outside the analyzer's steps (top of the file, a default value, a computed name) is only
      // marked in the reader: the range is shown, but it is not evidence to ask the AI about.
      setReaderEvidence({ id: crypto.randomUUID(), projectId: opened.projectId, fileId: opened.fileId, fileHash: opened.hash,
        startUtf16: site.startUtf16, endUtf16: site.endUtf16, startLine: site.startLine, endLine: site.endLine });
      setNotice(`이 호출(${site.startLine}행)은 함수 단계 목록에 없어 코드 위치만 강조했어요.`);
    }
  }
  // A place from the value search (plan V-1): re-read, and marked in the reader while the file is unchanged.
  async function showValueSite(site: ValueSite | CallSite) {
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(site.fileId);
    if (!opened || revision.current !== atRevision) return;
    if (opened.hash !== site.fileHash) { setNotice('값을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 다시 찾아 주세요.'); return; }
    setReaderEvidence({ id: crypto.randomUUID(), projectId: opened.projectId, fileId: opened.fileId, fileHash: opened.hash,
      startUtf16: site.startUtf16, endUtf16: site.endUtf16, startLine: site.startLine, endLine: site.endLine });
  }
  // The same for a function to follow: it is chosen in the flow view, which then searches its own calls.
  async function showCallFunction(target: CallFunction) {
    if (busy) return;
    setView('flow');
    const atRevision = revision.current;
    const opened = await readFile(target.fileId);
    if (!opened || revision.current !== atRevision) return;
    const found = matchFunction(opened, target);
    if (found.status === 'found') { selectSymbol(found.symbol.id); setEvidence(found.symbol.evidence); }
    else setNotice(found.status === 'changed' ? '호출을 찾은 뒤 이 파일이 바뀌어 그 함수를 고르지 않았어요. 다시 찾아 주세요.'
      : `그 함수(${target.startLine}행)는 코드 분석 범위 밖이라 고르지 못했어요.`);
  }

  async function cancel() {
    const current = ++request.current;
    setProject(null); setSource(null); setEvidence(null); selectSymbol(null); forgetMap(); forgetCalls();
    setBusy(true); setError(''); setNotice('');
    const result = await window.learning.cancel();
    if (current !== request.current) return;
    setBusy(false);
    if (result.ok) setNotice('작업을 취소했습니다.');
    else setError(result.message);
  }

  const pathOf = (fileId: string) => project?.files.find(file => file.id === fileId)?.relativePath ?? '(목록에 없는 파일)';
  const files = project?.files.filter(file => file.relativePath.toLowerCase().includes(search.toLowerCase())) ?? [];
  const intro = project?.overview.intro;
  const scope = [project?.name, source?.relativePath, symbol?.name, step?.title].filter(Boolean);

  return <div className={`app${project ? '' : ' app--empty'}${panelOpen ? '' : ' app--panel-closed'}`}>
    <header className="topbar">
      <h1 className="brand">Code Learning</h1>
      {project && <nav aria-label="현재 학습 위치" className="crumbs">
        {scope.map((part, index) => <span key={index} className="crumb">{part}</span>)}
      </nav>}
      <div className="topbar__actions">
        {busy && <span role="status" className="busy"><span className="spinner" aria-hidden="true" />처리 중…</span>}
        <span className="badge badge--muted" title="질문 탭에서 동의하고 보낸 질문만 Codex·Gemini에 보냅니다. 알려진 한계는 README에 있습니다.">AI는 동의한 질문만</span>
        <button className="btn btn--primary" onClick={openProject} disabled={busy}>프로젝트 폴더 열기</button>
        <button className="btn" onClick={cancel} disabled={!project && !busy}>작업 취소·프로젝트 닫기</button>
      </div>
    </header>

    {(error || notice || (project && (watchError || stale))) && <div className="notices">
      {error && <p role="alert" className="notice">{error}</p>}
      {notice && <p role="status" className="notice notice--info">{notice}</p>}
      {project && watchError && <p role="alert" className="notice notice--warn"><b>변경 감지 제한:</b> 폴더를 다시 열어 주세요. 근거를 사용할 때 파일을 다시 확인합니다.</p>}
      {project && stale && <p role="alert" className="notice notice--warn"><b>코드 변경 또는 잠자기 복귀:</b> 다시 확인 필요. 이전 코드 기준의 강조를 해제했습니다. 파일을 다시 읽으면 최신 코드로 이어서 볼 수 있어요.</p>}
    </div>}

    {!project ? <main className="welcome">
      <h2>프로젝트를 열어 코드를 읽어 보세요</h2>
      <p className="welcome__lead">폴더 하나를 고르면 어떤 파일이 있는지 보여주고, 함수 안의 조건·반환 같은 부분을 실제 코드 위치와 함께 짚어 줘요.</p>
      <ol className="welcome__steps">
        <li><b>폴더 열기</b><span>위의 ‘프로젝트 폴더 열기’를 눌러요.</span></li>
        <li><b>파일과 함수 고르기</b><span>왼쪽 목록에서 읽을 파일을 골라요.</span></li>
        <li><b>코드 위치 확인</b><span>구문을 누르면 해당 줄이 강조돼요.</span></li>
      </ol>
      <ul className="welcome__promises">
        <li>원본 파일을 수정하지 않아요.</li>
        <li>AI에는 질문 탭에서 동의한 질문만 보내요. 알려진 한계는 README에 있어요.</li>
      </ul>
    </main> : <>
      <aside className="sidebar" aria-label="보기와 파일">
        <div className="sidebar__project">
          <span className="eyebrow">프로젝트</span>
          <h2>{project.name}</h2>
        </div>
        <nav aria-label="보기" className="views">
          {views.map(item => <button key={item.id} className="views__item" aria-current={view === item.id ? 'page' : undefined}
            onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <section aria-label="파일 목록" className="files">
          <h3 className="eyebrow">파일 {project.files.length}개</h3>
          <input className="search" type="search" aria-label="파일명 검색" placeholder="파일명 검색"
            value={search} onChange={event => setSearch(event.target.value)} />
          <ul>{files.map(file =>
            <li key={file.id}><button className="files__item" disabled={busy} aria-current={source?.fileId === file.id ? 'true' : undefined}
              // The flow view picks its function from the chosen file, so it stays where it is.
              onClick={() => { if (view !== 'flow') setView('code'); void readFile(file.id); }}>{file.relativePath}</button></li>)}</ul>
          {files.length === 0 && <p className="hint">검색과 일치하는 파일이 없어요.</p>}
        </section>
      </aside>

      <main className="center">
        {view === 'overview' && <div className="page">
          <h2 className="page__title">한눈에 보기</h2>
          {overviewStale && <p className="notice notice--warn overview-stale"><b>다시 확인 필요:</b> 프로젝트를 연 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 아래 소개와 후보는 폴더를 열 때 읽은 내용이에요. 폴더를 다시 열면 새로 계산해요.</p>}
          <div className="cards">
            <section className="card" aria-labelledby="overview-intro">
              <h3 id="overview-intro">이 프로젝트는 무엇을 하나요?</h3>
              {intro ? <>
                <span className="tag tag--doc">문서에 적힌 소개</span>
                {intro.title && <p className="intro__title">{intro.title}</p>}
                {intro.text && <p className="intro__text">{intro.text}</p>}
                <p className="hint">{intro.relativePath}{intro.startLine !== null && ` · ${intro.startLine}–${intro.endLine}줄`} · 문서 내용이 실제 코드와 맞는지는 확인하지 않았어요.</p>
                <button className="btn btn--small" disabled={busy} onClick={() => { setView('code'); void readFile(intro.fileId); }}>{intro.relativePath} 열기</button>
              </> : <p className="unknown"><span className="tag tag--unknown">확인하지 못함</span>프로젝트 목적: 아직 확인하지 못했습니다.</p>}
            </section>
            <section className="card">
              <h3>읽을 수 있는 파일</h3>
              <p className="stat"><b>{project.files.length}</b>개</p>
              <details><summary>제외 항목</summary>
                <ul>{Object.entries(project.excluded).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul>
              </details>
            </section>
            <section className="card card--wide card--accent" aria-labelledby="overview-start">
              <h3 id="overview-start">어디부터 읽을까요?</h3>
              {project.overview.candidates.length > 0 ? <ul className="starts">{project.overview.candidates.map(item =>
                <li key={`${item.fileId}:${item.startUtf16}`}>
                  <button className="starts__item" disabled={busy} onClick={() => void startFrom(item)}>
                    <b>{item.name ?? '이 파일 살펴보기'}</b> <span className="path">{item.relativePath}</span>
                  </button>
                  <span className="hint">{candidateReasons[item.reason]}</span>
                </li>)}</ul>
                : <p>시작점 후보를 찾지 못했어요. 왼쪽 목록에서 궁금한 파일을 골라 <b>코드 읽기</b>로 시작해 보세요.</p>}
              <p className="hint"><span className="tag tag--unknown">학습 시작점 후보</span>TS/JS 파일 {project.overview.checkedFiles}개를 살펴봤어요{project.overview.limited && '(전체 중 일부)'}. 코드 구조로 고른 후보이고, 실제 실행 시작점인지는 확인하지 않았어요.</p>
              {project.overview.notes.map(note => <p key={note} className="hint">{note}</p>)}
            </section>
            <section className="card card--wide">
              <h3>확인한 범위와 모르는 부분</h3>
              <ul className="checklist">
                <li><span className="tag tag--ok">확인됨</span>파일 목록과 TS/JS 함수 안의 구문 위치{intro && ', README에 적힌 소개 문구'}</li>
                <li><span className="tag tag--unknown">확인하지 못함</span>프로젝트 목적(문서 내용이 코드와 맞는지 포함), 기능의 실제 실행 순서. 파일끼리 가져다 쓰는 관계는 ‘프로젝트 지도’에서 볼 수 있어요.</li>
              </ul>
              {project.warnings.map(message => <p key={message} className="hint">{message}</p>)}
              <p className="hint">새 파일 목록은 폴더를 다시 열어 갱신합니다. 현재 파일·제외 규칙의 변경은 읽기 전에 다시 확인합니다.</p>
            </section>
          </div>
        </div>}

        {view === 'map' && <ProjectMapView project={project} entry={projectMap}
          stale={projectMap !== null && projectMap.revision !== revision.current} mapping={mapping}
          onBuild={() => void buildMap()} onCancel={() => void cancelMap()}
          locked={busy} onOpenFile={fileId => { if (busy) return; setView('code'); void readFile(fileId); }}
          onShowImport={item => void showImport(item)} onShowFunction={item => void showFunction(item)} />}

        {view === 'flow' && <Flow source={source} symbol={symbol} step={step} evidence={evidence} locked={busy || stale}
          onSymbol={item => { selectSymbol(item.id); void showEvidence(item.evidence, null); }}
          onStep={next => {
            if (next) void showEvidence(next.evidence, next.id);
            else if (symbol) void showEvidence(symbol.evidence, null);
          }}
          onOpenCode={() => setView('code')}
          calls={calls && source && symbol && calls.key === callsKey(source, symbol) && <>
            <CallsFacts state={calls.state} stale={calls.revision !== revision.current} locked={busy} pathOf={pathOf}
              onRetry={() => void findCalls(source, symbol)} onCancel={() => void cancelCalls()}
              onShowSite={site => void showCallSite(site)} onShowFunction={target => void showCallFunction(target)} />
            {calls.state.status === 'done' && <ValuesFacts key={calls.key} result={calls.state.result} locked={busy} pathOf={pathOf}
              onShowSite={site => void showValueSite(site)} onShowFunction={target => void showCallFunction(target)} />}
          </>} />}

        {view === 'changes' && <div className="page page--empty">
          <h2 className="page__title">달라진 내용</h2>
          {stale && <p>프로젝트를 연 뒤 코드가 바뀌었을 수 있어요. 파일을 다시 읽어 최신 코드를 확인해 주세요.</p>}
          <p className="hint">변경 이력과 수정 전후 비교는 아직 준비 중이에요.</p>
        </div>}

        {view === 'code' && (!source ? <div className="page page--empty">
          <h2 className="page__title">코드 읽기</h2>
          <p>파일을 선택하면 원문과 확인한 함수 구조를 읽을 수 있습니다.</p>
        </div> : <div className="reader">
          <div className="reader__head">
            <h3 className="path">{source.relativePath}</h3>
            <span className="badge">읽기 전용</span>
            {symbol && <button className="btn btn--small" onClick={() => setView('flow')}>이 함수 흐름으로 보기</button>}
            <button className="btn btn--small" disabled={busy} onClick={() => readFile(source.fileId)}>파일 다시 읽기</button>
            <div className="reader__tools" role="group" aria-label="읽기 설정">
              <button className="btn btn--small" aria-keyshortcuts="Meta+F" onClick={() => reader.current?.openSearch()}>찾기 ⌘F</button>
              <button className="btn btn--small" aria-label="코드 글자 작게" disabled={codeSize <= CODE_SIZE.min}
                onClick={() => setCodeSize(size => size - 1)}>가−</button>
              <span className="reader__size" aria-live="polite">코드 {codeSize}px</span>
              <button className="btn btn--small" aria-label="코드 글자 크게" disabled={codeSize >= CODE_SIZE.max}
                onClick={() => setCodeSize(size => size + 1)}>가+</button>
              <button className="btn btn--small" aria-pressed={wrap} onClick={() => setWrap(on => !on)}>줄바꿈</button>
            </div>
          </div>
          <div className="reader__body">
            <section aria-label="구문과 코드" className="outline">
              <h4 className="eyebrow">함수와 구문</h4>
              {source.analysis.warnings.map(message => <p key={message} className="hint">{message}</p>)}
              {source.analysis.symbols.length === 0 && <p className="hint">이 파일에서 찾은 함수가 없어요.</p>}
              {source.analysis.symbols.some(item => overLimit(item.complexity)) && <p className="hint">{COMPLEXITY_NOTE}</p>}
              <ul className="symbols">{source.analysis.symbols.map(item => <li key={item.id}>
                <button className="symbols__item" aria-pressed={symbolId === item.id} disabled={busy || stale}
                  onClick={() => { selectSymbol(item.id); void showEvidence(item.evidence, null); }}>{item.name}</button>
                {overLimit(item.complexity) && <div className="symbols__signals">
                  <ComplexityTags {...item.complexity} />
                  {symbol?.id === item.id && <button className="btn btn--small" disabled={busy || stale}
                    onClick={() => void askSimpler(item)}>AI에게 단순하게 쓰는 법 묻기</button>}
                </div>}
                {symbol?.id === item.id && <ol className="steps" aria-label={`${item.name} 내부 구문`}>
                  {item.steps.map((next, index) => <li key={next.id} style={{ paddingLeft: next.depth * 14 }}>
                    <span className="steps__no" aria-hidden="true">{index + 1}</span>
                    <button className="steps__item" aria-pressed={stepId === next.id} disabled={busy || stale}
                      onClick={() => showEvidence(next.evidence, next.id)}>{next.title}</button>
                  </li>)}
                </ol>}
              </li>)}</ul>
            </section>
            <div className="code">
              {evidence && <p data-testid="evidence-range" className="evidence">근거: {source.relativePath} · {evidence.startLine}–{evidence.endLine}줄 · UTF-16 [{evidence.startUtf16}, {evidence.endUtf16})</p>}
              <Reader ref={reader} source={source} evidence={evidence} codeSize={codeSize} wrap={wrap} />
            </div>
          </div>
        </div>)}
      </main>

      <aside className="panel" aria-label="설명과 질문" hidden={!panelOpen}>
        <div className="panel__head">
          <div role="tablist" className="tabs">
            <button role="tab" aria-selected={panel === 'explain'} onClick={() => setPanel('explain')}>쉬운 설명</button>
            <button role="tab" aria-selected={panel === 'ask'} onClick={() => setPanel('ask')}>질문</button>
          </div>
          <button className="btn btn--ghost btn--small" onClick={() => setPanelOpen(false)}>패널 접기</button>
        </div>
        <p className="scope"><span className="eyebrow">현재 범위</span>{scope.join(' › ')}</p>
        {panel === 'explain' && <div className="panel__body">
          {step && evidence ? <section className="fact">
            <span className="tag tag--ok">코드에서 확인됨</span>
            <p><b>{symbol?.name}</b> 함수 안의 <b>{step.title}</b> 부분이에요. 원본 {evidence.startLine}–{evidence.endLine}줄에 있어요.</p>
          </section> : symbol && evidence ? <section className="fact">
            <span className="tag tag--ok">코드에서 확인됨</span>
            <p><b>{symbol.name}</b> 함수는 원본 {evidence.startLine}–{evidence.endLine}줄에 있어요. 왼쪽에서 구문을 골라 한 부분씩 볼 수 있어요.</p>
          </section> : <p className="hint">함수나 구문을 고르면 그 부분을 여기서 짚어 줘요.</p>}
          <section className="fact fact--muted">
            <span className="tag tag--unknown">AI 설명은 질문 탭에서</span>
            <p>여기에는 코드에서 확인한 내용만 보여요. AI 설명은 질문 탭에서 동의하고 질문하면 받을 수 있어요.</p>
          </section>
        </div>}
        <div hidden={panel !== 'ask'}>
          <AiPanel key={project.id} projectId={project.id} evidence={questionEvidence} stale={stale} draft={draft}
            relativePath={project.files.find(file => file.id === questionEvidence?.fileId)?.relativePath ?? ''}
            onEvidence={next => { setView('code'); void showEvidence(next, null, true); }} />
        </div>
      </aside>
      {!panelOpen && <button className="panel-reopen btn btn--small" onClick={() => setPanelOpen(true)}>설명 패널 펼치기</button>}
    </>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
