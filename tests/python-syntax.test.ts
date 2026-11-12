import { describe, expect, it } from 'vitest';
import { pythonFunction, measurePythonFunction } from '../src/core/analysis/python-syntax';
import { analyzeSource, parse } from '../src/core/analysis/syntax';
import type { Evidence } from '../src/shared/contracts';

const context = { projectId: 'project', fileId: 'python', fileHash: 'hash' };
const analyze = (text: string) => analyzeSource(text, 'x.py', context);
const slice = (text: string, evidence: Evidence) => text.slice(evidence.startUtf16, evidence.endUtf16);
const stepsOf = (body: string) => analyze(`async def f():\n${body.split('\n').map(line => `    ${line}`).join('\n')}\n`).symbols[0].steps;

describe('Python syntax', () => {
  it('collects imports anywhere, functions, decorated methods, nested names and async definitions', () => {
    const text = `from __future__ import annotations
import os
from pathlib import Path
@decorate
def f(x: int = 1, *args, **kwargs):
    import sys
    def inner():
        return 1
    class Local:
        def run(self):
            return 2
    return lambda x: x
class Order:
    def total(self):
        return 3
    @staticmethod
    async def decorated(value):
        return value
class Empty:
    pass
`;
    const result = analyze(text);
    expect(result.language).toBe('python');
    expect(result.imports.map(item => item.text)).toEqual(['from __future__ import annotations', 'import os', 'from pathlib import Path', 'import sys']);
    for (const item of result.imports) expect(slice(text, item.evidence)).toBe(item.text);
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['f', 'inner', 'Local.run', 'Order.total', 'Order.decorated']);
    expect(result.symbols.every(symbol => symbol.kind === 'function_definition' && !symbol.exported)).toBe(true);
    expect(result.symbols[0].params).toBe('(x: int = 1, *args, **kwargs)');
    expect(slice(text, result.symbols[0].evidence)).toMatch(/^@decorate\ndef f/);
    expect(slice(text, result.symbols[4].evidence)).toMatch(/^@staticmethod\n    async def decorated/);
    expect(result.warnings[1]).toBe('Python은 함수·클래스·import 목록, 구문 단계, 프로젝트 지도의 import 연결과 FastAPI 주소의 기능 흐름(처리 함수까지)을 보여 줘요. 파일 안내, 부르는 곳·값 찾기, 처리 함수 안의 호출 따라가기는 아직 TypeScript·JavaScript만 지원해요.');
  });

  it('collects classes with and without methods and preserves their base lists and ranges', () => {
    const text = `class Item:
    name: str
class Model(BaseModel):
    value: int
class Service( Base, Mixin, metaclass=Meta ):
    def run(self):
        pass
`;
    const result = analyze(text);
    expect(result.classes?.map(item => [item.name, item.bases])).toEqual([
      ['Item', ''], ['Model', '(BaseModel)'], ['Service', '( Base, Mixin, metaclass=Meta )'],
    ]);
    expect(result.classes?.map(item => slice(text, item.evidence))).toEqual([
      'class Item:\n    name: str', 'class Model(BaseModel):\n    value: int',
      'class Service( Base, Mixin, metaclass=Meta ):\n    def run(self):\n        pass',
    ]);
    expect(result.symbols.map(item => item.name)).toEqual(['Service.run']);
    const bases = `(${'Base'.repeat(100)})`;
    expect(analyze(`class Long${bases}:\n    pass\n`).classes?.[0].bases).toBe(bases.slice(0, 300) + '…');
  });

  it('prefixes only direct class members and includes class decorators in evidence', () => {
    const text = `@dataclass
class Outer:
    class Inner:
        pass
    @decorate
    class Decorated:
        pass
    def method(self):
        class Local:
            pass
    if ready:
        class Conditional:
            pass
def factory():
    @dataclass
    class Item:
        name: str
`;
    const classes = analyze(text).classes!;
    expect(classes.map(item => item.name)).toEqual(['Outer', 'Outer.Inner', 'Outer.Decorated', 'Local', 'Conditional', 'Item']);
    expect(classes[0].evidence.startLine).toBe(1);
    expect(slice(text, classes[0].evidence)).toBe(text.slice(0, text.indexOf('\ndef factory')));
    expect(slice(text, classes[2].evidence)).toBe('@decorate\n    class Decorated:\n        pass');
    expect(slice(text, classes[5].evidence)).toBe('@dataclass\n    class Item:\n        name: str');
  });

  it('excludes a broken class but keeps its sound methods', () => {
    const result = analyze('class Broken:\n    def bad(self):\n        value =\n    def good(self):\n        return 1\n');
    expect(result.classes).toEqual([]);
    expect(result.symbols.map(item => item.name)).toEqual(['Broken.good']);
    expect(result.warnings).toContain('구문 오류가 있습니다. 오류가 포함된 함수와 클래스는 분석에서 제외합니다.');
  });

  it('excludes sound classes inside a function with a syntax error', () => {
    const result = analyze('def broken():\n    class Kept:\n        pass\n    value =\nclass Good:\n    pass\n');
    expect(result.classes?.map(item => item.name)).toEqual(['Good']);
    expect(result.symbols).toEqual([]);
    expect(result.warnings).toContain('구문 오류가 있습니다. 오류가 포함된 함수와 클래스는 분석에서 제외합니다.');
  });

  it('shares the evidence budget with classes without a separate class cap', () => {
    const result = analyze('import os\ndef f():\n    return 1\n'
      + Array.from({ length: 1001 }, (_, i) => `class C${i}:\n    pass\n`).join(''));
    expect(result.classes).toHaveLength(997);
    expect(result.imports.length + result.classes!.length
      + result.symbols.reduce((sum, item) => sum + 1 + item.steps.length, 0)).toBe(1000);
    expect(result.warnings.join(' ')).toContain('근거 합계 1000개');
  });

  it('leaves classes absent for other languages and keeps the TS syntax-error sentence', () => {
    for (const file of ['main.ts', 'main.js', 'main.txt']) {
      expect(analyzeSource('class Item {}', file, context)).not.toHaveProperty('classes');
    }
    expect(analyzeSource('function broken( {', 'main.ts', context).warnings)
      .toContain('구문 오류가 있습니다. 오류가 포함된 함수는 분석에서 제외합니다.');
    expect(analyze('')).toHaveProperty('classes', []);
  });

  it.each([
    ['if ok:\n    pass\nelif other:\n    pass\nelse:\n    pass', [['if_statement', '조건 확인', 'ok', 0], ['if_statement', '다른 조건 확인', 'other', 1], ['else_clause', '다른 조건의 분기', undefined, 1]]],
    ['for x in items:\n    break\nelse:\n    pass', [['for_in_statement', '반복문', 'x in items', 0], ['break_statement', '반복 종료문', undefined, 1], ['loop_else_clause', '반복을 다 돈 뒤의 구문', undefined, 1]]],
    ['while ok:\n    continue\nelse:\n    pass', [['while_statement', '반복문', 'ok', 0], ['continue_statement', '다음 반복으로 이동하는 문장', undefined, 1], ['loop_else_clause', '반복을 다 돈 뒤의 구문', undefined, 1]]],
    ['try:\n    pass\nexcept (A, B) as error:\n    pass\nexcept:\n    pass\nelse:\n    pass\nfinally:\n    pass', [['try_statement', '오류 처리 구문', undefined, 0], ['catch_clause', '오류 받기', '(A, B) as error', 1], ['catch_clause', '오류 받기', undefined, 1], ['try_else_clause', '오류가 없을 때의 구문', undefined, 1], ['finally_clause', '마무리 구문', undefined, 1]]],
    ['try:\n    pass\nexcept* ValueError as error:\n    pass\nexcept* TypeError:\n    pass', [['try_statement', '오류 처리 구문', undefined, 0], ['catch_clause', '오류 받기', 'ValueError as error', 1], ['catch_clause', '오류 받기', 'TypeError', 1]]],
    ['with resource as x:\n    pass', [['with_statement', 'with 구문', 'resource as x', 0]]],
    ['match a, b:\n    case 1, 2 if ok:\n        pass\n    case _:\n        pass', [['match_statement', '값의 모양에 따른 분기', 'a, b', 0], ['case_clause', '분기 항목', '1, 2 if ok', 1], ['case_clause', '분기 항목', '_', 1]]],
    ['return value\nreturn\nraise error from cause\nraise\nassert ok, "message"', [['return_statement', '반환문', 'value', 0], ['return_statement', '반환문', undefined, 0], ['throw_statement', '오류 던지기', 'error', 0], ['throw_statement', '오류 던지기', undefined, 0], ['assert_statement', '확인문', 'ok', 0]]],
    ['x: int\nx: int = 1\nx += 2\nx = f()', [['annotation', '타입 표시', undefined, 0], ['assignment', '값 넣기', undefined, 0], ['assignment', '값 넣기', undefined, 0], ['assignment', '값 넣기', undefined, 0], ['call_expression', '호출 표현식', undefined, 1]]],
    ['await f()\nyield value', [['expression_statement', '표현식', undefined, 0], ['await_expression', '기다리는 표현식', undefined, 1], ['call_expression', '호출 표현식', undefined, 2], ['expression_statement', '표현식', undefined, 0], ['yield_expression', '값을 내보내는 표현식', undefined, 1]]],
  ])('maps each step kind, title, detail and depth in %s', (body, expected) => {
    expect(stepsOf(body).map(step => [step.kind, step.title, step.detail, step.depth])).toEqual(expected);
  });

  it.each(['"""doc\nmore"""', "('doc')", "'a' 'b'", "((('doc')))", "('doc' # comment\n)", 'f"no interpolation"'])('skips a bare string in steps and line counts: %s', doc => {
    const text = `def f():\n${doc.split('\n').map(line => `    ${line}`).join('\n')}\n    # comment\n    return 1\n`;
    const symbol = analyze(text).symbols[0];
    expect(symbol.steps.map(step => step.kind)).toEqual(['return_statement']);
    expect(symbol.complexity).toEqual({ lines: 1, depth: 0 });
  });

  it.each(['f"{work()}"', '\'a\' f"{work()}"', '(f"{work()}")'])('keeps interpolated strings and their calls: %s', expression => {
    const symbol = analyze(`def f():\n    ${expression}\n`).symbols[0];
    expect(symbol.steps.map(step => [step.kind, step.depth])).toEqual([['expression_statement', 0], ['call_expression', 1]]);
    expect(symbol.complexity).toEqual({ lines: 1, depth: 0 });
  });

  it('keeps nested definitions, decorated definitions, classes and lambdas out of the parent steps', () => {
    const symbol = analyze(`def outer():
    @decorate(factory())
    def inner():
        secret()
    class C:
        x = hidden()
        def method(self):
            other()
    value = lambda: deferred()
    return value
`).symbols[0];
    expect(symbol.steps.map(step => step.kind)).toEqual(['assignment', 'return_statement']);
  });

  it('links if and elif branches through the whole chain, including an empty consequence', () => {
    const steps = stepsOf('if a:\n    one()\nelif b:\n    pass\nelif c:\n    three()\nelse:\n    four()\nafter()');
    const [first, second, third] = steps.filter(step => step.kind === 'if_statement');
    const expressions = steps.filter(step => step.kind === 'expression_statement');
    expect(first.branch).toEqual({ whenTrue: expressions[0].id, whenFalse: second.id });
    expect(second.branch).toEqual({ whenTrue: expressions[3].id, whenFalse: third.id });
    expect(third.branch).toEqual({ whenTrue: expressions[1].id, whenFalse: steps.find(step => step.kind === 'else_clause')!.id });
    const fallback = stepsOf('if a:\n    pass\nelif b:\n    pass\nafter()');
    expect(fallback[1].branch).toEqual({ whenTrue: fallback[2].id, whenFalse: fallback[2].id });
  });

  it('does not guess targets outside the enclosing block or at function end', () => {
    for (const body of ['if a:\n    pass\nelif b:\n    pass', 'for x in xs:\n    if a:\n        pass\n    elif b:\n        pass\nafter()']) {
      const steps = stepsOf(body);
      const branches = steps.filter(step => step.kind === 'if_statement');
      expect(branches[0].branch).toEqual({ whenTrue: null, whenFalse: branches[1].id });
      expect(branches[1].branch).toEqual({ whenTrue: null, whenFalse: null });
    }
    expect(stepsOf('if a:\n    pass\nafter()')[0].branch).toMatchObject({ whenTrue: expect.any(String), whenFalse: expect.any(String) });
  });

  it('counts code lines and nesting without nesting elif or with', () => {
    const symbol = analyze(`def f():
    """doc"""
    # comment
    def inner():
        if deep:
            pass
    if a:
        pass
    elif b:
        with resource:
            match value:
                case 1:
                    pass
    else:
        pass
`).symbols[0];
    expect(symbol.complexity).toEqual({ lines: 9, depth: 2 });
    expect(analyze('def f():\n    for x in xs:\n        while ok:\n            try:\n                pass\n            finally:\n                pass\n').symbols[0].complexity).toEqual({ lines: 6, depth: 3 });
  });

  it('skips broken functions and their nested symbols while warning about syntax errors', () => {
    const result = analyze('def broken():\n    x = (\n    def inner():\n        pass\n\ndef good():\n    return 1\n');
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['good']);
    expect(result.warnings.join(' ')).toContain('구문 오류');
    expect(analyze('def unfinished(').warnings.join(' ')).toContain('구문 오류');
  });

  it('pins the grammar limitation: an unmatched dedent is accepted without a syntax warning', () => {
    const result = analyze('def f():\n    if True:\n        x = 1\n      y = 2\n');
    expect(result.symbols.map(symbol => symbol.name)).toEqual(['f']);
    expect(result.warnings.join(' ')).not.toContain('구문 오류');
  });

  it('bounds symbols and shares the evidence budget across imports and steps', () => {
    const many = analyze(Array.from({ length: 201 }, (_, i) => `def f${i}():\n    pass\n`).join(''));
    expect(many.symbols).toHaveLength(200);
    expect(many.warnings.join(' ')).toContain('일부 결과만 표시');
    const result = analyze('import os\n' + Array.from({ length: 100 }, (_, i) => `def f${i}():\n${'    work()\n'.repeat(20)}`).join(''));
    expect(result.imports.length + result.symbols.reduce((sum, symbol) => sum + 1 + symbol.steps.length, 0)).toBe(1000);
    expect(result.warnings.join(' ')).toContain('근거 합계 1000개');
    const visited = analyze(`values = [${'0,'.repeat(25000)}]\ndef unseen():\n    pass\n`);
    expect(visited.symbols).toEqual([]);
    expect(visited.warnings.join(' ')).toContain('구문 방문 20000회');
  });

  it('preserves UTF-16 evidence after Korean, emoji and combining text', () => {
    const text = '# 한글🙂e\u0301\r\n@decorate\r\ndef 인사(이름):\r\n    return "안녕🙂"\r\n';
    const symbol = analyze(text).symbols[0];
    expect(symbol.evidence).toMatchObject({ ...context, startUtf16: text.indexOf('@'), endUtf16: text.indexOf('\r\n', text.indexOf('return')), startLine: 2, endLine: 4 });
    expect(slice(text, symbol.steps[0].evidence)).toBe('return "안녕🙂"');
  });

  it('clips parameters and details and leaves truncated branch targets unknown', () => {
    const long = 'x'.repeat(400);
    const symbol = analyze(`def f(${long}):\n    if ${long}:\n        pass\n`).symbols[0];
    expect(symbol.params).toBe(`(${long}`.slice(0, 300) + '…');
    expect(symbol.steps[0].detail).toBe(long.slice(0, 300) + '…');
    const limited = analyze(`def f():\n${'    work()\n'.repeat(499)}    if ok:\n        done()\n    after()\n`).symbols[0].steps;
    expect(limited.at(-1)).toMatchObject({ kind: 'if_statement', branch: { whenTrue: null, whenFalse: null } });
  });
});

it('shares Python function names, decorator ranges and measurements with the map', () => {
  const text = '@decorate\ndef f():\n    return 1\nclass C:\n    @staticmethod\n    async def run():\n        return 2\n';
  const root = parse(text, 'x.py');
  const functions = root.descendantsOfType('function_definition').map(node => pythonFunction(node)!);
  const symbols = analyze(text).symbols;
  expect(functions.map(fn => [fn.name, fn.declaration.startIndex, fn.declaration.endIndex, measurePythonFunction(fn.body, text)]))
    .toEqual(symbols.map(symbol => [symbol.name, symbol.evidence.startUtf16, symbol.evidence.endUtf16, symbol.complexity]));
  expect(pythonFunction(root)).toBeNull();
  expect(pythonFunction(parse('def broken():\n    x =', 'x.py').firstNamedChild!)).toBeNull();
});
