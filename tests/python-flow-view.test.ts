import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Flow } from '../src/renderer/flow';
import { analyzeSource } from '../src/core/analysis/syntax';
import type { SourceView } from '../src/shared/contracts';

const python = `def f():
    try:
        value += 1
        raise error
    except Error:
        pass
    else:
        pass
    match value:
        case 1 if ready:
            pass
    with resource:
        pass
    assert ready
    value: int
    for x in xs:
        break
    else:
        pass
`;
const script = 'function f() { try { throw error; } catch (error) {} }';
function render(text: string, relativePath: string, kind?: string) {
  const source: SourceView = { projectId: 'p', fileId: 'f', hash: 'h', relativePath, text, guide: null,
    analysis: analyzeSource(text, relativePath, { projectId: 'p', fileId: 'f', fileHash: 'h' }) };
  const symbol = source.analysis.symbols[0];
  const step = symbol.steps.find(step => step.kind === kind);
  if (kind) expect(step).toBeDefined();
  return renderToStaticMarkup(React.createElement(Flow, { source, symbol, step, evidence: step?.evidence ?? null,
    locked: false, onSymbol() {}, onStep() {}, onOpenCode() {}, calls: null, marks: [], pendingMarks: [], onSaveMark() {} }));
}

it.each([
  ['try_statement', '안쪽 코드를 지나요. 안쪽에서 오류가 나면 그 오류를 받는 except로 갈 수 있고, finally가 있으면 마지막에 그 부분을 지나요.'],
  ['try_else_clause', 'try 안쪽이 오류 없이, return·break·continue로 빠져나가지도 않고 끝났을 때 여기를 지나요.'],
  ['case_clause', '값이 이 모양과 맞고, 뒤에 if 조건이 있으면 그것도 맞을 때 여기로 와요. 안쪽을 지난 뒤 다음 case로 내려가지 않아요.'],
  ['catch_clause', '앞의 try 안에서 난 오류를 이 except가 받을 때 여기로 와요.'],
  ['throw_statement', '오류를 던져요. 이 오류가 어디서 처리되는지는 감싼 except·finally·with에 따라 달라요. 이 함수 안에서 처리되지 않으면 함수를 부른 곳으로 넘어가요.'],
  ['assignment', '값을 계산해서 왼쪽 대상에 넣어요. += 같은 연산은 원래 있던 값도 함께 써요.'],
  ['break_statement', '감싼 반복문을 빠져나가려고 해요. 감싼 finally가 있으면 그 부분을 먼저 지나고 거기서 흐름이 바뀔 수 있어요.'],
  ['loop_else_clause', '반복이 중간에 빠져나가지 않고 다 돌았을 때 여기를 지나요. break로 나가면 건너뛰어요.'],
  ['with_statement', '쓸 것을 준비하고 안쪽 단계를 지나요. 안쪽을 나갈 때는 오류가 나도 정리 동작을 하고, 그 동작에 따라 오류가 멈출 수도 있어요.'],
  ['match_statement', '값을 위에서부터 case와 견줘, 처음 맞는 case로 가요. 맞는 case가 없으면 그냥 지나가요.'],
  ['assert_statement', '조건이 맞는지 확인해요. 맞지 않으면 오류를 던져요. 최적화 옵션으로 실행하면 이 확인은 건너뛰어요.'],
  ['annotation', '이름의 타입만 적어 둬요. 값은 넣지 않아요.'],
])('uses Python wording for %s', (kind, sentence) => {
  expect(render(python, 'main.py', kind)).toContain(sentence);
});

it.each([
  ['catch_clause', '받는 오류'], ['with_statement', '준비하는 것'], ['match_statement', '비교할 값'],
  ['case_clause', 'case 모양'], ['assert_statement', '확인하는 조건'],
])('uses a Python detail label for %s', (kind, label) => {
  expect(render(python, 'main.py', kind)).toContain(`<dt>${label}</dt>`);
});

it('uses except in the Python summary and preserves the TS summary and step sentences', () => {
  expect(render(python, 'main.py')).toContain('try 안에서 던진 오류는 except로 이어질 수 있고');
  expect(render(script, 'main.ts')).toContain('try 안에서 던진 오류는 catch로 이어질 수 있고');
  expect(render(script, 'main.ts', 'try_statement')).toContain('안쪽 코드를 지나요. 오류가 나면 catch가 있을 때 그쪽으로 가고, finally가 있으면 마지막에 그 부분을 지나요.');
  expect(render(script, 'main.ts', 'catch_clause')).toContain('앞의 try 안에서 오류가 났을 때 여기로 와요.');
  expect(render(script, 'main.ts', 'throw_statement')).toContain('받는 catch가 없으면 이 함수를 부른 곳으로 넘어가고');
});
