import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeFile } from '../src/core/analysis/file-guide';
import { analyzeSource } from '../src/core/analysis/syntax';
import { splitFileChunks } from '../src/core/analysis/file-chunks';

const fileId = randomUUID();
const fileHash = 'a'.repeat(64);
function guide(text: string, path = 'example.ts', paths: string[] = []) {
  return describeFile(text, path, fileId, fileHash, analyzeSource(text, path, { projectId: randomUUID(), fileId, fileHash }), paths.map(relativePath => ({ id: relativePath, relativePath, size: 0 })));
}

describe('file guide roles', () => {
  it.each([
    ['sample.test.ts', '@Controller() class C {}', '시험 파일'],
    ['sample.spec.js', 'check()', '시험 파일'],
    ['__tests__/sample.ts', '', '시험 파일'],
    ['e2e/sample.ts', '', '시험 파일'],
    ['main.ts', 'async function main() { await NestFactory.create(AppModule); }', 'NestJS 서버 시작 파일'],
    ['auth.ts', "@Controller('auth') export class AuthController {}", 'NestJS 컨트롤러'],
    ['auth.ts', '@Module({}) export class AuthModule {}', 'NestJS 모듈'],
    ['socket.ts', '@WebSocketGateway() class Gateway {}', 'NestJS 웹소켓 게이트웨이'],
    ['guard.ts', '@Injectable() class Guard { canActivate() { return true; } }', 'NestJS 가드'],
    ['service.ts', '@Injectable() class Service {}', 'NestJS 서비스'],
    ['dto/signup.ts', 'class Signup {}', '데이터 모양 (DTO)'],
    ['signup.dto.ts', 'class Signup {}', '데이터 모양 (DTO)'],
    ['data.ts', 'class Signup { @IsEmail() email!: string; }', '데이터 모양 (DTO)'],
    ['data.ts', 'class Signup { @Min(1) count!: number; }', '데이터 모양 (DTO)'],
    ['data.ts', 'class Signup { @Max(9) count!: number; }', '데이터 모양 (DTO)'],
    ['data.ts', 'class Signup { @Length(1, 9) name!: string; }', '데이터 모양 (DTO)'],
    ['app.tsx', 'export const App = () => <div>Hello</div>;', 'React 컴포넌트'],
    ['app.jsx', 'function App() { return <div/>; } export { App };', 'React 컴포넌트'],
    ['app.tsx', 'const App = () => <div/>; export default App;', 'React 컴포넌트'],
    ['hooks.ts', 'export const useDogs = () => []; export function useCat() {}', 'React 훅 모음'],
    ['types.ts', 'export interface Dog { name: string };', '타입 정의'],
    ['types.ts', 'export interface Dog { name: string }\nexport type Cat = string;', '타입 정의'],
    ['index.ts', "export { a } from './a'; export * from './b';", '모아 내보내기'],
    ['vite.config.ts', 'export default {}', '설정 파일'],
    ['plain.ts', 'function run() {} class C {}', '일반 코드'],
  ])('%s: %s → %s', (path, text, label) => {
    expect(guide(text, path).role.label).toBe(label);
  });

  it.each([
    ['web/app/(group)/@slot/dogs/[id]/page.tsx', '/dogs/:id'],
    ['web/src/app/[[...x]]/page.tsx', '/:x*'],
    ['web/app/[...x]/page.tsx', '/:x*'],
    ['web/app/page.tsx', '/'],
    ['web/app/dashboard/app/page.tsx', '/dashboard/app'],
  ])('describes Next screen %s', (path, route) => {
    const result = guide('export default () => <div/>', path, ['web/next.config.ts']);
    expect(result.role.label).toBe('Next 화면');
    expect(result.role.about).toContain('`' + route + '`');
    expect(result.role.about).toContain('(next.config의 basePath는 보지 않았어요)');
    expect(result.role.basis.range).toBeNull();
  });

  it.each([
    ['app/layout.tsx', 'Next 공통 틀'], ['app/api/route.ts', 'Next API 라우트'], ['pages/api/dogs.ts', 'Next API 라우트'],
  ])('describes %s as %s', (path, label) => {
    expect(guide('export default function App() {}', path, ['next.config.js']).role.label).toBe(label);
  });

  it('falls back for unconfigured, ambiguous and excluded Next paths', () => {
    for (const [path, paths] of [
      ['app/page.tsx', []], ['app/nested/app/page.tsx', ['next.config.ts', 'app/nested/next.config.ts']],
      ['app/_components/page.tsx', ['next.config.ts']], ['app/(..)photo/page.tsx', ['next.config.ts']],
    ] as [string, string[]][]) expect(guide('export default () => <div/>', path, paths).role.label).toBe('React 컴포넌트');
    expect(guide('export const GET = () => 1', 'app/_internal/route.ts', ['next.config.ts']).role.label).toBe('일반 코드');
  });

  it('uses class decorators and real calls, not comments or strings, and requires guard method on that class', () => {
    const text = `// NestFactory.create(App)
const text = '@Controller()';
@Injectable() class Service {}
class Other { canActivate() {} }`;
    expect(guide(text).role.label).toBe('NestJS 서비스');
    expect(guide('export const value = "useState"').role.label).toBe('일반 코드');
    expect(guide('export function useDogs() {} export function load() {}').role.label).toBe('일반 코드');
    expect(guide('export function App() { const render = () => <div/>; return 1; }', 'app.tsx').role.label).toBe('일반 코드');
  });

  it('reports directives only for the first statement, and keeps exact UTF-16 evidence', () => {
    const text = '\uFEFF// 📦\r\n"use client";\r\n@Controller("auth")\r\nexport class Auth {}';
    const result = guide(text);
    expect(result.notes).toEqual(['브라우저에서 도는 화면 코드예요.']);
    const range = result.role.basis.range!;
    expect(range).toMatchObject({ fileId, fileHash, startLine: 3, endLine: 3 });
    expect(text.slice(range.startUtf16, range.endUtf16)).toBe('@Controller("auth")');
    expect(guide("'use server'; const a = 1;").notes).toEqual(['서버에서 도는 코드예요.']);
    expect(guide("const a = 1; 'use client';").notes).toEqual([]);
    expect(guide('function run() {} class C {}').role.about).toBe('함수 1개·클래스 1개가 있어요.');
  });
});

describe('file guide chunks', () => {
  it('counts imports and reexports separately without changing AI chunk names or ranges', () => {
    const text = "import a from 'a';\nimport b from 'b';\nexport { c } from 'c';\nexport * from 'd';";
    const result = guide(text);
    expect(result.chunks[0].about).toBe('가져오기 2개: `a`, `b` · 다시 내보내기 2개: `c`, `d`');
    expect(result.chunks[0].chunk.name).toBe('가져오기 (4줄)');
    const original = splitFileChunks(text, 'example.ts', fileId, fileHash);
    expect(result.chunks.map(({ chunk: { id, ...chunk } }) => chunk)).toEqual(original.chunks.map(({ id, ...chunk }) => chunk));
    expect(guide("export * from './foo';").chunks[0].about).toBe('다시 내보내기 1개: `./foo`');
    expect(guide("import 'a'; import 'b'; import 'c'; import 'd'; import 'a';").chunks[0].about)
      .toBe('가져오기 5개: `a`, `b`, `c` 외 1곳');
  });

  it('connects function-valued variables and fields to exact symbols and steps', () => {
    const text = 'export const load = (id: string) => fetch(id);\nclass C { handler = (value: number) => { return save(value); }; }';
    const analysis = analyzeSource(text, 'example.ts', { projectId: randomUUID(), fileId, fileHash });
    const result = describeFile(text, 'example.ts', fileId, fileHash, analysis, []);
    for (const name of ['const load', 'C.handler 필드']) {
      const item = result.chunks.find(item => item.chunk.name === name)!;
      const symbol = analysis.symbols.find(symbol => symbol.id === item.symbolId)!;
      expect(symbol).toBeDefined();
      expect(item.about).toContain(`하는 일 단계 ${symbol.steps.length}개`);
      expect(item.about).toContain(name === 'const load' ? '매개변수 (id: string)' : '매개변수 (value: number)');
      expect(item.about).toContain(name === 'const load' ? '`fetch`' : '`save`');
    }
    const withoutSymbols = describeFile(text, 'example.ts', fileId, fileHash, { ...analysis, symbols: [] }, []);
    expect(withoutSymbols.chunks.every(item => item.symbolId === null && !item.about.includes('하는 일 단계'))).toBe(true);
  });

  it('describes controller paths, inheritance, fields and separate controller prefixes', () => {
    const result = guide(`@Controller('auth') export class Auth extends Base implements Handler {
@IsEmail() email!: string;
@Post('login') login(input: Input) { return this.authService.login(input); }
}
@Controller('dogs') class Dogs { @Get() list() { return []; } }`);
    expect(result.chunks[0].about).toContain("@Controller('auth')");
    expect(result.chunks[0].about).toContain('extends Base implements Handler');
    expect(result.chunks[0].about).toContain('주소 앞부분 `/auth`');
    expect(result.chunks[1].about).toBe('필드 email: string · @IsEmail()');
    expect(result.chunks.find(item => item.chunk.name === 'Auth.login')?.about)
      .toContain('요청을 받아요 · 이 파일 기준 경로 `POST /auth/login` (앱 공통 앞 경로는 빼고 봤어요)');
    expect(result.chunks.find(item => item.chunk.name === 'Dogs.list')?.about).toContain('`GET /dogs`');
  });

  it.each(["@Controller(prefix) class C { @Post('login') run() {} }", "@Controller('auth') class C { @Post(path) run() {} }"])
    ('does not invent dynamic decorator paths', text => {
      expect(guide(text).chunks.find(item => item.chunk.functionRange)?.about).toContain('주소를 글자로 적지 않아 확인 못 함');
      expect(guide(text).chunks.find(item => item.chunk.functionRange)?.about).not.toContain('이 파일 기준 경로');
    });

  it.each(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All'])('describes @%s', method => {
    expect(guide(`@Controller('/auth/') class C { @${method}('/login/') run() {} }`).chunks[1].about).toContain(`\`${method.toUpperCase()} /auth/login\``);
  });

  it('limits calls to three, excludes nested functions and describes returned JSX and hooks', () => {
    const result = guide(`export function App() {
useState(0); useQuery(); useMemo(() => nested()); useEffect(() => hidden());
function inner() { ignored(); } res.json(); return <div/>;
}`, 'app.tsx');
    expect(result.chunks[0].about).toContain('부르는 것: `useState`, `useQuery`, `useMemo` 외 2개');
    expect(result.chunks[0].about).not.toMatch(/nested|hidden|ignored/);
    expect(result.chunks[0].about).toContain('쓰는 훅: `useState`, `useQuery`, `useMemo` 외 1개');
    expect(result.chunks[0].about).toContain('화면 조각을 그려요');
    expect(guide('export const App = () => <div/>', 'app.tsx').chunks[0].about).toContain('화면 조각을 그려요');
  });

  it('describes value shapes and clips individual source fragments', () => {
    const result = guide('const object = {}; const list = []; const text = "hello"; const count = 1; const context = createContext(null); let empty;\n' + 'log.' + 'x'.repeat(80) + '();');
    expect(result.chunks.map(item => item.about).slice(0, 6)).toEqual(['값: 객체', '값: 배열', '값: 글자·숫자', '값: 글자·숫자', '값: `createContext(…)` 호출 결과', '값: 초기값 없음']);
    expect(result.chunks.at(-1)?.about).toHaveLength(61);
    expect(result.chunks.at(-1)?.about.endsWith('…')).toBe(true);
  });

  it('lists exported names, aliases, default and reexports, capping at twenty', () => {
    const result = guide(Array.from({ length: 23 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
    expect(result.exports).toHaveLength(20);
    expect(result.exports.at(-1)).toBe('value19');
    expect(result.exportsOmitted).toBe(3);
    expect(guide("const a = 1; export { a as b }; export { c as d } from 'm'; export * as tools from 'm'; export default 1;").exports)
      .toEqual(['b', 'd', 'tools', 'default']);
  });

  it('lists only declared export bindings, leaving property keys and default-value references out', () => {
    expect(guide('export const { key: renamed, nested: [first, ...rest], fallback = defaultValue } = value, extra = 2;').exports)
      .toEqual(['renamed', 'first', 'rest', 'fallback', 'extra']);
  });

  it('keeps valid chunks and both limitations on broken or oversized files', () => {
    const text = 'const broken = ;\n' + Array.from({ length: 83 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const result = guide(text);
    expect(result.chunks).toHaveLength(80);
    expect(result.limitations).toEqual(['구문 오류가 있어 일부 코드는 나누지 않았어요', '덩어리 3개는 설명하지 않았어요']);
    expect(guide('').chunks).toEqual([]);
  });
});

describe('file guide text', () => {
  it('describes an exported const value and keeps multi-line source on one line', () => {
    const result = guide("export const labels = { a: 1 };\nexport class C {\n  run(\n    first: string,\n    second: number,\n  ) {}\n}");
    expect(result.chunks[0].about).toBe('값: 객체');
    expect(result.chunks.find(item => item.chunk.name === 'C.run')!.about).toContain('매개변수 ( first: string, second: number, )');
  });

  it('describes a large file without walking every node per chunk', () => {
    const text = Array.from({ length: 120 }, (_, index) => `export function f${index}(a: number) {\n${
      Array.from({ length: 40 }, (_, line) => `  if (a > ${line}) { console.log([1].map(x => x * ${line})); }`).join('\n')}\n  return a;\n}`).join('\n');
    const started = performance.now();
    guide(text);
    // Was over 3 seconds when each chunk filtered all nodes; generous for slow machines.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('file guide imports', () => {
  it('resolves only a single candidate, keeps the first reference and separates external names', () => {
    const result = guide(`import './one.js';
export * from './one';
import './many';
import './missing';
import '../../outside';
import '/absolute';
function load() { import('./one'); require(name); }
import './a\\u002fb';
import 'react';
export * from 'react';
import '@/utils';`, 'src/example.ts', ['src/one.ts', 'src/many.ts', 'src/many/index.ts']);
    expect(result.imports).toEqual([
      { specifier: './one.js', line: 1, status: 'project', target: { fileId: 'src/one.ts', relativePath: 'src/one.ts' } },
      { specifier: './many', line: 3, status: 'ambiguous', target: null },
      { specifier: './missing', line: 4, status: 'not-found', target: null },
      { specifier: '../../outside', line: 5, status: 'outside', target: null },
      { specifier: '/absolute', line: 6, status: 'outside', target: null },
      { specifier: './one', line: 7, status: 'not-static', target: null },
      { specifier: null, line: 7, status: 'not-static', target: null },
      { specifier: null, line: 8, status: 'unreadable', target: null },
    ]);
    expect(result.external).toEqual(['react', '@/utils']);
  });

  it('preserves syntax errors and gives dynamic imports priority over unreadable paths', () => {
    const result = guide("import { a,, b } from './bad';\nimport('./a\\u002fb');\nrequire('./ok');");
    expect(result.imports.map(item => item.status)).toEqual(['syntax', 'not-static', 'not-static']);
    expect(result.imports.every(item => item.target === null)).toBe(true);
  });

  it('caps import rows at thirty and distinct external paths at eight', () => {
    const result = guide(Array.from({ length: 33 }, (_, i) => `import './missing${i}';`).join('\n')
      + Array.from({ length: 10 }, (_, i) => `import 'package${i}'; import 'package${i}';`).join('\n'));
    expect(result.imports).toHaveLength(30);
    expect(result.importsOmitted).toBe(3);
    expect(result.external).toHaveLength(8);
    expect(result.externalOmitted).toBe(2);
  });
});

describe('file guide function facts', () => {
  it.each([
    'function outer() { function inner() { inside(); } outside(); }',
    'const a = () => 1, b = () => 2;',
    'function a() { function same() { one(); } } function b() { function same() { two(); } }',
  ])('follows analyzer ranges, order and count: %s', text => {
    const analysis = analyzeSource(text, 'example.ts', { projectId: 'p', fileId, fileHash });
    const result = describeFile(text, 'example.ts', fileId, fileHash, analysis, []);
    expect(result.functions.map(item => item.symbolId)).toEqual(analysis.symbols.map(symbol => symbol.id));
    if (text.includes('outer')) expect(result.functions.map(item => item.calls)).toEqual([['outside'], ['inside']]);
    if (text.includes('same')) expect(result.functions.map(item => item.calls)).toEqual([[], ['one'], [], ['two']]);
  });

  it('does not provide facts when either end of the symbol range differs', () => {
    const text = 'function run() { work(); }';
    const analysis = analyzeSource(text, 'example.ts', { projectId: 'p', fileId, fileHash });
    for (const field of ['startUtf16', 'endUtf16'] as const) {
      const changed = { ...analysis, symbols: analysis.symbols.map(symbol => ({ ...symbol,
        evidence: { ...symbol.evidence, [field]: symbol.evidence[field] + 1 } })) };
      expect(describeFile(text, 'example.ts', fileId, fileHash, changed, []).functions).toEqual([]);
    }
  });

  it('describes Nest shapes without requiring imports and keeps the prefix hint', () => {
    const result = guide("@Controller('auth') class Auth { @Post('login') login(@Body() input: Input) { return this.auth.login(input); } }");
    expect(result.functions[0]).toMatchObject({ tags: ['서버 받는 곳 모양 · POST /auth/login'],
      routeNote: '앱 공통 앞 경로는 빼고 봤어요', calls: ['this.auth.login'] });
  });

  it.each([
    "@Controller(prefix) class C { @Post('login') run() {} }",
    "@Controller('auth') class C { @Post(path) run() {} }",
    String.raw`@Controller('a\u0075th') class C { @Post('login') run() {} }`,
    String.raw`@Controller('auth') class C { @Post('l\u006fgin') run() {} }`,
  ])('does not report a literal route for %s', text => {
    const result = guide(text);
    expect(result.functions[0].tags).toEqual(['서버 받는 곳 모양 · 주소 확인 못 함']);
    expect(result.chunks.find(item => item.chunk.functionRange)!.about).toContain('주소를 글자로 적지 않아 확인 못 함');
    expect(result.chunks.map(item => item.about).join('\n')).not.toMatch(/\/a\\u0075th|\/auth\/l\\u006fgin/);
    if (text.includes('a\\u0075th')) expect(result.chunks[0].about).toContain('주소를 글자로 적지 않아 확인 못 함');
  });

  it.each([
    ['app/api/x/route.ts', 'export async function GET() {}', [['서버 받는 곳 모양 · Next · GET']]],
    ['app/x/route.ts', 'export default function GET() {}', [[]]],
    ['app/x/route.ts', 'const handler = () => 1; export { handler as POST };', [['서버 받는 곳 모양 · Next · POST']]],
    ['pages/api/x.ts', 'export default function handler() {} export function GET() {}', [['서버 받는 곳 모양 · Next · 모든 방식'], []]],
    ['pages/api/x.ts', 'const handler = () => 1; export { handler as default };', [['서버 받는 곳 모양 · Next · 모든 방식']]],
  ])('distinguishes Next exports in %s: %s', (path, text, tags) => {
    expect(guide(text, path, ['next.config.ts']).functions.map(item => item.tags)).toEqual(tags);
  });

  it('labels JSX return expressions, hook names and calls only by shape', () => {
    const result = guide(`function App() { return <div/>; }
function check() { return !!<div/>; }
function useThing() { this.useCache(); }
function plain() { return 1; }`, 'example.tsx');
    expect(result.functions.map(item => item.tags)).toEqual([
      ['JSX(화면 조각)가 든 코드를 돌려줘요'], ['JSX(화면 조각)가 든 코드를 돌려줘요'], ['훅 이름'], [],
    ]);
    expect(result.functions[2].hooks).toEqual(['this.useCache']);
  });

  it('uses declared hook names rather than generated callback labels', () => {
    const result = guide('class C { useCache() {} } const useThing = () => 1; useMemo(() => 2);');
    expect(result.functions.map(item => item.tags)).toEqual([['훅 이름'], ['훅 이름'], []]);
  });

  it('limits calls and distinct hook names and excludes nested function bodies', () => {
    const result = guide('function run() { useA(); useB(); useC(() => nested()); useD(); useD(); function inner() { hidden(); } }');
    expect(result.functions[0]).toMatchObject({ calls: ['useA', 'useB', 'useC'], callsOmitted: 2,
      hooks: ['useA', 'useB', 'useC'], hooksOmitted: 1, tags: [], routeNote: null });
  });
});

describe('file guide stops and stores', () => {
  it('keeps nested functions and same-name functions separate, including front-end errors', () => {
    const result = guide(`function outer() {
  if (!user) throw new Error('이메일이 없어요');
  prisma.user.findUnique({});
  function same() { throw new Error('inner'); prisma.dog.delete({}); }
}
function other() { function same() { throw new Error('other'); prisma.cat.count({}); } }`, 'front.ts');
    expect(result.functions.map(fn => fn.stops.map(stop => stop.message))).toEqual([['이메일이 없어요'], ['inner'], [], ['other']]);
    expect(result.functions.map(fn => fn.stores.map(store => [store.model, store.action]))).toEqual([
      [['user', 'read']], [['dog', 'delete']], [], [['cat', 'count']],
    ]);
    expect(result.functions[0].stops[0]).toMatchObject({ condition: '!user', site: { fileId, fileHash, startLine: 2 } });
  });
  it('uses nodes from the facts tree for transaction callbacks, following serverFacts ownership', () => {
    const result = guide(`async function save() {
  return prisma.$transaction(async tx => {
    if (!user) throw new Error('missing');
    return tx.user.create({});
  });
}`);
    expect(result.functions.map(fn => fn.stops.map(stop => stop.message))).toEqual([['missing'], ['missing']]);
    expect(result.functions.map(fn => fn.stores.map(store => [store.model, store.action]))).toEqual([[['user', 'create']], [['user', 'create']]]);
  });
  it('keeps existing stop and store limits and omitted counts', () => {
    const result = guide(`function run() { ${Array.from({ length: 9 }, (_, i) => `if (n === ${i}) throw new Error('${i}'); prisma.user.count({});`).join('\n')} }`);
    expect(result.functions[0].stops).toHaveLength(6);
    expect(result.functions[0].stopsOmitted).toBe(3);
    expect(result.functions[0].stores).toHaveLength(8);
    expect(result.functions[0].storesOmitted).toBe(1);
  });
});
