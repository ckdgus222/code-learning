import { useRef, useState } from 'react';
import { PLAN_SEND_LIMIT, type PlanDocument, type PlanSelection } from '../shared/plan-compare';

export function usePlanCompare() {
  const [document, setDocument] = useState<PlanDocument | null>(null);
  const [selection, setSelection] = useState<PlanSelection | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const pending = useRef(false);

  function forget() {
    request.current++;
    pending.current = false;
    setDocument(null); setSelection(null); setError(''); setPicking(false);
  }

  async function pick() {
    if (pending.current) return;
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

  return { document, selection, setSelection, picking, error, pick, forget };
}
