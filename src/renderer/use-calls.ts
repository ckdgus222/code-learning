import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CodeSymbol, FunctionCalls, ProjectView, SourceView } from '../shared/contracts';
import type { CallsState } from './calls';
import type { View } from './selection';
import { shapeQueries, type ShapeSlot, type ShapesState } from './values';

export const callsKey = (from: SourceView, item: CodeSymbol) => `${from.fileId}:${from.hash}:${item.evidence.startUtf16}:${item.evidence.endUtf16}`;

// Keeps call searches and their value shapes together so replacement searches discard late results.
export function useCalls({ project, revision, view, source, symbol, setError }: {
  project: ProjectView | null; revision: RefObject<number>; view: View;
  source: SourceView | null; symbol: CodeSymbol | undefined; setError(message: string): void;
}) {
  // The call search for the function chosen in the flow view (plan v2.3 F), kept per function and file hash.
  const [calls, setCalls] = useState<{ key: string; state: CallsState; revision: number } | null>(null);
  const callsRequest = useRef(0);
  // The value shapes for those calls (plan v2.3 V-2), asked for once the calls are found, under the same key.
  const [shapes, setShapes] = useState<{ key: string; state: ShapesState; slots: ShapeSlot[] } | null>(null);
  const shapesRequest = useRef(0);

  // Choosing a function in the flow view searches its calls; coming back to it reuses what was found.
  useEffect(() => {
    if (view === 'function' && source && symbol && calls?.key !== callsKey(source, symbol)) void findCalls(source, symbol);
  }, [view, source, symbol]);
  // The calls found lead to their value shapes; coming back to a function reuses both.
  useEffect(() => {
    if (view === 'function' && calls?.state.status === 'done' && shapes?.key !== calls.key) void findShapes(calls.key, calls.state.result);
  }, [calls, view]);

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
  async function cancelCalls() {
    if (!project) return;
    callsRequest.current++;
    setCalls(previous => previous && { ...previous, state: { status: 'failed', message: '호출 찾기를 취소했어요.' } });
    const result = await window.learning.cancelFunctionCalls({ projectId: project.id });
    if (!result.ok) setError(result.message);
  }

  return { calls, shapes, forget: forgetCalls, find: findCalls, findShapes, cancel: cancelCalls, guideCaller };
}
