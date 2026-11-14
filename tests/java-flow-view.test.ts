import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Flow } from '../src/renderer/flow';
import { analyzeSource } from '../src/core/analysis/syntax';
import type { SourceView } from '../src/shared/contracts';
import { findsCalls } from '../src/shared/languages';

const text = `class A { int run() {
  try { fail(); } catch (First e) {} catch (Second e) {} finally {}
  try (var resource = open()) {}
  synchronized (lock) { assert ready; value += 1; }
  switch (value) { case 1: break; default: break; }
  return switch (value) { case String s when ready -> 1; default -> { yield 0; } };
} }`;
function render(kind?: string) {
  const source: SourceView = { projectId: 'p', fileId: 'f', hash: 'h', relativePath: 'A.java', text, guide: null,
    analysis: analyzeSource(text, 'A.java', { projectId: 'p', fileId: 'f', fileHash: 'h' }) };
  const symbol = source.analysis.symbols[0];
  const step = symbol.steps.find(step => step.kind === kind);
  if (kind) expect(step).toBeDefined();
  return renderToStaticMarkup(React.createElement(Flow, { source, symbol, step, evidence: step?.evidence ?? null,
    locked: false, onSymbol() {}, onStep() {}, onOpenCode() {}, calls: 'UNSUPPORTED', marks: [], pendingMarks: [], onSaveMark() {} }));
}

it.each([
  ['try_statement', '오류가 나면 그 오류 종류를 받을 수 있는 첫 catch로 가요. 맞는 catch가 없으면 함수 밖으로 넘어가요. finally가 있으면 마지막에 그 부분을 지나요.'],
  ['catch_clause', '앞의 try 안에서 난 오류의 종류가 이 catch와 맞아, 이 catch가 골라졌을 때 여기로 와요.'],
  ['switch_statement', '값·형식 패턴(case String s)·when 조건을 위에서부터 확인해 처음 맞는 case로 가요.'],
  ['switch_statement', '값이 null이면 case null이 없을 때 default로 가지 않고 NullPointerException 오류가 나요.'],
  ['switch_case', '콜론 case는 break 없이 아래 case로 내려갈 수 있어요.'],
  ['switch_rule', '이 화살표 case가 골라지면 안쪽을 지나요. 아래 case로 내려가지 않아요.'],
  ['switch_yield', 'switch 식의 값을 돌려주고 그 switch를 끝내요.'],
  ['try_with_resources_statement', '자원을 준비하고 안쪽 코드를 지나요. 끝나면 오류가 나도 자원을 자동으로 닫아요.'],
  ['synchronized_statement', '대상의 잠금을 얻은 뒤 안쪽 코드를 지나요.'],
  ['assert_statement', 'assert 검사가 켜져 있을 때 조건을 확인해요. 기본적으로 꺼져 있으며 -ea 같은 설정으로 켤 수 있어요. 맞지 않으면 오류를 던져요.'],
  ['assignment', '값을 계산해서 왼쪽 대상에 넣어요.'],
])('uses Java wording for %s', (kind, sentence) => {
  expect(render(kind)).toContain(sentence);
});

it.each([
  ['catch_clause', '받는 오류'], ['try_with_resources_statement', '준비하는 자원'],
  ['switch_rule', 'case 값·형식·조건'], ['switch_yield', '돌려주는 값'],
  ['assert_statement', '확인하는 조건'], ['synchronized_statement', '잠그는 대상'],
])('uses a Java detail label for %s', (kind, label) => {
  expect(render(kind)).toContain(`<dt>${label}</dt>`);
});

it('names catch in the Java summary', () => {
  expect(render()).toContain('try 안에서 던진 오류는 catch로 이어질 수 있고');
});

// The screen shows the scope notices instead of a call search for these languages (checked in electron-smoke).
it('does not search calls in Java, matching what calls.ts accepts', () => {
  expect(findsCalls('java')).toBe(false);
  expect(findsCalls('text')).toBe(false);
  for (const language of ['typescript', 'javascript', 'python'] as const) expect(findsCalls(language)).toBe(true);
});
