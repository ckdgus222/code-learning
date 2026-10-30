import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { FunctionCalls, ProjectFiles } from '../src/shared/contracts';

// Plan v2.3 F test project. Each case sits on its own line, so expected lists name it by a piece of its text.
const files: Record<string, string> = {
  'src/main.ts': `import { save, load as fetchIt } from './store';
import makeId from './id';
import { format } from './format-a';
import { pick } from 'lodash';
import { util } from '@/utils';
import * as store from './store';
import type { Shape } from './store';
import { again } from './again';
import { renamed as viaList } from './listed';
import { relay } from './barrel';
import { over } from './overload';

export function run(order: string, cb: () => void) {
  helper(order);
  arrow();
  save(order);
  fetchIt();
  makeId();
  format();
  pick();
  util();
  store.save(order);
  cb();
  replaced();
  again();
  viaList();
  relay();
  undeclaredThing();
  Shape();
  over(1);
  items.map(x => helper(x));
  (0, helper)();
}

function helper(x: string) { return x; }
const arrow = () => helper('a');
function replaced() {}
replaced = () => {};

function shadowLocal() {
  const helper = makeHelper();
  helper();
}

run('a', () => {});
`,
  'src/store.ts': 'export function save(order: string) { return order; }\nexport function load() { return 1; }\nexport type Shape = { a: number };\n',
  'src/id.ts': 'export default function makeId() { return 1; }\n',
  'src/format-a.ts': "export function format() { return 'a'; }\n",
  'src/format-b.ts': "export function format() { return 'b'; }\n",
  'src/listed.ts': 'function inner() { return 1; }\nfunction listed() { return inner(); }\nexport { listed, inner as renamed };\n',
  'src/again.ts': 'export function again() {}\nagain = () => {};\n',
  'src/barrel.ts': "export { relay } from './relay';\n",
  'src/relay.ts': 'export function relay() {}\n',
  'src/overload.ts': 'export function over(a: string): string;\nexport function over(a: number): number;\nexport function over(a: any) { return a; }\n',
  'src/persist.ts': 'export function persist() {}\npersist = () => {};\n',
  'src/keeper.ts': "import { persist as keep } from './persist';\nexport function useKeep() { keep(); }\n",
  'src/scopes.ts': `function target() {}
function arguments() {}
export function outer(target: () => void) {
  function inner() { target(); }
  return inner;
}
export function shadowed() {
  const target = makeTarget();
  target();
}
export function withDefault(cb = () => target()) { function target() {} return cb; }
export function viaArguments() { arguments(); }
export function defaultArguments(cb = () => arguments()) { return cb; }
export const arrowArguments = () => arguments();
export function f(f: () => void) { f(); }
export const named = function self() { self(); };
const holder = { save: function inner2() { inner2(); } };
holder.save();
const C = class target { m() { target(); } };
const D = class target extends target() {};
`,
  'src/odd.js': `var legacy = function () {};
function useLegacy() { legacy(); }
function f() { return 1; }
function blocky(flag) {
  if (flag) { function f() { return 2; } f(); }
  return f();
}
function twice() {}
function twice() {}
function useTwice() { twice(); }
function g() {}
if (globalThis.x) { function g() {} }
function useG() { g(); }
function h() { return 1; }
function useIf(x) {
  if (x) function h() { return 2; }
  return h();
}
`,
  'src/legacy-eval.js': "function a() {}\nfunction b() { a(); eval('1'); }\n",
  'src/space.ts': 'function save() {}\nnamespace N { export const save = () => 1; }\nnamespace N { export function go() { save(); } }\n',
  'src/broken-missing.ts': 'function a() {}\nfunction b() { a(); }\nconst x = (1;\n',
  // An ERROR node of its own after the functions (no MISSING node).
  'src/broken-error.ts': 'function a() {}\nfunction b() { a(); }\n@@@;\n',
  'src/anon.ts': 'export default () => 1;\n',
  'src/use-anon.ts': "import anon from './anon';\nexport function useAnon() { anon(); }\n",
  'src/chained.ts': 'function chained() { a().b().c(); }\n',
  'src/classy.ts': `function key() { return 'k'; }
function target() {}
export function build(key2: string) {
  const made = { [key()](key: string) { return key; } };
  class C { static { var target = 1; } }
  target();
  return made;
}
`,
  'src/asserted.ts': `let f = () => 1;
(f as any) = () => 2;
export const g = () => 1;
g! = () => 2;
let h = () => 1;
(<any>h) = () => 2;
let k = () => 1;
[k!] = [() => 2];
let m = () => 1;
({ x: m! } = { x: () => 2 });
export function run() { f(); g(); h(); k(); m(); }
`,
  'src/type-export.ts': 'function f() {}\nfunction g() {}\nexport type { f };\nexport { type g };\n',
  'src/use-type-export.ts': "import { f, g } from './type-export';\nexport function useBoth() { f(); g(); }\n",
  'src/use-asserted.ts': "import { g } from './asserted';\nexport function useG() { g(); }\n",
  'src/eval-paren.ts': "function target() { return 1; }\nexport function run() { (eval)('var target = () => 2'); return target(); }\n",
  'src/use-eval-paren.ts': "import { run } from './eval-paren';\nexport function go() { run(); }\n",
  'src/quoted.ts': "export const obj = { \"stash\"() { return 1; } };\nclass K { 'stash'() {} }\nexport function use() { obj.stash(); obj['stash'](); }\n",
  'src/decorated.ts': `function dec() { return () => {}; }
function make() { return 1; }
export function build() {
  @dec() class dec2 { @dec() method(@dec() dec: string) { return dec; } field = make(); [make()] = 2; static { make(); } }
  return dec2;
}
`,
  'src/twice-export.ts': 'export function f() { return 1; }\nfunction f() { return 2; }\n',
  'src/use-twice-export.ts': "import { f } from './twice-export';\nexport function useF() { f(); }\n",
  'src/import-reassigned.ts': "import { save } from './store';\nsave = () => 'other';\nexport function useSave() { save('x'); }\n",
  'src/commented.ts': "let f = () => 1;\n(/* note */ f) = () => 2;\nexport const g = () => 1;\n(/* note */ g) = () => 2;\nexport function run() { f(); }\n",
  'src/commented-eval.ts': "function h() {}\nexport function run() { (/* note */ eval)('1'); h(); }\n",
  'src/use-commented.ts': "import { g } from './commented';\nexport function useG() { g(); }\n",
  'src/escaped.ts': "function f() {}\nexport function run() { const \\u0066 = () => 2; f(); }\n",
  'src/enum-inside.ts': 'function f() { return 1; }\nexport function run() {\n  enum E { f = 1, value = f() }\n  return E;\n}\n',
  'src/script-global.js': "function f() { return 1; }\nwindow.f = function () { return 2; };\nfunction run() { f(); }\n",
  'src/member-eval.js': "function f() { return 1; }\nfunction run() { globalThis.eval('var f = 2'); f(); }\n",
  'src/global-destructure.js': "function f() {}\n[globalThis.f] = [() => 2];\nfunction run() { f(); }\n",
  'src/global-for.js': "function f() {}\nfor (self.f of []) {}\nfunction run() { f(); }\n",
  'src/global-update.js': "function f() {}\nglobal['f']++;\nfunction run() { f(); }\n",
  'src/escaped-class.ts': "function f() {}\nexport function run() { class \\u0066 {} f(); }\nconst C = class \\u0066 { m() { f(); } };\n",
  'src/escaped-param.ts': "function f() {}\nexport function run({ \\u0066 }: { f: () => void }) { f(); }\n",
  'src/escaped-local.ts': "function f() {}\nexport function run(o: { f: () => void }) { const { \\u0066 } = o; f(); }\n",
  'src/escaped-assign.ts': "let f = () => 1;\n({ \\u0066 } = { f: () => 2 });\nexport function run() { f(); }\n",
  'src/global-escaped-key.js': "function f() { return 1; }\nglobalThis['\\u0066'] = () => 2;\nfunction run() { return f(); }\n",
  'src/global-variable-key.js': "function f() { return 1; }\nconst key = 'f';\nwindow[key] = () => 2;\nfunction run() { return f(); }\n",
  'src/indirect-eval.js': "function f() { return 1; }\n(0, eval)('f = () => 2');\nfunction run() { return f(); }\n",
  'src/function-ctor.js': "function f() { return 1; }\nFunction('f = () => 2')();\nfunction run() { return f(); }\n",
  'src/self-import.ts': "import { f as other } from './self-import';\nexport function f() { return 1; }\nexport function run() { other(); }\n",
  'src/escaped-import-alias.ts': "import { save as \\u0067 } from './store';\nexport function runAlias() { g(); }\n",
  'src/escaped-import-name.ts': "import { \\u0073ave as g } from './store';\nexport function runName() { g(); }\n",
  'src/unicode-text.ts': "export function keep() { return \"\\uC800\" + /\\u0041/.source; }\nexport function runKeep() { keep(); }\n",
  'src/use-unicode-text.ts': "import { keep } from './unicode-text';\nexport function useKeep() { keep(); }\n",
  'src/shorthand-eval.js': "function f() { return 1; }\nconst runners = { eval };\nrunners['eval']('f = () => 2');\nfunction run() { return f(); }\n",
  'src/shorthand-function.js': "function f() { return 1; }\nconst makers = { Function };\nfunction run() { return f(); }\n",
  'src/function-type.ts': "function f() { return 1; }\nlet callback: Function;\nexport function run() { return f(); }\n",
  'src/import-alias.ts': "function f() {}\nimport f = N.f;\nexport function run() { f(); }\n",
  'src/import-require-escaped.ts': "function f() {}\nimport \\u0066 = require('pkg');\nexport function run() { f(); }\n",
  'src/late.ts': `function a() {}\nexport function b() { a(); }\n${'step();\n'.repeat(100)}a = () => {};\n`,
};

let root: string;
let project: ProjectFiles;
beforeEach(async () => {
  root = await mkdtemp('/private/tmp/learning-calls-test-');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  project = await scanProject(root, randomUUID());
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const idOf = (relative: string) => project.files.find(file => file.relativePath === relative)!.id;
const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
const lineOf = (relative: string, piece: string) => {
  const text = files[relative];
  expect(text.indexOf(piece), piece).toBeGreaterThanOrEqual(0);
  return text.slice(0, text.indexOf(piece)).split('\n').length;
};
async function callsOf(relative: string, name: string, limits = MAP_LIMITS, shouldStop?: () => boolean): Promise<FunctionCalls> {
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: idOf(relative), fileHash: hash }).symbols.find(item => item.name === name)!;
  return findFunctionCalls(root, project.id, project.files, { fileId: idOf(relative), fileHash: hash,
    startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, limits, shouldStop);
}
// Results by line and what they lead to, which the expected lists use.
const outcomes = (result: FunctionCalls) => result.calls.map(call => [call.startLine,
  call.status === 'typed' ? `타입 → ${pathOf(call.target.fileId)} ${call.target.name}`
    : call.status === 'linked' ? `→ ${pathOf(call.target.fileId)} ${call.target.name}`
    : call.status === 'external' ? `외부 ${call.specifier}` : `확인 못 함 ${call.reason}${call.detail ? ` ${call.detail}` : ''}`]);
const callers = (result: FunctionCalls) => result.callers?.map(item => [pathOf(item.fileId), item.startLine, item.inFunction?.name ?? null]) ?? null;
const maybe = (result: FunctionCalls) => result.maybeCallers.map(item => [pathOf(item.fileId), item.startLine, item.reason]);

describe('what a function calls (plan v2.3 F)', () => {
  it('keeps all chained calls with the same start and distinct ends', async () => {
    const { calls } = await callsOf('src/chained.ts', 'chained');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.startUtf16)).size).toBe(1);
    expect(new Set(calls.map(call => call.endUtf16)).size).toBe(3);
    expect(calls.map(call => files['src/chained.ts'].slice(call.startUtf16, call.endUtf16)).sort())
      .toEqual(['a()', 'a().b()', 'a().b().c()']);
  });

  it('settles each call by its nearest declaration and says why the rest are not settled', async () => {
    const main = 'src/main.ts';
    const at = (piece: string) => lineOf(main, piece);
    expect(outcomes(await callsOf(main, 'run'))).toEqual([
      [at('  helper(order);'), '→ src/main.ts helper'],
      [at('  arrow();'), '→ src/main.ts arrow'],
      [at('  save(order);'), '→ src/store.ts save'],
      [at('  fetchIt();'), '→ src/store.ts load'],
      [at('  makeId();'), '→ src/id.ts makeId'],
      [at('  format();'), '→ src/format-a.ts format'],
      [at('  pick();'), '외부 lodash'],
      [at('  util();'), '외부 @/utils'],
      [at('  store.save(order);'), '확인 못 함 member'],
      [at('  cb();'), '확인 못 함 not-function'],
      [at('  replaced();'), '확인 못 함 reassigned'],
      [at('  again();'), '확인 못 함 export 내보낸 쪽에서 다시 대입돼요.'],
      [at('  viaList();'), '→ src/listed.ts inner'],
      [at('  relay();'), '확인 못 함 export 다른 파일에서 다시 내보낸 이름은 따라가지 않아요.'],
      [at('  undeclaredThing();'), '확인 못 함 undeclared'],
      // A type-only import brings no value, so the name is not declared.
      [at('  Shape();'), '확인 못 함 undeclared'],
      // Overload headers are not separate declarations or exports.
      [at('  over(1);'), '→ src/overload.ts over'],
      // helper(x) inside the arrow belongs to the arrow.
      [at('  items.map('), '확인 못 함 member'],
      [at('  (0, helper)();'), '확인 못 함 expression'],
    ]);
  });

  it('follows scopes: parameters, locals, default values, arguments, own names and classes', async () => {
    const scopes = 'src/scopes.ts';
    const only = async (name: string) => outcomes(await callsOf(scopes, name));
    expect(await only('inner')).toEqual([[4, '확인 못 함 not-function']]);
    expect(await only('shadowed')).toEqual([[8, '확인 못 함 undeclared'], [9, '확인 못 함 not-function']]);
    // A default value cannot see the body's declarations, so it reaches the file's target.
    expect(await only('withDefault')).toEqual([]);
    expect(await only('이름 없는 함수 (11행)')).toEqual([[11, '→ src/scopes.ts target']]);
    expect(await only('viaArguments')).toEqual([[12, '확인 못 함 not-function']]);
    expect(await only('이름 없는 함수 (13행)')).toEqual([[13, '확인 못 함 not-function']]);
    // An arrow function has no arguments of its own.
    expect(await only('arrowArguments')).toEqual([[14, '→ src/scopes.ts arguments']]);
    expect(await only('f')).toEqual([[15, '확인 못 함 not-function']]);
    expect(await only('self')).toEqual([[16, '→ src/scopes.ts self']]);
    expect(await only('inner2')).toEqual([[17, '→ src/scopes.ts inner2']]);
    expect(await only('target.m')).toEqual([[19, '확인 못 함 not-function']]);
  });

  it('does not settle var, block functions, names declared twice, with or eval, namespaces, or files not seen to the end', async () => {
    const only = async (file: string, name: string) => outcomes(await callsOf(file, name));
    expect(await only('src/odd.js', 'useLegacy')).toEqual([[2, '확인 못 함 var']]);
    // Outside strict mode the block's f also reaches the rest of blocky.
    expect(await only('src/odd.js', 'blocky')).toEqual([[5, '확인 못 함 block-function'], [6, '확인 못 함 block-function']]);
    expect(await only('src/odd.js', 'useTwice')).toEqual([[10, '확인 못 함 duplicate']]);
    expect(await only('src/odd.js', 'useG')).toEqual([[13, '확인 못 함 duplicate']]);
    // Without braces the declaration is just as conditional as one in a block.
    expect(await only('src/odd.js', 'useIf')).toEqual([[17, '확인 못 함 block-function']]);
    expect(await only('src/legacy-eval.js', 'b')).toEqual([[2, '확인 못 함 unclear-file'], [2, '확인 못 함 unclear-file']]);
    expect(await only('src/space.ts', 'go')).toEqual([[3, '확인 못 함 namespace']]);
    expect(await only('src/broken-missing.ts', 'b')).toEqual([[2, '확인 못 함 incomplete']]);
    expect(await only('src/broken-error.ts', 'b')).toEqual([[2, '확인 못 함 incomplete']]);
    // The reassignment sits after the node limit, so the call is not settled; read to the end it is reassigned.
    expect(await only('src/late.ts', 'b')).toEqual([[2, '확인 못 함 reassigned']]);
    expect(outcomes(await callsOf('src/late.ts', 'b', { ...MAP_LIMITS, nodesPerFile: 60 }))).toEqual([[2, '확인 못 함 incomplete']]);
  });
});

describe('reassignments written with TypeScript marks', () => {
  it('sees through as, ! and <T> on the left of an assignment, in its file and through an import', async () => {
    expect(outcomes(await callsOf('src/asserted.ts', 'run'))).toEqual(Array.from({ length: 5 }, () => [11, '확인 못 함 reassigned']));
    expect(outcomes(await callsOf('src/use-asserted.ts', 'useG'))).toEqual([[2, '확인 못 함 export 내보낸 쪽에서 다시 대입돼요.']]);
  });
});

describe('eval in brackets and quoted property names', () => {
  it('takes (eval)(…) as eval, in its file and through an import', async () => {
    expect(outcomes(await callsOf('src/eval-paren.ts', 'run'))).toEqual([[2, '확인 못 함 expression'], [2, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/use-eval-paren.ts', 'go'))).toEqual([[2, '확인 못 함 export 가져온 파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어요.']]);
  });

  it('matches a method named by a string with its member calls, written with a dot or brackets', async () => {
    expect(outcomes(await callsOf('src/quoted.ts', 'use'))).toEqual([[3, '확인 못 함 member'], [3, '확인 못 함 member']]);
    for (const name of ['"stash"', "K.'stash'"]) {
      const method = await callsOf('src/quoted.ts', name);
      expect([method.names.property, maybe(method)]).toEqual([['stash'], [['src/quoted.ts', 3, 'member'], ['src/quoted.ts', 3, 'member']]]);
    }
  });
});

describe('imports written to and exports declared twice', () => {
  it('does not settle an imported name written to, nor an export whose name is declared twice', async () => {
    expect(outcomes(await callsOf('src/import-reassigned.ts', 'useSave'))).toEqual([[3, '확인 못 함 reassigned']]);
    expect(outcomes(await callsOf('src/use-twice-export.ts', 'useF'))).toEqual([[2, '확인 못 함 export 내보낸 쪽에 같은 이름의 선언이 여럿이에요.']]);
  });
});

describe('comments inside brackets', () => {
  it('still sees the name written to, and eval, behind a comment', async () => {
    expect(outcomes(await callsOf('src/commented.ts', 'run'))).toEqual([[5, '확인 못 함 reassigned']]);
    expect(outcomes(await callsOf('src/use-commented.ts', 'useG'))).toEqual([[2, '확인 못 함 export 내보낸 쪽에서 다시 대입돼요.']]);
    expect(outcomes(await callsOf('src/commented-eval.ts', 'run'))).toEqual([[2, '확인 못 함 expression'], [2, '확인 못 함 unclear-file']]);
  });
});

describe('escaped names and enums', () => {
  it('takes any mention of eval or Function as code that can change names', async () => {
    expect(outcomes(await callsOf('src/indirect-eval.js', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/function-ctor.js', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
  });

  it('also sees eval and Function written as shorthand properties, but not Function as a type', async () => {
    expect(outcomes(await callsOf('src/shorthand-eval.js', 'run'))).toEqual([[4, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/shorthand-function.js', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/function-type.ts', 'run'))).toEqual([[3, '→ src/function-type.ts f']]);
  });

  it('counts TS import = as a declaration, and looks for escapes in its name', async () => {
    expect(outcomes(await callsOf('src/import-alias.ts', 'run'))).toEqual([[3, '확인 못 함 duplicate']]);
    expect(outcomes(await callsOf('src/import-require-escaped.ts', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
  });

  it('finds a caller in the function\'s own file that imports it under another name', async () => {
    expect(outcomes(await callsOf('src/self-import.ts', 'run'))).toEqual([[3, '→ src/self-import.ts f']]);
    expect(callers(await callsOf('src/self-import.ts', 'f'))).toEqual([['src/self-import.ts', 3, 'run']]);
  });

  it('counts window.f = … as writing to f, and any eval call as eval', async () => {
    expect(outcomes(await callsOf('src/script-global.js', 'run'))).toEqual([[3, '확인 못 함 reassigned']]);
    for (const file of ['src/global-destructure.js', 'src/global-for.js', 'src/global-update.js']) {
      expect(outcomes(await callsOf(file, 'run')), file).toEqual([[3, '확인 못 함 reassigned']]);
    }
    // A key that cannot be read as it is written may be any name.
    expect(outcomes(await callsOf('src/global-escaped-key.js', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/global-variable-key.js', 'run'))).toEqual([[4, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/member-eval.js', 'run'))).toEqual([[2, '확인 못 함 unclear-file'], [2, '확인 못 함 unclear-file']]);
  });

  it('does not settle a file with escaped names, nor a call inside an enum', async () => {
    expect(outcomes(await callsOf('src/escaped.ts', 'run'))).toEqual([[2, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/escaped-class.ts', 'run'))).toEqual([[2, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/escaped-class.ts', '\\u0066.m'))).toEqual([[3, '확인 못 함 unclear-file']]);
    // Escaped names in destructuring: a parameter, a local and an assignment.
    for (const file of ['src/escaped-param.ts', 'src/escaped-local.ts']) expect(outcomes(await callsOf(file, 'run')), file).toEqual([[2, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/escaped-assign.ts', 'run'))).toEqual([[3, '확인 못 함 unclear-file']]);
    expect(outcomes(await callsOf('src/enum-inside.ts', 'run'))).toEqual([[3, '확인 못 함 namespace']]);
  });
});

describe('type-only exports', () => {
  it('does not take export type { f } or export { type g } as functions to call', async () => {
    expect(outcomes(await callsOf('src/use-type-export.ts', 'useBoth'))).toEqual([
      [2, '확인 못 함 export 그 이름으로 내보낸 것이 없어요.'], [2, '확인 못 함 export 그 이름으로 내보낸 것이 없어요.']]);
  });
});

describe('computed method names and static blocks', () => {
  it('works out decorators and computed keys where the class sits, and leaves the class body to no function', async () => {
    // Class, method and parameter decorators and the computed key run when build defines the class;
    // the field value and the static block do not run as part of build.
    expect(outcomes(await callsOf('src/decorated.ts', 'build'))).toEqual([
      [4, '→ src/decorated.ts dec'], [4, '→ src/decorated.ts dec'], [4, '→ src/decorated.ts dec'], [4, '→ src/decorated.ts make']]);
    expect(outcomes(await callsOf('src/decorated.ts', 'dec2.method'))).toEqual([]);
    expect(callers(await callsOf('src/decorated.ts', 'dec'))).toEqual([1, 2, 3].map(() => ['src/decorated.ts', 4, 'build']));
    expect(callers(await callsOf('src/decorated.ts', 'make'))).toEqual([['src/decorated.ts', 4, null], ['src/decorated.ts', 4, 'build'], ['src/decorated.ts', 4, null]]);
  });

  it('works out a computed method name where the method sits, and keeps a static block\'s var inside it', async () => {
    // key() in the computed name is build's call, and the method's parameter named key does not hide it.
    expect(outcomes(await callsOf('src/classy.ts', 'build'))).toEqual([[4, '→ src/classy.ts key'], [6, '→ src/classy.ts target']]);
    expect(callers(await callsOf('src/classy.ts', 'key'))).toEqual([['src/classy.ts', 4, 'build']]);
    expect(callers(await callsOf('src/classy.ts', 'target'))).toEqual([['src/classy.ts', 6, 'build']]);
  });
});

describe('where a function is called from (plan v2.3 F)', () => {
  const main = 'src/main.ts';
  it('finds calls by its name in its file and through imports elsewhere, and lists the ones it could not settle', async () => {
    const save = await callsOf('src/store.ts', 'save');
    expect(save.names).toEqual({ local: ['save'], exported: ['save'], property: [] });
    expect(callers(save)).toEqual([[main, lineOf(main, '  save(order);'), 'run']]);
    // Imported and then written to in import-reassigned.ts: not settled, so listed here.
    // Files that may name save with escapes are reported as not examined to the end.
    expect(save.unexamined.filter(file => file.relativePath.startsWith('src/escaped-import')).map(file => file.relativePath))
      .toEqual(['src/escaped-import-alias.ts', 'src/escaped-import-name.ts']);
    expect(outcomes(await callsOf('src/escaped-import-alias.ts', 'runAlias'))).toEqual([[2, '확인 못 함 unclear-file']]);
    // Escapes in strings and regular expressions are not names.
    expect(outcomes(await callsOf('src/unicode-text.ts', 'runKeep'))).toEqual([[2, '→ src/unicode-text.ts keep']]);
    expect(outcomes(await callsOf('src/use-unicode-text.ts', 'useKeep'))).toEqual([[2, '→ src/unicode-text.ts keep']]);
    expect(maybe(save)).toEqual([['src/import-reassigned.ts', 3, 'reassigned'], [main, lineOf(main, '  store.save(order);'), 'member'],
      ['src/scopes.ts', 18, 'member']]);
    const helper = await callsOf(main, 'helper');
    expect(callers(helper)).toEqual([[main, lineOf(main, '  helper(order);'), 'run'],
      [main, lineOf(main, '  items.map('), `map에 넘긴 함수 (${lineOf(main, '  items.map(')}행)`], [main, lineOf(main, 'const arrow'), 'arrow']]);
    expect(maybe(helper)).toEqual([[main, lineOf(main, '  helper();'), 'not-function']]);
    expect(callers(await callsOf(main, 'run'))).toEqual([[main, lineOf(main, "run('a'"), null]]);
  });

  it('keeps the two functions of one name apart, and follows renamed and default imports', async () => {
    const other = await callsOf('src/format-b.ts', 'format');
    expect([callers(other), maybe(other)]).toEqual([[], []]);
    expect(callers(await callsOf('src/id.ts', 'makeId'))).toEqual([[main, lineOf(main, '  makeId();'), 'run']]);
    // A default export without a name is still found by its imports.
    const anon = await callsOf('src/anon.ts', '기본 내보내기 함수 (1행)');
    expect([anon.names, callers(anon)]).toEqual([{ local: [], exported: ['default'], property: [] }, [['src/use-anon.ts', 2, 'useAnon']]]);
    // Renamed on import and reassigned where it is exported: listed as not settled.
    const persist = await callsOf('src/persist.ts', 'persist');
    expect([callers(persist), maybe(persist)]).toEqual([[], [['src/keeper.ts', 2, 'export']]]);
  });

  it('uses a property name only for member calls, and the file name of a named function expression', async () => {
    const inner2 = await callsOf('src/scopes.ts', 'inner2');
    expect(inner2.names).toEqual({ local: ['inner2'], exported: [], property: ['save'] });
    expect(callers(inner2)).toEqual([['src/scopes.ts', 17, 'inner2']]);
    // save(order) in main.ts reaches store.ts, so it is not listed here.
    expect(maybe(inner2)).toEqual([[main, lineOf(main, '  store.save(order);'), 'member'], ['src/scopes.ts', 18, 'member']]);
    const target = await callsOf('src/scopes.ts', 'target');
    expect(callers(target)).toEqual([['src/scopes.ts', 11, '이름 없는 함수 (11행)']]);
    expect(maybe(target)).toEqual([4, 9, 19, 20].map(line => ['src/scopes.ts', line, 'not-function']));
  });

  it('does not search for a function called by no name', async () => {
    const callback = await callsOf(main, `map에 넘긴 함수 (${lineOf(main, '  items.map(')}행)`);
    expect([callback.callers, callback.names]).toEqual([null, { local: [], exported: [], property: [] }]);
  });
});

describe('limits and safety of the call search', () => {
  it('reports what it could not read within its limits, and stops between files when asked', async () => {
    const tight = await callsOf('src/store.ts', 'save', { ...MAP_LIMITS, files: 2 });
    expect(tight.limited).toBe(true);
    expect(tight.notes).toEqual(['부르는 곳은 파일 2개·합계 16 MiB까지만 찾아요. 나머지 파일은 보지 않았어요.']);
    expect(tight.unexamined.some(item => item.reason === '찾기 한도에 닿아 이 파일은 읽지 않았어요.')).toBe(true);
    let asked = 0;
    await expect(callsOf('src/store.ts', 'save', MAP_LIMITS, () => ++asked > 3)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a function that is no longer where it was chosen, and changes nothing', async () => {
    const { hash } = await readAllowed(root, 'src/store.ts');
    const before = await Promise.all(Object.keys(files).map(name => readFile(path.join(root, name), 'utf8')));
    const request = { fileId: idOf('src/store.ts'), fileHash: hash, startUtf16: 0, endUtf16: 5 };
    await expect(findFunctionCalls(root, project.id, project.files, request, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, { ...request, fileHash: 'a'.repeat(64) }, MAP_LIMITS))
      .rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, { ...request, fileId: randomUUID() }, MAP_LIMITS))
      .rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await callsOf('src/main.ts', 'run');
    expect(await Promise.all(Object.keys(files).map(name => readFile(path.join(root, name), 'utf8')))).toEqual(before);
  });
});

describe('class calls found from written types', () => {
  it.each(['@Inject(AuthService) private readonly', 'private', 'public', 'protected', 'readonly'])('follows %s constructor properties through .js imports without confirming incoming values', async modifier => {
    await writeFile(path.join(root, 'service.ts'), 'export class AuthService { signup(input: string) { return this.issueTokens(); } issueTokens() { return 1; } }');
    await writeFile(path.join(root, 'controller.ts'), `import { AuthService } from './service.js';
export class AuthController { constructor(${modifier} auth: AuthService) {} login(input: string) { return this.auth.signup(input); } }`);
    project = await scanProject(root, project.id);
    const outgoing = await callsOf('controller.ts', 'AuthController.login');
    expect(outgoing.calls).toHaveLength(1);
    expect(outgoing.calls[0]).toMatchObject({ status: 'typed', target: { name: 'AuthService.signup', fileId: idOf('service.ts') }, basis: 'this.auth에 적힌 타입 AuthService로 찾았어요' });
    const incoming = await callsOf('service.ts', 'AuthService.signup');
    expect(incoming.typedCallers).toHaveLength(1);
    expect(incoming.typedCallers[0]).toMatchObject({ fileId: idOf('controller.ts'), text: 'this.auth.signup(input)', args: [{ text: 'input', spread: false }] });
    expect(incoming.callers).toEqual([]);
    expect(incoming.calls[0]).toMatchObject({ status: 'typed', target: { name: 'AuthService.issueTokens' }, basis: '같은 클래스 AuthService의 메서드로 찾았어요' });
    expect(incoming.values.find(value => value.name === 'input')).toMatchObject({ role: 'parameter' });
  });

  it('also follows an ordinary function imported with a JS extension', async () => {
    await writeFile(path.join(root, 'extension.ts'), "import { save } from './src/store.js'; export function run() { save('x'); }");
    project = await scanProject(root, project.id);
    expect((await callsOf('extension.ts', 'run')).calls[0]).toMatchObject({ status: 'linked', target: { name: 'save' } });
  });

  it.each([
    ['same method', 'class C { m() {} run() { this.m(); } }', 'C.run', 'C.m'],
    ['arrow keeps this', 'class C { m() {} run() { const arrow = () => this.m(); } }', 'arrow', 'C.m'],
    ['field type', 'class A { m() {} } class C { private f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['initialized field', 'class A { m() {} } class C { f: A = new A(); run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['type looked up at field', 'class A { m() {} } class C { f: A; run(A: unknown) { this.f.m(); } }', 'C.run', 'A.m'],
    ['overload body', 'class C { m(x: string): void; m(x: number): void; m(x: any) {} run() { this.m(1); } }', 'C.run', 'C.m'],
    ['nested class write excluded', 'class C { m() {} run() { class Inner { run() { this.m = other; } } this.m(); } }', 'C.run', 'C.m'],
    ['property read in deeper write', 'class C { f: A; run() { this.f.value = 1; this.f.m(); } } class A { m() {} }', 'C.run', 'A.m'],
    ['method read', 'class C { m() {} run() { const a = this.m; this.m(); } }', 'C.run', 'C.m'],
  ])('resolves %s', async (_label, text, chosen, targetName) => {
    await writeFile(path.join(root, 'typed.ts'), text);
    project = await scanProject(root, project.id);
    expect((await callsOf('typed.ts', chosen)).calls.at(-1)).toMatchObject({ status: 'typed', target: { name: targetName } });
    const target = await callsOf('typed.ts', targetName);
    expect(target.typedCallers).toHaveLength(1);
    expect(target.callers).toEqual([]);
  });

  it.each([
    ['plain function', 'class C { m() {} run() { function inner() { this.m(); } } }', 'inner', 'C.m'],
    ['static method', 'class C { m() {} static run() { this.m(); } }', 'C.run', 'C.m'],
    ['inner field arrow', 'class Outer { m() {} make() { class Inner { m() {} f = () => this.m(); } } }', 'Inner.f', 'Outer.m'],
    ['computed key context', 'class Outer { m() {} make() { class Inner { m() {} [this.m()]() {} } } }', 'Outer.make', 'Outer.m'],
    ['decorator context', 'class Outer { m() {} make() { class Inner { m() {} @dec(this.m()) run() {} } } }', 'Outer.make', 'Outer.m'],
    ['dynamic write', 'class C { m() {} run() { this[key] = other; this.m(); } }', 'C.run', 'C.m'],
    ['computed member', 'class C { m() {} [key]() {} run() { this.m(); } }', 'C.run', 'C.m'],
    ['computed field', 'class C { m() {} [key] = 1; run() { this.m(); } }', 'C.run', 'C.m'],
    ['method assignment', 'class C { m() {} run() { this.m = () => 1; this.m(); } }', 'C.run', 'C.m'],
    ['field assignment', 'class A { m() {} } class C { constructor(private f: A) {} run() { this.f = other; this.f.m(); } }', 'C.run', 'A.m'],
    ['split namespace', 'class A { m() {} } namespace N {} namespace N { class C { constructor(private f: A) {} run() { this.f.m(); } } }', 'C.run', 'A.m'],
    ['target namespace', 'namespace N { class A { m() {} } class C { f: A; run() { this.f.m(); } } }', 'C.run', 'A.m'],
    ['type parameter shadow', 'class A { m() {} } class B {} class C<A extends B> { constructor(private f: A) {} run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['type alias shadow', 'class A { m() {} } type A = Other; class C { f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['interface shadow', 'class A { m() {} } interface A {} class C { f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['static field', 'class A { m() {} } class B { m() {} } class Base { f: B; } class C extends Base { static f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['missing type', 'class A { m() {} } class C { f; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['generic type', 'class A<T> { m() {} } class C { f: A<string>; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['union type', 'class A { m() {} } class C { f: A | null; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['qualified type', 'class A { m() {} } class C { f: ns.A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['interface only', 'interface A { m(): void; } class C { f: A; run() { this.f.m(); } m() {} }', 'C.run', 'C.m'],
    ['inject token', "class A { m() {} } class C { constructor(@Inject('TOKEN') private f: A) {} run() { this.f.m(); } }", 'C.run', 'A.m'],
    ['inject factory', 'class A { m() {} } class C { constructor(@Inject(forwardRef(() => A)) private f: A) {} run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['other decorator', 'class A { m() {} } class C { constructor(@Other(A) private f: A) {} run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['duplicate method', 'class C { m() {} m() {} run() { this.m(); } }', 'C.run', 'C.m'],
    ['field and method', 'class C { m = other; m() {} run() { this.m(); } }', 'C.run', 'C.m'],
    ['duplicate field', 'class A { m() {} } class C { f: A; constructor(private f: A) {} run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['inherited method', 'class A { m() {} } class C extends A { run() { this.m(); } }', 'C.run', 'A.m'],
    ['deep member', 'class A { m() {} } class C { f: A; run() { this.f.a.m(); } }', 'C.run', 'A.m'],
    ['getter target', 'class C { get m() { return other; } run() { this.m(); } }', 'C.run', 'C.m'],
    ['static target', 'class C { static m() {} run() { this.m(); } }', 'C.run', 'C.m'],
    ['target write', 'class A { m() {} change() { this.m = other; } } class C { f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['target computed name', 'class A { m() {} [key]() {} } class C { f: A; run() { this.f.m(); } }', 'C.run', 'A.m'],
    ['computed call', "class C { m() {} run() { this['m'](); } }", 'C.run', 'C.m'],
    ['super call', 'class A { m() {} } class C extends A { run() { super.m(); } }', 'C.run', 'A.m'],
  ])('blocks %s in outgoing and typed incoming calls', async (_label, text, chosen, targetName) => {
    await writeFile(path.join(root, 'blocked.ts'), text);
    project = await scanProject(root, project.id);
    const outgoing = await callsOf('blocked.ts', chosen);
    const memberCalls = outgoing.calls.filter(call => call.text.includes('this.') || call.text.includes('this[') || call.text.includes('super.'));
    expect(memberCalls.length).toBeGreaterThan(0);
    expect(memberCalls.every(call => call.status === 'unknown')).toBe(true);
    const target = await callsOf('blocked.ts', targetName);
    expect(target.typedCallers).toEqual([]);
    expect(target.callers).toEqual([]);
    expect(target.maybeCallers.length).toBeGreaterThan(0);
  });

  it.each(['this.m = other', 'this.m ??= other', 'for (this.m of xs) {}', 'for (this.m in xs) {}',
    '[this.m] = xs', '({ a: this.m } = x)', '++this.m', 'this.m--', 'delete this.m',
    'this[key] = other', "delete this['m']", 'function inner() { this.m = other; }'])('blocks writes: %s', async write => {
    await writeFile(path.join(root, 'writes.ts'), `class C { m() {} run() { ${write}; this.m(); } }`);
    project = await scanProject(root, project.id);
    expect((await callsOf('writes.ts', 'C.run')).calls.at(-1)).toMatchObject({ status: 'unknown', reason: 'member' });
    expect((await callsOf('writes.ts', 'C.m')).typedCallers).toEqual([]);
  });

  it.each([
    ['reexport', "export { A } from './actual';", "import { A } from './target';", 'member'],
    ['import type', 'export class A { m() {} }', "import type { A } from './target';", 'member'],
    ['inline import type', 'export class A { m() {} }', "import { type A } from './target';", 'member'],
    ['target type shadow', 'export class A { m() {} } interface A {}', "import { A } from './target';", 'member'],
    ['target unclear', 'export class A { m() {} } eval(code);', "import { A } from './target';", 'unclear-file'],
    ['target incomplete', 'export class A { m() {} } const broken = ;', "import { A } from './target';", 'incomplete'],
    ['source unclear', 'export class A { m() {} }', "import { A } from './target'; eval(code);", 'unclear-file'],
    ['source incomplete', 'export class A { m() {} }', "import { A } from './target'; const broken = ;", 'incomplete'],
  ])('blocks %s across files', async (_label, target, imported, reason) => {
    await writeFile(path.join(root, 'target.ts'), target);
    await writeFile(path.join(root, 'actual.ts'), 'export class A { m() {} }');
    await writeFile(path.join(root, 'caller.ts'), `${imported} class C { f: A; run() { this.f.m(); } }`);
    project = await scanProject(root, project.id);
    expect((await callsOf('caller.ts', 'C.run')).calls[0]).toMatchObject({ status: 'unknown', reason });
    expect((await callsOf(_label === 'reexport' ? 'actual.ts' : 'target.ts', 'A.m')).typedCallers).toEqual([]);
  });
});

it('follows alias imports and refuses competing candidates', async () => {
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
  await writeFile(path.join(root, 'src/alias-entry.ts'), "import { save } from '@/store'; export function aliasRun() { save('x'); }");
  project = await scanProject(root, project.id);
  const linked = await callsOf('src/alias-entry.ts', 'aliasRun');
  expect(linked.calls[0]).toMatchObject({ status: 'linked', target: { fileId: idOf('src/store.ts'), name: 'save' } });
  await writeFile(path.join(root, 'src/store.js'), 'export function save() {}');
  project = await scanProject(root, project.id);
  const uncertain = await callsOf('src/alias-entry.ts', 'aliasRun');
  expect(uncertain.calls[0]).toMatchObject({ status: 'unknown', detail: '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.' });
});
