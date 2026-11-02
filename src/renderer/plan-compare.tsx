import React from 'react';
import { PLAN_SEND_LIMIT, selectionBytes } from '../shared/plan-compare';
import type { usePlanCompare } from './use-plan-compare';

export function PlanCompare({ state, locked }: { state: ReturnType<typeof usePlanCompare>; locked: boolean }) {
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
    <p className="hint">지금은 문서와 범위만 골라요. AI에 보내거나 저장하지 않아요.</p>
    <button className="btn" disabled={locked || picking} onClick={() => void state.pick()}>
      {picking ? '문서 읽는 중…' : document ? '다른 문서 고르기' : '기획 문서 고르기'}
    </button>
    {error && <p role="alert">{error}</p>}
    {document && <>
      <p>{document.name} · {document.bytes.toLocaleString()} 바이트 · {document.lines.toLocaleString()}줄</p>
      {!large && <p>문서 전체를 보내요.</p>}
      {large && selection && <>
        <fieldset disabled={locked || picking}>
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
    </>}
  </section>;
}
