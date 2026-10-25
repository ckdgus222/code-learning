import React, { useState } from 'react';
import { STRUCTURE_NOTE, type Analysis, type FileGuide, type GuideRange } from '../shared/contracts';
import { ComplexityTags } from './complexity';

const kinds = { imports: '가져오기', class: '클래스', function: '메서드/함수', field: '필드', variable: '값', statement: '문장' };
const importStatuses = { project: '', ambiguous: '어느 파일인지 하나로 정하지 못함', 'not-found': '프로젝트에서 찾지 못함',
  outside: '프로젝트 폴더 밖 · 확인 못 함', 'not-static': '실행할 때 정하는 가져오기 · 확인 못 함',
  unreadable: '가져올 경로를 읽지 못함', syntax: '구문 오류로 확인 못 함' };

export function FileGuideCard({ guide, analysis, busy, stale, onShow, onSelect, onOpenFile }: {
  guide: FileGuide; analysis: Analysis; busy: boolean; stale: boolean;
  onShow(range: GuideRange): void; onSelect(symbolId: string): void; onOpenFile(fileId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const locked = busy || stale;
  const basis = guide.role.basis;
  const facts = new Map(guide.functions.map(item => [item.symbolId, item]));
  const otherChunks = guide.chunks.filter(item => !item.chunk.functionRange);
  return <details open className="card file-guide" aria-label="이 파일은">
    <summary>이 파일은</summary>
    <p><span className="badge">{guide.role.label}</span> <span className="badge">코드 모양으로 추정</span></p>
    <p>{guide.role.about}</p>
    {basis.range && <button className="btn btn--chip" disabled={locked} onClick={() => onShow(basis.range!)}>
      근거: {basis.text} ({basis.range.startLine}행)
    </button>}
    <p className="hint">코드 모양으로 짐작했어요. 자세한 문장 설명은 아래 AI 설명에서 만들 수 있어요.</p>
    {guide.notes.map(note => <p key={note} className="hint">{note}</p>)}
    {guide.limitations.map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    <h4>가져다 쓰는 파일 {guide.imports.length + guide.importsOmitted}개</h4>
    <ul className="file-guide__imports">{guide.imports.map((item, index) => <li key={index}>
      {item.target && <button className="btn btn--small" disabled={locked} title={item.target.relativePath}
        onClick={() => onOpenFile(item.target!.fileId)}>{item.target.relativePath.split('/').at(-1)} 열기</button>}
      <p className="hint">{item.specifier ?? '경로 확인 못 함'} · {item.line}행{item.status !== 'project' && ` · ${importStatuses[item.status]}`}</p>
    </li>)}</ul>
    {guide.importsOmitted > 0 && <p className="hint">외 {guide.importsOmitted}개</p>}
    {!!guide.external.length && <p className="hint">외부 패키지 또는 경로 별칭 · 확인 못 함: {guide.external.join(', ')}{guide.externalOmitted > 0 && ` 외 ${guide.externalOmitted}개`}</p>}
    {!!guide.exports.length && <p>내보내는 것: {guide.exports.join(', ')}{guide.exportsOmitted > 0 && ` 외 ${guide.exportsOmitted}개`}</p>}
    {analysis.warnings.filter(message => message !== STRUCTURE_NOTE).map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    <h4>이 파일의 함수 {analysis.symbols.length}개</h4>
    <p className="hint">종류 표시는 코드 모양으로 판단했어요. 실제로 요청이 이어지는지는 흐름 따라가기에서 확인해요.</p>
    <ol className="file-guide__functions">{(expanded ? analysis.symbols : analysis.symbols.slice(0, 8)).map(symbol => {
      const fact = facts.get(symbol.id);
      const params = symbol.params.replace(/\s+/g, ' ').trim().replace(/^\(/, '').replace(/\)$/, '').trim();
      return <li key={symbol.id}>
        <div className="file-guide__function-heading"><strong>{symbol.name}</strong><span className="hint">{symbol.evidence.startLine}–{symbol.evidence.endLine}행</span></div>
        {fact?.tags.map(tag => <p key={tag}><span className="tag">{tag} · 모양으로 판단</span></p>)}
        {fact?.routeNote && <p className="hint">{fact.routeNote}</p>}
        <p>받는 것: {params.length > 60 ? `${params.slice(0, 60)}…` : params || '없음'}</p>
        {!!fact?.calls.length && <p>부르는 것: {fact.calls.join(', ')}{fact.callsOmitted > 0 && ` 외 ${fact.callsOmitted}개`}</p>}
        {!!fact?.hooks.length && <p>훅처럼 이름 붙인 호출: {fact.hooks.join(', ')}{fact.hooksOmitted > 0 && ` 외 ${fact.hooksOmitted}개`}</p>}
        <p>크기: {symbol.complexity.lines}줄 · 깊이 {symbol.complexity.depth}</p>
        <ComplexityTags {...symbol.complexity} />
        <div className="file-guide__actions">
          <button className="btn btn--small" disabled={locked} onClick={() => onShow(symbol.evidence)}>코드 보기</button>
          <button className="btn btn--small" disabled={locked} onClick={() => onSelect(symbol.id)}>이 함수 고르기</button>
        </div>
      </li>;
    })}</ol>
    {analysis.symbols.length > 8 && <button className="btn btn--small" disabled={locked} onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '더 보기'}</button>}
    <details>
      <summary>그 밖의 코드 {otherChunks.length}개</summary>
      <ol className="file-guide__chunks">{(otherExpanded ? otherChunks : otherChunks.slice(0, 8)).map(({ chunk, about }) => {
        const importsLabel = about.startsWith('다시 내보내기') ? '다시 내보내기' : about.includes(' · 다시 내보내기') ? '가져오기·다시 내보내기' : '가져오기';
        const label = chunk.kind === 'imports' ? importsLabel : kinds[chunk.kind];
        const name = chunk.kind === 'imports' ? `${label} (${chunk.range.endLine - chunk.range.startLine + 1}줄)` : chunk.name;
        return <li key={chunk.id}>
          <span className="badge">{label}</span> <strong>{name}</strong> <span className="hint">{chunk.range.startLine}–{chunk.range.endLine}행</span>
          <p>{about}</p>
          <button className="btn btn--small" disabled={locked} onClick={() => onShow(chunk.range)}>코드 보기</button>
        </li>;
      })}</ol>
      {otherChunks.length > 8 && <button className="btn btn--small" disabled={locked} onClick={() => setOtherExpanded(value => !value)}>{otherExpanded ? '접기' : '더 보기'}</button>}
    </details>
  </details>;
}
