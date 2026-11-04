import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readAllowed, readTypeFile, scanProject } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { fileCallbacks, findValueShapes, readProjectCode, SHAPE_LIMITS, type ShapeLimits } from '../src/core/analysis/shapes';
import { newStopSlots, publishProcess, requestStop, stopRequested, takeProcess } from '../src/core/analysis/side-stop';
import { shapeQueries } from '../src/renderer/values';
import type { ProjectFiles, Shape } from '../src/shared/contracts';

// Plan v2.3 V-2 test project. node_modules holds fake packages: types only, JS only, a pnpm-style link inside the
// folder, a link out of the folder, a type file under a secret-named folder, and a hard link.
const files: Record<string, string> = {
  '.gitignore': 'src/hidden.ts\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    allowJs: true, jsx: 'preserve', noEmit: true }, include: ['src', 'packages'] }),
  'src/order.ts': `import { discount } from 'pricing';
import { LIMIT } from './config';
import { hidden } from './hidden';
import { onlyJs } from 'js-only';
import { outside } from 'outside-link';
import { linked } from 'pnpm-style';
import { secretType } from 'vault-pkg';
import { hard } from 'hard-pkg';
export interface Item { name: string; price: number; qty: number }
// 한글 주석 😀 앞에 있어도 위치가 맞아야 함
export function makeOrder(items: Item[], coupon?: string) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const status = items.length > LIMIT ? 'too many' : 'ok';
  return { items, total: discount(total, coupon), status, more: [hidden, onlyJs, outside, linked, secretType, hard] };
}
export const label = (order: { status: string }) => order.status === 'ok' ? 'fine' as const : 'bad' as const;
export class Shop { checkout(count: number) { return count > 1; } }
`,
  'src/config.ts': 'export const LIMIT = 10;\n',
  'src/hidden.ts': 'export const hidden: { secret: number } = { secret: 1 };\n',
  'src/cart.js': `/** @param {{ price: number, qty: number }[]} items */
export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
export function label(order, discount = 0.1) {
  return { status: order.status, rate: discount };
}
`,
  'src/live.ts': 'let n = 1;\nn = 2;\nexport { n as live };\n',
  'src/use-live.ts': "import { live } from './live';\nexport function useLive() { return live; }\n",
  'src/data.js': 'export const limit = 3;\n',
  'src/data.ts': 'export const limit = "different";\n',
  'src/use-data.js': "import { limit } from './data.js';\nexport function useData() { return limit; }\n",
  'src/any.ts': `interface Company { name: string }
type Box = { value: any };
export function kinds(a: any, b: any[], c: "any", d: Company, e: { company: any }, f: Box) { return [a, b, c, d, e, f] as const; }
export function wide(): { ${Array.from({ length: 100 }, (_, i) => `p${i}: ${i === 50 ? 'any' : 'number'}`).join('; ')} } { return null!; }
`,
  'packages/a/index.ts': 'export const aLocal = 1;\n',
  'src/use-a.ts': "import { aType } from '../packages/a/node_modules/a-dep/index';\nexport function useA() { return aType; }\n",
  'packages/a/node_modules/a-dep/index.d.ts': 'export declare const aType: { a: 1 };\n',
  'node_modules/pricing/package.json': JSON.stringify({ name: 'pricing', types: 'index.d.ts' }),
  'node_modules/pricing/index.d.ts': 'export declare function discount(total: number, coupon?: string): number;\n',
  'node_modules/js-only/package.json': JSON.stringify({ name: 'js-only', main: 'index.js' }),
  'node_modules/js-only/index.js': 'exports.onlyJs = { shape: 1 };\n',
  'node_modules/.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style/package.json': JSON.stringify({ name: 'pnpm-style', types: 'index.d.ts' }),
  'node_modules/.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style/index.d.ts': 'export declare const linked: { ok: true };\n',
  'node_modules/.pnpm/pnpm-style@2.0.0/node_modules/pnpm-style/package.json': JSON.stringify({ name: 'pnpm-style', types: 'index.d.ts' }),
  'node_modules/.pnpm/pnpm-style@2.0.0/node_modules/pnpm-style/index.d.ts': 'export declare const linked: { ok: false };\n',
  'node_modules/vault-pkg/package.json': JSON.stringify({ name: 'vault-pkg', types: 'credentials/index.d.ts' }),
  'node_modules/vault-pkg/credentials/index.d.ts': 'export declare const secretType: { leaked: true };\n',
  'node_modules/hard-pkg/package.json': JSON.stringify({ name: 'hard-pkg', types: 'index.d.ts' }),
  'node_modules/hard-store.d.ts': 'export declare const hard: { linked: true };\n',
};

let root: string;
let outsideDir: string;
let project: ProjectFiles;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-shapes-test-')));
  outsideDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-shapes-outside-')));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  await symlink('.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style', path.join(root, 'node_modules/pnpm-style'));
  await mkdir(path.join(outsideDir, 'outside-link'));
  await writeFile(path.join(outsideDir, 'outside-link/package.json'), JSON.stringify({ name: 'outside-link', types: 'index.d.ts' }));
  await writeFile(path.join(outsideDir, 'outside-link/index.d.ts'), 'export declare const outside: { far: true };\n');
  await symlink(path.join(outsideDir, 'outside-link'), path.join(root, 'node_modules/outside-link'));
  linkSync(path.join(root, 'node_modules/hard-store.d.ts'), path.join(root, 'node_modules/hard-pkg/index.d.ts'));
  project = await scanProject(root, randomUUID());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

const idOf = (relative: string) => project.files.find(file => file.relativePath === relative)!.id;
const at = (relative: string) => path.join(root, relative);
// A path with / as the checker writes it on every OS.
const slashed = (name: string) => name.split(path.sep).join('/');
// A path as the checker gives it for a file it opened: / and, on Windows, a lowercase drive letter.
const checkerName = (name: string) => slashed(name).replace(/^[A-Z]:/, drive => drive.toLowerCase());
async function targetOf(relative: string, name: string) {
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: idOf(relative), fileHash: hash }).symbols.find(item => item.name === name)!;
  return { fileId: idOf(relative), fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
const show = (shape: Shape | undefined) => !shape ? null : 'text' in shape ? `${shape.text}${shape.hasAny ? ' [any]' : ''}` : `? ${shape.unknown}`;
/** The function's V-1 names and its return, each with the shape found: as the screen asks for them. */
async function shapesOf(relative: string, name: string, limits: ShapeLimits = SHAPE_LIMITS) {
  const target = await targetOf(relative, name);
  const calls = await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS);
  const { queries, slots } = shapeQueries(calls.values, target.fileId);
  const { shapes, watch } = await findValueShapes(root, project.id, project.files, target, queries, newStopSlots(), limits);
  const names = Object.fromEntries(calls.values.map((value, index) => {
    const slot = slots[index];
    return [value.name, !slot ? null : 'skipped' in slot ? `skipped ${slot.skipped}` : show(shapes.names[slot.query])];
  }));
  return { returns: show(shapes.returns), names, notes: shapes.notes, watch, shapes };
}

describe('value shapes (plan v2.3 V-2)', () => {
  it('reads the shapes the checker gives a TypeScript function, its names and imports, under the reading rules', async () => {
    const found = await shapesOf('src/order.ts', 'makeOrder');
    expect(found.returns).toBe('{ items: Item[]; total: number; status: string; more: any[]; } [any]');
    expect(found.names).toEqual({
      items: 'Item[]',
      coupon: 'string | undefined',
      total: 'number',
      status: '"ok" | "too many"',
      // A package with type files: read under the user's exception.
      discount: '(total: number, coupon?: string | undefined) => number',
      // Followed by V-1 to config.ts and found there by the checker too.
      LIMIT: '10',
      // .gitignore'd: V-1 cannot follow it, so no shape is asked.
      hidden: null,
      // JS only, a link out of the folder, a secret-named folder, a hard link: not read, so not found.
      onlyJs: '? 가져온 대상을 타입 검사기가 찾지 못했어요.',
      outside: '? 가져온 대상을 타입 검사기가 찾지 못했어요.',
      secretType: '? 가져온 대상을 타입 검사기가 찾지 못했어요.',
      hard: '? 가져온 대상을 타입 검사기가 찾지 못했어요.',
      // A pnpm-style link inside the folder is followed.
      linked: '{ ok: true; }',
    });
    expect(found.notes).toEqual([]);
    // Each real file once; package.json files are read to resolve packages even when their types are not.
    expect(found.watch.files.map(file => slashed(path.relative(root, file.path))).sort()).toEqual([
      'node_modules/.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style/index.d.ts',
      'node_modules/.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style/package.json',
      'node_modules/hard-pkg/package.json', 'node_modules/js-only/package.json',
      'node_modules/pricing/index.d.ts', 'node_modules/pricing/package.json', 'node_modules/vault-pkg/package.json',
      'packages/a/node_modules/a-dep/index.d.ts']);
    expect(found.watch.links.map(link => [slashed(path.relative(root, link.path)), slashed(link.target)])).toEqual([
      ['node_modules/pnpm-style', '.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style']]);
  });

  it('finds the return of an arrow function and a method, and the shapes of plain JavaScript', async () => {
    expect((await shapesOf('src/order.ts', 'label')).returns).toBe('"bad" | "fine"');
    expect((await shapesOf('src/order.ts', 'Shop.checkout')).returns).toBe('boolean');
    const total = await shapesOf('src/cart.js', 'total');
    expect(total.returns).toBe('number');
    expect(total.names.items).toBe('{ price: number; qty: number; }[]');
    const label = await shapesOf('src/cart.js', 'label');
    expect(label.names).toEqual({ order: 'any [any]', discount: 'number' });
    expect(label.returns).toBe('{ status: any; rate: number; } [any]');
  });

  it('marks only a real any: not the text "any", not inside a named type, and also where the printed shape is cut short', async () => {
    const kinds = await shapesOf('src/any.ts', 'kinds');
    expect(kinds.names).toEqual({ a: 'any [any]', b: 'any[] [any]', c: '"any"', d: 'Company', e: '{ company: any; } [any]', f: 'Box' });
    const wide = await shapesOf('src/any.ts', 'wide');
    // p50 is the one any, and it is in the part printed as "... more ...".
    expect(wide.returns).toContain('...');
    expect(wide.returns!.endsWith(' [any]')).toBe(true);
    expect(wide.returns!.slice(0, -' [any]'.length)).not.toMatch(/\bany\b/);
  });

  it('shows the shape of an import exported through a list, found where V-1 followed it', async () => {
    expect((await shapesOf('src/use-live.ts', 'useLive')).names).toEqual({ live: 'number' });
  });

  it('does not request a shape when a TS import has both JS and TS candidates', async () => {
    await writeFile(at('src/ambiguous-data.ts'), files['src/use-data.js']);
    project = await scanProject(root, project.id);
    const target = await targetOf('src/ambiguous-data.ts', 'useData');
    const result = await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS);
    expect(result.values.find(value => value.name === 'limit')?.unknown).toContain('후보가 여럿');
    expect(shapeQueries(result.values, target.fileId).queries).toEqual([]);
  });

  // A JS importer keeps the original path; the checker may still substitute data.ts.
  it('shows no shape when the checker found another declaration than the one V-1 followed', async () => {
    const found = await shapesOf('src/use-data.js', 'useData');
    expect(found.names.limit).toBe('? 타입 검사기가 찾은 선언이 값 따라가기의 선언과 같은지 확인하지 못해 모양을 붙이지 않았어요.');
  });

  it('checks a name against its place and refuses a changed file', async () => {
    const target = await targetOf('src/order.ts', 'makeOrder');
    const { shapes } = await findValueShapes(root, project.id, project.files, target,
      [{ name: 'coupon', at: target.startUtf16, expect: null }], newStopSlots());
    expect(show(shapes.names[0])).toBe('? 이름 위치가 맞지 않아 모양을 찾지 않았어요.');
    await writeFile(path.join(root, 'src/order.ts'), files['src/order.ts'] + '\n');
    await expect(findValueShapes(root, project.id, project.files, target, [], newStopSlots())).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('applies the .gitignore of now: a folder excluded after opening gives no dependency types', async () => {
    expect((await shapesOf('src/use-a.ts', 'useA')).returns).toBe('{ a: 1; }');
    await writeFile(path.join(root, '.gitignore'), 'src/hidden.ts\npackages/a/\n');
    const after = await shapesOf('src/use-a.ts', 'useA');
    expect(after.returns).toBe('any [any]');
    expect(after.notes).toContain('프로젝트 파일 일부를 읽지 않았어요(한도를 넘었거나 지금 규칙으로 읽을 수 없음). 그 파일에서 오는 모양은 any로 보일 수 있어요.');
  });

  it('stops reading at the byte limits, before reading: type files over what is left, and a project file grown since opening', async () => {
    const target = await targetOf('src/order.ts', 'makeOrder');
    const code = await readProjectCode(root, project.files, target, newStopSlots(), SHAPE_LIMITS);
    const small = { ...SHAPE_LIMITS, typeBytes: 60 };
    let reads = 0;
    const { callbacks: fs, notes, watch } = fileCallbacks(root, code.texts, code.allowedDirs, '/nowhere/lib/', newStopSlots(), small,
      { beforeOpen: () => { reads++; } });
    // pricing/package.json (39 bytes) fits; index.d.ts (74 bytes) is over what is left: only its size is looked at, and
    // it is not opened again on the next question.
    expect(fs.readFile!(at('node_modules/pricing/package.json'))).toContain('pricing');
    expect(fs.readFile!(at('node_modules/pricing/index.d.ts'))).toBeNull();
    expect(fs.readFile!(at('node_modules/pricing/index.d.ts'))).toBeNull();
    expect(watch.files.map(file => path.basename(file.path))).toEqual(['package.json']);
    expect([...notes]).toEqual(['외부 패키지 타입 파일이 한도(5,000개·64 MiB·파일당 4 MiB)를 넘어 일부를 읽지 않았어요. 그 부분은 any로 보일 수 있어요.']);
    expect(reads).toBe(2);
    // config.ts grows after the folder was opened: the read itself is limited to the bytes left.
    const chosen = Buffer.byteLength(files['src/order.ts']);
    writeFileSync(path.join(root, 'src/config.ts'), `export const LIMIT = 10;\n// ${'x'.repeat(400)}\n`);
    const limited = await readProjectCode(root, project.files, target, newStopSlots(), { ...SHAPE_LIMITS, projectBytes: chosen + 100 });
    expect(limited.texts.has(path.join(root, 'src/config.ts'))).toBe(false);
    expect([...limited.notes]).toEqual(['프로젝트 파일 일부를 읽지 않았어요(한도를 넘었거나 지금 규칙으로 읽을 수 없음). 그 파일에서 오는 모양은 any로 보일 수 있어요.']);
    expect([...limited.texts.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(chosen + 100);
  });

  it('notes the limits of files read', async () => {
    const found = await shapesOf('src/order.ts', 'makeOrder', { ...SHAPE_LIMITS, typeFiles: 1 });
    expect(found.notes).toContain('외부 패키지 타입 파일이 한도(5,000개·64 MiB·파일당 4 MiB)를 넘어 일부를 읽지 않았어요. 그 부분은 any로 보일 수 있어요.');
    const small = await shapesOf('src/order.ts', 'makeOrder', { ...SHAPE_LIMITS, projectBytes: 1200 });
    expect(small.names.LIMIT).toBe('? 가져온 대상을 타입 검사기가 찾지 못했어요.');
    expect(small.notes.length).toBe(1);
  });

  it('stops when asked, before or during the checker, and leaves no checker process', async () => {
    const target = await targetOf('src/order.ts', 'makeOrder');
    const before = newStopSlots();
    requestStop(before);
    await expect(findValueShapes(root, project.id, project.files, target, [], before)).rejects.toMatchObject({ code: 'CANCELLED' });
    // The checker's requests block this thread, so the stop comes from another one, as from the session: it waits for
    // the process number, then does what requestStop does (side-stop.ts) and reports the number it ended.
    const during = newStopSlots();
    const stopper = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const slots = new Int32Array(workerData);
      while (!Atomics.load(slots, 1)) Atomics.wait(slots, 1, 0, 1);
      Atomics.store(slots, 0, 1);
      const pid = Atomics.exchange(slots, 1, 0);
      if (pid > 0) process.kill(pid, 'SIGKILL');
      Atomics.store(slots, 2, 1);
      Atomics.notify(slots, 2);
      parentPort.postMessage(pid);`, { eval: true, workerData: during.buffer });
    const ended = new Promise<number>(resolve => stopper.once('message', resolve));
    await expect(findValueShapes(root, project.id, project.files, target, [], during)).rejects.toMatchObject({ code: 'CANCELLED' });
    const pid = await ended;
    await stopper.terminate();
    expect(pid).toBeGreaterThan(0);
    expect(Atomics.load(during, 1)).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});

describe('dependency type files (plan v2.3 V-2 reading rules)', () => {
  async function callbacks() {
    const target = await targetOf('src/order.ts', 'makeOrder');
    const code = await readProjectCode(root, project.files, target, newStopSlots(), SHAPE_LIMITS);
    return fileCallbacks(root, code.texts, code.allowedDirs, '/nowhere/lib/', newStopSlots(), SHAPE_LIMITS);
  }

  it('answers only what the rules allow, in reading and in listing', async () => {
    const { callbacks: fs } = await callbacks();
    expect(fs.readFile!(at('node_modules/pricing/index.d.ts'))).toContain('discount');
    expect(fs.readFile!(at('node_modules/js-only/index.js'))).toBeNull();
    expect(fs.readFile!(at('node_modules/vault-pkg/credentials/index.d.ts'))).toBeNull();
    expect(fs.readFile!(at('node_modules/outside-link/index.d.ts'))).toBeNull();
    expect(fs.readFile!(at('node_modules/hard-pkg/index.d.ts'))).toBeNull();
    expect(fs.readFile!(at('src/hidden.ts'))).toBeNull();
    expect(fs.readFile!(path.join(outsideDir, 'outside-link/index.d.ts'))).toBeNull();
    expect(fs.readFile!(at('node_modules/pnpm-style/index.d.ts'))).toContain('ok: true');
    expect(fs.fileExists!(at('node_modules/vault-pkg/credentials/index.d.ts'))).toBe(false);
    expect(fs.directoryExists!(at('node_modules/vault-pkg/credentials'))).toBe(false);
    expect(fs.directoryExists!(at('node_modules/outside-link'))).toBe(false);
    expect(fs.directoryExists!(path.dirname(root))).toBe(true);
    expect(fs.fileExists!(path.join(path.dirname(root), 'tsconfig.json'))).toBe(false);
    expect(fs.getAccessibleEntries!(at('node_modules/vault-pkg'))).toEqual({ files: ['package.json'], directories: [] });
    expect(fs.getAccessibleEntries!(at('node_modules/js-only'))).toEqual({ files: ['package.json'], directories: [] });
    const top = fs.getAccessibleEntries!(root)!;
    expect(top.files.sort()).toEqual(['tsconfig.json']);
    expect(top.directories.sort()).toEqual(['node_modules', 'packages', 'src']);
    expect(fs.getAccessibleEntries!(at('src'))!.files).not.toContain('hidden.ts');
    expect(fs.realpath!(at('node_modules/pnpm-style'))).toBe(slashed(at('node_modules/.pnpm/pnpm-style@1.0.0/node_modules/pnpm-style')));
  });

  it('answers checker paths with forward slashes and a lowercase drive letter the same as app paths', async () => {
    const { callbacks: fs } = await callbacks();
    for (const relative of ['src/order.ts', 'node_modules/pricing/index.d.ts', 'node_modules/pnpm-style/index.d.ts', 'src/hidden.ts']) {
      const name = at(relative);
      expect(fs.readFile!(checkerName(name))).toBe(fs.readFile!(name));
      expect(fs.fileExists!(checkerName(name))).toBe(fs.fileExists!(name));
    }
    for (const relative of ['', 'src', 'node_modules/pricing', 'node_modules/pnpm-style']) {
      const name = at(relative);
      expect(fs.getAccessibleEntries!(checkerName(name))).toEqual(fs.getAccessibleEntries!(name));
    }
  });

  it('leaves checker library paths with a lowercase drive letter to the real file system', () => {
    const libDir = (path.join(outsideDir, 'lib') + path.sep).replace(/^[A-Z]:/, drive => drive.toLowerCase());
    const { callbacks: fs } = fileCallbacks(root, new Map(), new Set(['']), libDir, newStopSlots(), SHAPE_LIMITS);
    const libFile = checkerName(path.join(libDir, 'lib.es5.d.ts'));
    expect(fs.readFile!(libFile)).toBeUndefined();
    expect(fs.fileExists!(libFile)).toBeUndefined();
    expect(fs.directoryExists!(libFile)).toBeUndefined();
    expect(fs.getAccessibleEntries!(libFile)).toBeUndefined();
  });

  it('refuses dependency types inside a folder excluded now, in reading and in listing', async () => {
    await writeFile(path.join(root, '.gitignore'), 'src/hidden.ts\npackages/a/\n');
    const { callbacks: fs } = await callbacks();
    expect(fs.readFile!(at('packages/a/node_modules/a-dep/index.d.ts'))).toBeNull();
    expect(fs.directoryExists!(at('packages/a/node_modules'))).toBe(false);
    expect(fs.getAccessibleEntries!(at('packages'))).toEqual({ files: [], directories: [] });
  });

  it.skipIf(process.platform === 'win32')('reads a type file without waiting on a named pipe, and catches a swap to one', () => {
    const real = at('node_modules/pricing/index.d.ts');
    execFileSync('mkfifo', [at('node_modules/pricing/fifo.d.ts')]);
    expect(() => readTypeFile(root, at('node_modules/pricing/fifo.d.ts'))).toThrow(expect.objectContaining({ code: 'NOT_ALLOWED' }));
    expect(() => readTypeFile(root, real, undefined, { beforeOpen: () => {
      unlinkSync(real);
      execFileSync('mkfifo', [real]);
    } })).toThrow(expect.objectContaining({ code: 'CHANGED' }));
  });

  it('reads a type file the way readStable does: changes while reading are caught', () => {
    const real = at('node_modules/pricing/index.d.ts');
    expect(readTypeFile(root, real).text).toContain('discount');
    rmSync(real);
    writeFileSync(real, 'export declare const x: 1;\n');
    expect(() => readTypeFile(root, real, undefined, { afterRead: () => appendFileSync(real, '// more\n') }))
      .toThrow(expect.objectContaining({ code: 'CHANGED' }));
    expect(() => readTypeFile(root, real, 4)).toThrow(expect.objectContaining({ code: 'LIMIT' }));
  });

  it.skipIf(process.platform === 'win32')('catches a folder swapped while a type file is read', () => {
    const real = at('node_modules/pricing/index.d.ts');
    rmSync(real);
    writeFileSync(real, 'export declare const x: 1;\n// more\n');
    expect(() => readTypeFile(root, real, undefined, { afterRead: () => {
      renameSync(at('node_modules/pricing'), at('node_modules/pricing-old'));
      mkdirSync(at('node_modules/pricing'));
      writeFileSync(real, 'export declare const x: 1;\n// more\n');
    } })).toThrow(expect.objectContaining({ code: 'CHANGED' }));
  });

  it('stops the checker with CHANGED when a link passed on the way is pointed elsewhere while reading', async () => {
    const target = await targetOf('src/order.ts', 'makeOrder');
    const code = await readProjectCode(root, project.files, target, newStopSlots(), SHAPE_LIMITS);
    const link = at('node_modules/pnpm-style');
    // Reinstalling another version re-points the link; the old version's files stay, so only the link tells.
    const { callbacks: fs, stopCode } = fileCallbacks(root, code.texts, code.allowedDirs, '/nowhere/lib/', newStopSlots(), SHAPE_LIMITS,
      { afterRead: () => { unlinkSync(link); symlinkSync('.pnpm/pnpm-style@2.0.0/node_modules/pnpm-style', link, 'dir'); } });
    expect(() => fs.readFile!(at('node_modules/pnpm-style/index.d.ts'))).toThrow('CHANGED');
    expect(stopCode()).toBe('CHANGED');
  });
});

describe('one side takes the checker process number (side-stop.ts)', () => {
  it('lets the session end the process when it takes the number first; the worker then sends nothing', () => {
    const slots = newStopSlots();
    publishProcess(slots, 4242);
    const kills: number[] = [];
    requestStop(slots, pid => { kills.push(pid); });
    expect(kills).toEqual([4242]);
    expect(stopRequested(slots)).toBe(true);
    expect(takeProcess(slots, 4242)).toBe(false);
  });

  it('lets the worker end the process when it takes the number first; the session then sends nothing', () => {
    const slots = newStopSlots();
    publishProcess(slots, 4242);
    expect(takeProcess(slots, 4242)).toBe(true);
    const kills: number[] = [];
    requestStop(slots, pid => { kills.push(pid); });
    expect(kills).toEqual([]);
  });

  it('holds the worker back, when the session has taken the number, until the session has sent its signal', async () => {
    const slots = newStopSlots();
    publishProcess(slots, 4242);
    // A stand-in for the session caught half way: the number taken, the signal sent 200 ms later.
    const halfway = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const slots = new Int32Array(workerData);
      Atomics.store(slots, 0, 1);
      Atomics.exchange(slots, 1, 0);
      parentPort.postMessage('taken');
      setTimeout(() => { Atomics.store(slots, 2, 1); Atomics.notify(slots, 2); }, 200);`, { eval: true, workerData: slots.buffer });
    await new Promise(resolve => halfway.once('message', resolve));
    const started = Date.now();
    expect(takeProcess(slots, 4242)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await halfway.terminate();
  });
});

describe('shape queries from V-1 names (plan v2.3 V-2 request limits)', () => {
  const name = (value: string, at = 1) => ({ group: 'inside' as const, name: value, role: 'const' as const, shape: 'plain' as const,
    declaredAt: { fileId: 'f', fileHash: 'h', startUtf16: at, endUtf16: at + 1, startLine: 1, endLine: 1, text: value },
    type: null, fixed: null, initial: null, assignments: [], index: null, outerFunction: null, unknown: null, external: null, notes: [] });

  it('asks up to 500 names of up to 200 characters, and says why the others are not asked', () => {
    const exact = shapeQueries(Array.from({ length: 500 }, (_, i) => name(`n${i}`, i)), 'f');
    expect(exact.queries.length).toBe(500);
    expect(exact.slots.every(slot => slot && 'query' in slot)).toBe(true);
    const over = shapeQueries(Array.from({ length: 501 }, (_, i) => name(`n${i}`, i)), 'f');
    expect(over.queries.length).toBe(500);
    expect(over.slots[500]).toEqual({ skipped: '이름이 많아 앞의 500개만 찾았어요' });
    const long = shapeQueries([name('x'.repeat(200)), name('y'.repeat(201)), name('z')], 'f');
    expect(long.queries.map(query => query.name.length)).toEqual([200, 1]);
    expect(long.slots).toEqual([{ query: 0 }, { skipped: '이름이 200자를 넘어요' }, { query: 1 }]);
  });

  it('asks no shape for a name V-1 could not settle, a class-like declaration, or one declared in another file', () => {
    const { queries, slots } = shapeQueries([{ ...name('a'), unknown: 'why' }, { ...name('b'), role: 'other' },
      { ...name('c'), declaredAt: { ...name('c').declaredAt, fileId: 'other' } },
      { ...name('d'), role: 'import', declaredAt: null, external: 'pkg' },
      { ...name('e'), role: 'import', declaredAt: { ...name('e', 7).declaredAt, fileId: 'other' } }], 'f');
    expect(slots).toEqual([null, null, null, { query: 0 }, { query: 1 }]);
    expect(queries).toEqual([{ name: 'd', at: null, expect: null }, { name: 'e', at: null, expect: { fileId: 'other', startUtf16: 7 } }]);
  });
});
