import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/core/analysis/syntax';
import { describeFile } from '../src/core/analysis/file-guide';
import { functionBands, functionParams } from '../src/renderer/code-bands';

function analyze(text: string, path = 'example.tsx') {
  const analysis = analyzeSource(text, path, { projectId: 'p', fileId: 'f', fileHash: 'h' });
  const guide = describeFile(text, path, 'f', 'h', analysis, []);
  return { analysis, guide, lineCount: text.split('\n').length };
}

describe('function bands', () => {
  it('places one header before the start line and bands only the function range', () => {
    const { analysis, guide, lineCount } = analyze('// before\nfunction run( input: string ) {\n  return input;\n}\n// after');
    expect(functionBands(analysis, guide, lineCount)).toEqual({
      headers: [{ line: 2, items: [{ symbolId: analysis.symbols[0].id, text: 'run · 받는 것: input: string', kind: 'plain' }] }],
      lines: [2, 3, 4].map(line => ({ line, kind: 'plain' })),
    });
  });

  it('marks Nest routes as shapes with the common prefix excluded immediately after the address', () => {
    const { analysis, guide, lineCount } = analyze("@Controller('auth')\nclass Auth {\n@Post('login') login(input: string) { return input; }\n}", 'auth.controller.ts');
    const bands = functionBands(analysis, guide, lineCount);
    expect(bands.headers[0].items[0]).toEqual({ symbolId: analysis.symbols[0].id, kind: 'server',
      text: 'Auth.login · 서버 받는 곳 모양 · POST /auth/login (공통 앞 경로 제외) (모양) · 받는 것: input: string' });
  });

  it('uses the shortest range on nested lines even when analysis lists the inner function first', () => {
    const { analysis, guide, lineCount } = analyze('function Outer() {\n  function useInner() {\n    return 1;\n  }\n  return <div />;\n}');
    analysis.symbols.reverse();
    const bands = functionBands(analysis, guide, lineCount);
    expect(bands.headers.map(header => header.line)).toEqual([1, 2]);
    expect(bands.lines).toEqual([1, 2, 3, 4, 5, 6].map(line => ({ line, kind: line >= 2 && line <= 4 ? 'hook' : 'jsx' })));
  });

  it('groups same-line functions in analysis order, matching facts by ID', () => {
    const { analysis, guide, lineCount } = analyze('const a = () => 1, b = () => <div />;');
    const bands = functionBands(analysis, guide, lineCount);
    expect(bands.headers).toEqual([{ line: 1, items: [
      { symbolId: analysis.symbols[0].id, text: 'a · 받는 것: 없음', kind: 'plain' },
      { symbolId: analysis.symbols[1].id, text: 'b · JSX(화면 조각)가 든 코드를 돌려줘요 (모양) · 받는 것: 없음', kind: 'jsx' },
    ] }]);
    expect(bands.lines).toEqual([{ line: 1, kind: 'jsx' }]);
  });

  it('shows only names and parameters when the guide or an individual fact is missing', () => {
    const { analysis, guide, lineCount } = analyze('function useOne(input: string) { return <div />; }\nfunction useTwo() {}');
    const expected = analysis.symbols.map(symbol => ({ symbolId: symbol.id, text: `${symbol.name} · 받는 것: ${functionParams(symbol.params)}`, kind: 'plain' }));
    expect(functionBands(analysis, null, lineCount).headers.flatMap(header => header.items)).toEqual(expected);
    guide.functions = guide.functions.slice(0, 1);
    expect(functionBands(analysis, guide, lineCount).headers[1].items).toEqual([expected[1]]);
  });

  it('uses server, JSX, hook and plain kinds in that order of precedence', () => {
    const { analysis, guide, lineCount } = analyze('export function GET() { return <div />; }\nfunction useView() { return <div />; }\nfunction useData() { return 1; }\nfunction plain() {}');
    guide.functions[0].tags.unshift('서버 받는 곳 모양 · Next · GET');
    expect(functionBands(analysis, guide, lineCount).headers.flatMap(header => header.items.map(item => item.kind))).toEqual(['server', 'jsx', 'hook', 'plain']);
    expect(functionBands(analysis, guide, lineCount).headers[0].items[0].text).not.toContain('공통 앞 경로 제외');
  });

  it('skips starts outside the document and clips end lines to its length', () => {
    const { analysis, guide } = analyze('function first() {\n  return 1;\n}\nfunction second() {}');
    expect(functionBands(analysis, guide, 2).headers.map(header => header.line)).toEqual([1]);
    expect(functionBands(analysis, guide, 2).lines).toEqual([{ line: 1, kind: 'plain' }, { line: 2, kind: 'plain' }]);
    expect(functionBands(analysis, guide, 0)).toEqual({ headers: [], lines: [] });
  });

  it('does not draw functions absent from analysis, including invalid syntax', () => {
    const { analysis, guide, lineCount } = analyze('const broken = ;\nfunction valid() {}');
    expect(functionBands(analysis, guide, lineCount).headers).toHaveLength(analysis.symbols.length);
    expect(functionBands({ ...analysis, symbols: [] }, guide, lineCount)).toEqual({ headers: [], lines: [] });
  });

  it('does not confuse functions with the same name', () => {
    const { analysis, guide, lineCount } = analyze('function outer() { function useData() { return <div />; } }\nfunction useData() { return 1; }');
    expect(functionBands(analysis, guide, lineCount).headers.flatMap(header => header.items).map(item => item.kind)).toEqual(['plain', 'jsx', 'hook']);
  });
});

describe('shared function parameters', () => {
  it.each([['', '없음'], [' ( \n ) ', '없음'], ['(\n input: string,\tcount: number\n)', 'input: string, count: number'],
    ['x'.repeat(60), 'x'.repeat(60)], ['x'.repeat(61), `${'x'.repeat(60)}…`]])('formats %j', (params, expected) => {
    expect(functionParams(params)).toBe(expected);
  });
});
