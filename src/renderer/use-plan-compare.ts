import { useEffect, useRef, useState } from 'react';
import { PLAN_SEND_LIMIT, type PlanDocument, type PlanSelection, type PlanCompareResult } from '../shared/plan-compare';
import type { LearningEvent, LearningMode, LearningPhase } from '../shared/ai';
import type { ProjectEvent } from '../shared/contracts';

export interface PlanCompareFreshness {
  status: 'fresh' | 'checking' | 'stale' | 'error';
  reasons: string[];
}
const watchError = '파일 감시가 멈춰 바뀐 코드를 알 수 없어요. 폴더를 다시 열어 주세요';

export function usePlanCompare(project: { id: string } | null, keyBusy: () => boolean = () => false) {
  const projectId = project?.id ?? null;
  const [document, setDocument] = useState<PlanDocument | null>(null);
  const [selection, updateSelection] = useState<PlanSelection | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LearningPhase | null>(null);
  const [result, setResult] = useState<PlanCompareResult | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const projectEvents = useRef(0);
  const [freshness, setFreshness] = useState<PlanCompareFreshness>({ status: 'fresh', reasons: [] });
  const resultRef = useRef<PlanCompareResult | null>(null);
  const freshnessRef = useRef(freshness);
  const checkRequest = useRef(0);
  const watchBroken = useRef(false);
  const [consent, setConsent] = useState(false);
  const job = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[] }>({ id: null, starting: false, queued: [] });
  const runRequest = useRef(0);
  const receiver = useRef((_event: LearningEvent) => {});
  receiver.current = event => {
    if (event.projectId !== projectId) return;
    if (job.current.starting) { if (job.current.queued.length < 16) job.current.queued.push(event); return; }
    if (event.jobId !== job.current.id) return;
    if (event.kind === 'progress') { setPhase(event.phase); return; }
    job.current.id = null;
    setRunning(false);
    if (event.kind === 'failed') setError(event.error.message);
    if (event.kind === 'plan-compare-completed') {
      checkRequest.current++;
      resultRef.current = event.result;
      setResult(event.result);
      void save(event.projectId, event.jobId);
      updateFreshness(watchBroken.current ? { status: 'stale', reasons: [watchError] } : { status: 'fresh', reasons: [] });
    }
  };
  const projectReceiver = useRef((_event: ProjectEvent) => {});
  projectReceiver.current = event => {
    if (event.projectId !== projectId) return;
    projectEvents.current++;
    if (event.kind === 'watch-error') watchBroken.current = true;
    if (!resultRef.current || freshnessRef.current.status === 'stale') return;
    checkRequest.current++;
    updateFreshness({ status: 'stale', reasons: [watchBroken.current ? watchError
      : '대조 뒤 코드나 제외 규칙이 바뀌었어요(또는 잠자기에서 돌아왔어요)'] });
  };
  useEffect(() => window.learning.onLearningEvent(event => receiver.current(event)), []);
  useEffect(() => window.learning.onProjectEvent(event => projectReceiver.current(event)), []);
  useEffect(() => { forget(); if (project) void restore(project.id); }, [project]);
  const request = useRef(0);
  const pending = useRef(false);

  function updateFreshness(next: PlanCompareFreshness) {
    freshnessRef.current = next;
    setFreshness(next);
  }
  function clearResult() {
    loadRequest.current++;
    setSavedAt(null);
    checkRequest.current++;
    resultRef.current = null;
    setResult(null);
    updateFreshness({ status: 'fresh', reasons: [] });
  }
  async function save(projectId: string, jobId: string) {
    const message = '대조 결과를 저장하지 못했어요. 앱을 닫으면 사라져요.';
    try {
      const response = await window.learning.savePlanCompare({ projectId, jobId });
      if (resultRef.current?.jobId !== jobId) return;
      if (response.ok) { setSavedAt(response.value.savedAt); return; }
      if (response.code !== 'PROJECT_CLOSED') setError(message);
    } catch {
      if (resultRef.current?.jobId === jobId) setError(message);
    }
  }
  async function restore(projectId: string) {
    const current = ++loadRequest.current;
    const events = projectEvents.current;
    const message = '저장한 대조 결과를 불러오지 못했어요.';
    try {
      const response = await window.learning.savedPlanCompare({ projectId });
      if (current !== loadRequest.current) return;
      if (!response.ok) {
        if (response.code !== 'PROJECT_CLOSED') setError(message);
        return;
      }
      if (!response.value) return;
      const { result, savedAt, reasons } = response.value;
      checkRequest.current++;
      resultRef.current = result;
      setResult(result); setSavedAt(savedAt);
      if (watchBroken.current) { updateFreshness({ status: 'stale', reasons: [watchError] }); return; }
      if (events !== projectEvents.current) {
        updateFreshness({ status: 'stale', reasons: ['대조 뒤 코드나 제외 규칙이 바뀌었어요(또는 잠자기에서 돌아왔어요)'] });
        return;
      }
      updateFreshness({ status: reasons.length ? 'stale' : 'fresh', reasons });
    } catch {
      if (current === loadRequest.current) setError(message);
    }
  }
  async function remove() {
    const removed = resultRef.current;
    if (!removed || job.current.starting || job.current.id) return;
    loadRequest.current++;
    try {
      const response = await window.learning.deletePlanCompare({ projectId: removed.projectId });
      if (resultRef.current?.jobId !== removed.jobId) return;
      if (!response.ok) { setError(response.message); return; }
      clearResult();
    } catch {
      if (resultRef.current?.jobId === removed.jobId) setError('대조 결과를 지우지 못했어요.');
    }
  }
  // A stale result never rechecks, so a broken watch (always stale) cannot be turned fresh here.
  async function recheck() {
    const checked = resultRef.current;
    if (!checked || freshnessRef.current.status === 'stale' || freshnessRef.current.status === 'checking'
      || job.current.starting || job.current.id) return;
    const current = ++checkRequest.current;
    updateFreshness({ status: 'checking', reasons: [] });
    try {
      const response = await window.learning.checkPlanCompare({ projectId: checked.projectId,
        documentId: checked.document.documentId, planHash: checked.basis.planHash, scopeHash: checked.basis.scopeHash });
      if (current !== checkRequest.current) return;
      if (!response.ok) { updateFreshness({ status: 'error', reasons: [response.message] }); return; }
      updateFreshness({ status: response.value.reasons.length ? 'stale' : 'fresh', reasons: response.value.reasons });
    } catch {
      if (current !== checkRequest.current) return;
      updateFreshness({ status: 'error', reasons: ['확인 요청을 보내지 못했어요. 다시 시도해 주세요.'] });
    }
  }

  function invalidate() {
    const current = ++runRequest.current;
    const id = job.current.id;
    job.current = { id: null, starting: false, queued: [] };
    setRunning(false); setPhase(null); clearResult(); setConsent(false);
    if (id) void window.learning.cancelExplanation({ jobId: id }).then(response => {
      if (current === runRequest.current && !response.ok) setError(response.message);
    }).catch(() => { if (current === runRequest.current) setError('대조 작업을 취소하지 못했어요.'); });
  }
  function setSelection(next: PlanSelection) {
    if (job.current.starting || job.current.id) return;
    updateSelection(next); clearResult(); setConsent(false); setError('');
  }
  async function start(mode: LearningMode) {
    if (keyBusy() || !projectId || !document || !selection || !consent || job.current.starting || job.current.id) return;
    const current = ++runRequest.current;
    job.current = { id: null, starting: true, queued: [] };
    setRunning(true); setPhase(null); clearResult(); setConsent(false); setError('');
    try {
      const response = await window.learning.startPlanCompare({ projectId, selection, mode, consent: true });
      if (current !== runRequest.current) {
        if (response.ok) void window.learning.cancelExplanation({ jobId: response.value.jobId });
        return;
      }
      const queued = job.current.queued;
      job.current = { id: response.ok ? response.value.jobId : null, starting: false, queued: [] };
      if (!response.ok) { setError(response.message); setRunning(false); return; }
      queued.forEach(event => receiver.current(event));
    } catch {
      if (current !== runRequest.current) return;
      job.current = { id: null, starting: false, queued: [] };
      setRunning(false); setError('대조 요청을 시작하지 못했어요. 다시 시도해 주세요.');
    }
  }
  function cancel() { invalidate(); setError('대조 작업을 취소했어요.'); }

  function forget() {
    invalidate();
    watchBroken.current = false;
    request.current++;
    pending.current = false;
    setDocument(null); updateSelection(null); setError(''); setPicking(false);
  }

  async function pick() {
    if (pending.current) return;
    invalidate();
    const current = ++request.current;
    pending.current = true;
    setPicking(true);
    try {
      const result = await window.learning.pickPlanDocument();
      if (current !== request.current) return;
      if (!result.ok) { setError(result.message); return; }
      if (!result.value) return;
      const next = result.value;
      setDocument(next); setError('');
      const useLines = next.bytes <= PLAN_SEND_LIMIT || !next.sections.some(section => section.level > 0);
      setSelection(useLines ? { documentId: next.documentId, startLine: 1, endLine: next.lines }
        : { documentId: next.documentId, sectionIds: [] });
    } catch {
      if (current === request.current) setError('기획 문서를 고르지 못했어요. 다시 시도해 주세요.');
    } finally {
      if (current === request.current) { pending.current = false; setPicking(false); }
    }
  }

  return { document, selection, setSelection, picking, error, pick, forget, running, phase, result, savedAt, remove, freshness, recheck, consent, setConsent, start, cancel };
}
