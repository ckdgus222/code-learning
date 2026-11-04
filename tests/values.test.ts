import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { FunctionCalls, NameValue, ProjectFiles } from '../src/shared/contracts';

// Plan v2.3 V-1 test project: what the code writes for each name, by line.
const files: Record<string, string> = {
  'src/config.ts': `export const LIMIT = 10;
export let counter = 0;
counter = 1;
let snap = 1;
export default snap;
snap = 2;
export { snap as liveSnap };
`,
  'src/order.ts': `import { LIMIT, counter, liveSnap } from './config';
import defaultSnap from './config';
import { pick } from 'lodash';
const RATE = 0.1;
const LABEL = \`order\`;
const GREETING = \`hi \${LABEL}\`;
let total = 0;
export function place(order: string, qty = 1, ...rest: string[]) {
  const [head] = 'xy';
  const { a = 1 } = { a: 2 };
  let count: number = 0;
  count = 1;
  count += 2;
  {
    let count = 5;
    count = 6;
  }
  for (const item of rest) {}
  try {} catch (e) {}
  total++;
  const bump = () => { total = total + 1; };
  return [order, qty, head, a, RATE, LABEL, GREETING, LIMIT, counter, liveSnap, defaultSnap, pick, count, total, bump];
}
`,
  'src/use.ts': "import { place } from './order';\nplace('a', 2);\nplace(...['b']);\n",
  'src/order.test.ts': "import { place } from './order';\nplace('t', 3, 'x');\n",
  'src/outer.ts': `export function outer(limit: number) {
  function inner(step: number) { return limit + step; }
  inner(5);
  return inner;
}
outer(100);
`,
  'src/redecl.js': 'function f(x) { var x = 2; return x; }\nf(1);\nvar d = 1;\nvar d = 2;\nfunction useD() { return d; }\n',
  'src/args.js': `function g(x) { const change = () => { arguments[0] = 2; }; change(); return x; }
function h(y) { function inner() { return arguments[0]; } return y + inner(); }
`,
  'src/tagged.ts': 'export function tag(parts: TemplateStringsArray, value: number) { return value; }\ntag`a ${1}`;\ntag`plain`;\n',
  'src/this-param.ts': 'export function withThis(this: void, x: number) { return x; }\nwithThis(10);\n',
  'src/reassigned.js': 'function r(v) { return v; }\nr = (v) => v;\nr(1);\n',
  'src/evil.js': "let z = 1;\nfunction useZ() { return z; }\neval('');\n",
  'src/broken.ts': 'let q = 1;\nfunction useQ() { return q; }\nconst x = (1;\n',
  'src/pattern-write.ts': 'let x = 0;\nexport function f(obj: { x: number }) { ({ x } = obj); }\n',
  'src/twice-inside.js': 'function f() { var x = 1; var x = 2; return x; }\n',
  'src/broken-import.ts': "import { LIMIT } from './config';\nexport function useLimit() { return LIMIT; }\nconst x = (1;\n",
  'src/loop.ts': 'export function walk(entries: [string, number][]) { for (const [key, count] of entries) {} }\n',
  'src/view.tsx': 'const div = 42;\nconst Card = () => null;\nexport function View() { return <div><Card /></div>; }\n',
  'src/typed.ts': 'const x = 42;\nexport function f() { let cb: (x: number) => number; return cb; }\n',
  'src/catch-var.js': 'function f() { try { throw 1; } catch (x) { var x = 2; } return x; }\n',
  'src/as-type.ts': 'const x = 42;\nexport function f(cb: unknown) { return cb as (x: number) => number; }\n',
  'src/catch-for.js': 'function f(xs) { try { throw 1; } catch (x) { for (var x of xs) {} } return x; }\nfunction g(xs) { try { throw 1; } catch (k) { for (var k in xs) {} } return k; }\n',
  'src/var-arguments.js': 'function f(x) { var arguments; arguments[0] = 2; return x; }\n',
  'src/using.ts': 'const resource = 42;\nexport function f() { using resource = acquire(); return resource; }\n',
  'src/svg.tsx': 'const xmlns = 1, xlink = 2, label = 3;\nconst motion = { div: () => null };\nexport function View() { return <svg xmlns:xlink="urn:example"><motion.div title={label} /></svg>; }\n',
  'src/namespace-import.ts': "import * as config from './config';\nimport * as lodash from 'lodash';\nexport function f() { return [config, lodash]; }\n",
  'src/inside-namespace.ts': 'namespace N { const x = 1; export function f() { return x; } }\n',
  'src/class-use.ts': 'class Box {}\nexport function make() { return new Box(); }\n',
  'src/local-class.ts': 'export function f() { class Local {} return new Local(); }\n',
  'src/static-param.ts': 'export const f = (x: number) => class { static { var x = 2; } };\nf(1);\n',
  'src/call-param.js': 'function outer(cb) { function inner() { cb(); } return inner; }\n',
  'src/namespace-write.ts': 'let x = 1;\nnamespace N { export let x = 2; }\nnamespace N { x = 3; }\nexport function f() { return x; }\n',
  'src/split-namespace.ts': 'namespace N { export const x = 1; }\nnamespace N { export function f() { return x; } }\n',
  'src/undefined-name.js': 'function outer(undefined) { function inner() { undefined = 1; return undefined; } return inner; }\n',
  'src/arguments-param.js': 'function f(arguments) { return arguments; }\nf(7);\n',
  'src/arguments-let.js': 'function f(x) { let arguments = {}; arguments[0] = 2; return x; }\n',
  'src/let-function.js': 'function f() { let x = () => 1; x = 42; return x; }\nfunction g() { let y = () => 1; return y; }\n',
  'src/import-write.ts': "import { LIMIT } from './config';\nexport function f() { LIMIT = 2; return LIMIT; }\nexport function g() { let LIMIT = 3; LIMIT = 4; return LIMIT; }\n",
  'src/local-class.js': 'function f() { class Local {} return new Local(); }\n',
  'src/let-export.js': 'export let x = () => 1;\nx = 42;\nlet y = () => 2;\ny = 43;\nexport { y };\nexport let z = () => 3;\n',
  'src/use-let-export.js': "import { x, y, z } from './let-export';\nfunction f() { return [x, y, z]; }\n",
  'src/default-let.js': 'let x = () => 1;\nexport default x;\nx = 42;\nexport { x as live };\n',
  'src/use-default-let.js': "import first, { live } from './default-let';\nfunction f() { return [first, live]; }\n",
  'src/default-let-before.js': 'let x = () => 1;\nx = 42;\nexport default x;\n',
  'src/use-default-let-before.js': "import first from './default-let-before';\nfunction f() { return first; }\n",
  'src/default-fn.js': 'let x = () => 1;\nexport default x;\n',
  'src/use-default-fn.js': "import first from './default-fn';\nfunction f() { return first; }\n",
  'src/for-arguments.js': 'function f(x) { for (var arguments of [arguments]) { arguments[0] = 2; } return x; }\n',
  'src/fn-reassigned.js': 'function source() {}\nsource = 42;\nfunction use() { return source; }\nfunction inner() { function local() {} local = 1; return local; }\n',
  'src/fn-export.js': 'export function source() {}\nsource = 42;\n',
  'src/use-fn-export.js': "import { source } from './fn-export';\nfunction use() { return source; }\n",
  'src/block-fn.js': 'function f() { if (true) { function x() {} x = 42; return x; } }\n',
  'src/global-fn.js': 'function x() {}\nglobalThis.x = 42;\nfunction f() { return x; }\n',
  'src/self-name.js': 'function f() { return 1; }\nf = 42;\nfunction g() { return g; }\ng = 1;\n',
  'src/param-fn.js': 'function outer(x) { function x() {} x = 42; return x; }\n',
  'src/global-let.js': 'const rate = 0.1;\nlet count = 0;\nvar total = 0;\nglobalThis.rate = 0.2;\nglobalThis.count = 1;\nglobalThis.total = 1;\nfunction f() { return [rate, count, total]; }\n',
  'src/global-const-fn.js': 'const x = () => 1;\nconst y = function () { return 2; };\nglobalThis.x = 42;\nglobalThis.y = 43;\nfunction f() { return [x, y]; }\n',
  'src/arrow-var-arguments.js': 'const f = (x) => { var arguments = {}; arguments[0] = 2; return x; };\n',
  'src/catch-typed.ts': 'export function f() { try { g(); } catch (error: unknown) { return error; } try { g(); } catch ({ message = "none", [0]: first }: any) { return [message, first]; } }\n',
  'src/inner-change.js': 'function outer() { function source() {} function change() { source = 42; } change(); }\nfunction outer2() { let source = () => {}; function change() { source = 42; } change(); }\n',
  'src/fn-twice.js': 'function f() { function x() {} function x() {} x = 42; return x; }\n',
  'src/fn-var-twice.js': 'function f() { var x = 1; function x() {} return x; }\n',
  'src/script.js': 'var w = 1;\nwindow.w = 2;\nfunction useW() { return w; }\n',
};

let root: string;
let project: ProjectFiles;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-values-test-')));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  project = await scanProject(root, randomUUID());
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const idOf = (relative: string) => project.files.find(file => file.relativePath === relative)!.id;
const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
async function search(relative: string, name: string): Promise<FunctionCalls> {
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: idOf(relative), fileHash: hash }).symbols.find(item => item.name === name)!;
  return findFunctionCalls(root, project.id, project.files, { fileId: idOf(relative), fileHash: hash,
    startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS);
}
// One line per name: what the expected lists compare.
function card(value: NameValue) {
  const at = value.declaredAt ? `${pathOf(value.declaredAt.fileId)}:${value.declaredAt.startLine}` : null;
  return {
    name: value.name, group: value.group, role: value.role, shape: value.shape, at, type: value.type, fixed: value.fixed,
    initial: value.initial ? `${value.initial.kind} ${value.initial.text}` : null,
    assignments: value.assignments.map(item => `${item.startLine} ${item.text}`),
    index: value.index, outer: value.outerFunction?.name ?? null, unknown: value.unknown, external: value.external, notes: value.notes.length,
  };
}
const blank = { shape: 'plain', at: null, type: null, fixed: null, initial: null, assignments: [], index: null, outer: null, unknown: null,
  external: null, notes: 0 };

describe('values written in the code (plan v2.3 V-1)', () => {
  it('lists the parameters, the names declared inside and the names used from outside, with what is written for each', async () => {
    const values = (await search('src/order.ts', 'place')).values.map(card);
    const order = 'src/order.ts';
    expect(values).toEqual([
      { ...blank, name: 'order', group: 'parameter', role: 'parameter', at: `${order}:8`, type: 'string', index: 0 },
      { ...blank, name: 'qty', group: 'parameter', role: 'parameter', at: `${order}:8`, initial: 'default 1', index: 1 },
      { ...blank, name: 'rest', group: 'parameter', role: 'parameter', shape: 'rest', at: `${order}:8`, type: 'string[]', initial: 'pattern ...rest: string[]' },
      // Destructuring: the declaration as written, never a value taken out of it.
      { ...blank, name: 'head', group: 'inside', role: 'const', shape: 'destructured', at: `${order}:9`, initial: "pattern [head] = 'xy'" },
      { ...blank, name: 'a', group: 'inside', role: 'const', shape: 'destructured', at: `${order}:10`, initial: 'pattern { a = 1 } = { a: 2 }' },
      // The inner block's own count and its write are not mixed in.
      { ...blank, name: 'count', group: 'inside', role: 'let', at: `${order}:11`, type: 'number', initial: 'value 0',
        assignments: ['12 count = 1', '13 count += 2'] },
      { ...blank, name: 'count', group: 'inside', role: 'let', at: `${order}:15`, initial: 'value 5', assignments: ['16 count = 6'] },
      { ...blank, name: 'item', group: 'inside', role: 'for', at: `${order}:18`, initial: 'loop item of rest' },
      { ...blank, name: 'e', group: 'inside', role: 'catch', at: `${order}:19` },
      // Names from outside come in the order they are first used (total++ is on line 20).
      // total is written by place and by the arrow inside it: both are writes of the one declaration.
      { ...blank, name: 'total', group: 'outside', role: 'let', at: `${order}:7`, initial: 'value 0',
        assignments: ['20 total++', '21 total = total + 1'] },
      { ...blank, name: 'RATE', group: 'outside', role: 'const', at: `${order}:4`, fixed: '0.1' },
      { ...blank, name: 'LABEL', group: 'outside', role: 'const', at: `${order}:5`, fixed: '`order`' },
      // A template with ${…} is not a fixed value.
      { ...blank, name: 'GREETING', group: 'outside', role: 'const', at: `${order}:6`, initial: 'value `hi ${LABEL}`' },
      { ...blank, name: 'LIMIT', group: 'outside', role: 'import', at: 'src/config.ts:1', fixed: '10' },
      // A live export carries the exporting file's writes.
      { ...blank, name: 'counter', group: 'outside', role: 'import', at: 'src/config.ts:2', initial: 'value 0', assignments: ['3 counter = 1'] },
      { ...blank, name: 'liveSnap', group: 'outside', role: 'import', at: 'src/config.ts:4', initial: 'value 1', assignments: ['6 snap = 2'] },
      // export default snap exports the value snap has then, so its later write is not shown.
      { ...blank, name: 'defaultSnap', group: 'outside', role: 'import', at: 'src/config.ts:5', initial: 'export snap' },
      { ...blank, name: 'pick', group: 'outside', role: 'import', external: 'lodash' },
    ]);
  });

  it('gives each call\'s arguments by position, with test files and tagged templates told apart', async () => {
    const place = await search('src/order.ts', 'place');
    expect(place.callers!.map(site => [pathOf(site.fileId), site.startLine, site.inTest, site.args])).toEqual([
      ['src/order.test.ts', 2, true, [{ text: "'t'", spread: false }, { text: '3', spread: false }, { text: "'x'", spread: false }]],
      ['src/use.ts', 2, false, [{ text: "'a'", spread: false }, { text: '2', spread: false }]],
      ['src/use.ts', 3, false, [{ text: "...['b']", spread: true }]],
    ]);
    const tag = await search('src/tagged.ts', 'tag');
    expect(tag.callers!.map(site => site.args)).toEqual([null, null]);
    // A TS this parameter takes no argument: x is the first.
    const withThis = await search('src/this-param.ts', 'withThis');
    expect([withThis.values.map(card).map(value => [value.name, value.index]), withThis.callers!.map(site => site.args)])
      .toEqual([[['x', 0]], [[{ text: '10', spread: false }]]]);
    // A reassigned function has no settled callers, so no arguments to show for its parameter.
    const reassigned = await search('src/reassigned.js', 'r');
    expect([reassigned.callers, reassigned.maybeCallers.map(site => site.startLine)]).toEqual([[], [3]]);
  });

  it('tells an outer function\'s parameter from the chosen one\'s', async () => {
    // Called and nothing else: still a name it uses, an outer function's parameter.
    expect((await search('src/call-param.js', 'inner')).values.map(value => [value.name, value.group, value.outerFunction?.name]))
      .toEqual([['cb', 'outside', 'outer']]);
    const inner = await search('src/outer.ts', 'inner');
    expect(inner.values.map(card)).toEqual([
      { ...blank, name: 'step', group: 'parameter', role: 'parameter', at: 'src/outer.ts:2', type: 'number', index: 0 },
      { ...blank, name: 'limit', group: 'outside', role: 'parameter', at: 'src/outer.ts:1', type: 'number', outer: 'outer' },
    ]);
    expect(inner.callers!.map(site => site.args)).toEqual([[{ text: '5', spread: false }]]);
  });

  it('does not settle a parameter declared again, a name declared twice, or names in files it cannot settle', async () => {
    const f = (await search('src/redecl.js', 'f')).values.map(value => [value.name, value.group, value.unknown]);
    expect(f).toEqual([['x', 'parameter', '매개변수와 같은 이름을 본문에서 다시 선언했어요.'], ['x', 'inside', '매개변수와 같은 이름을 본문에서 다시 선언했어요.']]);
    expect((await search('src/redecl.js', 'useD')).values.map(value => [value.name, value.unknown])).toEqual([['d', '같은 이름이 한 범위에 여러 번 선언됐어요.']]);
    expect((await search('src/evil.js', 'useZ')).values.map(value => value.unknown)).toEqual(['파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어 이름을 정할 수 없어요.']);
    expect((await search('src/broken.ts', 'useQ')).values.map(value => value.unknown)).toEqual(['구문 오류가 있어 이 파일의 이름은 확정하지 않았어요.']);
  });

  it('counts a name written through a destructuring pattern as used, and keeps names declared twice inside to themselves', async () => {
    const f = (await search('src/pattern-write.ts', 'f')).values.map(card);
    expect(f.map(value => [value.name, value.group, value.assignments])).toEqual([['obj', 'parameter', []], ['x', 'outside', ['2 { x } = obj']]]);
    expect((await search('src/twice-inside.js', 'f')).values.map(value => [value.name, value.group, value.unknown]))
      .toEqual([['x', 'inside', '같은 이름이 한 범위에 여러 번 선언됐어요.'], ['x', 'inside', '같은 이름이 한 범위에 여러 번 선언됐어요.']]);
    // A file not seen to the end does not settle its imports either.
    expect((await search('src/broken-import.ts', 'useLimit')).values.map(value => [value.name, value.unknown]))
      .toEqual([['LIMIT', '구문 오류가 있어 이 파일의 이름은 확정하지 않았어요.']]);
  });

  it('does not take JSX element tags or names inside types as uses, and does not settle a var that shares a catch name', async () => {
    // <div> is an element, not the const div; Card is a component, a function (the calls' part), so not listed.
    expect((await search('src/view.tsx', 'View')).values.map(value => value.name)).toEqual([]);
    expect((await search('src/typed.ts', 'f')).values.map(value => [value.name, value.group])).toEqual([['cb', 'inside']]);
    // A namespaced JSX name is not two variables; a JSX expression and the object of <motion.div> are real uses.
    expect((await search('src/svg.tsx', 'View')).values.map(value => value.name)).toEqual(['motion', 'label']);
    expect((await search('src/catch-var.js', 'f')).values.map(value => [value.name, value.role, value.unknown])).toEqual([
      ['x', 'catch', 'catch로 받는 이름과 같은 이름을 var로 다시 선언했어요.'], ['x', 'var', 'catch로 받는 이름과 같은 이름을 var로 다시 선언했어요.']]);
  });

  it('skips names in any type, and marks loop vars that share a catch name', async () => {
    expect((await search('src/as-type.ts', 'f')).values.map(value => value.name)).toEqual(['cb']);
    for (const name of ['f', 'g']) {
      expect((await search('src/catch-for.js', name)).values.filter(value => value.group === 'inside').map(value => [value.role, value.unknown]))
        .toEqual([['catch', 'catch로 받는 이름과 같은 이름을 var로 다시 선언했어요.'], ['for', 'catch로 받는 이름과 같은 이름을 var로 다시 선언했어요.']]);
    }
  });

  it('does not work out values in a file that declares or assigns arguments or undefined as a name (a rare case)', async () => {
    const odd = '파일에 arguments나 undefined를 이름으로 선언하거나 대입한 곳이 있어 값을 정하지 않았어요.';
    const files = ['src/arguments-param.js', 'src/arguments-let.js', 'src/arrow-var-arguments.js', 'src/for-arguments.js', 'src/var-arguments.js',
      'src/undefined-name.js'];
    for (const file of files) {
      const name = file === 'src/undefined-name.js' ? 'outer' : 'f';
      const values = (await search(file, name)).values;
      expect(values.length, file).toBeGreaterThan(0);
      expect(values.every(value => value.unknown === odd), file).toBe(true);
    }
    // Only declared or assigned names count: using the arguments object is the ordinary case, with its note.
    expect((await search('src/args.js', 'g')).values.map(value => [value.name, value.unknown, value.notes.length])).toEqual([['x', null, 1]]);
    // The call search still settles calls around such names (plan F): the parameter's arguments are there.
    expect((await search('src/arguments-param.js', 'f')).callers!.map(site => site.args)).toEqual([[{ text: '7', spread: false }]]);
  });

  it('does not settle names in a file with a using declaration, which this grammar reads as an assignment', async () => {
    expect((await search('src/using.ts', 'f')).values.map(value => [value.name, value.unknown]))
      .toEqual([['resource', '파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어 이름을 정할 수 없어요.']]);
  });

  it('never drops a used name without a word: namespace imports, names in a namespace, classes', async () => {
    expect((await search('src/namespace-import.ts', 'f')).values.map(value => [value.name, value.role, value.unknown, value.external])).toEqual([
      ['config', 'import', '이름공간 가져오기(* as)라 파일 전체를 가리켜요. 값을 하나로 따라가지 않아요.', null], ['lodash', 'import', null, 'lodash']]);
    expect((await search('src/inside-namespace.ts', 'f')).values.map(value => [value.name, value.unknown])).toEqual([['x', 'TS namespace·enum 안이라 이름을 정할 수 없어요.']]);
    // Declared in another block of the namespace: no declaration is found, and it is still listed.
    expect((await search('src/split-namespace.ts', 'f')).values.map(value => [value.name, value.unknown])).toEqual([['x', 'TS namespace·enum 안이라 이름을 정할 수 없어요.']]);
    // x = 3 in the second namespace block may be N.x: it is not taken as a write to the outer x.
    expect((await search('src/namespace-write.ts', 'f')).values.map(value => [value.name, value.unknown, value.assignments.length]))
      .toEqual([['x', 'TS namespace 안에서 같은 이름에 대입한 곳이 있어 이 이름의 값을 정할 수 없어요.', 0]]);
    expect((await search('src/class-use.ts', 'make')).values.map(value => [value.name, value.group, value.role, value.unknown]))
      .toEqual([['Box', 'outside', 'other', '클래스·enum·namespace·require 같은 선언이라 값을 따라가지 않아요.']]);
    // Made inside the function: shown as made inside, not as something from outside.
    expect((await search('src/local-class.ts', 'f')).values.map(value => [value.name, value.group, value.declaredAt?.startLine]))
      .toEqual([['Local', 'inside', 1]]);
  });

  it('shows a let that starts as a function once another value is assigned, and refuses an imported name written to', async () => {
    expect((await search('src/let-function.js', 'f')).values.map(value => [value.name, value.initial?.text, value.assignments.map(item => item.text)]))
      .toEqual([['x', '() => 1', ['x = 42']]]);
    // Never given another value: a function, which the calls' lists are for.
    expect((await search('src/let-function.js', 'g')).values).toEqual([]);
    expect((await search('src/import-write.ts', 'f')).values.map(value => [value.name, value.unknown])).toEqual([['LIMIT', '가져온 이름에 대입하는 곳이 있어요(실행하면 오류가 나요).']]);
    // A local of the same name written to is another name: the import is not involved.
    expect((await search('src/import-write.ts', 'g')).values.map(value => [value.name, value.group, value.assignments.length])).toEqual([['LIMIT', 'inside', 1]]);
    // The same through an import, exported with the declaration or in a list; z is never reassigned.
    expect((await search('src/use-let-export.js', 'f')).values.map(value => [value.name, value.role, value.initial?.text, value.assignments.map(item => item.text)]))
      .toEqual([['x', 'import', '() => 1', ['x = 42']], ['y', 'import', '() => 2', ['y = 43']]]);
    // export default x exports what x is then: with a write before or after it, only that expression is shown;
    // export { x as live } follows x, writes included. Never written to, x stays a function (the calls' part).
    expect((await search('src/use-default-let.js', 'f')).values.map(value => [value.name, value.initial?.text ?? null, value.assignments.map(item => item.text)]))
      .toEqual([['first', 'x', []], ['live', '() => 1', ['x = 42']]]);
    expect((await search('src/use-default-let-before.js', 'f')).values.map(value => [value.name, value.initial?.kind, value.initial?.text, value.assignments.length]))
      .toEqual([['first', 'export', 'x', 0]]);
    expect((await search('src/use-default-fn.js', 'f')).values).toEqual([]);
    // A function declaration given another value: shown with the function as its first value, in its file,
    // inside the chosen function, and through an import.
    const card = (value: NameValue) => [value.name, value.group, value.role, value.initial?.text, value.assignments.map(item => item.text)];
    expect((await search('src/fn-reassigned.js', 'use')).values.map(card)).toEqual([['source', 'outside', 'function', 'function source() {}', ['source = 42']]]);
    expect((await search('src/fn-reassigned.js', 'inner')).values.map(card)).toEqual([['local', 'inside', 'function', 'function local() {}', ['local = 1']]]);
    expect((await search('src/use-fn-export.js', 'use')).values.map(card)).toEqual([['source', 'outside', 'import', 'function source() {}', ['source = 42']]]);
    // A block's function: not worked out, but still listed. A function a global object can replace: listed with a note.
    expect((await search('src/block-fn.js', 'f')).values.map(value => [value.name, value.group, value.unknown]))
      .toEqual([['x', 'inside', '블록 안 함수 선언이라 범위를 정할 수 없어요.']]);
    expect((await search('src/global-fn.js', 'f')).values.map(value => [value.name, value.role, value.notes.length])).toEqual([['x', 'function', 1]]);
    // A function's own name is not one it makes inside itself; used in its body, it is its name from outside.
    expect((await search('src/self-name.js', 'f')).values).toEqual([]);
    expect((await search('src/self-name.js', 'g')).values.map(value => [value.name, value.group])).toEqual([['g', 'outside']]);
    // A function declared with a parameter's name: neither is worked out.
    expect((await search('src/param-fn.js', 'outer')).values.map(value => [value.name, value.group, value.unknown])).toEqual([
      ['x', 'parameter', '매개변수와 같은 이름을 본문에서 다시 선언했어요.'], ['x', 'inside', '매개변수와 같은 이름을 본문에서 다시 선언했어요.']]);
    // A catch name keeps its written type; destructured, it shows the pattern as written, defaults included.
    expect((await search('src/catch-typed.ts', 'f')).values.map(value => [value.name, value.type, value.shape, value.initial?.text ?? null])).toEqual([
      ['error', 'unknown', 'plain', null],
      ['message', null, 'destructured', '{ message = "none", [0]: first }'], ['first', null, 'destructured', '{ message = "none", [0]: first }']]);
    // Given another value only from a function inside: shown either way it is declared.
    for (const name of ['outer', 'outer2']) {
      expect((await search('src/inner-change.js', name)).values.map(value => [value.name, value.group, value.assignments.map(item => item.text)]), name)
        .toEqual([['source', 'inside', ['source = 42']]]);
    }
    expect((await search('src/fn-twice.js', 'f')).values.map(value => [value.name, value.group, value.unknown]))
      .toEqual([['x', 'inside', '같은 이름이 한 범위에 여러 번 선언됐어요.']]);
    expect((await search('src/fn-var-twice.js', 'f')).values.map(value => [value.name, value.role, value.unknown]))
      .toEqual([['x', 'var', '같은 이름이 한 범위에 여러 번 선언됐어요.']]);
    expect((await search('src/local-class.js', 'f')).values.map(value => [value.name, value.group])).toEqual([['Local', 'inside']]);
  });

  it('keeps a parameter apart from a var in a class static block of its expression body', async () => {
    const f = await search('src/static-param.ts', 'f');
    expect(f.values.map(value => [value.name, value.group, value.index, value.unknown])).toEqual([['x', 'parameter', 0, null]]);
    expect(f.callers!.map(site => site.args)).toEqual([[{ text: '1', spread: false }]]);
  });

  it('shows a destructured loop name with its loop head', async () => {
    expect((await search('src/loop.ts', 'walk')).values.map(card).map(value => [value.name, value.shape, value.initial]))
      .toEqual([['entries', 'plain', null], ['key', 'destructured', 'loop [key, count] of entries'], ['count', 'destructured', 'loop [key, count] of entries']]);
  });

  it('notes a parameter that arguments can change, and a script name window can change', async () => {
    expect((await search('src/args.js', 'g')).values.map(value => [value.name, value.notes.length])).toEqual([['x', 1]]);
    // h's inner function uses its own arguments, not h's.
    expect((await search('src/args.js', 'h')).values.map(value => [value.name, value.notes.length])).toEqual([['y', 0]]);
    // Only a var (or a function declaration) is the global object's property: let and const get no note.
    expect((await search('src/global-let.js', 'f')).values.map(value => [value.name, value.notes.length])).toEqual([['rate', 0], ['count', 0], ['total', 1]]);
    // A const holding a function is not the global object's property either: still a plain function (the calls' part).
    expect((await search('src/global-const-fn.js', 'f')).values).toEqual([]);
    expect((await search('src/script.js', 'useW')).values.map(value => [value.name, value.notes.length])).toEqual([['w', 1]]);
  });
});
