import { AppError } from '../src/shared/errors';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitFileChunks } from '../src/core/analysis/file-chunks';
import { analyzeSource, NESTED_NOTE } from '../src/core/analysis/syntax';

const fileId = randomUUID();
const hash = 'a'.repeat(64);
const split = (text: string, path = 'example.ts') => splitFileChunks(text, path, fileId, hash);

describe('file explanation chunks', () => {
  it('splits a decorated controller into its head, field, constructor, method, function field and static block', () => {
    const text = `@Controller('auth')
export class AuthController extends Base implements Handler {
  @Inject() cookieOptions = { secure: true };
  constructor(@Inject(Service) private service: Service) {}
  @Post()
  login() { return this.service; }
  handler = () => 1;
  static { register(); }
}`;
    const { chunks, limitations } = split(text);
    expect(limitations).toEqual([]);
    expect(chunks.map(chunk => chunk.name)).toEqual(['클래스 AuthController', 'AuthController.cookieOptions 필드',
      'AuthController.constructor', 'AuthController.login', 'AuthController.handler 필드', '8–8행 문장']);
    const code = (index: number) => text.slice(chunks[index].range.startUtf16, chunks[index].range.endUtf16);
    expect(code(0)).toBe("@Controller('auth')\nexport class AuthController extends Base implements Handler ");
    expect(code(1)).toBe('@Inject() cookieOptions = { secure: true }');
    expect(code(2)).toBe('constructor(@Inject(Service) private service: Service) {}');
    expect(code(3)).toBe('@Post()\n  login() { return this.service; }');
    expect(code(5)).toBe('static { register(); }');
    const symbols = analyzeSource(text, 'example.ts', { projectId: randomUUID(), fileId, fileHash: hash }).symbols;
    for (const symbol of symbols) {
      expect(chunks.some(chunk => chunk.functionRange?.startUtf16 === symbol.evidence.startUtf16 &&
        chunk.functionRange.endUtf16 === symbol.evidence.endUtf16)).toBe(true);
    }
  });

  it('keeps module configuration in the class head and DTO decorators with their fields', () => {
    const module = split('@Module({ imports: [AuthModule], providers: [Service] })\nexport class AppModule {}');
    expect(module.chunks).toHaveLength(1);
    expect(module.chunks[0].name).toBe('클래스 AppModule');
    const dto = split('export class LoginDto {\n @IsEmail()\n email!: string;\n @MinLength(8) password?: string;\n}');
    expect(dto.chunks.map(chunk => chunk.name)).toEqual(['클래스 LoginDto', 'LoginDto.email 필드', 'LoginDto.password 필드']);
    expect(dto.chunks[1].range).toMatchObject({ startLine: 2, endLine: 3 });
  });

  it('keeps React callbacks inside the component, linked only to its direct function', () => {
    const text = "import React from 'react';\nexport const App = () => <button onClick={() => alert('hi')}>Hi</button>;\n";
    const { chunks } = split(text, 'App.tsx');
    expect(chunks.map(chunk => chunk.name)).toEqual(['가져오기 (1줄)', 'const App']);
    const functions = analyzeSource(text, 'App.tsx', { projectId: randomUUID(), fileId, fileHash: hash }).symbols;
    expect(functions).toHaveLength(2);
    expect(chunks[1].functionRange).toEqual({ startUtf16: functions[0].evidence.startUtf16, endUtf16: functions[0].evidence.endUtf16 });
    expect(chunks.some(chunk => chunk.functionRange?.startUtf16 === functions[1].evidence.startUtf16)).toBe(false);
  });

  it('groups adjacent imports and reexports, stopping at a statement, comment or blank line', () => {
    const text = "import a from 'a';\nexport { b } from 'b';\nrun();\nimport c from 'c';\n\nimport d from 'd';\n// note\nimport e from 'e';";
    expect(split(text).chunks.map(chunk => chunk.name)).toEqual(['가져오기 (2줄)', '3–3행 문장', '가져오기 (1줄)', '가져오기 (1줄)', '가져오기 (1줄)']);
  });

  it('keeps exported declarations whole, linking only directly held functions', () => {
    const text = `export const config = {}, extra = 1;
export function run() { function inner() {} return () => 1; }
export const f = () => 1;
const a = () => 1, b = () => 2;
export default function () { return 1; }
run();`;
    const chunks = split(text).chunks;
    expect(chunks.map(chunk => chunk.name)).toEqual(['const config 외 1개', 'run', 'const f', 'const a 외 1개', '기본 내보내기 함수 (5행)', '6–6행 문장']);
    expect(chunks.map(chunk => !!chunk.functionRange)).toEqual([false, true, true, false, true, false]);
    expect(text.slice(chunks[1].range.startUtf16, chunks[1].range.endUtf16)).toMatch(/^export function/);
  });

  it('omits broken statements and members but keeps valid class members and reports syntax errors', () => {
    const result = split('const before = 1;\nconst broken = ;\nclass C { good() {} bad = ; next() {} }\nconst after = 2;');
    expect(result.limitations).toContain('구문 오류가 있어 일부 코드는 나누지 않았어요');
    expect(result.chunks.map(chunk => chunk.name)).toEqual(['const before', '클래스 C', 'C.good', 'C.next', 'const after']);
  });

  it('retains the first 80 chunks and counts every omitted chunk', () => {
    const result = split(Array.from({ length: 83 }, (_, i) => `const value${i} = ${i};`).join('\n'));
    expect(result.chunks).toHaveLength(80);
    expect(result.chunks.at(-1)?.name).toBe('const value79');
    expect(new Set(result.chunks.map(chunk => chunk.id)).size).toBe(80);
    expect(result.limitations).toEqual(['덩어리 3개는 설명하지 않았어요']);
  });

  it('names destructured variables by their first bound name and counts the other bindings', () => {
    expect(split('const { key: renamed, nested: [first, ...rest], fallback = 1 } = value, extra = 2;').chunks[0].name)
      .toBe('const renamed 외 4개');
  });

  it('preserves UTF-16 positions with BOM, CRLF, emoji and Korean names', () => {
    const text = '\uFEFF// 📦\r\nexport function 주문() { return "📦"; }\r\n';
    const chunk = split(text).chunks[0];
    expect(chunk.range).toMatchObject({ fileId, fileHash: hash, startUtf16: text.indexOf('export'), endUtf16: text.lastIndexOf('}') + 1, startLine: 2, endLine: 2 });
    expect(chunk.name).toBe('주문');
  });

  it.each(['a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.ts', 'a.tsx', 'a.mts', 'a.cts'])('supports %s', path => {
    expect(split('const value = 1;', path).chunks).toHaveLength(1);
  });
  it('rejects non-code files and makes no chunks from only comments or an empty file', () => {
    expect(() => split('{}', 'a.json')).toThrow('TS/JS');
    expect(split('// comment\n/* note */\n').chunks).toEqual([]);
    expect(split('').chunks).toEqual([]);
  });
});

it('reports the nesting limit before describing any structure', () => {
  const text = `export function run() {}\n${'f('.repeat(5000)}0${')'.repeat(5000)}`;
  expect(() => split(text)).toThrowError(AppError);
  expect(() => split(text)).toThrowError(expect.objectContaining({ code: 'LIMIT', message: NESTED_NOTE }));
});
