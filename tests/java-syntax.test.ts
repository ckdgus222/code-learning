import { describe, expect, it } from 'vitest';
import { analyzeSource, NESTED_NOTE } from '../src/core/analysis/syntax';
import { MAX_SYMBOLS } from '../src/core/analysis/syntax-tools';
import { STRUCTURE_NOTE } from '../src/shared/contracts';

const context = { projectId: 'p', fileId: 'f', fileHash: 'h' };
const analyze = (text: string, file = 'Order.java') => analyzeSource(text, file, context);
const method = (body: string) => analyze(`class Order { int run() { ${body} } }`).symbols[0];

describe('Java declarations', () => {
  it('collects bodies, nearest named types and compact constructor parameters', () => {
    const text = `import java.util.List;
      abstract class Order {
        @Deprecated public Order(int n) { super(); }
        abstract int absent();
        @Deprecated public int total(int n) { return n; }
        class Inner { void run() {} }
        interface Service { default void run() {} void absent(); }
        enum Kind { ONE { void run() {} }; void run() {} }
        record Item(int value, String name) { Item { check(value); } }
        @interface Tag { String value(); }
      }`;
    const result = analyze(text, 'Order.JAVA');
    expect(result.language).toBe('java');
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['Order.Order', 'Order.total', 'Inner.run', 'Service.run', 'run', 'Kind.run', 'Item.Item']);
    expect(result.symbols.every(symbol => !symbol.exported)).toBe(true);
    expect(result.symbols[0]).toMatchObject({ kind: 'constructor_declaration', params: '(int n)' });
    expect(result.symbols[1]).toMatchObject({ kind: 'method_declaration', params: '(int n)' });
    expect(result.symbols.at(-1)).toMatchObject({ kind: 'compact_constructor_declaration', params: '(int value, String name)' });
    expect(result.imports).toEqual([]);
    expect(result.classes).toBeUndefined();
    const evidence = result.symbols[1].evidence;
    expect(text.slice(evidence.startUtf16, evidence.endUtf16)).toBe('@Deprecated public int total(int n) { return n; }');
    expect(result.warnings).toContain(STRUCTURE_NOTE);
    expect(result.warnings).toContain('Java는 메서드·생성자 목록, 구문 단계, 코드 색상만 보여 줘요. 부르는 곳·값 찾기, 파일 안내, AI 파일 설명, 프로젝트 지도, 서버 주소는 아직 지원하지 않아요.');
  });

  it('keeps nested declarations and lambdas out of outer steps and complexity', () => {
    const text = `class Order { void run() {
      Runnable task = () -> {
        if (ready) { return; }
      };
      Object value = new Object() {
        void anonymous() { if (ready) { return; } }
      };
      class Local { void local() { if (ready) { return; } } }
      record LocalRecord(int n) { void local() { return; } }
      interface LocalInterface { default void local() { return; } }
      enum LocalEnum { ONE; void local() { return; } }
      // line comment
      /* block
         comment */
      done();
    } }`;
    const result = analyze(text);
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['Order.run', 'anonymous', 'Local.local', 'LocalRecord.local', 'LocalInterface.local', 'LocalEnum.local']);
    const outer = result.symbols[0];
    expect(outer.steps.map(step => step.kind)).toEqual(['lexical_declaration', 'lexical_declaration', 'call_expression', 'expression_statement', 'call_expression']);
    // The two declarations, their trailing semicolon lines, and done() are outer code.
    expect(outer.complexity).toEqual({ lines: 5, depth: 0 });
    expect(result.symbols[1].steps.some(step => step.kind === 'return_statement')).toBe(true);
  });

  it('excludes a method with syntax errors and preserves its valid sibling', () => {
    const result = analyze('class Order { int bad() { return (1; } int good() { return 2; } }');
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['Order.good']);
    expect(result.warnings).toContain('구문 오류가 있습니다. 오류가 포함된 함수는 분석에서 제외합니다.');
  });

  it('clips both name parts, parameters and details', () => {
    const long = 'x'.repeat(350);
    const result = analyze(`class ${long} { int ${long}(int ${long}) { return ${long}; } }`).symbols[0];
    expect(result.name).toBe(`${'x'.repeat(300)}….${'x'.repeat(300)}…`);
    expect(result.params).toHaveLength(301);
    expect(result.steps[0].detail).toBe(`${'x'.repeat(300)}…`);
  });

  it('uses the existing symbol limit and no-function warning', () => {
    const result = analyze(`class Order { ${Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `void f${i}() {}`).join('\n')} }`);
    expect(result.symbols).toHaveLength(MAX_SYMBOLS);
    expect(result.warnings.some(warning => warning.includes('분석량 제한'))).toBe(true);
    expect(analyze('interface Empty { void absent(); }').warnings.some(warning => warning.includes('분석할 수 있는 함수가 없습니다'))).toBe(true);
  });

  it('uses the existing nesting limit', () => {
    const result = method('if (ready) {'.repeat(1600) + 'return 1;' + '}'.repeat(1600));
    expect(result).toBeUndefined();
    expect(analyze(`class A { void run() { ${'{'.repeat(2200)}${'}'.repeat(2200)} } }`).warnings).toContain(NESTED_NOTE);
  });
});

it.each([
  ['if (ready) {} else {}', 'if_statement', '조건 확인', 'ready'],
  ['if (ready) {} else {}', 'else_clause', '다른 조건의 분기', undefined],
  ['for (int i = 0; i < 3; i++) {}', 'for_statement', '반복문', 'i < 3'],
  ['for (String x : xs) {}', 'for_in_statement', '반복문', 'String x : xs'],
  ['while (ready) {}', 'while_statement', '반복문', 'ready'],
  ['do {} while (ready);', 'do_statement', '반복문', 'ready'],
  ['switch (value) { case 1: break; default: break; }', 'switch_statement', '값에 따른 분기', 'value'],
  ['switch (value) { case 1: break; default: break; }', 'switch_case', '분기 항목', 'case 1'],
  ['switch (value) { case 1: break; default: break; }', 'switch_default', '기본 분기', 'default'],
  ['int n = switch (value) { case String s when !s.isEmpty() -> 1; default -> 0; };', 'switch_rule', '분기 항목', 'case String s when !s.isEmpty()'],
  ['return switch (value) { default -> { yield 2; } };', 'switch_yield', 'switch 값 돌려주기', '2'],
  ['try {} catch (Error e) {} finally {}', 'try_statement', '오류 처리 구문', undefined],
  ['try (var r = open()) {}', 'try_with_resources_statement', '자원을 쓰는 오류 처리 구문', 'var r = open()'],
  ['try {} catch (Error | Exception e) {}', 'catch_clause', '오류 받기', 'Error | Exception e'],
  ['try {} finally {}', 'finally_clause', '마무리 구문', undefined],
  ['return (value);', 'return_statement', '반환문', 'value'],
  ['throw error;', 'throw_statement', '오류 던지기', 'error'],
  ['break;', 'break_statement', '반복·분기 종료문', undefined],
  ['continue;', 'continue_statement', '다음 반복으로 이동하는 문장', undefined],
  ['int x = 1;', 'lexical_declaration', '변수 선언', undefined],
  ['x += 1;', 'assignment', '값 넣기', undefined],
  ['run();', 'expression_statement', '표현식', undefined],
  ['run();', 'call_expression', '호출 표현식', undefined],
  ['new Item();', 'call_expression', '호출 표현식', undefined],
  ['assert (ready) : "bad";', 'assert_statement', '확인문', 'ready'],
  ['synchronized (lock) {}', 'synchronized_statement', '잠금 구문', 'lock'],
])('maps %s to %s', (body, kind, title, detail) => {
  const steps = method(body!).steps;
  const step = steps.find(step => step.kind === kind);
  expect(step).toBeDefined();
  expect(step?.title).toBe(title);
  expect(step?.detail).toBe(detail);
});

it.each(['this(1);', 'super(1);'])('includes explicit constructor invocation %s', invocation => {
  const result = analyze(`class A { A() { ${invocation} } }`);
  expect(result.symbols[0].steps.map(step => step.kind)).toEqual(['call_expression']);
});

it('keeps Java if-chain titles and depths flat, but counts an if inside an else block', () => {
  const result = method('if (a) { x(); } else if (b) { y(); } else if (c) {} else { z(); }');
  expect(result.steps.map(step => [step.title, step.depth])).toEqual([
    ['조건 확인', 0], ['표현식', 1], ['호출 표현식', 2],
    ['다른 조건 확인', 1], ['표현식', 2], ['호출 표현식', 3],
    ['다른 조건 확인', 1], ['다른 조건의 분기', 1], ['표현식', 2], ['호출 표현식', 3],
  ]);
  expect(result.complexity.depth).toBe(1);
  expect(method('if (a) {} else { if (b) {} }').complexity.depth).toBe(2);
  expect(method('if (a) if (b) {}').complexity.depth).toBe(2);
});

it.each([
  ['method', 'if (a) { x(); } else if (b) { y(); } else { z(); } next();'],
  ['method', 'if (a) {} else if (b) {} next();'],
  ['method', 'if (a) {} else x(); next();'],
  ['method', 'if (outer) if (a) {} next();'],
  ['constructor', 'if (a) {} next();'],
  ['method', 'switch (n) { case 1: if (a) {} next(); break; }'],
])('matches JS branch targets in a %s: %s', (location, body) => {
  const java = `class A { ${location === 'constructor' ? 'A' : 'void run'}() { ${body} } }`;
  const js = `class A { ${location === 'constructor' ? 'constructor' : 'run'}() { ${body} } }`;
  const targets = (text: string, file: string) => {
    const steps = analyze(text, file).symbols[0].steps;
    return steps.filter(step => step.kind === 'if_statement').map(step => {
      const target = (id: string | null | undefined) => {
        const found = steps.find(step => step.id === id);
        return found ? text.slice(found.evidence.startUtf16, found.evidence.endUtf16).replace(/^else\s+/, '') : null;
      };
      return [target(step.branch?.whenTrue), target(step.branch?.whenFalse)];
    });
  };
  expect(targets(java, 'A.java')).toEqual(targets(js, 'A.js'));
});

it.each([
  'if (ready) { BODY }', 'for (;;) { BODY }', 'for (int n : ns) { BODY }',
  'while (ready) { BODY }', 'do { BODY } while (ready);',
  'switch (n) { case 1: BODY }', 'try { BODY } finally {}',
  'try (var resource = open()) { BODY }', 'synchronized (lock) { BODY }',
])('counts nesting inside %s', statement => {
  expect(method(statement.replace('BODY', 'if (other) {}')).complexity.depth).toBe(2);
});

it('excludes comment-only lines and initializers from method steps', () => {
  const result = analyze(`class Order {
    static { initialize(); }
    int value = initialize();
    void run() {
      // comment
      /* block
         comment */
      return;
    }
  }`);
  expect(result.symbols.map(symbol => symbol.name)).toEqual(['Order.run']);
  expect(result.symbols[0].steps.map(step => step.kind)).toEqual(['return_statement']);
  expect(result.symbols[0].complexity).toEqual({ lines: 1, depth: 0 });
});
