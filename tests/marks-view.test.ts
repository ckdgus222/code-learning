import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MarkBadge, MarkEditor, LearningMarksCard } from '../src/renderer/learning-marks';
import { Flow } from '../src/renderer/flow';
import type { LearningMark, SourceView } from '../src/shared/contracts';
import { analyzeSource } from '../src/core/analysis/syntax';

const mark: LearningMark = { relativePath: 'read.ts', name: 'read', occurrence: 0,
  state: 'understood', note: 'first line\nsecond line', codeHash: 'a'.repeat(64), savedAt: '2026-10-29' };
const editor = (props: Partial<React.ComponentProps<typeof MarkEditor>> = {}) =>
  renderToStaticMarkup(React.createElement(MarkEditor, { mark, currentHash: mark.codeHash, locked: false, onSave() {}, ...props }));

it.each(['understood', 'review', null] as const)('shows the pressed state and changed warning for %s', state => {
  const html = editor({ mark: { ...mark, state }, currentHash: 'b'.repeat(64) });
  expect(html).toContain('aria-label="학습 기록"');
  const pressed = state === 'understood' ? '이해함' : state === 'review' ? '다시 보기' : '표시 없음';
  expect(html).toContain(`aria-pressed="true">${pressed}</button>`);
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toContain(state === 'understood' ? '이해한 뒤 이 함수 코드가 바뀌었어요.' : '표시한 뒤 이 함수 코드가 바뀌었어요.');
  expect(html).toContain('지금 코드로 확인');
  expect(html).toContain('maxLength="500"');
  expect(html).toContain('disabled="">메모 저장');
});

it.each([{ locked: true }, { currentHash: undefined }])('locks every control while unavailable: %j', props => {
  const html = editor({ currentHash: 'b'.repeat(64), ...props });
  const controls = html.match(/<(?:button|textarea)\b[^>]*>/g)!;
  expect(controls.length).toBeGreaterThanOrEqual(5);
  expect(controls.every(control => control.includes('disabled=""'))).toBe(true);
});

it('does not warn or mark understood for a new record', () => {
  const html = editor({ mark: undefined });
  expect(html).toContain('aria-pressed="true">표시 없음');
  expect(html).not.toContain('지금 코드로 확인');
});

it('dispatches explicit state and confirm changes without attaching the unsaved note', () => {
  const onSave = vi.fn();
  const buttons: { children?: React.ReactNode; onClick?: () => void }[] = [];
  function Probe() {
    const tree = MarkEditor({ mark, currentHash: 'b'.repeat(64), locked: false, onSave });
    const pending: React.ReactNode[] = [tree];
    while (pending.length) {
      const item = pending.shift();
      if (Array.isArray(item)) { pending.push(...item); continue; }
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(item)) continue;
      if (item.type === 'button') buttons.push(item.props);
      pending.push(item.props.children);
    }
    return tree;
  }
  renderToStaticMarkup(React.createElement(Probe));
  for (const text of ['표시 없음', '이해함', '다시 보기', '지금 코드로 확인']) buttons.find(button => button.children === text)!.onClick!();
  expect(onSave.mock.calls).toEqual([[{ state: null }], [{ state: 'understood' }], [{ state: 'review' }], [{ confirm: true }]]);
});

it.each(['understood', 'review', null] as const)('labels saved functions with text for %s, note and code changes', state => {
  const html = renderToStaticMarkup(React.createElement(MarkBadge, { mark: { ...mark, state }, currentHash: 'b'.repeat(64) }));
  if (state) expect(html).toContain(state === 'understood' ? '✓ 이해함' : '↻ 다시 보기');
  expect(html).toContain('메모');
  expect(html).toContain('! 표시한 뒤 바뀜');
  expect(renderToStaticMarkup(React.createElement(MarkBadge, { mark: undefined, currentHash: 'b'.repeat(64) }))).toBe('');
});

it('puts learning controls only in the function summary and marks beside the function name', () => {
  const text = 'function read() { return 1; }';
  const source: SourceView = { projectId: 'p', fileId: 'f', relativePath: 'read.ts', hash: 'h', text, guide: null,
    analysis: analyzeSource(text, 'read.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' }) };
  const symbol = source.analysis.symbols[0];
  const props: React.ComponentProps<typeof Flow> = { source, symbol, step: undefined, evidence: symbol.evidence,
    locked: false, calls: null, marks: [mark], pendingMarks: [], onSaveMark() {}, onStep() {}, onSymbol() {}, onOpenCode() {} };
  const summary = renderToStaticMarkup(React.createElement(Flow, props));
  expect(summary).toContain('aria-label="학습 기록"');
  expect(summary).toContain('✓ 이해함');
  expect(summary.indexOf('하는 일')).toBeLessThan(summary.indexOf('aria-label="학습 기록"'));
  const step = renderToStaticMarkup(React.createElement(Flow, { ...props, step: symbol.steps[0], evidence: symbol.steps[0].evidence }));
  expect(step).not.toContain('aria-label="학습 기록"');
  expect(step).toContain('✓ 이해함');
});

it('groups records, folds understood and note-only lists, truncates first lines and disables missing files', () => {
  const html = renderToStaticMarkup(React.createElement(LearningMarksCard, {
    marks: [mark, { ...mark, name: 'again', state: 'review', note: 'a'.repeat(81) + '\nsecond line' },
      { ...mark, relativePath: 'missing.ts', state: null }],
    files: [{ id: 'f', relativePath: 'read.ts', size: 1 }], locked: false, onOpen() {},
  }));
  expect(html).toContain('이해함 1개 · 다시 보기 1개 · 메모만 1개');
  expect(html).toContain('<details><summary>이해함</summary>');
  expect(html).toContain('<details><summary>메모만</summary>');
  expect(html).toContain('read.ts › again');
  expect(html).toContain('a'.repeat(80));
  expect(html).not.toContain('a'.repeat(81));
  expect(html).not.toContain('second line');
  expect(html).toContain('<span>missing.ts › read · 파일을 찾지 못했어요</span>');
  expect(html).not.toContain('! 표시한 뒤 바뀜');
  expect(html.match(/<button/g)).toHaveLength(2);
  const empty = renderToStaticMarkup(React.createElement(LearningMarksCard, { marks: [], files: [], locked: false, onOpen() {} }));
  expect(empty).toBe('');
});
