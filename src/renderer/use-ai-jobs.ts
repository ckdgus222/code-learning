import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CodeSymbol, ProjectView, SourceView } from '../shared/contracts';
import type { ConnectionReport, LearningEvent, LearningMode } from '../shared/ai';
import { inspectionBlockedReason, needsAutomaticInspection } from './connections';
import { rememberFileExplanation, type FileExplanationEntry, type FileExplanationState } from './file-explanation';
import type { OverviewState } from './overview';

// Keeps AI jobs and installation checks together so their running states block conflicting work.
export function useAiJobs({ project, source, symbol, revision, setError }: {
  project: ProjectView | null; source: SourceView | null; symbol: CodeSymbol | undefined;
  revision: RefObject<number>; setError(message: string): void;
}) {
  // The AI installation check, shared by the question panel and the overview card.
  const [connections, setConnections] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const inspectionPending = useRef(false);
  const [mode, setMode] = useState<LearningMode>('local-worker');
  const [featureGuideRunning, setFeatureGuideRunning] = useState(false);
  const [questionRunning, setQuestionRunning] = useState(false);
  const [fileExplanations, setFileExplanations] = useState<FileExplanationEntry[]>([]);
  const [fileExplanationState, setFileExplanationState] = useState<FileExplanationState | null>(null);
  const fileExplanationRequest = useRef(0);
  const fileExplanationJob = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[]; revision: number }>({ id: null, starting: false, queued: [], revision: 0 });
  // Plan G1: the overview job and its result.
  const [overviewAi, setOverviewAi] = useState<OverviewState | null>(null);
  // Counts opened folders (and closings): the overview card starts over, its consent unchecked, for each one.
  const [overviewCard, setOverviewCard] = useState(0);
  const overviewRequest = useRef(0);
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

  function connectionCheckBlockedReason(): string | null {
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
    fileExplanationRequest.current++;
    fileExplanationJob.current = { id: null, starting: false, queued: [], revision: revision.current };
    setFileExplanations([]); setFileExplanationState(null); setMode('local-worker');
    overviewRequest.current++;
    overviewJob.current = { id: null, starting: false, queued: [] };
    setOverviewAi(null);
    setOverviewCard(count => count + 1);
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

  return {
    connections, checking, inspectConnections, ensureConnections,
    mode, setMode, questionRunning, setQuestionRunning, featureGuideRunning, setFeatureGuideRunning,
    overview: overviewAi, overviewCard, startOverview, cancelOverview,
    fileExplanation, fileExplanationStale, fileExplanationState, fileExplanationRunning,
    sourceExplanationState, fileExplanationOpen, functionExplanation, startFileExplanation, cancelFileExplanation,
    forget,
  };
}
