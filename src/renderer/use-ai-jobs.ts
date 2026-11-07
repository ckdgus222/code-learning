import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CodeSymbol, ProjectView, SourceView } from '../shared/contracts';
import type { ConnectionReport, LearningEvent, LearningMode } from '../shared/ai';
import { inspectionBlockedReason, needsAutomaticInspection } from './connections';
import { rememberFileExplanation, type FileExplanationEntry, type FileExplanationState } from './file-explanation';
import type { OverviewState } from './overview';

const OVERVIEW_SAVE_FAILED = 'AI 개요를 저장하지 못했어요. 앱을 닫으면 사라져요.';
const OVERVIEW_LOAD_FAILED = '저장된 AI 개요를 불러오지 못했어요.';

const EXPLANATION_SAVE_FAILED = '파일 설명을 저장하지 못했어요. 앱을 닫으면 사라져요.';
const EXPLANATION_LOAD_FAILED = '저장된 파일 설명을 불러오지 못했어요.';

// Keeps AI jobs and installation checks together so their running states block conflicting work.
export function useAiJobs({ project, source, symbol, revision, setError, setNotice, planCompareRunning }: {
  planCompareRunning: boolean;
  project: ProjectView | null; source: SourceView | null; symbol: CodeSymbol | undefined;
  revision: RefObject<number>; setError(message: string): void; setNotice(message: string): void;
}) {
  // The AI installation check, shared by the question panel and the overview card.
  const [connections, setConnections] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const inspectionPending = useRef(false);
  const [mode, setMode] = useState<LearningMode>('codex');
  const [featureGuideRunning, setFeatureGuideRunning] = useState(false);
  const [questionRunning, setQuestionRunning] = useState(false);
  const [fileExplanations, setFileExplanations] = useState<FileExplanationEntry[]>([]);
  const [fileExplanationState, setFileExplanationState] = useState<FileExplanationState | null>(null);
  const fileExplanationRequest = useRef(0);
  const savedExplanationRequest = useRef(0);
  const fileExplanationJob = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[]; revision: number }>({ id: null, starting: false, queued: [], revision: 0 });
  // Plan G1: the overview job and its result.
  const [overviewAi, setOverviewAi] = useState<OverviewState | null>(null);
  // Counts opened folders (and closings): the overview card starts over, its consent unchecked, for each one.
  const [overviewCard, setOverviewCard] = useState(0);
  const overviewRequest = useRef(0);
  const savedOverviewRequest = useRef(0);
  const overviewJob = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[] }>({ id: null, starting: false, queued: [] });

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
      setOverviewAi(state => state?.status === 'running' ? { status: 'done', result: event.result, revision: state.revision, savedAt: null, changed: false } : state);
      void window.learning.saveOverview({ projectId: event.projectId, result: event.result }).then(saved => {
        if (!saved.ok) {
          if (saved.code !== 'PROJECT_CLOSED') setNotice(OVERVIEW_SAVE_FAILED);
          return;
        }
        setOverviewAi(state => state?.status === 'done' && state.result.jobId === event.result.jobId
          ? { ...state, savedAt: saved.value.savedAt } : state);
      }).catch(() => setNotice(OVERVIEW_SAVE_FAILED));
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
      setFileExplanations(previous => rememberFileExplanation(previous, { result: event.result, revision: job.revision, savedAt: null }));
      setFileExplanationState(null);
      void window.learning.saveFileExplanation({ projectId: event.projectId, result: event.result }).then(saved => {
        if (!saved.ok) {
          if (saved.code !== 'PROJECT_CLOSED') setNotice(EXPLANATION_SAVE_FAILED);
          return;
        }
        setFileExplanations(previous => previous.map(entry => entry.result.jobId === event.result.jobId
          ? { ...entry, savedAt: saved.value.savedAt } : entry));
      }).catch(() => setNotice(EXPLANATION_SAVE_FAILED));
    }
  };
  useEffect(() => window.learning.onLearningEvent(event => fileExplanationReceiver.current(event)), []);

  useEffect(() => {
    const token = ++savedExplanationRequest.current;
    if (!project || !source || fileExplanations.some(entry => entry.result.range.fileId === source.fileId)) return;
    const fileId = source.fileId;
    const requestedRevision = revision.current;
    void window.learning.savedFileExplanation({ projectId: project.id, fileId }).then(saved => {
      if (token !== savedExplanationRequest.current) return;
      if (!saved.ok) {
        if (saved.code !== 'PROJECT_CLOSED') setNotice(EXPLANATION_LOAD_FAILED);
        return;
      }
      if (!saved.value) return;
      const entry = { ...saved.value, revision: requestedRevision };
      setFileExplanations(previous => previous.some(item => item.result.range.fileId === fileId)
        ? previous : rememberFileExplanation(previous, entry));
    }).catch(() => {
      if (token === savedExplanationRequest.current) setNotice(EXPLANATION_LOAD_FAILED);
    });
    return () => { savedExplanationRequest.current++; };
    // Load only when the opened file changes, not when a result is saved or deleted.
  }, [project?.id, source?.fileId]);

  useEffect(() => {
    const token = ++savedOverviewRequest.current;
    if (!project || overviewAi !== null) return;
    const requestedRevision = revision.current;
    void window.learning.savedOverview({ projectId: project.id }).then(saved => {
      if (token !== savedOverviewRequest.current) return;
      if (!saved.ok) {
        if (saved.code !== 'PROJECT_CLOSED') setNotice(OVERVIEW_LOAD_FAILED);
        return;
      }
      const entry = saved.value;
      if (!entry) return;
      setOverviewAi(state => state === null ? { status: 'done', ...entry, revision: requestedRevision } : state);
    }).catch(() => {
      if (token === savedOverviewRequest.current) setNotice(OVERVIEW_LOAD_FAILED);
    });
    return () => { savedOverviewRequest.current++; };
    // Reopening the same folder also changes this object. Saving/deleting must not trigger another read.
  }, [project]);

  async function deleteOverview() {
    if (!project || overviewAi?.status !== 'done' || questionRunning || fileExplanationRunning || featureGuideRunning || checking) return;
    const jobId = overviewAi.result.jobId;
    savedOverviewRequest.current++;
    try {
      const deleted = await window.learning.deleteOverview({ projectId: project.id });
      if (!deleted.ok) { setError(deleted.message); return; }
      setOverviewAi(state => state?.status === 'done' && state.result.jobId === jobId ? null : state);
    } catch { setError('AI 개요를 지우지 못했어요.'); }
  }

  async function deleteFileExplanation() {
    if (!project || !source || !fileExplanation || fileExplanationRunning) return;
    const fileId = source.fileId;
    const jobId = fileExplanation.result.jobId;
    savedExplanationRequest.current++;
    try {
      const deleted = await window.learning.deleteFileExplanation({ projectId: project.id, fileId });
      if (!deleted.ok) { setError(deleted.message); return; }
      setFileExplanations(previous => previous.filter(entry => entry.result.range.fileId !== fileId || entry.result.jobId !== jobId));
    } catch { setError('파일 설명을 지우지 못했어요.'); }
  }

  function connectionCheckBlockedReason(): string | null {
    if (planCompareRunning) return '대조 작업 중에는 설치를 다시 확인할 수 없어요.';
    // A check starts main's list of AI programs over: the overview's next stage would find none.
    return inspectionBlockedReason({ overviewRunning: overviewAi?.status === 'running',
      fileExplanationRunning, questionRunning, featureGuideRunning });
  }
  async function ensureConnections(): Promise<string | null> {
    if (!needsAutomaticInspection(connections, inspectionPending.current, connectionCheckBlockedReason())) return null;
    return inspectConnections({ automatic: true });
  }
  /** Resolves to an error message, or null; the result is shared with the overview card. */
  async function inspectConnections(request?: { automatic: true }): Promise<string | null> {
    const blocked = connectionCheckBlockedReason();
    if (blocked) return blocked;
    if (inspectionPending.current) return null;
    inspectionPending.current = true;
    setChecking(true);
    try {
      const result = await window.learning.checkConnections(request);
      if (!result.ok) { setConnections(null); return result.message; }
      setConnections(result.value);
      return null;
    } catch {
      setConnections(null);
      return '로컬 AI 설치를 확인하지 못했어요. 다시 시도해 주세요.';
    } finally {
      inspectionPending.current = false;
      setChecking(false);
    }
  }
  function forget() {
    savedOverviewRequest.current++;
    savedExplanationRequest.current++;
    fileExplanationRequest.current++;
    fileExplanationJob.current = { id: null, starting: false, queued: [], revision: revision.current };
    setFileExplanations([]); setFileExplanationState(null); setMode('codex');
    overviewRequest.current++;
    overviewJob.current = { id: null, starting: false, queued: [] };
    setOverviewAi(null);
    setOverviewCard(count => count + 1);
  }
  async function startOverview(startFileId: string | null) {
    if (!project || planCompareRunning || questionRunning || fileExplanationRunning || featureGuideRunning || checking) return;
    savedOverviewRequest.current++;
    const token = ++overviewRequest.current;
    overviewJob.current = { id: null, starting: true, queued: [] };
    setOverviewAi({ status: 'running', phase: null, revision: revision.current });
    const result = await window.learning.startOverview({ projectId: project.id, startFileId, mode, consent: true });
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
    if (!project || !source || planCompareRunning || questionRunning || fileExplanationRunning || featureGuideRunning || overviewAi?.status === 'running' || checking) return;
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

  return {
    connections, checking, inspectConnections, ensureConnections,
    mode, setMode, questionRunning, setQuestionRunning, featureGuideRunning, setFeatureGuideRunning,
    overview: overviewAi, overviewCard, startOverview, cancelOverview, deleteOverview,
    fileExplanation, fileExplanationStale, fileExplanationState, fileExplanationRunning,
    sourceExplanationState, fileExplanationOpen, functionExplanation, startFileExplanation, cancelFileExplanation, deleteFileExplanation,
    forget,
  };
}
