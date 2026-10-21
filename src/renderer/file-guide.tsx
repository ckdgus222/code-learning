import React, { useState } from 'react';
import type { FileGuide, GuideRange } from '../shared/contracts';

const kinds = { imports: '가져오기', class: '클래스', function: '메서드/함수', field: '필드', variable: '값', statement: '문장' };

export function FileGuideCard({ guide, busy, stale, onShow, onSelect }: {
  guide: FileGuide; busy: boolean; stale: boolean;
  onShow(range: GuideRange): void; onSelect(symbolId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const locked = busy || stale;
  const basis = guide.role.basis;
  return <details open className="card file-guide" aria-label="이 파일은">
    <summary>이 파일은</summary>
    <p><span className="badge">{guide.role.label}</span> {guide.role.about}</p>
    {basis.range && <button className="btn btn--chip" disabled={locked} onClick={() => onShow(basis.range!)}>
      근거: {basis.text} ({basis.range.startLine}행)
    </button>}
    <p className="hint">코드 모양으로 짐작했어요. 자세한 문장 설명은 아래 AI 설명에서 만들 수 있어요.</p>
    {guide.notes.map(note => <p key={note} className="hint">{note}</p>)}
    {!!guide.exports.length && <p>내보내는 것: {guide.exports.join(', ')}{guide.exportsOmitted > 0 && ` 외 ${guide.exportsOmitted}개`}</p>}
    {guide.limitations.map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    <h4>안의 코드</h4>
    <ol className="file-guide__chunks">{(expanded ? guide.chunks : guide.chunks.slice(0, 8)).map(({ chunk, about, symbolId }) => {
      const importsLabel = about.startsWith('다시 내보내기') ? '다시 내보내기' : about.includes(' · 다시 내보내기') ? '가져오기·다시 내보내기' : '가져오기';
      const label = chunk.kind === 'imports' ? importsLabel : kinds[chunk.kind];
      const name = chunk.kind === 'imports' ? `${label} (${chunk.range.endLine - chunk.range.startLine + 1}줄)` : chunk.name;
      return <li key={chunk.id}>
        <span className="badge">{label}</span> <strong>{name}</strong> <span className="hint">{chunk.range.startLine}–{chunk.range.endLine}행</span>
        <p>{about}</p>
        <button className="btn btn--small" disabled={locked} onClick={() => onShow(chunk.range)}>코드 보기</button>{' '}
        {symbolId && <button className="btn btn--small" disabled={locked} onClick={() => onSelect(symbolId)}>이 함수 고르기</button>}
      </li>;
    })}</ol>
    {guide.chunks.length > 8 && <button className="btn btn--small" disabled={locked} onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '더 보기'}</button>}
  </details>;
}
