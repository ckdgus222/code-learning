import React, { useEffect } from 'react';
import { GEMINI_MODEL, type LearningMode, type LearningPhase, type ConnectionReport } from '../shared/ai';
import { PLAN_SEND_LIMIT, selectionBytes } from '../shared/plan-compare';
import { savedDate } from './overview';
import { PlanCompareResultView, modes } from './plan-compare-result';
import type { MapImport } from '../shared/contracts';
import type { usePlanCompare } from './use-plan-compare';

const phases: Record<LearningPhase, string> = { collecting: '대조 자료 모으는 중', organizing: '파일 고르는 중', 'reading-related': '고른 코드 읽는 중', explaining: '기획 대조 작성 중', reviewing: 'Codex가 대조 검토 중', validating: '자료가 바뀌었는지 확인 중' };

export function PlanCompare({ state, locked, mode, checking, readiness, onInspect, onFile, onImport }: {
  state: ReturnType<typeof usePlanCompare>; locked: boolean; mode: LearningMode; checking: boolean;
  readiness: ConnectionReport['modes'][number] | null; onInspect(): void; onFile(fileId: string): void; onImport(site: MapImport): void;
}) {
  useEffect(() => { state.setConsent(false); }, [mode]);
  const { document, selection, setSelection, picking, error } = state;
  const large = !!document && document.bytes > PLAN_SEND_LIMIT;
  const hasHeadings = !!document?.sections.some(section => section.level > 0);
  const byLines = selection && 'startLine' in selection;
  const selected = document && selection && 'sectionIds' in selection
    ? document.sections.filter(section => selection.sectionIds.includes(section.id)) : [];
  let bytes = 0;
  let invalid = '';
  if (document && selection) {
    try { bytes = selectionBytes(document, selection); }
    catch { invalid = '문서 안의 시작 줄과 끝 줄을 순서대로 골라 주세요.'; }
  }
  const excluded: string[] = [];
  if (document && selection && !invalid && byLines) {
    if (selection.startLine > 1) excluded.push(`1–${selection.startLine - 1}줄`);
    if (selection.endLine < document.lines) excluded.push(`${selection.endLine + 1}–${document.lines}줄`);
  }
  if (document && selection && !byLines) {
    excluded.push(...document.sections.filter(section => !selected.some(parent =>
      parent.startLine <= section.startLine && parent.endLine >= section.endLine))
      .map(section => `${section.title}${selected.some(child => child.startLine >= section.startLine && child.endLine <= section.endLine) ? ' (선택한 하위 절 제외)' : ''}`));
  }

  return <section className="card card--wide plan-compare" aria-labelledby="plan-compare-title">
    <h3 id="plan-compare-title">기획과 비교</h3>
    <p>기획 문서와 코드를 비교해 기획대로인 것·다른 것·못 찾은 것과 시키지 않은 작업 후보를 찾아요. AI 결과라 정확성을 보장하지 않아요.</p>
    <button className="btn" disabled={locked || picking || state.running} onClick={() => void state.pick()}>
      {picking ? '문서 읽는 중…' : document ? '다른 문서 고르기' : '기획 문서 고르기'}
    </button>
    {error && <p role="alert">{error}</p>}
    {document && <>
      <p>{document.name} · {document.bytes.toLocaleString()} 바이트 · {document.lines.toLocaleString()}줄</p>
      {!large && <p>문서 전체를 보내요.</p>}
      {large && selection && <>
        <fieldset disabled={locked || picking || state.running}>
          <legend>보낼 범위 고르기</legend>
          {hasHeadings && <label><input type="radio" name="plan-selection" checked={!byLines}
            onChange={() => setSelection({ documentId: document.documentId, sectionIds: [] })} />장·절로 고르기</label>}
          <label><input type="radio" name="plan-selection" checked={!!byLines}
            onChange={() => setSelection({ documentId: document.documentId, startLine: 1, endLine: document.lines })} />줄 범위로 고르기</label>
          {!byLines && <ul className="plan-compare__sections">{document.sections.map(section => {
            const covered = selected.some(parent => parent.id !== section.id && parent.startLine <= section.startLine && parent.endLine >= section.endLine);
            return <li key={section.id} style={{ paddingInlineStart: `${Math.max(0, section.level - 1)}rem` }}>
              <label><input type="checkbox" checked={covered || selection.sectionIds.includes(section.id)} disabled={covered}
                onChange={event => setSelection({ documentId: document.documentId, sectionIds: event.target.checked
                  ? [...selection.sectionIds, section.id] : selection.sectionIds.filter(id => id !== section.id) })} />
                {section.title} · {section.bytes.toLocaleString()} 바이트</label>
            </li>;
          })}</ul>}
          {byLines && <div className="plan-compare__lines">
            <label>시작 줄<input type="number" min={1} max={document.lines} value={Number.isNaN(selection.startLine) ? '' : selection.startLine}
              onChange={event => setSelection({ ...selection, startLine: event.target.valueAsNumber })} /></label>
            <label>끝 줄<input type="number" min={1} max={document.lines} value={Number.isNaN(selection.endLine) ? '' : selection.endLine}
              onChange={event => setSelection({ ...selection, endLine: event.target.valueAsNumber })} /></label>
          </div>}
        </fieldset>
        {invalid ? <p role="alert">{invalid}</p> : <>
          <p role="status">고른 합계: {bytes.toLocaleString()} 바이트 / 48 KiB ({PLAN_SEND_LIMIT.toLocaleString()} 바이트)</p>
          {bytes > PLAN_SEND_LIMIT && <p role="alert">고른 범위가 48 KiB를 넘어요. 범위를 줄여 주세요.</p>}
          <p>대조하지 않을 범위: {excluded.join(', ') || '없음'}</p>
        </>}
      </>}
      {selection && !invalid && bytes <= PLAN_SEND_LIMIT && (byLines || selected.length > 0) && <div>
        <p>{modes[mode]}</p>
        <p className="hint">방식은 오른쪽 AI 칸의 ‘설정’에서 고를 수 있어요. 답변은 AI 제공자 서버에서 만들어요.
          {(mode === 'local-worker' || mode === 'antigravity') && ` Gemini 3.8 Flash · High (${GEMINI_MODEL})를 요청해요.`}</p>
        <button className="btn" disabled={locked || state.running || checking} onClick={onInspect}>{checking ? '설치 확인 중…' : '로컬 AI 설치 확인'}</button>
        <p className="hint">{readiness?.reason ?? '먼저 설치 상태를 확인해 주세요. 설치 확인만으로 로그인이나 실제 AI 연결이 검증되는 것은 아닙니다.'}</p>
        <label><input type="checkbox" checked={state.consent} disabled={locked || state.running || !readiness?.ready}
          onChange={event => state.setConsent(event.target.checked)} />보낼 자료에 동의</label>
        <details><summary>무엇을 보내나요?</summary>
          <p>고른 기획 범위(최대 48 KiB), 파일 목록과 지도 연결을 {mode === 'local-worker' ? 'Codex와 Gemini' : mode === 'codex' ? 'Codex' : mode === 'antigravity' ? 'Gemini(Antigravity)' : 'Claude Code'}에 보내요.
            {mode === 'local-worker' ? ' Codex가 고른 코드 최대 8개·파일당 32 KiB·합계 80 KiB를 Gemini와 Codex에 보내요.' : ' 같은 AI가 고른 코드 최대 8개·파일당 32 KiB·합계 80 KiB를 보내요.'}
            비밀값처럼 보이는 내용은 가린 뒤 보내지만 모든 비밀값을 찾는다고 보장하지는 않아요.</p>
        </details>
        <button className="btn btn--primary" disabled={locked || picking || state.running || checking || !state.consent || !readiness?.ready}
          onClick={() => void state.start(mode)}>대조하기</button>
      </div>}
      {state.running && <p role="status">{state.phase ? phases[state.phase] : '대조 작업 시작 중'} <button className="btn" onClick={state.cancel}>대조 작업 취소</button></p>}
    </>}
    {state.result && <>
      <p className="hint">{state.savedAt ? `저장됨 · ${savedDate(state.savedAt)}` : '저장 전'}{' '}
        <button className="btn btn--small" disabled={locked || state.running} onClick={() => void state.remove()}>지우기</button>
      </p>
      <PlanCompareResultView result={state.result} freshness={state.freshness} locked={locked}
        recheck={state.recheck} onFile={onFile} onImport={onImport} />
    </>}
  </section>;
}
