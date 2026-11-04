import React, { useEffect, useRef } from 'react';
import type { MapImport } from '../shared/contracts';
import type { LearningMode } from '../shared/ai';
import { planPartFor, type PlanCompareResult, type PlanRange } from '../shared/plan-compare';
import type { PlanCompareFreshness } from './use-plan-compare';

export const PLAN_COMPARE_CHECK_MS = 10_000;
export const modes: Record<LearningMode, string> = { 'local-worker': '로컬 워커 · Codex → Gemini → Codex', codex: 'Codex 단독', antigravity: 'Antigravity 단독', 'claude-code': 'Claude Code 단독 · 준비 중' };
const stages = { organizing: '파일 고르기', explaining: '대조', reviewing: '검토' };
const rangeLabel = (range: PlanRange) => range.startLine === range.endLine ? `${range.startLine}줄` : `${range.startLine}–${range.endLine}줄`;

export function PlanCompareResultView({ result, freshness, locked, recheck, onFile, onImport }: {
  result: PlanCompareResult; freshness: PlanCompareFreshness; locked: boolean;
  recheck(): void; onFile(fileId: string): void; onImport(site: MapImport): void;
}) {
  const check = useRef(recheck);
  check.current = recheck;
  useEffect(() => {
    const recheckCurrent = () => check.current();
    recheckCurrent();
    window.addEventListener('focus', recheckCurrent);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') recheckCurrent();
    }, PLAN_COMPARE_CHECK_MS);
    return () => { window.removeEventListener('focus', recheckCurrent); window.clearInterval(interval); };
  }, [result.jobId]);

  const disabled = locked || freshness.status !== 'fresh';
  const readIds = new Set(result.read.map(file => file.fileId));
  const listed = result.files.filter(file => !readIds.has(file.id));
  const count = (status: PlanCompareResult['compare']['items'][number]['status']) => result.compare.items.filter(item => item.status === status).length;
  const groups = [
    { key: 'differs', label: '다름', title: '있지만 기획과 다름', count: count('differs') },
    { key: 'missing', label: '못 찾음', title: '기획에 있는데 못 찾음', count: count('missing') },
    { key: 'unverified', label: '확인 못 함', title: '찾았지만 확인 못 함', count: count('unverified') },
    { key: 'unrequested', label: '시키지 않은 작업', title: '시키지 않은 작업 후보', count: result.compare.unrequested.length },
    { key: 'design', label: '설계와 다른 연결', title: '설계와 다른 연결', count: result.compare.designMismatches.length },
    { key: 'matches', label: '기획대로', title: '기획대로 있음', count: count('matches') },
  ];
  function excerpt(range: PlanRange) {
    const part = planPartFor(result.plan, range)!;
    const offset = range.startLine - part.startLine;
    const lineCount = range.endLine - range.startLine + 1;
    const lines = part.text.split('\n').slice(offset, offset + Math.min(lineCount, 6));
    const remaining = lineCount - lines.length;
    return <>
      <blockquote style={{ whiteSpace: 'pre-wrap' }}>{lines.join('\n')}</blockquote>
      {remaining > 0 && <p className="hint">… 외 {remaining}줄은 기획 문서에서 보세요</p>}
    </>;
  }
  function fileButtons(ids: string[]) {
    return <ul>{ids.map(id => <li key={id}>
      <button className="btn btn--small" disabled={disabled} onClick={() => onFile(id)}>{result.files.find(file => file.id === id)!.relativePath}</button>
      {!readIds.has(id) && <span className="hint"> 목록만 봄</span>}
    </li>)}</ul>;
  }

  return <div className="plan-compare-result">
    <p role="status" className="visually-hidden">대조 결과 · 기획대로 {count('matches')} · 다름 {count('differs')} · 확인 못 함 {count('unverified')} · 못 찾음 {count('missing')} · 시키지 않은 작업 후보 {result.compare.unrequested.length} · 설계와 다른 연결 {result.compare.designMismatches.length}
      {result.structureOnly && ' · 코드를 읽지 않은 구조 비교'} · 대조한 범위: {result.sent.map(range => `${range.startLine}–${range.endLine}줄`).join(', ')}</p>
    <div className="plan-summary" role="list" aria-label="요약">
      {groups.map(group => <div key={group.key} role="listitem" className={`plan-summary__cell plan-summary__cell--${group.key}`}>
        <strong>{group.count}</strong><span>{group.label}</span>
      </div>)}
    </div>
    <p className="hint">AI 대조 · 정확성을 보장하지 않아요 · {modes[result.mode]} · {result.review}</p>
    <ul className="hint">{result.models.map((model, index) => <li key={index}>{model.provider === 'codex' ? 'Codex' : 'Gemini 3.8 Flash · High'}
      {' · '}{stages[model.stage]} · 요청 모델: {model.requestedModel ?? '실행기 기본값'} · 응답 모델: {model.reportedModel ?? '알려 주지 않음'}</li>)}</ul>
    {freshness.status === 'checking' && <p role="status">지금 파일과 맞는지 확인 중</p>}
    {freshness.status === 'stale' && <p role="alert" className="notice notice--warn">다시 확인 필요: {freshness.reasons.join('. ')}. 결과는 대조할 때의 코드 기준이에요. 다시 대조해 주세요.</p>}
    {freshness.status === 'error' && <p role="alert">지금 파일과 맞는지 확인하지 못했어요: {freshness.reasons.join('. ')}</p>}
    <p className="hint">새 파일과 기획 문서 변경은 10초마다 확인해요</p>
    {groups.map(group => <details key={`${result.jobId}:${group.key}`} className={`plan-group plan-group--${group.key}`} open={group.count > 0 && group.key !== 'matches'}>
      <summary>{group.title} ({group.count})</summary>
      {group.key === 'unrequested' && <p>기획에서 찾아본 범위: {result.sent.map(rangeLabel).join(', ')}</p>}
      {group.count === 0 && <p>없음</p>}
      {result.structureOnly && (group.key === 'differs' || group.key === 'matches') && <p>코드를 읽지 않은 구조 비교라 판정하지 않았어요</p>}
      {result.compare.items.filter(item => item.status === group.key).map((item, index) => <article className="plan-item" key={index}>
        <span className={`tag plan-tag plan-tag--${group.key}`}>{group.label}</span>
        <div className="plan-item__body">
          <p className="plan-item__range">기획 {rangeLabel(item.plan)}</p>
          <h4>{item.title}</h4>
          {item.difference !== null && <p>다른 점: {item.difference}</p>}
          {item.missingEvidence !== null && <p>부족한 근거: {item.missingEvidence}</p>}
          {item.searched !== null && <p>조사한 범위: {item.searched}</p>}
          {excerpt(item.plan)}
        </div>
        <div className="plan-item__evidence">{fileButtons(item.files)}</div>
      </article>)}
      {group.key === 'unrequested' && result.compare.unrequested.map((item, index) => <article className="plan-item" key={index}>
        <span className={`tag plan-tag plan-tag--${group.key}`}>{group.label}</span>
        <div className="plan-item__body"><h4>{item.title}</h4><p>{item.note}</p></div>
        <div className="plan-item__evidence">{fileButtons(item.files)}</div>
      </article>)}
      {group.key === 'design' && result.compare.designMismatches.map((item, index) => {
        const edge = result.edges.find(edge => edge.index === item.edge)!;
        return <article className="plan-item" key={index}>
          <span className={`tag plan-tag plan-tag--${group.key}`}>{group.label}</span>
          <div className="plan-item__body">
            <p className="plan-item__range">기획 {rangeLabel(item.plan)}</p>
            <p>{item.note}</p>{excerpt(item.plan)}
          </div>
          <div className="plan-item__evidence">
            <button className="btn btn--small" disabled={disabled} onClick={() => onImport(edge.site)}>{edge.from} → {edge.to} · {edge.line}행</button>
          </div>
        </article>;
      })}
      {group.key === 'design' && result.limitations.some(note => note.includes('잇지 못한 연결')) && <p>지도에서 잇지 못한 연결은 판단하지 않았어요</p>}
    </details>)}
    <p className="hint">‘못 찾음’은 읽은 범위에서 찾지 못했다는 뜻이고, 구현이 없다는 확정이 아니에요.</p>
    <div className="card plan-scope">
      <section aria-label="조사한 범위">
        <h4>조사한 범위</h4>
        {result.structureOnly ? <p>코드는 읽지 않았어요(구조 비교)</p> : <>
          <p>코드까지 읽은 파일 {result.read.length}개</p>
          <ul>{result.read.map(file => <li key={file.fileId}>{file.relativePath}</li>)}</ul>
        </>}
        <details><summary>목록만 본 파일 {listed.length}개</summary><ul>{listed.map(file => <li key={file.id}>{file.relativePath}</li>)}</ul></details>
        {result.limitations.length > 0 && <p className="hint">빠진 파일과 이유는 아래 한계를 보세요</p>}
      </section>
      <p>대조하지 않은 기획 범위: {result.excluded.map(rangeLabel).join(', ') || '없음'}</p>
      {result.compare.unknowns.length > 0 && <section><h4>AI가 판단하지 못한 점</h4><ul>{result.compare.unknowns.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
      {result.limitations.length > 0 && <section><h4>한계</h4><ul>{result.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
    </div>
  </div>;
}
