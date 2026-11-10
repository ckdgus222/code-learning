import React from 'react';
import type { Analysis, Evidence } from '../shared/contracts';
import { firstRows, Omitted } from './project-map';

/** Classes and imports of a Python file, shown under the outline's function list (TS/JS lists imports in the file guide). */
export function OutlineLists({ analysis, locked, current, onShow }: {
  analysis: Analysis;
  /** A read or an evidence check is running, or the file changed: rows cannot be clicked. */
  locked: boolean;
  /** The evidence the code view shows now; its row is marked pressed. */
  current: Evidence | null;
  onShow(evidence: Evidence): void;
}): React.ReactElement | null {
  const classes = analysis.classes ?? [];
  if (!classes.length && !analysis.imports.length) return null;
  return <>
    {classes.length > 0 && <>
      <h4 className="eyebrow">클래스 {classes.length}개</h4>
      <ul className="symbols">{classes.map(({ name, bases, evidence }) => <li key={evidence.id} className="symbols__row">
        <button className="symbols__item" aria-pressed={current?.id === evidence.id} disabled={locked}
          onClick={() => onShow(evidence)}>{name}</button>
        <span className="symbols__meta">{bases ? `${bases} · ` : ''}{evidence.startLine}–{evidence.endLine}행</span>
      </li>)}</ul>
    </>}
    {analysis.imports.length > 0 && <details>
      <summary className="eyebrow">import {analysis.imports.length}개</summary>
      <ul className="symbols">{firstRows(analysis.imports).map(({ text, evidence }) => {
        const label = text.replace(/\s+/g, ' ');
        return <li key={evidence.id} className="symbols__row">
          <button className="symbols__item" aria-pressed={current?.id === evidence.id} disabled={locked} title={label}
            onClick={() => onShow(evidence)}>{label.length > 80 ? `${label.slice(0, 80)}…` : label}</button>
          <span className="symbols__meta">{evidence.startLine}행</span>
        </li>;
      })}</ul>
      <Omitted count={analysis.imports.length} />
    </details>}
  </>;
}
