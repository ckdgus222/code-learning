import React, { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { MergeView } from '@codemirror/merge';
import type { ChangeKind, FileChange, GitCommit, GitHistory, ProjectChanges } from '../shared/contracts';

/*
 * Plan v2.3 C-2: a chosen commit against the files now. Read only: nothing here changes a file, the index or a branch.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'done'; value: T };
/** A comparison and the project revision it was made at, to tell when the files changed after it. */
export interface ChangesEntry { commit: string; state: Loaded<ProjectChanges>; revision: number }
/** One change opened: the old code (none for a new file) and the code now (none for a deleted file). */
export interface DiffEntry { change: FileChange; old: Loaded<string> | null; now: Loaded<string> | null }

export const kindLabels: Record<ChangeKind, string> = { modified: '수정', added: '추가', untracked: '미추적', renamed: '이름 변경', deleted: '삭제' };
const kindOrder: ChangeKind[] = ['modified', 'added', 'untracked', 'renamed', 'deleted'];
const dateOf = (time: number) => new Date(time * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
/** HEAD that did not change the opened folder is listed without its subject, which is about other folders. */
const commitLabel = (commit: GitCommit) =>
  `${commit.oid.slice(0, 7)} · ${dateOf(commit.time)} · ${commit.subject === null ? '지금 커밋(HEAD)' : `${commit.head ? 'HEAD · ' : ''}${commit.subject}`}`;
const changePath = (change: FileChange) => change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;

// Shown 300 at a time: every change stays reachable, a deleted file's old code too.
const PAGE = 300;

/** The changes of a comparison, by kind; shown in the changes view and next to the map. */
export function ChangeList({ result, locked, onOpen }: { result: ProjectChanges; locked: boolean; onOpen(change: FileChange): void }) {
  const counts = kindOrder.map(kind => [kind, result.changes.filter(change => change.kind === kind).length] as const).filter(([, count]) => count);
  const [shown, setShown] = useState(PAGE);
  const left = result.changes.length - shown;
  return <>
    <p>{counts.length ? counts.map(([kind, count]) => <span key={kind} className={`tag tag--change tag--${kind}`}>{kindLabels[kind]} {count}</span>)
      : '고른 커밋 뒤로 바뀐 파일이 없어요.'}</p>
    {result.changes.length > 0 && <ul className="map-list" aria-label="바뀐 파일">
      {result.changes.slice(0, shown).map(change => <li key={`${change.kind}:${change.path}`}>
        <span className={`tag tag--change tag--${change.kind}`}>{kindLabels[change.kind]}</span> <span className="path">{changePath(change)}</span>{' '}
        <button className="btn btn--small" disabled={locked} onClick={() => onOpen(change)}>비교 보기</button>
      </li>)}
    </ul>}
    {left > 0 && <p className="hint">{shown}개를 보여요. 나머지 {left}개 <button className="btn btn--small"
      onClick={() => setShown(count => count + PAGE)}>{Math.min(PAGE, left)}개 더 보기</button></p>}
    {result.notCompared.length > 0 && <p className="hint">비교하지 못했거나 제외한 경로: {result.notCompared.map(item => `${item.reason} ${item.count}개`).join(', ')}.</p>}
    {result.notes.map(note => <p key={note} className="hint">{note}</p>)}
  </>;
}

export function ChangesView({ history, changes, stale, diff, locked, onRetryHistory, onCompare, onRefresh, onCancel, onOpen, onOpenCode }: {
  history: Loaded<GitHistory> | null; changes: ChangesEntry | null; stale: boolean; diff: DiffEntry | null; locked: boolean;
  onRetryHistory(): void; onCompare(commit: string): void; onRefresh(): void; onCancel(): void; onOpen(change: FileChange): void;
  onOpenCode(fileId: string): void;
}) {
  const commits = history?.status === 'done' ? history.value.commits : [];
  const chosen = commits.find(commit => commit.oid === changes?.commit);
  const comparing = changes?.state.status === 'loading';
  return <div className="page changes-page">
    <h2 className="page__title">달라진 내용</h2>
    <p className="hint">고른 커밋과 지금 파일을 비교해요. 사람이 바꿨는지 AI가 바꿨는지는 가려내지 않아요. 앱은 Git의 필터·줄 끝 바꾸기를 실행하지 않고
      내용 그대로 비교해요. 그런 설정을 쓰는 저장소는 Git과 달리 수정으로 보일 수 있어요.</p>
    {!history || history.status === 'loading' ? <span role="status" className="busy"><span className="spinner" aria-hidden="true" />Git 기록을 읽는 중…</span>
      : history.status === 'failed' ? <p>{history.message} <button className="btn btn--small" onClick={onRetryHistory}>다시 읽기</button></p>
      : !history.value.available ? <p className="notice">{history.value.reason}</p>
      : <>
        <div className="map-actions">
          <label>기준 커밋{' '}
            <select value={changes?.commit ?? ''} disabled={comparing} onChange={event => onCompare(event.target.value)}>
              {commits.map(commit => <option key={commit.oid} value={commit.oid}>{commitLabel(commit)}</option>)}
            </select>
          </label>
          {comparing ? <>
            <span role="status" className="busy"><span className="spinner" aria-hidden="true" />비교하는 중…</span>
            <button className="btn btn--small" onClick={onCancel}>비교 취소</button>
          </> : changes && <button className="btn btn--small" onClick={onRefresh}>다시 비교</button>}
        </div>
        {changes && stale && <p className="notice notice--warn"><b>다시 확인 필요:</b> 비교한 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 다시 비교해 주세요.</p>}
        {changes?.state.status === 'failed' && <p className="notice notice--warn">{changes.state.message}</p>}
        {changes?.state.status === 'done' && <section className="card" aria-label="바뀐 파일 목록">
          <h3>기준 {chosen ? chosen.oid.slice(0, 7) : changes.commit.slice(0, 7)} ↔ 지금 파일 · {changes.state.value.changes.length}개</h3>
          <ChangeList result={changes.state.value} locked={locked} onOpen={onOpen} />
        </section>}
        <p className="hint">새 커밋이나 스테이징 뒤에는 ‘다시 비교’를 눌러 주세요. 커밋 목록도 다시 읽고, HEAD와 비교하던 중이면 새 HEAD와 비교해요.
          폴더를 연 뒤 새로 만든 파일은 폴더를 다시 열어야 들어와요.</p>
      </>}
    {diff && <DiffPane entry={diff} onOpenCode={onOpenCode} />}
  </div>;
}

function DiffPane({ entry, onOpenCode }: { entry: DiffEntry; onOpenCode(fileId: string): void }) {
  const { change, old, now } = entry;
  const failed = [old?.status === 'failed' && `이전 코드를 열 수 없어요: ${old.message}`, now?.status === 'failed' && `지금 코드를 열 수 없어요: ${now.message}`]
    .filter(Boolean) as string[];
  const loading = old?.status === 'loading' || now?.status === 'loading';
  const before = old?.status === 'done' ? old.value : null;
  const after = now?.status === 'done' ? now.value : null;
  return <section className="card diff-card" aria-label="고른 변경 비교">
    <h3><span className={`tag tag--change tag--${change.kind}`}>{kindLabels[change.kind]}</span> <span className="path">{changePath(change)}</span></h3>
    {change.fileId && <button className="btn btn--small" onClick={() => onOpenCode(change.fileId!)}>코드 읽기에서 열기</button>}
    {loading && <span role="status" className="busy"><span className="spinner" aria-hidden="true" />코드를 여는 중…</span>}
    {failed.map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    {/* Whether a side exists comes from the kind of change; a side that failed to open is a failure, said above. */}
    {before !== null && after !== null ? <>
      <p className="hint">왼쪽은 고른 커밋, 오른쪽은 지금 파일이에요. 바뀌지 않은 부분은 접어 두었어요.</p>
      <Merge before={before} after={after} file={change.path} />
    </> : !loading && <>
      {before !== null && <>
        <p className="hint">{change.kind === 'deleted' ? '고른 커밋의 코드예요. 지금은 이 경로에 파일이 없어요.' : '고른 커밋의 코드만 열 수 있어 그것만 보여요.'}</p>
        <Single text={before} file={change.oldPath ?? change.path} label="고른 커밋의 코드 (읽기 전용)" />
      </>}
      {after !== null && <>
        <p className="hint">{change.kind === 'added' || change.kind === 'untracked' ? '고른 커밋에는 없던 파일이에요. 지금 코드예요.'
          : '지금 코드만 열 수 있어 그것만 보여요.'}</p>
        <Single text={after} file={change.path} label="지금 코드 (읽기 전용)" />
      </>}
    </>}
  </section>;
}

/** Read-only code with line numbers, coloured for TS/JS as in the reader; CR and BOM are kept. */
function readOnly(file: string, label: string): Extension[] {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  const typescript = ['.ts', '.tsx', '.mts', '.cts'].includes(extension);
  const code = typescript || ['.js', '.jsx', '.mjs', '.cjs'].includes(extension);
  return [EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(),
    EditorView.contentAttributes.of({ 'aria-label': label, role: 'textbox', 'aria-readonly': 'true', tabindex: '0' }),
    ...(code ? [javascript({ typescript, jsx: true }), syntaxHighlighting(defaultHighlightStyle)] : [])];
}

function Merge({ before, after, file }: { before: string; after: string; file: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new MergeView({ parent: host.current!, a: { doc: before, extensions: readOnly(file, '고른 커밋의 코드 (읽기 전용)') },
      b: { doc: after, extensions: readOnly(file, '지금 코드 (읽기 전용)') }, collapseUnchanged: { margin: 3, minSize: 4 }, gutter: true });
    return () => view.destroy();
  }, [before, after, file]);
  return <div ref={host} className="diff-view" data-testid="diff-view" />;
}

function Single({ text, file, label }: { text: string; file: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: readOnly(file, label) }) });
    return () => view.destroy();
  }, [text, file, label]);
  return <div ref={host} className="diff-view" data-testid="diff-view" />;
}
