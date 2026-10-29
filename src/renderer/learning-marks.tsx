import React, { useEffect, useState } from 'react';
import { LEARNING_NOTE_LIMIT, type LearningMark, type ProjectFile } from '../shared/contracts';
import { markView, type MarkChange } from './marks';

export function MarkEditor({ mark, currentHash, locked, onSave }: {
  mark: LearningMark | undefined; currentHash: string | undefined; locked: boolean; onSave(change: MarkChange): void;
}) {
  const [note, setNote] = useState(mark?.note ?? '');
  useEffect(() => { setNote(mark?.note ?? ''); }, [mark?.note]);
  const view = markView(mark, currentHash);
  const disabled = locked || !currentHash;
  return <section aria-label="학습 기록" className="learning-mark">
    <h4>학습 기록</h4>
    <div className="flow-nav">
      {([['표시 없음', null], ['이해함', 'understood'], ['다시 보기', 'review']] as const).map(([label, state]) =>
        <button key={label} className="btn" aria-pressed={view.state === state} disabled={disabled}
          onClick={() => onSave({ state })}>{label}</button>)}
    </div>
    {view.changed && <p className="notice notice--warn">{view.state === 'understood'
      ? '이해한 뒤 이 함수 코드가 바뀌었어요. 다시 읽고 확인해 주세요.'
      : '표시한 뒤 이 함수 코드가 바뀌었어요. 맞는 함수인지 확인해 주세요.'}
      {' '}<button className="btn" disabled={disabled} onClick={() => onSave({ confirm: true })}>지금 코드로 확인</button>
    </p>}
    <textarea aria-label="메모" maxLength={LEARNING_NOTE_LIMIT} value={note} disabled={disabled}
      onChange={event => setNote(event.target.value)} />
    <button className="btn" disabled={disabled || note === view.note} onClick={() => onSave({ note })}>메모 저장</button>
  </section>;
}

export function MarkBadge({ mark, currentHash }: { mark: LearningMark | undefined; currentHash: string | undefined }) {
  if (!mark) return null;
  const view = markView(mark, currentHash);
  return <span className="hint learning-mark__badge">
    {view.state === 'understood' && '✓ 이해함'}{view.state === 'review' && '↻ 다시 보기'}
    {view.note.trim() && ' 메모'}{view.changed && ' ! 표시한 뒤 바뀜'}
  </span>;
}

export function LearningMarksCard({ marks, files, locked, onOpen }: {
  marks: LearningMark[]; files: ProjectFile[]; locked: boolean; onOpen(mark: LearningMark): void;
}) {
  if (!marks.length) return null;
  const understood = marks.filter(mark => mark.state === 'understood');
  const review = marks.filter(mark => mark.state === 'review');
  const notes = marks.filter(mark => mark.state === null);
  const rows = (list: LearningMark[]) => <ul>{list.map(mark => <li key={JSON.stringify([mark.relativePath, mark.name, mark.occurrence])}>
    {files.some(file => file.relativePath === mark.relativePath)
      ? <button className="flow-link" disabled={locked} onClick={() => onOpen(mark)}>{mark.relativePath} › {mark.name}</button>
      : <span>{mark.relativePath} › {mark.name} · 파일을 찾지 못했어요</span>}
    {mark.note.trim() && <p className="hint">{mark.note.split(/\r?\n/)[0].slice(0, 80)}</p>}
  </li>)}</ul>;
  return <section className="card card--wide" aria-label="학습 기록">
    <h3>학습 기록</h3>
    <p>이해함 {understood.length}개 · 다시 보기 {review.length}개 · 메모만 {notes.length}개</p>
    <h4>다시 보기</h4>{review.length ? rows(review) : <p className="hint">다시 보기로 표시한 함수가 없어요.</p>}
    <details><summary>이해함</summary>{rows(understood)}</details>
    <details><summary>메모만</summary>{rows(notes)}</details>
    <p className="hint">이해한 뒤 코드가 바뀌었는지는 함수를 열면 보여요.</p>
  </section>;
}
