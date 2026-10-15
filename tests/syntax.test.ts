import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/core/analysis/syntax';
import type { Evidence } from '../src/shared/contracts';

const context = {
  projectId: '8659dbe6-e890-454b-b75c-c70622a99e18',
  fileId: '6c8af416-7789-478e-8418-a6f851557a8d',
  fileHash: 'test-hash',
};
const analyze = (text: string, path = 'sample.ts') => analyzeSource(text, path, context);
const slice = (source: string, evidence: Evidence) => source.slice(evidence.startUtf16, evidence.endUtf16);

describe('static source analysis', () => {
  it('preserves native UTF-16 evidence for Korean, emoji, combining text, BOM and CRLF', () => {
    const source = '\uFEFF// 한글🙂e\u0301\r\nimport { 읽기 } from "./파일";\r\nfunction 인사() {\r\n  return "🙂e\u0301";\r\n}\r\n';
    const result = analyze(source);
    expect(result.language).toBe('typescript');
    expect(result.symbols).toHaveLength(1);
    const symbol = result.symbols[0];
    expect(symbol.name).toBe('인사');
    expect(symbol.evidence.startUtf16).toBe(source.indexOf('function'));
    expect(symbol.evidence.endUtf16).toBe(source.lastIndexOf('}') + 1);
    expect(symbol.evidence.startLine).toBe(3);
    expect(symbol.evidence.endLine).toBe(5);
    expect(slice(source, symbol.evidence)).toBe('function 인사() {\r\n  return "🙂e\u0301";\r\n}');
    expect(slice(source, symbol.steps[0].evidence)).toBe('return "🙂e\u0301";');
    expect(result.imports[0].text).toBe('import { 읽기 } from "./파일";');
    expect(slice(source, result.imports[0].evidence)).toBe(result.imports[0].text);
    const allEvidence = [symbol.evidence, ...symbol.steps.map(step => step.evidence), result.imports[0].evidence];
    for (const item of allEvidence) {
      expect(item).toMatchObject(context);
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.endUtf16).toBeLessThanOrEqual(source.length);
    }
    expect(new Set(allEvidence.map(item => item.id)).size).toBe(allEvidence.length);
  });

  it.each(['', '\n', '\r\n'])('keeps the function range independent of trailing %j', ending => {
    const source = `function value() { return 1; }${ending}`;
    const evidence = analyze(source).symbols[0].evidence;
    expect(slice(source, evidence)).toBe('function value() { return 1; }');
    expect(evidence.endLine).toBe(1);
  });

  it('shows both branches, returns and calls as syntax rather than a resolved execution path', () => {
    const source = 'function choose(ok: boolean) { const value = read(); if (ok) { return send(value); } else { return 0; } }';
    const result = analyze(source);
    const steps = result.symbols[0].steps;
    expect(steps.map(step => step.kind)).toEqual([
      'lexical_declaration', 'call_expression', 'if_statement', 'return_statement',
      'call_expression', 'else_clause', 'return_statement',
    ]);
    expect(steps.find(step => step.kind === 'call_expression')?.depth).toBe(1);
    expect(steps.filter(step => step.kind === 'return_statement').map(step => slice(source, step.evidence)))
      .toEqual(['return send(value);', 'return 0;']);
    expect(result.warnings.join(' ')).toContain('실제 실행 순서와 호출 대상은 확인하지 않았습니다');
  });

  it('finds arrows, function expressions and methods without merging nested function bodies', () => {
    const source = 'const twice = (n: number) => n * 2; const obj = { run() { return twice(2); } }; function outer() { const later = () => secret(); return later; } const expression = function named() { return 3; };';
    const symbols = analyze(source).symbols;
    expect(symbols.map(symbol => symbol.name)).toEqual(['twice', 'run', 'outer', 'later', 'named']);
    expect(symbols[0].steps[0].title).toBe('표현식 결과 반환');
    const outerCalls = symbols.find(symbol => symbol.name === 'outer')!.steps.filter(step => step.kind === 'call_expression');
    expect(outerCalls).toEqual([]);
    expect(slice(source, symbols.find(symbol => symbol.name === 'later')!.steps[0].evidence)).toBe('secret()');
  });

  it.each(['view.tsx', 'view.jsx'])('uses a JSX-capable grammar for %s', path => {
    const result = analyze('const View = () => <button onClick={() => send()}>안녕🙂</button>;', path);
    expect(result.language).toBe(path.endsWith('.tsx') ? 'typescript' : 'javascript');
    expect(result.symbols[0].name).toBe('View');
    expect(result.warnings.some(warning => warning.includes('구문 오류'))).toBe(false);
  });

  it('analyzes JavaScript with its own grammar', () => {
    const result = analyze('export function add(a, b) { return a + b; }', 'math.js');
    expect(result.language).toBe('javascript');
    expect(result.symbols[0].name).toBe('add');
  });

  it('excludes malformed functions and still exposes separately valid functions', () => {
    const result = analyze('function broken() { const value = ; return value; }\nfunction good() { return 1; }');
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['good']);
    expect(result.warnings.some(warning => warning.includes('구문 오류'))).toBe(true);
  });

  it('handles an entirely broken file without presenting a definite function', () => {
    const result = analyze('function broken( {');
    expect(result.symbols).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('구문 오류'))).toBe(true);
  });

  it('reports supported files without functions honestly, including an empty source', () => {
    for (const source of ['', 'const answer = 42;']) {
      const result = analyze(source);
      expect(result.symbols).toEqual([]);
      expect(result.warnings.some(warning => warning.includes('함수가 없습니다'))).toBe(true);
    }
  });

  it('does not pretend to analyze unsupported languages or execute JavaScript', () => {
    expect(analyze('def hello():\n  return 1', 'main.py')).toMatchObject({ language: 'text', symbols: [], imports: [] });
    expect(() => analyze('throw new Error("must not execute"); function keep() {}', 'main.js')).not.toThrow();
  });

  it('caps a compact file with many functions and explicitly reports partial results', () => {
    const source = Array.from({ length: 500 }, (_, i) => `function f${i}(){}`).join('');
    expect(Buffer.byteLength(source)).toBeLessThan(256 * 1024);
    const result = analyze(source);
    expect(result.symbols).toHaveLength(200);
    expect(result.symbols.at(-1)?.name).toBe('f199');
    expect(result.warnings.some(warning => warning.includes('일부 결과만 표시'))).toBe(true);
  });

  it('shares one evidence budget across imports, functions and all of their steps', () => {
    const source = 'import value from "./value";' + Array.from({ length: 100 }, (_, i) =>
      `function f${i}(){${'run();'.repeat(20)}}`).join('');
    const result = analyze(source);
    const evidence = [
      ...result.imports.map(item => item.evidence),
      ...result.symbols.flatMap(symbol => [symbol.evidence, ...symbol.steps.map(step => step.evidence)]),
    ];
    expect(evidence).toHaveLength(1000);
    expect(result.symbols.length).toBeGreaterThan(1);
    expect(result.symbols.length).toBeLessThan(100);
    for (const item of evidence) expect(slice(source, item)).not.toBe('');
    expect(result.warnings.some(warning => warning.includes('근거 합계 1000개'))).toBe(true);
  });

  it('stops a huge single function at the same file-wide output limit', () => {
    const source = `function many(){${'run();'.repeat(5000)}}function later(){}`;
    const result = analyze(source);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].steps).toHaveLength(999);
    expect(result.warnings.some(warning => warning.includes('일부 결과만 표시'))).toBe(true);
  });

  it('describes parameters, conditions, returned values and if branches of a guard-clause function', () => {
    const source = [
      'export function placeOrder(quantity: number, stock: number) {',
      '  if (quantity <= 0) {',
      "    return { ok: false, message: '수량은 1개 이상이어야 합니다. 📦' };",
      '  }',
      '  if (quantity > stock) {',
      "    return { ok: false, message: '재고가 부족합니다.' };",
      '  }',
      '  const remaining = stock - quantity;',
      '  return { ok: true, remaining };',
      '}',
    ].join('\n');
    const [symbol] = analyze(source).symbols;
    expect(symbol.params).toBe('(quantity: number, stock: number)');
    expect(symbol.steps.map(step => step.kind)).toEqual([
      'if_statement', 'return_statement', 'if_statement', 'return_statement', 'lexical_declaration', 'return_statement',
    ]);
    const [firstIf, firstReturn, secondIf, secondReturn, declaration, lastReturn] = symbol.steps;
    expect(firstIf.detail).toBe('quantity <= 0');
    expect(secondIf.detail).toBe('quantity > stock');
    expect(firstReturn.detail).toBe("{ ok: false, message: '수량은 1개 이상이어야 합니다. 📦' }");
    expect(lastReturn.detail).toBe('{ ok: true, remaining }');
    expect(declaration.detail).toBeUndefined();
    expect(firstIf.branch).toEqual({ whenTrue: firstReturn.id, whenFalse: secondIf.id });
    expect(secondIf.branch).toEqual({ whenTrue: secondReturn.id, whenFalse: declaration.id });
    expect(firstReturn.branch).toBeUndefined();
  });

  it('links an else-if chain to the code after the whole chain', () => {
    const source = 'function pick(a, b) { if (a) foo(); else if (b) bar(); baz(); }';
    const steps = analyze(source).symbols[0].steps;
    const step = (code: string) => steps.find(item => slice(source, item.evidence) === code)!;
    expect(step('if (a) foo(); else if (b) bar();').branch)
      .toEqual({ whenTrue: step('foo();').id, whenFalse: step('else if (b) bar();').id });
    expect(step('if (b) bar();').branch).toEqual({ whenTrue: step('bar();').id, whenFalse: step('baz();').id });
  });

  it('continues after an empty if and never treats a call in the condition as the true branch', () => {
    const source = 'function f(ok) { if (check(ok)) {} return 1; }';
    const [ifStep, call, returned] = analyze(source).symbols[0].steps;
    expect(call.kind).toBe('call_expression');
    expect(ifStep.detail).toBe('check(ok)');
    expect(ifStep.branch).toEqual({ whenTrue: returned.id, whenFalse: returned.id });
  });

  it('leaves the next step unknown instead of guessing a loop repeat or a function end', () => {
    const loop = 'function f(items) { for (const item of items) { if (item) { use(item); } } }';
    const loopSteps = analyze(loop).symbols[0].steps;
    const inner = loopSteps.find(step => step.kind === 'if_statement')!;
    expect(inner.branch).toEqual({ whenTrue: loopSteps.find(step => slice(loop, step.evidence) === 'use(item);')!.id, whenFalse: null });

    // Without braces the inner if's range is followed by the OUTER else, which a true `a` never reaches.
    const nested = 'function h(a, b) { if (a) if (b) {} else foo(); else bar(); baz(); }';
    const nestedSteps = analyze(nested).symbols[0].steps;
    const nestedStep = (code: string) => nestedSteps.find(item => slice(nested, item.evidence) === code)!;
    expect(nestedStep('if (b) {} else foo();').branch).toEqual({ whenTrue: null, whenFalse: nestedStep('else foo();').id });
    expect(nestedStep('if (a) if (b) {} else foo(); else bar();').branch)
      .toEqual({ whenTrue: nestedStep('if (b) {} else foo();').id, whenFalse: nestedStep('else bar();').id });

    // Instance field code runs on `new C()`, not while f runs, so it is neither a step nor a branch target.
    const withClass = 'function f(ok) { if (ok) {} class C { x = sideEffect(); } const D = class { y = other(); }; return C; }';
    const classSteps = analyze(withClass).symbols.find(symbol => symbol.name === 'f')!.steps;
    expect(classSteps.map(item => slice(withClass, item.evidence))).toEqual([
      'if (ok) {}', 'const D = class { y = other(); };', 'return C;',
    ]);
    expect(classSteps[0].branch).toEqual({ whenTrue: classSteps[1].id, whenFalse: classSteps[1].id });

    const inCase = 'function k(x, a) { switch (x) { case 1: if (a) foo(); bar(); } }';
    const caseSteps = analyze(inCase).symbols[0].steps;
    expect(caseSteps.find(item => item.kind === 'if_statement')!.branch?.whenFalse)
      .toBe(caseSteps.find(item => slice(inCase, item.evidence) === 'bar();')!.id);

    const both = 'function g(x) { if (x) { return 1; } else { return 2; } }';
    const bothSteps = analyze(both).symbols[0].steps;
    expect(bothSteps.filter(step => step.kind === 'return_statement').map(step => step.detail)).toEqual(['1', '2']);
    expect(bothSteps[0].branch?.whenFalse).toBe(bothSteps.find(step => step.kind === 'else_clause')!.id);
  });

  it('records the code that loops, switch, throw and return decide on or hand back', () => {
    const source = [
      'function f(a, list) {',
      '  for (let i = 0; i < a; i++) {}',
      '  for (;;) { break; }',
      '  for (const k of list) {}',
      '  while (ok()) {}',
      '  do {} while (a < 3);',
      '  switch (a) { case 1: break; default: return; }',
      "  throw new Error('e');",
      '}',
    ].join('\n');
    const steps = analyze(source).symbols[0].steps;
    const details = (kind: string) => steps.filter(step => step.kind === kind).map(step => step.detail);
    expect(details('for_statement')).toEqual(['i < a', undefined]);
    expect(details('for_in_statement')).toEqual(['k of list']);
    expect(details('while_statement')).toEqual(['ok()']);
    expect(details('do_statement')).toEqual(['a < 3']);
    expect(details('switch_statement')).toEqual(['a']);
    expect(details('switch_case')).toEqual(['1']);
    expect(details('return_statement')).toEqual([undefined]);
    expect(details('throw_statement')).toEqual(["new Error('e')"]);
  });

  it('records an arrow expression body as the returned value, even when it returns a function', () => {
    const source = 'const make = () => () => 42; const wrap = () => function () { return 1; }; const twice = x => add(x, x);';
    const symbols = analyze(source).symbols;
    const steps = (name: string) => symbols.find(symbol => symbol.name === name)!.steps
      .map(step => [step.kind, slice(source, step.evidence)]);
    expect(steps('make')).toEqual([['expression_body', '() => 42']]);
    expect(steps('wrap')).toEqual([['expression_body', 'function () { return 1; }']]);
    expect(steps('twice')).toEqual([['expression_body', 'add(x, x)']]);
    expect(symbols.find(symbol => symbol.name === 'twice')!.params).toBe('x');
    // The returned functions keep their own steps instead of leaking into the outer function.
    expect(symbols.map(symbol => symbol.steps.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('cuts long details and parameter lists to a bounded length', () => {
    const long = 'a'.repeat(400);
    const symbol = analyze(`function f(${long}) { if (${long}) { return 1; } }`).symbols[0];
    expect(symbol.params).toBe(`(${long}`.slice(0, 300) + '…');
    expect(symbol.steps[0].detail).toBe(long.slice(0, 300) + '…');
  });

  it('does not point a branch at a step cut by the analysis budget', () => {
    const source = `function many(ok){${'run();'.repeat(499)} if (ok) { done(); } after(); }`;
    const result = analyze(source);
    const steps = result.symbols[0].steps;
    expect(steps.at(-1)!.kind).toBe('if_statement');
    expect(steps.at(-1)!.branch).toEqual({ whenTrue: null, whenFalse: null });
    expect(result.warnings.some(warning => warning.includes('일부 결과만 표시'))).toBe(true);
  });

  it('bounds traversal even when nodes do not produce evidence', () => {
    const source = `const values=[${'0,'.repeat(25000)}];function unseen(){}`;
    const result = analyze(source);
    expect(result.symbols).toHaveLength(0);
    expect(result.warnings.some(warning => warning.includes('구문 방문 20000회'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('함수가 없습니다'))).toBe(false);
  });
});
