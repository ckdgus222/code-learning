import { useEffect, useRef, useState } from 'react';
import { PLAN_SEND_LIMIT, type PlanDocument, type PlanSelection, type PlanCompareResult } from '../shared/plan-compare';
import type { LearningEvent, LearningMode, LearningPhase } from '../shared/ai';

export function usePlanCompare(projectId: string | null) {
  const [document, setDocument] = useState<PlanDocument | null>(null);
  const [selection, updateSelection] = useState<PlanSelection | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LearningPhase | null>(null);
  const [result, setResult] = useState<PlanCompareResult | null>(null);
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
    if (event.kind === 'plan-compare-completed') setResult(event.result);
  };
  useEffect(() => window.learning.onLearningEvent(event => receiver.current(event)), []);
  useEffect(() => { forget(); }, [projectId]);
  const request = useRef(0);
  const pending = useRef(false);

  function invalidate() {
    const current = ++runRequest.current;
    const id = job.current.id;
    job.current = { id: null, starting: false, queued: [] };
    setRunning(false); setPhase(null); setResult(null); setConsent(false);
    if (id) void window.learning.cancelExplanation({ jobId: id }).then(response => {
      if (current === runRequest.current && !response.ok) setError(response.message);
    }).catch(() => { if (current === runRequest.current) setError('대조 작업을 취소하지 못했어요.'); });
  }
  function setSelection(next: PlanSelection) {
    if (job.current.starting || job.current.id) return;
    updateSelection(next); setResult(null); setConsent(false); setError('');
  }
  async function start(mode: LearningMode) {
    if (!projectId || !document || !selection || !consent || job.current.starting || job.current.id) return;
    const current = ++runRequest.current;
    job.current = { id: null, starting: true, queued: [] };
    setRunning(true); setPhase(null); setResult(null); setConsent(false); setError('');
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

  return { document, selection, setSelection, picking, error, pick, forget, running, phase, result, consent, setConsent, start, cancel };
}
