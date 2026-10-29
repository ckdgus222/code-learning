import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FlowNode, CallSite, ValueSite, CodeSide, CodeSymbol, Evidence, FileChange, FunctionCalls, GitHistory, MapExport, MapFunction, MapImport, ProjectView, SourceView,
  StartCandidate, LearningMark, MarkKey, LearningSpot, RecentProject, SavedSpot } from '../shared/contracts';
import { showsFiles, useSelection, type View } from './selection';
import { Reader, type ReaderHandle } from './reader';
import { Icon } from './icons';
import { ancestorFolderPaths, buildFileTree, filterFileTree, type TreeFolder } from './file-tree';
import { AiPanel } from './ai-panel';
import { FileGuideCard } from './file-guide';
import { fileUses } from './screen-groups';
import { aiFunctionSummaries, functionDoes, importersOf } from './guide-facts';
import { FileExplanationCard, rememberFileExplanation, type FileExplanationEntry, type FileExplanationState } from './file-explanation';
import { Flow } from './flow';
import { markKeysOf, sameMarkKey, nextMark, type MarkChange } from './marks';
import { LearningMarksCard } from './learning-marks';
import { ProjectMapView, type MapEntry } from './project-map';
import { FeatureChooser, FeatureList, FlowLimits, FlowPicture, FlowWalk, hasFlowCode, RoutesStatus, siteOf, useFeatureFlows, type FlowStart } from './feature-flow';
import { codeNameOf } from '../core/analysis/flow-story';
import { matchCallStep, matchFunction, matchImport } from './map-layout';
import { CallsFacts, type CallFunction, type CallsState } from './calls';
import { shapeQueries, ValuesFacts, type ShapeSlot, type ShapesState } from './values';
import { COMPLEXITY_NOTE, ComplexityTags, overLimit } from './complexity';
import { ChangesView, type ChangesEntry, type DiffEntry, type Loaded } from './changes';
import { ResumeCard, restoreSpot, spotOf, OverviewAi, TopicBar, recordPlace, type OverviewState, type Place, type Topic } from './overview';
import type { ConnectionReport, LearningEvent, OverviewFeature, LearningMode, FileExplanationRange } from '../shared/ai';
import './styles.css';

const views: { id: Exclude<View, 'function'>; label: string; more?: true }[] = [
  { id: 'overview', label: '한눈에 보기' }, { id: 'flow', label: '흐름 따라가기' },
  { id: 'code', label: '코드 읽기' }, { id: 'map', label: '프로젝트 지도', more: true }, { id: 'changes', label: '달라진 내용', more: true },
];
const candidateReasons: Record<StartCandidate['reason'], string> = {
  'package-main': 'package.json의 main이 가리키는 파일',
  'package-bin': 'package.json의 bin(명령)이 가리키는 파일',
  'entry-name': '이름이 index·main·app인 파일',
  exported: '다른 파일에서 쓰도록 내보낸(export) 함수',
};
// Plan v2.3 C-1: the AI is only asked; the app never changes the code.
const SAVE_FAILED = '학습 위치를 저장하지 못했어요. 다음에 이어서 보기가 예전 위치일 수 있어요.';
const SIMPLER_QUESTION = '이 함수를 더 단순하고 읽기 쉽게 쓸 수 있을까요? 바꾼다면 어디를 어떻게 바꾸면 좋을지 알려 주세요.';
// Plan G1·F1: the question a topic prepares about its feature; only put in the box, sent by the user.
const featureQuestion = (name: string) => `‘${name}’ 기능이 이 함수에서 어떻게 시작하는지, 어떤 입력을 받고 어느 코드에서 주요 처리를 하며 `
  + '무엇을 돌려주거나 저장·표시하는지 단계별로 설명해 주세요. 확인하지 못한 연결은 따로 적어 주세요.';
// Code text size in px (plan 7.3: 14–16px to start, adjustable).
const CODE_SIZE = { min: 12, start: 15, max: 20 };

function FileTreeList({ folder, expanded, searching, currentFileId, busy, onToggle, onFile, hidden = false }: {
  folder: TreeFolder; expanded: Set<string>; searching: boolean; currentFileId?: string; busy: boolean;
  onToggle: (path: string) => void; onFile: (fileId: string) => void; hidden?: boolean;
}) {
  return <ul id={`file-folder-${encodeURIComponent(folder.path)}`} hidden={hidden}>
    {!hidden && folder.children.map(child => {
      if (child.kind === 'file') return <li key={child.file.id}>
        <button className="files__item" disabled={busy} aria-label={child.file.relativePath} title={child.file.relativePath}
          aria-current={currentFileId === child.file.id ? 'true' : undefined}
          onClick={() => onFile(child.file.id)}>{child.name}</button>
      </li>;
      const open = searching || expanded.has(child.path);
      const label = <><span aria-hidden="true">{open ? '▾' : '▸'}</span> {child.name}</>;
      return <li key={`folder:${child.path}`}>
        {searching ? <span className="files__folder" title={child.path}>{label}</span>
          : <button className="files__folder" title={child.path} aria-label={`폴더 ${child.path}`}
            aria-expanded={open} aria-controls={`file-folder-${encodeURIComponent(child.path)}`}
            onClick={() => onToggle(child.path)}>{label}</button>}
        <FileTreeList folder={child} expanded={expanded} searching={searching} currentFileId={currentFileId}
          busy={busy} onToggle={onToggle} onFile={onFile} hidden={!open} />
      </li>;
    })}
  </ul>;
}

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
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(true);
  const [fileGuideOpen, setFileGuideOpen] = useState(false);
  const [draft, setDraft] = useState<{ text: string; id: number; topic?: { name: string; evidenceId: string } } | null>(null);
  // The AI installation check, shared by the question panel and the overview card.
  const [connections, setConnections] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<LearningMode>('local-worker');
  const [featureGuideRunning, setFeatureGuideRunning] = useState(false);
  const [questionRunning, setQuestionRunning] = useState(false);
  const [fileExplanations, setFileExplanations] = useState<FileExplanationEntry[]>([]);
  const [fileExplanationState, setFileExplanationState] = useState<FileExplanationState | null>(null);
  const fileExplanationRequest = useRef(0);
  const fileExplanationJob = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[]; revision: number }>({ id: null, starting: false, queued: [], revision: 0 });
  // Plan G1: the overview job and its result; plan F1: the topic being learned and where '한눈에 보기로' puts the focus.
  const [overviewAi, setOverviewAi] = useState<OverviewState | null>(null);
  // Counts opened folders (and closings): the overview card starts over, its consent unchecked, for each one.
  const [overviewCard, setOverviewCard] = useState(0);
  const overviewRequest = useRef(0);
  const overviewJob = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[] }>({ id: null, starting: false, queued: [] });
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [resume, setResume] = useState<{ projectId: string; saved: SavedSpot } | null>(null);
  const openedAt = useRef(0);
  const [marks, setMarks] = useState<{ projectId: string; list: LearningMark[] } | null>(null);
  const [pendingMarks, setPendingMarks] = useState<MarkKey[]>([]);
  const savingMarks = useRef<MarkKey[]>([]);
  const [topic, setTopic] = useState<Topic | null>(null);
  // The places looked at under the topic (the last 20).
  const [places, setPlaces] = useState<Place[]>([]);
  const [focusAnchor, setFocusAnchor] = useState<string | null>(null);
  // Reading settings live as long as the window: they stay across files and views, not across restarts.
  const [codeSize, setCodeSize] = useState(CODE_SIZE.start);
  const [wrap, setWrap] = useState(false);
  const [bands, setBands] = useState(true);
  const [functionFocus, setFunctionFocus] = useState<{ fileId: string; hash: string; symbolId: string } | null>(null);
  const reader = useRef<ReaderHandle>(null);
  const request = useRef(0);
  const revision = useRef(0);
  // A second notice changes no other state (stale is already set), so this redraws the screen for the map.
  const [, setRevisionShown] = useState(0);
  // The map is drawn by its own worker, so it has its own request counter: reads may go on meanwhile.
  const [projectMap, setProjectMap] = useState<MapEntry | null>(null);
  const [mapTab, setMapTab] = useState<'feature' | 'file'>('feature');
  const [mapping, setMapping] = useState(false);
  const mapRequest = useRef(0);
  // The call search for the function chosen in the flow view (plan v2.3 F), kept per function and file hash.
  const [calls, setCalls] = useState<{ key: string; state: CallsState; revision: number } | null>(null);
  const callsRequest = useRef(0);
  // The value shapes for those calls (plan v2.3 V-2), asked for once the calls are found, under the same key.
  const [shapes, setShapes] = useState<{ key: string; state: ShapesState; slots: ShapeSlot[] } | null>(null);
  const shapesRequest = useRef(0);
  // Plan v2.3 C-2: the commits of the opened folder, the comparison with the one chosen, and one change opened.
  const [history, setHistory] = useState<Loaded<GitHistory> | null>(null);
  const [changes, setChanges] = useState<ChangesEntry | null>(null);
  const [diff, setDiff] = useState<DiffEntry | null>(null);
  const historyRequest = useRef(0);
  const changesRequest = useRef(0);
  const diffRequest = useRef(0);
  const { view, setView, symbolId, stepId, selectSymbol, selectStep } = useSelection();
  const features = useFeatureFlows(project, revision.current);
  const importers = useMemo(() => source && projectMap ? importersOf(source.fileId, source.relativePath, projectMap.map) : null,
    [source?.fileId, projectMap]);
  const does = useMemo(() => functionDoes(source?.fileId ?? '', source?.hash ?? '', source?.analysis.symbols ?? [],
    features.stale ? null : features.routes ?? null, features.groupingProps.flows),
  [source?.fileId, source?.hash, features.routes, features.groupingProps.flows, features.stale]);
  const uses = useMemo(() => source && features.routes && features.groupingProps.flows
    ? fileUses(source.fileId, source.hash, features.routes, features.groupingProps.flows)
    : { uses: [], changed: false }, [source?.fileId, source?.hash, features.routes, features.groupingProps.flows]);
  const currentView = useRef(view);
  const currentBusy = useRef(busy);
  currentView.current = view;
  currentBusy.current = busy;
  useEffect(() => {
    if (view === 'overview' || (view === 'map' && mapTab === 'feature')) features.start();
  }, [project, view, mapTab]);
  const symbol = source?.analysis.symbols.find(item => item.id === symbolId);
  const step = symbol?.steps.find(item => item.id === stepId);
  const fileExplanation = fileExplanations.find(entry => entry.result.range.fileId === source?.fileId) ?? null;
  const fileExplanationStale = fileExplanation !== null &&
    (fileExplanation.revision !== revision.current || fileExplanation.result.range.fileHash !== source?.hash);
  const fileExplanationRunning = fileExplanationState?.status === 'running';
  // The AI file explanation job of the file now read, if any (another file's job is shown in the top bar).
  const sourceExplanationState = source && fileExplanationState?.fileId === source.fileId ? fileExplanationState : null;
  const fileExplanationOpen = !!fileExplanation || (sourceExplanationState !== null &&
    (sourceExplanationState.status === 'running' || !!sourceExplanationState.message));
  const functionChunk = symbol && fileExplanation?.result.chunks.find(chunk =>
    chunk.functionRange?.startUtf16 === symbol.evidence.startUtf16 && chunk.functionRange.endUtf16 === symbol.evidence.endUtf16);
  const functionExplanation = symbol && fileExplanation && !fileExplanationStale
    ? functionChunk ? fileExplanation.result.explanation.chunks.find(chunk => chunk.chunkId === functionChunk.id)?.summary ?? '설명 없음'
      : '이 함수는 따로 설명한 덩어리가 없어요' : null;

  useEffect(() => {
    if (!source) return;
    setExpandedFolders(current => new Set([...current, ...ancestorFolderPaths(source.relativePath)]));
  }, [source]);

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

  const overviewReceiver = useRef((_event: LearningEvent) => {});
  overviewReceiver.current = event => {
    const job = overviewJob.current;
    if (event.projectId !== project?.id) return;
    if (job.starting) { if (job.queued.length < 16) job.queued.push(event); return; }
    if (event.jobId !== job.id) return;
    if (event.kind === 'progress') { setOverviewAi(state => state?.status === 'running' ? { ...state, phase: event.phase } : state); return; }
    job.id = null;
    if (event.kind === 'failed') setOverviewAi({ status: 'failed', message: event.error.message, cancelled: event.error.code === 'CANCELLED' });
    else if (event.kind === 'overview-completed') {
      setOverviewAi(state => state?.status === 'running' ? { status: 'done', result: event.result, revision: state.revision } : state);
    }
  };
  useEffect(() => window.learning.onLearningEvent(event => overviewReceiver.current(event)), []);
  const fileExplanationReceiver = useRef((_event: LearningEvent) => {});
  fileExplanationReceiver.current = event => {
    const job = fileExplanationJob.current;
    if (event.projectId !== project?.id) return;
    if (job.starting) { if (job.queued.length < 16) job.queued.push(event); return; }
    if (event.jobId !== job.id) return;
    if (event.kind === 'progress') {
      setFileExplanationState(state => state?.status === 'running' ? { ...state, phase: event.phase } : state);
      return;
    }
    job.id = null;
    if (event.kind === 'failed') {
      setFileExplanationState(state => state && { status: 'failed', fileId: state.fileId,
        message: event.error.message, cancelled: event.error.code === 'CANCELLED' });
    } else if (event.kind === 'file-explanation-completed') {
      if (job.revision !== revision.current) {
        setFileExplanationState({ status: 'failed', fileId: event.result.range.fileId, message: '파일이 바뀌어 다시 만들어 주세요', cancelled: false });
        return;
      }
      setFileExplanations(previous => rememberFileExplanation(previous, { result: event.result, revision: job.revision }));
      setFileExplanationState(null);
    }
  };
  useEffect(() => window.learning.onLearningEvent(event => fileExplanationReceiver.current(event)), []);
  // Coming back to the overview puts the focus on the card the topic came from (plan U1).
  useEffect(() => {
    if (view !== 'overview' || !focusAnchor) return;
    const target = document.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(focusAnchor)}"]`) ?? document.querySelector<HTMLElement>('[data-anchor="overview"]');
    for (let details = target?.closest('details'); details; details = details.parentElement?.closest('details')) {
      details.open = true;
    }
    target?.focus();
    setFocusAnchor(null);
  }, [view, focusAnchor, overviewAi]);

  // Plan F1: while a topic is open, each settled place in the code views is recorded.
  // A change notice clears the marks, which is no move: nothing is recorded while the code waits for a re-read.
  useEffect(() => {
    if (!topic || busy || stale || !source || (view !== 'function' && view !== 'code')) return;
    const range = evidence && evidence.fileId === source.fileId
      ? { startUtf16: evidence.startUtf16, endUtf16: evidence.endUtf16, startLine: evidence.startLine, endLine: evidence.endLine } : null;
    const place: Place = { view, fileId: source.fileId, fileHash: source.hash, range,
      symbol: symbol ? { name: symbol.name, startUtf16: symbol.evidence.startUtf16, step: step ? symbol.steps.indexOf(step) : null } : null };
    setPlaces(previous => recordPlace(previous, place));
  }, [topic === null, busy, stale, view, source?.fileId, source?.hash, symbol?.id, stepId, evidence?.id]);

  useEffect(() => {
    if (project) return;
    let cancelled = false;
    void window.learning.recentProjects().then(result => {
      if (!cancelled && result.ok) setRecentProjects(result.value);
    });
    return () => { cancelled = true; };
  }, [project]);

  const lastPlace = places.at(-1) ?? null;
  useEffect(() => {
    // Opening or closing a folder clears the topic in memory, never its saved location.
    if (!project || !topic) return;
    try { void saveSpot(project.id, spotOf(topic, lastPlace, project.files)); }
    catch { setNotice(SAVE_FAILED); }
  }, [project, topic, lastPlace]);

  async function saveSpot(projectId: string, spot: LearningSpot | null) {
    try {
      const result = await window.learning.saveLearningSpot({ projectId, spot });
      if (result.ok || result.code === 'PROJECT_CLOSED') return;
    } catch { /* An unavailable IPC connection is also a save failure. */ }
    setNotice(SAVE_FAILED);
  }

  // A newly opened project starts from its overview, not the previous project's view.
  useEffect(() => setView('overview'), [project, setView]);
  // Choosing a function in the flow view searches its calls; coming back to it reuses what was found.
  useEffect(() => {
    if (view === 'function' && source && symbol && calls?.key !== callsKey(source, symbol)) void findCalls(source, symbol);
  }, [view, source, symbol]);
  // The calls found lead to their value shapes; coming back to a function reuses both.
  useEffect(() => {
    if (view === 'function' && calls?.state.status === 'done' && shapes?.key !== calls.key) void findShapes(calls.key, calls.state.result);
  }, [calls, view]);
  // The changes view reads the folder's commits the first time it is looked at, then compares with HEAD.
  useEffect(() => {
    if (view === 'changes' && project && !history) void loadHistory();
  }, [view, project]);
  // The map is drawn the first time it is looked at after a folder opens.
  useEffect(() => {
    if (view === 'map' && mapTab === 'file' && project && !projectMap && !mapping) void buildMap();
  }, [view, project, mapTab]);

  async function openProject(projectId?: string) {
    const current = ++request.current;
    setBusy(true); setError(''); setNotice('');
    const result = await (projectId ? window.learning.openRecent({ projectId }) : window.learning.openProject());
    if (current !== request.current) return;
    setBusy(false);
    if (!result.ok) {
      openedAt.current++;
      setError(result.message); setProject(null); setSource(null); setEvidence(null); selectSymbol(null); forgetMap(); forgetCalls(); forgetChanges(); forgetOverview(); return;
    }
    if (!result.value) return;
    // Cancelling the folder picker keeps this session, including its pending reads and saves.
    const opening = ++openedAt.current;
    // Reopening the same folder keeps the project ID but gives every file a new ID, so the map goes too.
    forgetMap(); forgetCalls(); forgetChanges(); forgetOverview();
    setExpandedFolders(new Set());
    setProject(result.value); setSource(null); setEvidence(null); setStale(false); setOverviewStale(false); setWatchError(false); setSearch(''); selectSymbol(null);
    const id = result.value.id;
    await Promise.all([
      window.learning.learningSpot({ projectId: id }).then(saved => {
        if (opening !== openedAt.current) return;
        if (saved.ok && saved.value) setResume({ projectId: id, saved: saved.value });
      }),
      window.learning.learningMarks({ projectId: id }).then(saved => {
        if (opening !== openedAt.current) return;
        if (saved.ok) setMarks({ projectId: id, list: saved.value });
        else if (saved.code !== 'PROJECT_CLOSED') setNotice('학습 기록을 불러오지 못했어요.');
      }),
    ]);
  }

  async function saveMark(key: MarkKey, change: MarkChange, currentHash: string) {
    if (!project || marks?.projectId !== project.id || busy || stale || savingMarks.current.some(item => sameMarkKey(item, key))) return;
    const opening = openedAt.current;
    const mark = nextMark(marks.list.find(item => sameMarkKey(item, key)), change, currentHash, key);
    savingMarks.current = [...savingMarks.current, key];
    setPendingMarks(savingMarks.current);
    try {
      const result = await window.learning.saveLearningMark({ projectId: project.id, mark });
      if (opening !== openedAt.current) return;
      if (!result.ok) {
        if (result.code !== 'PROJECT_CLOSED') setNotice('학습 기록을 저장하지 못했어요.');
        return;
      }
      setMarks(previous => {
        if (previous?.projectId !== project.id) return previous;
        const list = previous.list.filter(item => !sameMarkKey(item, key));
        if (result.value) list.push(result.value);
        return { projectId: project.id, list };
      });
    } catch {
      if (opening === openedAt.current) setNotice('학습 기록을 저장하지 못했어요.');
    } finally {
      if (opening === openedAt.current) {
        savingMarks.current = savingMarks.current.filter(item => !sameMarkKey(item, key));
        setPendingMarks(savingMarks.current);
      }
    }
  }

  async function openMark(mark: LearningMark) {
    if (!project || busy) return;
    const file = project.files.find(item => item.relativePath === mark.relativePath);
    if (!file) return;
    setView('function');
    const atRevision = revision.current;
    const opened = await readFile(file.id);
    if (!opened || revision.current !== atRevision) return;
    const keys = markKeysOf(opened);
    const found = opened.analysis.symbols.find(item => sameMarkKey(mark, keys.get(item.id)!));
    if (!found) { setNotice(`‘${mark.name}’ 함수를 이 파일에서 찾지 못했어요. 이름이 바뀌었을 수 있어요.`); return; }
    selectSymbol(found.id); setReaderEvidence(found.evidence);
  }

  /**
   * Opens a file in the reader. Moving around (a topic, a call, a value, the map, an overview: integrated plan 6.2) keeps
   * the question's code, and with it the answers and a question on its way; choosing code to ask about is a separate step.
   * Only opening a file from the file list starts with no question.
   */
  async function readFile(fileId: string, clearQuestion = false): Promise<SourceView | null> {
    if (!project) return null;
    const current = ++request.current;
    const atRevision = revision.current;
    setBusy(true); setError(''); setNotice(''); selectSymbol(null);
    if (clearQuestion) setEvidence(null); else setReaderEvidence(null);
    const result = await window.learning.readSource({ projectId: project.id, fileId });
    if (current !== request.current) return null;
    setBusy(false);
    if (!result.ok) { setError(result.message); setSource(null); return null; }
    setSource(result.value); setStale(revision.current !== atRevision);
    // The question's own file, read again and changed: its code is gone, so it is not kept as the question.
    const read = result.value;
    setQuestionEvidence(question => question && question.fileId === read.fileId && question.fileHash !== read.hash ? null : question);
    return result.value;
  }

  // Candidates were found when the folder opened. Only a file whose hash is unchanged is trusted
  // to still hold the same function at the same place; otherwise the reader chooses again.
  async function startFrom(candidate: StartCandidate) {
    const next: Topic = { name: candidate.name ?? candidate.relativePath, original: candidate.name ?? candidate.relativePath, origin: 'start',
      start: { fileId: candidate.fileId, fileHash: candidate.fileHash, relativePath: candidate.relativePath, functionName: candidate.name,
        startUtf16: candidate.name === null ? null : candidate.startUtf16 },
      anchor: `start:${candidate.fileId}:${candidate.startUtf16}` };
    beginTopic(next);
    await openStart(next);
  }
  /** A new topic (or none) starts with no places looked at. */
  function beginTopic(next: Topic | null) { setTopic(next); setPlaces([]); }
  /**
   * Back to the place before (plan F1): the file is read again, and only while it is as it was are its function and
   * step chosen again (by name and place, by range) and its range marked. A range of no step is for looking only.
   */
  async function goBack() {
    const target = places.at(-2);
    if (!target) return;
    setPlaces(previous => previous.slice(0, -1));
    await goTo(target, '그 뒤 파일이 바뀌어 위치를 되살리지 않았어요. 파일만 열었어요.');
  }

  async function goTo(target: Place, changedNotice: string) {
    setView(target.view);
    const atRevision = revision.current;
    const opened = await readFile(target.fileId);
    if (!opened || revision.current !== atRevision) return;
    // Where it lands stands for the place gone back to (a file changed since too), whatever view is shown meanwhile.
    const land = (symbol: Place['symbol'], marked: Evidence | null) => setPlaces(previous => [...previous.slice(0, -1), {
      view: target.view, fileId: opened.fileId, fileHash: opened.hash, symbol,
      range: marked && { startUtf16: marked.startUtf16, endUtf16: marked.endUtf16, startLine: marked.startLine, endLine: marked.endLine } }]);
    const { range, symbol: chosen } = target;
    if (opened.hash !== target.fileHash || (range && range.endUtf16 > opened.text.length) ||
        (chosen && chosen.startUtf16 >= opened.text.length)) {
      setNotice(changedNotice); land(null, null); return;
    }
    const found = chosen && opened.analysis.symbols.find(item => item.name === chosen.name && item.evidence.startUtf16 === chosen.startUtf16);
    const same = (marked: Evidence) => range !== null && marked.startUtf16 === range.startUtf16 && marked.endUtf16 === range.endUtf16;
    // The same file as it was gives the same steps in the same order.
    const listed = found && chosen.step !== null ? found.steps[chosen.step] : undefined;
    const step = listed && same(listed.evidence) ? listed : undefined;
    const marked = step ? step.evidence : found && (!range || same(found.evidence)) ? found.evidence
      : range ? { id: crypto.randomUUID(), projectId: opened.projectId, fileId: opened.fileId, fileHash: opened.hash, ...range } : null;
    if (found) selectSymbol(found.id);
    if (step) selectStep(step.id);
    setReaderEvidence(marked);
    land(found ? { name: found.name, startUtf16: found.evidence.startUtf16, step: step ? chosen.step : null } : null, marked);
  }

  /**
   * Opens a topic's start in the flow view, keeping the question. A function is chosen only while the file has the hash
   * it had: by name and place when the place is known, by name when that name is the file's only function by it.
   */
  async function openStart(target: Topic, changedNotice?: string) {
    setView('function');
    const atRevision = revision.current;
    const opened = await readFile(target.start.fileId);
    // A change notice during the read (a wake from sleep included) leaves the code to be checked again.
    if (opened && revision.current !== atRevision) return;
    const { functionName, startUtf16, fileHash } = target.start;
    if (opened && changedNotice && (opened.hash !== fileHash || (startUtf16 !== null && startUtf16 >= opened.text.length))) {
      setNotice(changedNotice); return;
    }
    if (!opened || functionName === null) {
      if (opened && target.origin === 'ai') setNotice('AI가 출발 함수를 정하지 못했어요. 이 파일에서 함수를 골라 주세요.');
      return;
    }
    if (opened.hash !== fileHash) {
      setNotice(target.origin === 'start' ? '파일이 폴더를 열 때와 달라 후보 위치를 다시 확인해야 해요. 왼쪽에서 함수를 직접 골라 주세요.'
        : '출발점을 정한 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 왼쪽에서 함수를 직접 골라 주세요.');
      return;
    }
    const found = opened.analysis.symbols.filter(item => (item.name === functionName || (!functionName.includes('.') && item.name.endsWith(`.${functionName}`))) && (startUtf16 === null || item.evidence.startUtf16 === startUtf16));
    if (found.length !== 1) {
      setNotice(found.length > 1 ? `이 파일에 ‘${functionName}’ 함수가 ${found.length}개라 하나로 정하지 못했어요. 왼쪽에서 직접 골라 주세요.`
        : `‘${functionName}’ 함수를 이 파일에서 찾지 못했어요. 왼쪽에서 직접 골라 주세요.`);
      return;
    }
    selectSymbol(found[0].id);
    setReaderEvidence(found[0].evidence);
    // Found once by name, the start is kept by place, so returning to it finds this very function.
    if (startUtf16 === null) setTopic(current => current === target ? { ...target, start: { ...target.start, startUtf16: found[0].evidence.startUtf16 } } : current);
  }

  async function resumeLearning() {
    if (!project || !resume || resume.projectId !== project.id || busy || topic) return;
    const restored = restoreSpot(resume.saved.spot, project.files);
    if ('missingStart' in restored) return;
    // Restore both together before reading: a failed or cancelled read must keep the saved step.
    setTopic(restored.topic); setPlaces(restored.place ? [restored.place] : []); setResume(null);
    const changedNotice = '지난번 본 뒤로 이 파일이 바뀌었어요. 이 부분은 다시 확인해 주세요. 파일만 열었어요.';
    if (restored.place) { await goTo(restored.place, changedNotice); return; }
    await openStart(restored.topic, changedNotice);
  }

  function closeTopic() {
    beginTopic(null); setResume(null);
    if (project) void saveSpot(project.id, null);
  }

  /**
   * Whether the evidence was checked against the file and is now shown. Evidence from an answer or the overview is only
   * looked at, so the question's code stays (plan G1 E1). An overview has its own freshness: one made after the last
   * change opens code even while the reader waits for a re-read, as main reads the file again and that brings it up to date.
   */
  async function showEvidence(next: Evidence, nextStep: string | null, from: 'code' | 'answer' | 'overview' = 'code'): Promise<boolean> {
    if (!project || (stale && from !== 'overview')) return false;
    const current = ++request.current;
    const atRevision = revision.current;
    const lookedAt = from !== 'code';
    const clear = () => { if (lookedAt) setReaderEvidence(null); else setEvidence(null); };
    setBusy(true); setError(''); setNotice('');
    const result = await window.learning.readEvidence({ projectId: project.id, evidenceId: next.id });
    if (current !== request.current) return false;
    setBusy(false);
    if (revision.current !== atRevision) { setStale(true); clear(); return false; }
    if (!result.ok) { setError(result.message); clear(); if (result.code === 'CHANGED' || result.code === 'NOT_ALLOWED') setStale(true); return false; }
    setSource(result.value.source);
    if (lookedAt) { setReaderEvidence(result.value.evidence); selectSymbol(null); }
    else setEvidence(result.value.evidence);
    selectStep(nextStep);
    if (from === 'overview') setStale(false);
    return true;
  }

  async function selectGuideFunction(id: string) {
    if (busy || stale || !source) return false;
    const item = source.analysis.symbols.find(item => item.id === id);
    if (!item) return false;
    selectSymbol(item.id);
    return showEvidence(item.evidence, null);
  }

  // The question is about the whole function, so it becomes the question's code even when a step inside it was chosen.
  async function askSimpler(target: CodeSymbol) {
    if (!await showEvidence(target.evidence, null)) return;
    openQuestion(SIMPLER_QUESTION);
  }
  /** Puts a question in the box and shows it; a topic ties it to the code it was prepared for (AiPanel). */
  function openQuestion(text: string, topic?: { name: string; evidenceId: string }) {
    setPanelOpen(true);
    setDraft(current => ({ text, id: (current?.id ?? 0) + 1, ...(topic ? { topic } : {}) }));
  }

  /** Resolves to an error message, or null; the result is shared with the overview card. */
  async function inspectConnections(): Promise<string | null> {
    // A check starts main's list of AI programs over: the overview's next stage would find none.
    if (overviewAi?.status === 'running') return '개요를 만드는 동안에는 설치를 다시 확인할 수 없어요.';
    if (fileExplanationRunning || questionRunning || featureGuideRunning) return 'AI 작업이 진행 중인 동안에는 설치를 다시 확인할 수 없어요.';
    setChecking(true);
    const result = await window.learning.checkConnections();
    setChecking(false);
    if (!result.ok) return result.message;
    setConnections(result.value);
    return null;
  }
  function forgetOverview() {
    setMarks(null); savingMarks.current = []; setPendingMarks([]);
    setResume(null);
    fileExplanationRequest.current++;
    fileExplanationJob.current = { id: null, starting: false, queued: [], revision: revision.current };
    setFileExplanations([]); setFileExplanationState(null); setMode('local-worker');
    overviewRequest.current++;
    overviewJob.current = { id: null, starting: false, queued: [] };
    setOverviewAi(null); beginTopic(null); setFocusAnchor(null); setOverviewCard(count => count + 1);
  }
  async function startOverview(startFileId: string | null) {
    if (!project || questionRunning || fileExplanationRunning || featureGuideRunning || checking) return;
    const token = ++overviewRequest.current;
    overviewJob.current = { id: null, starting: true, queued: [] };
    setOverviewAi({ status: 'running', phase: null, revision: revision.current });
    const result = await window.learning.startOverview({ projectId: project.id, startFileId, mode: 'local-worker', consent: true });
    if (token !== overviewRequest.current) {
      if (result.ok) void window.learning.cancelExplanation({ jobId: result.value.jobId });
      return;
    }
    const queued = overviewJob.current.queued;
    overviewJob.current = { id: result.ok ? result.value.jobId : null, starting: false, queued: [] };
    if (!result.ok) { setOverviewAi({ status: 'failed', message: result.message, cancelled: false }); return; }
    queued.forEach(event => overviewReceiver.current(event));
  }
  async function cancelOverview() {
    overviewRequest.current++;
    const jobId = overviewJob.current.id;
    overviewJob.current = { id: null, starting: false, queued: [] };
    setOverviewAi({ status: 'failed', message: '개요 작업을 취소했어요.', cancelled: true });
    if (jobId) {
      const result = await window.learning.cancelExplanation({ jobId });
      if (!result.ok) setError(result.message);
    }
  }

  async function startFileExplanation() {
    if (!project || !source || questionRunning || fileExplanationRunning || featureGuideRunning || overviewAi?.status === 'running' || checking) return;
    const token = ++fileExplanationRequest.current;
    fileExplanationJob.current = { id: null, starting: true, queued: [], revision: revision.current };
    setFileExplanationState({ status: 'running', fileId: source.fileId, revision: revision.current, phase: null, mode });
    const result = await window.learning.startFileExplanation({ projectId: project.id, fileId: source.fileId,
      expectedFileHash: source.hash, mode, consent: true });
    if (token !== fileExplanationRequest.current) {
      if (result.ok) void window.learning.cancelExplanation({ jobId: result.value.jobId });
      return;
    }
    const queued = fileExplanationJob.current.queued;
    fileExplanationJob.current = { ...fileExplanationJob.current, id: result.ok ? result.value.jobId : null, starting: false, queued: [] };
    if (!result.ok) { setFileExplanationState({ status: 'failed', fileId: source.fileId, message: result.message, cancelled: false }); return; }
    queued.forEach(event => fileExplanationReceiver.current(event));
  }
  async function cancelFileExplanation() {
    fileExplanationRequest.current++;
    const jobId = fileExplanationJob.current.id;
    fileExplanationJob.current = { id: null, starting: false, queued: [], revision: revision.current };
    setFileExplanationState(state => state && { status: 'failed', fileId: state.fileId, message: 'AI 작업을 취소했습니다.', cancelled: true });
    if (jobId) {
      const result = await window.learning.cancelExplanation({ jobId });
      if (!result.ok) setError(result.message);
    }
  }
  function showFileGuideRange(range: FileExplanationRange) {
    if (busy || stale || !source) return;
    if (source.fileId !== range.fileId || source.hash !== range.fileHash) {
      setNotice('안내를 만든 뒤 이 파일이 바뀌어 강조하지 않았어요. 파일을 다시 읽고 확인해 주세요.');
      return;
    }
    setReaderEvidence({ id: crypto.randomUUID(), projectId: source.projectId, ...range });
  }
  async function showFileExplanationRange(range: FileExplanationRange) {
    if (busy || fileExplanationStale) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(range.fileId);
    if (!opened || revision.current !== atRevision) return;
    if (opened.hash !== range.fileHash) { setNotice('설명을 만든 뒤 이 파일이 바뀌어 강조하지 않았어요'); return; }
    setReaderEvidence({ id: crypto.randomUUID(), projectId: opened.projectId, ...range });
  }
  function followFeature(feature: OverviewFeature, anchor: string) {
    if (overviewAi?.status !== 'done') return;
    const start = overviewAi.result.sources.find(item => item.evidence.id === feature.start.evidenceId);
    if (!start) return;
    const next: Topic = { name: feature.name, original: feature.name, origin: 'ai', anchor,
      start: { fileId: start.evidence.fileId, fileHash: start.evidence.fileHash, relativePath: start.relativePath,
        functionName: feature.start.functionName, startUtf16: null } };
    beginTopic(next);
    void openStart(next);
  }
  function startTopicHere() {
    if (!source || !symbol) return;
    beginTopic({ name: symbol.name, original: symbol.name, origin: 'function', anchor: null,
      start: { fileId: source.fileId, fileHash: source.hash, relativePath: source.relativePath, functionName: symbol.name,
        startUtf16: symbol.evidence.startUtf16 } });
  }
  // The function now shown becomes the question's code (a new question target), then the box is filled.
  async function prepareTopicQuestion() {
    if (!topic || !symbol) return;
    const target = symbol;
    const name = topic.name.trim() || topic.original;
    if (!await showEvidence(target.evidence, null)) return;
    openQuestion(featureQuestion(name), { name, evidenceId: target.evidence.id });
  }
  // A role's function, named by the AI: chosen only while the file is as read and that name is its only function.
  async function showNamedFunction(name: string, at: Evidence) {
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(at.fileId);
    if (!opened || revision.current !== atRevision) return;
    if (opened.hash !== at.fileHash) { setNotice('개요를 만든 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 개요를 다시 만들어 주세요.'); return; }
    const found = opened.analysis.symbols.filter(item => item.name === name || (!name.includes('.') && item.name.endsWith(`.${name}`)));
    if (found.length === 1) { selectSymbol(found[0].id); setReaderEvidence(found[0].evidence); return; }
    setNotice(found.length > 1 ? `이 파일에 ‘${name}’ 함수가 ${found.length}개라 하나로 정하지 못했어요. 왼쪽에서 직접 골라 주세요.`
      : `‘${name}’은 이 파일의 함수 목록에 없어요(이름 없는 함수나 다른 종류일 수 있어요). 왼쪽에서 직접 골라 주세요.`);
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
    if (found.status === 'found') setReaderEvidence(found.evidence);
    else setNotice(found.status === 'changed' ? '지도를 만든 뒤 이 파일이 바뀌어 import 위치를 강조하지 않았어요. 지도를 다시 만들어 주세요.'
      : `이 import(${item.startLine}행)는 코드 분석 범위 밖이라 강조하지 못했어요.`);
  }

  // Like showImport: a map range is chosen only while the file has the hash it had for the map.
  async function showFunction(item: MapFunction | MapExport) {
    if (busy) return;
    setView('code');
    const atRevision = revision.current;
    const opened = await readFile(item.fileId);
    if (!opened || revision.current !== atRevision) return;
    if ('kind' in item) {
      if (opened.fileId !== item.fileId || opened.hash !== item.fileHash) {
        setNotice('지도를 만든 뒤 이 파일이 바뀌어 export 위치를 강조하지 않았어요. 지도를 다시 만들어 주세요.');
        return;
      }
      selectSymbol(null);
      setReaderEvidence({ id: crypto.randomUUID(), projectId: opened.projectId, fileId: item.fileId, fileHash: item.fileHash,
        startUtf16: item.startUtf16, endUtf16: item.endUtf16, startLine: item.startLine, endLine: item.endLine });
      return;
    }
    const found = matchFunction(opened, item);
    if (found.status === 'found') { selectSymbol(found.symbol.id); setReaderEvidence(found.symbol.evidence); }
    else setNotice(found.status === 'changed' ? '지도를 만든 뒤 이 파일이 바뀌어 함수를 고르지 않았어요. 지도를 다시 만들어 주세요.'
      : `이 함수(${item.startLine}행)는 코드 분석 범위 밖이라 고르지 못했어요.`);
  }

  const callsKey = (from: SourceView, item: CodeSymbol) => `${from.fileId}:${from.hash}:${item.evidence.startUtf16}:${item.evidence.endUtf16}`;
  // The function card the last call search belongs to; looked up only while the file guide is drawn.
  function guideCaller(found: NonNullable<typeof calls>) {
    const item = source?.analysis.symbols.find(symbol => found.key === callsKey(source, symbol));
    return item ? { symbolId: item.id, state: found.state, stale: found.revision !== revision.current } : null;
  }
  function forgetCalls() { callsRequest.current++; setCalls(null); forgetShapes(); }
  // A search still running is replaced by the next one, so only its result is dropped here.
  function forgetShapes() { shapesRequest.current++; setShapes(null); }
  async function findCalls(from: SourceView, item: CodeSymbol) {
    if (!project) return;
    forgetShapes();
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
  async function findShapes(key: string, found: FunctionCalls) {
    if (!project) return;
    const current = ++shapesRequest.current;
    const { queries, slots } = shapeQueries(found.values, found.fileId);
    setShapes({ key, slots, state: { status: 'finding' } });
    const result = await window.learning.valueShapes({ projectId: project.id, fileId: found.fileId, fileHash: found.fileHash,
      startUtf16: found.startUtf16, endUtf16: found.endUtf16, names: queries });
    if (current !== shapesRequest.current) return;
    setShapes({ key, slots, state: result.ok ? { status: 'done', result: result.value } : { status: 'failed', message: result.message } });
  }
  function forgetChanges() {
    historyRequest.current++; changesRequest.current++; diffRequest.current++;
    setHistory(null); setChanges(null); setDiff(null);
  }
  /**
   * Reads the folder's commits and compares again. A comparison with HEAD moves to the new HEAD after a new commit;
   * one with an older commit keeps it while it is still listed. The first time, HEAD (first in the list).
   */
  async function loadHistory(previous?: { commit: string; head: boolean }) {
    if (!project) return;
    const current = ++historyRequest.current;
    setHistory({ status: 'loading' });
    const result = await window.learning.gitHistory({ projectId: project.id });
    if (current !== historyRequest.current) return;
    setHistory(result.ok ? { status: 'done', value: result.value } : { status: 'failed', message: result.message });
    if (!result.ok || !result.value.available) return;
    const { commits } = result.value;
    const kept = previous && !previous.head && commits.some(commit => commit.oid === previous.commit) ? previous.commit : commits[0].oid;
    void compare(kept);
  }
  function refreshChanges() {
    if (!changes) return;
    const head = history?.status === 'done' && history.value.commits.some(commit => commit.oid === changes.commit && commit.head);
    void loadHistory({ commit: changes.commit, head });
  }
  async function compare(commit: string) {
    if (!project) return;
    const current = ++changesRequest.current;
    diffRequest.current++;
    setDiff(null);
    const atRevision = revision.current;
    setChanges({ commit, revision: atRevision, state: { status: 'loading' } });
    // Main replaces a comparison still running.
    const result = await window.learning.projectChanges({ projectId: project.id, commit });
    if (current !== changesRequest.current) return;
    setChanges({ commit, revision: atRevision, state: result.ok ? { status: 'done', value: result.value } : { status: 'failed', message: result.message } });
  }
  async function cancelCompare() {
    if (!project) return;
    changesRequest.current++;
    setChanges(previous => previous && { ...previous, state: { status: 'failed', message: '비교를 취소했어요.' } });
    const result = await window.learning.cancelChanges({ projectId: project.id });
    if (!result.ok) setError(result.message);
  }
  /**
   * One change side by side: the old code from the commit and the code now, each read under the app's rules by a side
   * worker, so the file open in the reader and its evidence stay as they are.
   */
  async function openChange(change: FileChange) {
    if (!project || !changes) return;
    setView('changes');
    const current = ++diffRequest.current;
    const oldPath = change.kind === 'modified' || change.kind === 'renamed' || change.kind === 'deleted' ? change.oldPath ?? change.path : null;
    setDiff({ change, old: oldPath ? { status: 'loading' } : null, now: change.fileId ? { status: 'loading' } : null });
    const result = await window.learning.fileDiff({ projectId: project.id, commit: changes.commit, oldPath, fileId: change.fileId });
    if (current !== diffRequest.current) return;
    if (!result.ok) {
      const failed: Loaded<string> = { status: 'failed', message: result.message };
      setDiff({ change, old: oldPath ? failed : null, now: change.fileId ? failed : null });
      return;
    }
    const loaded = (code: CodeSide | null): Loaded<string> | null => !code ? null
      : 'text' in code ? { status: 'done', value: code.text } : { status: 'failed', message: code.message };
    setDiff({ change, old: loaded(result.value.old), now: loaded(result.value.now) });
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
    if (found.status === 'found') { selectSymbol(found.symbol.id); selectStep(found.step.id); setReaderEvidence(found.step.evidence); }
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
    if (currentBusy.current) return;
    setView('code');
    await readSiteRange(site, '값을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 다시 찾아 주세요.');
  }
  async function readSiteRange(site: ValueSite | CallSite, changedMessage: string) {
    if (currentBusy.current) return;
    const atRevision = revision.current;
    const opened = await readFile(site.fileId);
    if (!opened || revision.current !== atRevision) return;
    if (opened.hash !== site.fileHash) { setNotice(changedMessage); return; }
    setReaderEvidence({ id: crypto.randomUUID(), projectId: opened.projectId, fileId: opened.fileId, fileHash: opened.hash,
      startUtf16: site.startUtf16, endUtf16: site.endUtf16, startLine: site.startLine, endLine: site.endLine });
  }
  async function showFlowNode(node: FlowNode | null) {
    if (!node) return;
    await readSiteRange(siteOf(node), '흐름을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 주소를 다시 찾아 주세요.');
  }
  async function readFlowCode(fileId: string) {
    if (!project || currentBusy.current) return null;
    const current = ++request.current;
    currentBusy.current = true;
    setBusy(true);
    try {
      const result = await window.learning.readSource({ projectId: project.id, fileId });
      return current === request.current ? result : null;
    } finally {
      if (current === request.current) { currentBusy.current = false; setBusy(false); }
    }
  }
  // Only the question's code changes: readFile would clear the flow view's source and highlight, so both reads are direct.
  async function askFlowStep(node: FlowNode, question: string, topic: string) {
    if (!project || currentBusy.current) return;
    const current = ++request.current;
    const atRevision = revision.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const opened = await window.learning.readSource({ projectId: project.id, fileId: node.fileId });
      if (current !== request.current || revision.current !== atRevision) return;
      if (!opened.ok) { setError(opened.message); return; }
      const found = matchFunction(opened.value, siteOf(node));
      if (found.status !== 'found') {
        setNotice(found.status === 'changed' ? '흐름을 찾은 뒤 이 파일이 바뀌어 질문을 준비하지 않았어요. 주소를 다시 찾아 주세요.'
          : '이 함수는 코드 분석 범위 밖이라 질문할 코드로 고르지 못했어요. 코드 읽기에서 범위를 골라 질문해 주세요.');
        return;
      }
      const result = await window.learning.readEvidence({ projectId: project.id, evidenceId: found.symbol.evidence.id });
      if (current !== request.current || revision.current !== atRevision) return;
      if (!result.ok) {
        setError(result.message);
        if (result.code === 'CHANGED' || result.code === 'NOT_ALLOWED') setStale(true);
        return;
      }
      setQuestionEvidence(result.value.evidence);
      openQuestion(question, { name: topic, evidenceId: result.value.evidence.id });
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function showFlowSite(nodeId: string, site: ValueSite) {
    if (currentBusy.current) return;
    features.setSite(nodeId, site);
    await readSiteRange(site, '흐름을 찾은 뒤 이 파일이 바뀌어 강조하지 않았어요. 주소를 다시 찾아 주세요.');
  }
  async function followFeatureRoute(routeIndex: number, start?: FlowStart) {
    if (currentBusy.current) return;
    setView('flow');
    const node = await features.follow(routeIndex, start);
    if (currentView.current === 'flow' && !currentBusy.current) await showFlowNode(node);
  }
  async function followFeatureInMap(routeIndex: number, start?: FlowStart) {
    if (currentBusy.current) return;
    await features.follow(routeIndex, start);
  }
  // The same for a function to follow: it is chosen in the flow view, which then searches its own calls.
  async function showCallFunction(target: CallFunction) {
    if (busy) return;
    setView('function');
    const atRevision = revision.current;
    const opened = await readFile(target.fileId);
    if (!opened || revision.current !== atRevision) return;
    const found = matchFunction(opened, target);
    if (found.status === 'found') { selectSymbol(found.symbol.id); setReaderEvidence(found.symbol.evidence); }
    else setNotice(found.status === 'changed' ? '호출을 찾은 뒤 이 파일이 바뀌어 그 함수를 고르지 않았어요. 다시 찾아 주세요.'
      : `그 함수(${target.startLine}행)는 코드 분석 범위 밖이라 고르지 못했어요.`);
  }

  async function cancel() {
    openedAt.current++;
    const current = ++request.current;
    setProject(null); setSource(null); setEvidence(null); selectSymbol(null); forgetMap(); forgetCalls(); forgetChanges(); forgetOverview();
    setBusy(true); setError(''); setNotice('');
    const result = await window.learning.cancel();
    if (current !== request.current) return;
    setBusy(false);
    if (result.ok) setNotice('작업을 취소했습니다.');
    else setError(result.message);
  }

  const pathOf = (fileId: string) => project?.files.find(file => file.id === fileId)?.relativePath ?? '(목록에 없는 파일)';
  const fileTree = useMemo(() => buildFileTree(project?.files ?? []), [project?.files]);
  const visibleFileTree = useMemo(() => filterFileTree(fileTree, search), [fileTree, search]);
  const flowCodeName = features.flow && features.routes ? codeNameOf(features.routes.routes[features.flow.routeIndex]) : '';
  const flowTitle = features.selectedFeature?.name ?? features.groupingProps.index?.flatMap(group => group.features).find(feature => feature.routeIndex === features.flow?.routeIndex)?.name ?? flowCodeName;
  const intro = project?.overview.intro;
  const scope = [project?.name, source?.relativePath, symbol?.name, step?.title].filter(Boolean);
  const filesVisible = showsFiles(view);

  const viewButton = (item: typeof views[number]) => <button key={item.id} className={`views__item${item.more ? ' views__item--more' : ''}`}
    aria-current={(view === 'function' ? 'code' : view) === item.id ? 'page' : undefined}
    onClick={() => setView(item.id)}><Icon name={item.id} /><span>{item.label}</span></button>;
  return <div className={`app${project ? '' : ' app--empty'}${project && filesVisible ? ' app--files' : ''}${panelOpen ? '' : ' app--panel-closed'}`}>
    <header className="topbar">
      <h1 className="brand">Code Learning</h1>
      {project && <div className="topbar__project">
        <span aria-hidden="true">/</span>
        <h2>{project.name}</h2>
        <span className="badge">읽기 전용</span>
      </div>}
      {project && <nav aria-label="현재 학습 위치" className="crumbs">
        {scope.slice(1).map((part, index) => <span key={index} className="crumb">{part}</span>)}
      </nav>}
      <div className="topbar__actions">
        {busy && <span role="status" className="busy"><span className="spinner" aria-hidden="true" />처리 중…</span>}
        {fileExplanationState?.status === 'running' && (view !== 'code' || source?.fileId !== fileExplanationState.fileId || !panelOpen) &&
          <span role="status">파일 설명 진행 중 <button className="btn btn--small" onClick={() => void cancelFileExplanation()}>파일 설명 작업 취소</button></span>}
        <button className="btn" onClick={() => void openProject()} disabled={busy}>프로젝트 폴더 열기</button>
        <button className="btn btn--ghost" onClick={cancel} disabled={!project && !busy}>프로젝트 닫기</button>
      </div>
    </header>

    {project && <nav aria-label="보기" className="views">
      {views.filter(item => !item.more).map(viewButton)}
      <p className="views__more">더 보기</p>
      {views.filter(item => item.more).map(viewButton)}
    </nav>}

    {(error || notice || (project && (watchError || stale))) && <div className="notices">
      {error && <p role="alert" className="notice">{error}</p>}
      {notice && <p role="status" className="notice notice--info">{notice}</p>}
      {project && watchError && <p role="alert" className="notice notice--warn"><b>변경 감지 제한:</b> 폴더를 다시 열어 주세요. 근거를 사용할 때 파일을 다시 확인합니다.</p>}
      {project && stale && <p role="alert" className="notice notice--warn"><b>코드 변경 또는 잠자기 복귀:</b> 다시 확인 필요. 이전 코드 기준의 강조를 해제했습니다. 파일을 다시 읽으면 최신 코드로 이어서 볼 수 있어요.</p>}
    </div>}

    {!project ? <main className="welcome">
      <h2>프로젝트를 열어 코드를 읽어 보세요</h2>
      <p className="welcome__lead">폴더 하나를 고르면 어떤 파일이 있는지 보여주고, 함수 안의 조건·반환 같은 부분을 실제 코드 위치와 함께 짚어 줘요.</p>
      {recentProjects.length > 0 && <section className="welcome__recent" aria-label="최근 프로젝트">
        <h3>최근 프로젝트</h3>
        <ul className="recent-projects">{recentProjects.map(recent => <li key={recent.id}>
          <button className="btn" disabled={busy} onClick={() => void openProject(recent.id)}>
            <b>{recent.name}</b><small>{recent.root}</small>
            <small>{new Date(recent.openedAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}</small>
          </button>
        </li>)}</ul>
      </section>}
      <ol className="welcome__steps">
        <li><b>폴더 열기</b><span>위의 ‘프로젝트 폴더 열기’를 눌러요.</span></li>
        <li><b>파일과 함수 고르기</b><span>‘코드 읽기’에서 읽을 파일을 골라요.</span></li>
        <li><b>코드 위치 확인</b><span>구문을 누르면 해당 줄이 강조돼요.</span></li>
      </ol>
      <ul className="welcome__promises">
        <li>원본 파일을 수정하지 않아요.</li>
        <li>AI에는 오른쪽 AI 칸에서 동의한 질문만 보내요. 알려진 한계는 README에 있어요.</li>
      </ul>
    </main> : <>
      {filesVisible && <aside className="sidebar" aria-label="보기와 파일">
        <section aria-label="파일 목록" className="files">
          <h3 className="eyebrow">파일 {project.files.length}개</h3>
          <input className="search" type="search" aria-label="파일명 검색" placeholder="파일명 검색"
            value={search} onChange={event => setSearch(event.target.value)} />
          <FileTreeList folder={visibleFileTree} expanded={expandedFolders} searching={search.length > 0}
            currentFileId={source?.fileId} busy={busy} onToggle={path => setExpandedFolders(current => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path); else next.add(path);
              return next;
            })}
            // The flow view picks its function from the chosen file, so it stays where it is.
            onFile={fileId => { if (view !== 'function') setView('code'); void readFile(fileId, true); }} />
          {visibleFileTree.children.length === 0 && <p className="hint">검색과 일치하는 파일이 없어요.</p>}
        </section>
      </aside>}

      <main className="center">
        <TopicBar topic={topic} places={places.length} canStartHere={(view === 'function' || view === 'code') && !!source && !!symbol}
          canAsk={!!symbol && !stale} locked={busy || stale} onRename={name => setTopic(current => current && { ...current, name })}
          onStartHere={startTopicHere} onStart={() => { if (topic) void openStart(topic); }} onBack={() => void goBack()}
          onAsk={() => void prepareTopicQuestion()}
          onOverview={() => { setView('overview'); setFocusAnchor(topic?.anchor ?? 'overview'); }} onClose={closeTopic} />
        <div className="page" hidden={view !== 'overview'}>
          <h2 className="page__title" tabIndex={-1} data-anchor="overview">한눈에 보기</h2>
          {overviewStale && <p className="notice notice--warn overview-stale"><b>다시 확인 필요:</b> 프로젝트를 연 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 아래 소개와 후보는 폴더를 열 때 읽은 내용이에요. 폴더를 다시 열면 새로 계산해요.</p>}
          <div className="cards">
            {resume?.projectId === project.id && !topic && <ResumeCard saved={resume.saved} files={project.files} locked={busy}
              onResume={() => void resumeLearning()} />}
            {marks?.projectId === project.id && <LearningMarksCard marks={marks.list} files={project.files} locked={busy}
              onOpen={mark => void openMark(mark)} />}
            {view === 'overview' && <section className="card card--wide" aria-labelledby="overview-intro">
              <h3 id="overview-intro">이 프로젝트는 무엇을 하나요?</h3>
              {intro ? <>
                <span className="tag tag--doc">문서에 적힌 소개</span>
                {intro.title && <p className="intro__title">{intro.title}</p>}
                {intro.text && <p className="intro__text">{intro.text}</p>}
                <p className="hint">{intro.relativePath}{intro.startLine !== null && ` · ${intro.startLine}–${intro.endLine}줄`} · 문서 내용이 실제 코드와 맞는지는 확인하지 않았어요.</p>
                <button className="btn btn--chip" disabled={busy} onClick={() => { setView('code'); void readFile(intro.fileId); }}>{intro.relativePath} 열기</button>
              </> : <p className="unknown"><span className="tag tag--unknown">확인하지 못함</span>프로젝트 목적: 아직 확인하지 못했습니다.</p>}
            </section>}
            <FeatureChooser key={project.files[0]?.id ?? project.id} project={project} state={features}
              mode={mode} running={questionRunning || fileExplanationRunning || featureGuideRunning || overviewAi?.status === 'running'}
              checking={checking} connections={connections} onInspect={inspectConnections} onRunning={setFeatureGuideRunning}
              revision={revision.current} locked={busy} onFollow={(index, start) => void followFeatureRoute(index, start)} />
            {view === 'overview' && <details key={overviewCard} className="card card--wide" aria-label="더 알아보기"
              // Once an overview was asked for, its progress, result or error stays in view (the prop never turns false again).
              open={features.routes?.routes.length === 0 || !!features.error || overviewAi !== null}>
            <summary onClick={event => { if (overviewAi?.status === 'running') event.preventDefault(); }}>
              더 알아보기 · 시작 파일 후보 · AI 개요 · 확인한 범위
            </summary>
            <section className="card card--wide card--accent" aria-labelledby="overview-start">
              <h3 id="overview-start">어디부터 읽을까요?</h3>
              {project.overview.candidates.length > 0 ? <ul className="starts">{project.overview.candidates.map(item =>
                <li key={`${item.fileId}:${item.startUtf16}`}>
                  <button className="starts__item" disabled={busy} data-anchor={`start:${item.fileId}:${item.startUtf16}`} onClick={() => void startFrom(item)}>
                    <b>{item.name ?? '이 파일 살펴보기'}</b> <span className="path">{item.relativePath}</span>
                  </button>
                  <span className="hint">{candidateReasons[item.reason]}</span>
                </li>)}</ul>
                : <p>시작점 후보를 찾지 못했어요. <b>코드 읽기</b>에서 궁금한 파일을 골라 시작해 보세요.</p>}
              <p className="hint"><span className="tag tag--unknown">학습 시작점 후보</span>TS/JS 파일 {project.overview.checkedFiles}개를 살펴봤어요{project.overview.limited && '(전체 중 일부)'}. 코드 구조로 고른 후보이고, 실제 실행 시작점인지는 확인하지 않았어요.</p>
              {project.overview.notes.map(note => <p key={note} className="hint">{note}</p>)}
            </section>
            <OverviewAi key={overviewCard} project={project} state={overviewAi} locked={busy || questionRunning || fileExplanationRunning || featureGuideRunning}
              stale={overviewAi?.status === 'done' && overviewAi.revision !== revision.current}
              readiness={connections?.modes.find(item => item.mode === 'local-worker') ?? null} checking={checking}
              revealAnchor={topic?.anchor ?? null} topicName={topic ? topic.name.trim() || topic.original : null} onInspect={() => { void inspectConnections().then(message => { if (message) setError(message); }); }}
              onStart={startFileId => void startOverview(startFileId)} onCancel={() => void cancelOverview()}
              onEvidence={next => { setView('code'); void showEvidence(next, null, 'overview'); }}
              onFollow={followFeature} onFunction={(name, at) => void showNamedFunction(name, at)} />
            <section className="card card--wide">
              <h3>확인한 범위와 모르는 부분</h3>
              <p className="stat">읽을 수 있는 파일 <b>{project.files.length}</b>개</p>
              <details><summary>제외 항목</summary>
                <ul>{Object.entries(project.excluded).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul>
              </details>
              <ul className="checklist">
                <li><span className="tag tag--ok">확인됨</span>파일 목록과 TS/JS 함수 안의 구문 위치{intro && ', README에 적힌 소개 문구'}</li>
                <li><span className="tag tag--unknown">확인하지 못함</span>프로젝트 목적(문서 내용이 코드와 맞는지 포함), 기능의 실제 실행 순서. 파일끼리 가져다 쓰는 관계는 ‘프로젝트 지도’에서 볼 수 있어요.</li>
              </ul>
              {project.warnings.map(message => <p key={message} className="hint">{message}</p>)}
              <p className="hint">새 파일 목록은 폴더를 다시 열어 갱신합니다. 현재 파일·제외 규칙의 변경은 읽기 전에 다시 확인합니다.</p>
            </section>
            </details>}
          </div>
        </div>

        {view === 'flow' && <div className="page feature-page">
          <h2 className="page__title">흐름 따라가기</h2>
          <RoutesStatus state={features} retryDisabled={busy || features.stale}
            retry={features.selected !== null ? () => void followFeatureRoute(features.selected!) : undefined} />
          {features.following && <p role="status">기능 흐름을 찾는 중… <button className="btn" onClick={features.cancelFollow}>기능 흐름 취소</button></p>}
          {!features.flow && !features.following && <>
            <p>한눈에 보기에서 기능을 고르거나, 아래 목록에서 골라 주세요</p>
            {features.routes && <FeatureList {...features.groupingProps} search={features.search} setSearch={features.setSearch} groups={features.groups} routes={features.routes} selected={features.selected}
              disabled={busy || features.stale} onFollow={(index, start) => void followFeatureRoute(index, start)} />}
          </>}
          {features.flow && features.routes && <FlowWalk flow={features.flow}
            title={flowTitle}
            about={features.selectedFeature?.about}
            codeName={flowCodeName} walk={features.walk} selection={features.selection}
            summary={features.summary} setSummary={features.setSummary}
            setStory={id => void showFlowNode(features.setStory(id))} setStep={index => void showFlowNode(features.setStep(index))}
            setNode={id => void showFlowNode(features.setNode(id))} locked={busy} stale={features.stale}
            readCode={readFlowCode} onChoose={features.clearFlow} onCode={site => void showValueSite(site)} onSite={(id, site) => void showFlowSite(id, site)}
            onFunction={target => void showCallFunction(target)} onAsk={(node, question, topic) => void askFlowStep(node, question, topic)}>
            {features.currentNode && (source && evidence && hasFlowCode(source, evidence, features.currentNode, features.walk.site)
              ? <div className="code flow-walk-code" data-testid="flow-code">
                <p className="evidence" data-testid="evidence-range" data-utf16={`${evidence.startUtf16},${evidence.endUtf16}`}>근거: {source.relativePath} · {evidence.startLine}–{evidence.endLine}줄</p>
                <Reader source={source} evidence={evidence} codeSize={codeSize} wrap={wrap}
                  symbolId={null} stepId={null} locked={busy || stale} />
              </div>
              : <button className="btn" disabled={busy} onClick={() => void showFlowNode(features.currentNode)}>이 단계 코드 보기</button>)}
          </FlowWalk>}
          <FlowLimits project={project} routes={features.routes} flow={features.flow} locked={busy} onCode={site => void showValueSite(site)} />
        </div>}
        {view === 'map' && <div className="page map-page">
          <div className="map-heading">
            <h2 className="page__title">프로젝트 지도</h2>
            <div className="map-tabs" role="group" aria-label="지도 종류">
              <button aria-pressed={mapTab === 'feature'} onClick={() => setMapTab('feature')}>기능별 연결</button>
              <button aria-pressed={mapTab === 'file'} onClick={() => setMapTab('file')}>파일 연결</button>
            </div>
          </div>
          {mapTab === 'feature' && <>
            <RoutesStatus state={features} retryDisabled={busy || features.stale}
              retry={features.selected !== null ? () => void followFeatureInMap(features.selected!) : undefined} />
            {features.following && <p role="status">기능 흐름을 찾는 중… <button className="btn" onClick={features.cancelFollow}>기능 흐름 취소</button></p>}
            {!features.flow && !features.following && <>
              <p>기능을 고르면 화면 → 요청 → 서버 연결을 세 칸 지도로 보여 줘요.</p>
              {features.routes && <FeatureList {...features.groupingProps} search={features.search} setSearch={features.setSearch} groups={features.groups} routes={features.routes} selected={features.selected}
                disabled={busy || features.stale} onFollow={(index, start) => void followFeatureInMap(index, start)} />}
            </>}
            {features.flow && <>
              <div className="map-actions">
                <h3>{flowTitle}</h3>
                <button className="btn" disabled={busy} onClick={features.clearFlow}>다른 기능 고르기</button>
                <button className="btn" onClick={() => setView('flow')}>흐름 따라가기에서 단계별로 보기</button>
              </div>
              <FlowPicture key={`${features.flow.routesId}:${features.flow.routeIndex}`} flow={features.flow}
                locked={busy} stale={features.stale} readCode={readFlowCode}
                onCode={site => void showValueSite(site)} onFunction={target => void showCallFunction(target)} />
            </>}
            <FlowLimits project={project} routes={features.routes} flow={features.flow} locked={busy} onCode={site => void showValueSite(site)} />
          </>}
          {mapTab === 'file' && <ProjectMapView project={project} entry={projectMap}
            stale={projectMap !== null && projectMap.revision !== revision.current} mapping={mapping}
            changes={changes?.state.status === 'done' ? { result: changes.state.value, stale: changes.revision !== revision.current } : null}
            onShowChange={change => void openChange(change)}
            onBuild={() => void buildMap()} onCancel={() => void cancelMap()}
            locked={busy} onOpenFile={fileId => { if (busy) return; setView('code'); void readFile(fileId); }}
            onShowImport={item => void showImport(item)} onShowFunction={item => void showFunction(item)} />}
        </div>}

        {view === 'function' && functionExplanation && <p className="function-explanation" data-testid="function-chunk-summary">{functionExplanation}</p>}
        {view === 'function' && <Flow marks={marks?.projectId === project.id ? marks.list : null} pendingMarks={pendingMarks}
          onSaveMark={(key, change, hash) => void saveMark(key, change, hash)} source={source} symbol={symbol} step={step} evidence={evidence} locked={busy || stale}
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
              shapes={shapes?.key === calls.key ? shapes : null}
              onRetryShapes={() => { if (calls.state.status === 'done') void findShapes(calls.key, calls.state.result); }}
              onShowSite={site => void showValueSite(site)} onShowFunction={target => void showCallFunction(target)} />}
          </>} />}

        {view === 'changes' && <ChangesView history={history} changes={changes} diff={diff} locked={busy}
          stale={changes !== null && changes.revision !== revision.current}
          onRetryHistory={() => void loadHistory()} onCompare={commit => void compare(commit)} onRefresh={refreshChanges} onCancel={() => void cancelCompare()}
          onOpen={change => void openChange(change)} onOpenCode={fileId => { if (busy) return; setView('code'); void readFile(fileId); }} />}

        {view === 'code' && (!source ? <div className="page page--empty">
          <h2 className="page__title">코드 읽기</h2>
          <p>파일을 선택하면 원문과 확인한 함수 구조를 읽을 수 있습니다.</p>
        </div> : <div className="reader">
          <div className="reader__head">
            <h3 className="path reader__file">{source.relativePath}</h3>
            <span className="badge">읽기 전용</span>
            {symbol && <button className="btn btn--small" onClick={() => setView('function')}>이 함수 흐름으로 보기</button>}
            <button className="btn btn--small" disabled={busy} onClick={() => readFile(source.fileId)}>파일 다시 읽기</button>
            <div className="reader__tools" role="group" aria-label="읽기 설정">
              <button className="btn btn--icon" aria-label="찾기 ⌘F" title="찾기 ⌘F" aria-keyshortcuts="Meta+F" onClick={() => reader.current?.openSearch()}><Icon name="search" /></button>
              <button className="btn btn--icon" aria-label="코드 글자 작게" title="코드 글자 작게" disabled={codeSize <= CODE_SIZE.min}
                onClick={() => setCodeSize(size => size - 1)}><Icon name="smaller" /></button>
              <span className="reader__size" aria-live="polite">코드 {codeSize}px</span>
              <button className="btn btn--icon" aria-label="코드 글자 크게" title="코드 글자 크게" disabled={codeSize >= CODE_SIZE.max}
                onClick={() => setCodeSize(size => size + 1)}><Icon name="larger" /></button>
              <button className="btn btn--icon" aria-label="줄바꿈" title="줄바꿈" aria-pressed={wrap} onClick={() => setWrap(on => !on)}><Icon name="wrap" /></button>
              <button className="btn btn--small" aria-pressed={bands} onClick={() => setBands(on => !on)}>설명 줄</button>
            </div>
            {stale && <p className="hint">파일이 바뀌어 설명 줄을 숨겼어요. 파일 다시 읽기를 눌러 주세요.</p>}
          </div>
          <section aria-label="이 파일 안내" className="file-guide-fold">
            {step && evidence ? <section className="fact">
              <span className="tag tag--ok">코드에서 확인됨</span>
              <p><b>{symbol?.name}</b> 함수 안의 <b>{step.title}</b> 부분이에요. 원본 {evidence.startLine}–{evidence.endLine}줄에 있어요.</p>
            </section> : symbol && evidence ? <section className="fact">
              <span className="tag tag--ok">코드에서 확인됨</span>
              <p><b>{symbol.name}</b> 함수는 원본 {evidence.startLine}–{evidence.endLine}줄에 있어요. 왼쪽에서 구문을 골라 한 부분씩 볼 수 있어요.</p>
            </section> : null}
            {source.guide && <FileGuideCard key={`${source.fileId}:${source.hash}`} guide={source.guide} analysis={source.analysis} busy={busy} stale={stale}
              open={fileGuideOpen} onToggle={setFileGuideOpen}
              ai={aiFunctionSummaries(fileExplanation?.result ?? null, fileExplanationStale, source.analysis.symbols)}
              importers={{ state: mapping ? 'running' : projectMap ? 'ready' : 'none',
                stale: projectMap !== null && projectMap.revision !== revision.current, result: importers }}
              onBuildMap={() => void buildMap()} onCancelMap={() => void cancelMap()} onShowImport={item => void showImport(item)}
              does={does} doesState={{ routes: features.stale ? 'stale' : features.routes ? 'ready' : 'none', flows: features.groupingProps.flows !== null }}
              callers={calls && guideCaller(calls)}
              onFindCallers={item => void findCalls(source, item)}
              onCancelCallers={() => void cancelCalls()} onShowCallSite={site => void showCallSite(site)} pathOf={pathOf}
              uses={{ ...uses, routes: features.routes ?? null,
                state: features.stale ? 'stale' : features.groupingProps.grouping ? 'running' : features.groupingProps.flows ? 'ready' : 'none' }}
              onUse={use => void followFeatureRoute(use.routeIndex, { through: use.through, storyId: use.storyId, step: use.step, nodeId: use.nodeId })}
              focus={functionFocus?.fileId === source.fileId && functionFocus.hash === source.hash ? functionFocus : null}
              onOpenFile={fileId => { if (busy || stale) return; void readFile(fileId); }}
              onShow={showFileGuideRange} onSelect={selectGuideFunction} />}
          </section>
          {functionExplanation && <p className="function-explanation" data-testid="function-chunk-summary">{functionExplanation}</p>}
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
              {evidence && <p data-testid="evidence-range" data-utf16={`${evidence.startUtf16},${evidence.endUtf16}`} className="evidence">근거: {source.relativePath} · {evidence.startLine}–{evidence.endLine}줄</p>}
              <Reader ref={reader} source={source} evidence={evidence} codeSize={codeSize} wrap={wrap}
                bands={bands && !stale} onFunction={async id => {
                  if (busy || stale) return;
                  if (!await selectGuideFunction(id)) return;
                  setFileGuideOpen(true);
                  setFunctionFocus({ fileId: source.fileId, hash: source.hash, symbolId: id });
                }}
                symbolId={symbolId} stepId={stepId} locked={busy || stale}
                onStep={next => { if (!busy && !stale) void showEvidence(next.evidence, next.id); }} />
            </div>
          </div>
        </div>)}
      </main>

      <aside className="panel" aria-label="AI 질문" hidden={!panelOpen}>
        <div className="panel__head">
          <button className="btn btn--ghost btn--icon" aria-label="AI 칸 접기" title="AI 칸 접기" onClick={() => setPanelOpen(false)}><Icon name="collapse" /></button>
        </div>
        <AiPanel key={project.id} projectId={project.id} evidence={questionEvidence} stale={stale} draft={draft}
          connections={connections} checking={checking} otherRunning={overviewAi?.status === 'running' || fileExplanationRunning || featureGuideRunning} onInspect={inspectConnections}
          mode={mode} onMode={setMode} onRunning={setQuestionRunning}
          relativePath={project.files.find(file => file.id === questionEvidence?.fileId)?.relativePath ?? ''}
          onEvidence={next => { setView('code'); void showEvidence(next, null, 'answer'); }} />
        {view === 'code' && source && source.analysis.language !== 'text' && <details className="card"
          key={`${source.fileId}:${source.hash}`}
          open={fileExplanationOpen}>
          <summary onClick={event => {
            if (fileExplanationOpen) event.preventDefault();
          }}>AI로 이 파일 설명 만들기</summary>
          <FileExplanationCard source={source} entry={fileExplanation}
            state={sourceExplanationState} stale={fileExplanationStale}
            mode={mode} locked={busy} running={questionRunning || fileExplanationRunning || featureGuideRunning || overviewAi?.status === 'running'}
            checking={checking} connections={connections}
            onInspect={() => { void inspectConnections().then(message => { if (message) setError(message); }); }}
            onStart={() => void startFileExplanation()} onCancel={() => void cancelFileExplanation()}
            onShow={range => void showFileExplanationRange(range)} />
        </details>}
      </aside>
      {!panelOpen && <button className="panel-reopen btn btn--small" onClick={() => setPanelOpen(true)}>AI 칸 펼치기</button>}
    </>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
