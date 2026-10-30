import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CodeSide, FileChange, GitHistory, ProjectView } from '../shared/contracts';
import type { ChangesEntry, DiffEntry, Loaded } from './changes';
import type { View } from './selection';

// Keeps Git comparisons and their pending reads together so other views can share the same changes.
export function useChanges({ project, revision, view, setView, setError }: {
  project: ProjectView | null; revision: RefObject<number>; view: View;
  setView(view: View): void; setError(message: string): void;
}) {
  // Plan v2.3 C-2: the commits of the opened folder, the comparison with the one chosen, and one change opened.
  const [history, setHistory] = useState<Loaded<GitHistory> | null>(null);
  const [changes, setChanges] = useState<ChangesEntry | null>(null);
  const [diff, setDiff] = useState<DiffEntry | null>(null);
  const historyRequest = useRef(0);
  const changesRequest = useRef(0);
  const diffRequest = useRef(0);

  // The changes view reads the folder's commits the first time it is looked at, then compares with HEAD.
  useEffect(() => {
    if (view === 'changes' && project && !history) void loadHistory();
  }, [view, project]);

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

  return { history, changes, diff, forget: forgetChanges, loadHistory, refresh: refreshChanges, compare, cancelCompare, openChange };
}
