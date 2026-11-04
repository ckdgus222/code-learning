import { lstatSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { API as TsApi, Checker, Symbol as TsSymbol, Type } from 'typescript/unstable/sync';
import type { FileSystem } from 'typescript/unstable/fs';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import type { ProjectFile, Shape, ShapeQuery, ValueShapes } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { inDependencyFolder, isTypeFileName, MAX_FILE_BYTES, readAllowed, readTypeFile, resolveInside, TYPE_FILE_BYTES,
  type FileState, type LinkStep } from '../project/files';
import { publishProcess, stopRequested, takeProcess } from './side-stop';

/*
 * Plan v2.3 V-2: the shape (type) the TypeScript checker reads from the code, for the chosen function's return value
 * and the names V-1 lists. Nothing is run. The checker (tsgo from typescript 7.0.2, pinned) runs as a process of its
 * own and asks this worker for every file through callbacks, answered under the app's rules (`fileCallbacks`).
 */

export const SHAPE_LIMITS = { files: 1000, projectBytes: 16 * 1024 * 1024, typeFiles: 5000, typeBytes: 64 * 1024 * 1024,
  typeFileBytes: TYPE_FILE_BYTES, text: 400 };
export type ShapeLimits = typeof SHAPE_LIMITS;
export interface ShapesTarget { fileId: string; fileHash: string; startUtf16: number; endUtf16: number }
/** The dependency type files read and the links passed on the way, for the session to watch. */
export interface TypeWatch { files: (FileState & { path: string })[]; links: LinkStep[] }

const codeExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const projectNote = '프로젝트 파일 일부를 읽지 않았어요(한도를 넘었거나 지금 규칙으로 읽을 수 없음). 그 파일에서 오는 모양은 any로 보일 수 있어요.';
const typeLimitNote = '외부 패키지 타입 파일이 한도(5,000개·64 MiB·파일당 4 MiB)를 넘어 일부를 읽지 않았어요. 그 부분은 any로 보일 수 있어요.';
const configNote = '설정 파일(tsconfig 등)에 오류가 있어 모양이 실제 설정과 다를 수 있어요.';
const cancelled = () => new AppError('CANCELLED', '작업을 취소했습니다.');

export async function findValueShapes(root: string, projectId: string, files: ProjectFile[], target: ShapesTarget,
  queries: ShapeQuery[], slots: Int32Array, limits: ShapeLimits = SHAPE_LIMITS): Promise<{ shapes: ValueShapes; watch: TypeWatch }> {
  root = native(root);
  const project = await readProjectCode(root, files, target, slots, limits);
  const [{ API, NodeBuilderFlags, SymbolFlags }, { SyntaxKind }] = await Promise.all([
    import('typescript/unstable/sync'), import('typescript/unstable/ast')]);
  const tsgo = tsgoPaths();
  const checkerFiles = fileCallbacks(root, project.texts, project.allowedDirs, tsgo.libDir, slots, limits);

  // From here until the process is taken back there is no await: see side-stop.ts.
  const api = new API({ cwd: root, tsserverPath: tsgo.exe, fs: checkerFiles.callbacks });
  let child: ChildProcess;
  try { child = processOf(api); }
  catch (error) { try { api.close(); } catch { /* not started */ } throw error; }
  const pid = child.pid!;
  const exited = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  publishProcess(slots, pid);
  let shapes: ValueShapes | undefined;
  let failed: unknown;
  try {
    if (stopRequested(slots)) throw cancelled();
    shapes = ask(api);
  } catch (error) { failed = error; }
  if (takeProcess(slots, pid)) child.kill('SIGKILL');
  // The API's channel unrefs the process; ref it so this thread waits for its exit before replying.
  child.ref();
  await exited;
  if (failed !== undefined || !shapes) {
    const code = checkerFiles.stopCode();
    if (code === 'CHANGED') throw new AppError('CHANGED', '모양을 찾는 동안 타입 파일이 바뀌었어요. 다시 찾아 주세요.');
    if (code === 'CANCELLED' || stopRequested(slots)) throw cancelled();
    if (failed instanceof AppError) throw failed;
    throw new AppError('INTERNAL', '값의 모양을 찾지 못했어요.');
  }
  return { shapes: { ...shapes, notes: [...new Set([...shapes.notes, ...project.notes, ...checkerFiles.notes])] }, watch: checkerFiles.watch };

  function ask(api: TsApi): ValueShapes {
    const chosen = slashed(path.join(root, project.chosen.relativePath));
    const snapshot = api.updateSnapshot({ openFiles: [chosen] });
    checkerFiles.checkStop();
    const opened = snapshot.getDefaultProjectForFile(chosen);
    const source = opened?.program.getSourceFile(chosen);
    if (!opened || !source) throw new AppError('INTERNAL', '값의 모양 분석기가 이 파일을 열지 못했어요.');
    const { checker } = opened;

    const shapeOf = (type: Type | undefined): Shape => {
      if (!type) return { unknown: '타입 검사기가 모양을 정하지 못했어요.' };
      const printed = checker.typeToString(type);
      const text = printed.length > limits.text ? `${printed.slice(0, limits.text)}…(길어서 줄였어요)` : printed;
      // A real `any` in the type as printed, looked for in the untruncated type tree: not the text "any". Named
      // types (an alias, an interface) are not opened up, as the printed shape does not open them either.
      const tree = checker.typeToTypeNode(type, undefined, NodeBuilderFlags.NoTruncation);
      const hasAny = (node: Node): boolean => node.kind === SyntaxKind.AnyKeyword || !!node.forEachChild(hasAny);
      return { text, hasAny: !!tree && hasAny(tree) };
    };
    const unalias = (symbol: TsSymbol) => symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

    const returns = returnShape(checker, source, shapeOf);
    const names = queries.map((query): Shape => {
      checkerFiles.checkStop();
      if (query.at === null) return importShape(checker, source, query, unalias, shapeOf, file => !!opened.program.getSourceFile(file));
      const symbol = checker.getSymbolAtPosition(chosen, query.at);
      if (!symbol || symbol.name !== query.name) return { unknown: '이름 위치가 맞지 않아 모양을 찾지 않았어요.' };
      return shapeOf(checker.getTypeOfSymbol(symbol));
    });
    const notes = opened.program.getConfigFileParsingDiagnostics().length ? [configNote] : [];
    return { projectId, fileId: target.fileId, fileHash: target.fileHash, startUtf16: target.startUtf16, endUtf16: target.endUtf16,
      returns, names, notes };
  }

  /**
   * The chosen function in the checker's tree: a function that ends where it ends and starts at or before it (the
   * analyzer leaves `export` out of a function, the checker keeps it in); the innermost of those.
   */
  function returnShape(checker: Checker, source: SourceFile, shapeOf: (type: Type | undefined) => Shape): Shape {
    const kinds = new Set([SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction,
      SyntaxKind.MethodDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.Constructor]);
    let found: Node | null = null;
    const visit = (node: Node): void => {
      if (node.pos > target.endUtf16 || node.end < target.endUtf16) return;
      if (kinds.has(node.kind) && node.end === target.endUtf16 && node.getStart() <= target.startUtf16 &&
          (!found || node.getStart() >= found.getStart())) found = node;
      node.forEachChild(visit);
    };
    visit(source);
    const signature = found && checker.getSignatureFromDeclaration(found);
    if (!signature) return { unknown: '타입 검사기에서 이 함수를 찾지 못했어요.' };
    return shapeOf(checker.getReturnTypeOfSignature(signature));
  }

  /** An imported name: its one import binding in the chosen file, followed to what it imports. */
  function importShape(checker: Checker, source: SourceFile, query: ShapeQuery, unalias: (symbol: TsSymbol) => TsSymbol,
    shapeOf: (type: Type | undefined) => Shape, inProgram: (file: string) => boolean): Shape {
    type Named = Node & { text: string };
    const bindings: Node[] = [];
    for (const statement of source.statements) {
      if (statement.kind !== SyntaxKind.ImportDeclaration) continue;
      const clause = (statement as unknown as { importClause?: { name?: Named; namedBindings?: Node & { name?: Named; elements?: readonly (Node & { name: Named })[] } } }).importClause;
      if (clause?.name?.text === query.name) bindings.push(clause.name);
      const named = clause?.namedBindings;
      if (named?.kind === SyntaxKind.NamespaceImport && named.name?.text === query.name) bindings.push(named.name);
      for (const element of named?.kind === SyntaxKind.NamedImports ? named.elements ?? [] : []) {
        if (element.name.text === query.name) bindings.push(element.name);
      }
    }
    const local = bindings.length === 1 ? checker.getSymbolAtLocation(bindings[0]) : undefined;
    if (!local) return { unknown: '가져온 이름을 타입 검사기에서 하나로 찾지 못했어요.' };
    const imported = unalias(local);
    if (checker.isUnknownSymbol(imported)) return { unknown: '가져온 대상을 타입 검사기가 찾지 못했어요.' };
    if (query.expect) {
      // V-1 followed this import to a declaration: a shape only when the checker found that same one.
      const file = files.find(item => item.id === query.expect!.fileId);
      const at = file && slashed(path.join(root, file.relativePath));
      // Asking about a file outside the checker's program is an error, not an empty answer.
      const expected = at && inProgram(at) ? checker.getSymbolAtPosition(at, query.expect.startUtf16) : undefined;
      const same = (a: TsSymbol, b: TsSymbol) => a.id === b.id || a.getExportSymbol().id === b.getExportSymbol().id;
      if (!expected || !same(unalias(expected), imported)) {
        return { unknown: '타입 검사기가 찾은 선언이 값 따라가기의 선언과 같은지 확인하지 못해 모양을 붙이지 않았어요.' };
      }
    }
    return shapeOf(checker.getTypeOfSymbol(imported));
  }
}

/**
 * The project's code files, read now under the current rules through readAllowed: the chosen file first, then in
 * path order within the map's limits. Folders allowed now are those of the files read and their parents, and the
 * project folder (''): readAllowed checks every part of a path against the current exclusions and .gitignore.
 */
export async function readProjectCode(root: string, files: ProjectFile[], target: ShapesTarget, slots: Int32Array, limits: ShapeLimits) {
  const chosen = files.find(file => file.id === target.fileId);
  if (!chosen) throw new AppError('NOT_ALLOWED', '현재 프로젝트에 등록된 파일이 아닙니다.');
  const isCode = (file: ProjectFile) => codeExtensions.has(path.extname(file.relativePath).toLowerCase());
  if (!isCode(chosen)) throw new AppError('UNSUPPORTED', '타입 검사기가 읽는 코드 파일이 아니에요.');
  const texts = new Map<string, string>();
  const allowedDirs = new Set<string>(['']);
  const notes = new Set<string>();
  let bytes = 0;
  for (const file of [chosen, ...files.filter(file => file !== chosen && isCode(file))]) {
    if (stopRequested(slots)) throw cancelled();
    // The size listed when the folder opened may be old: the bytes left are the limit of the read itself.
    const left = limits.projectBytes - bytes;
    if (texts.size >= limits.files || left <= 0) { notes.add(projectNote); continue; }
    let read: { text: string; hash: string };
    try { read = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left)); }
    catch (error) {
      if (file === chosen) throw error;
      notes.add(projectNote);
      continue;
    }
    if (file === chosen && read.hash !== target.fileHash) throw new AppError('CHANGED', '코드가 바뀌었어요. 파일을 다시 읽고 함수를 골라 주세요.');
    texts.set(path.join(root, file.relativePath), read.text);
    bytes += Buffer.byteLength(read.text);
    for (let dir = path.posix.dirname(file.relativePath); dir !== '.'; dir = path.posix.dirname(dir)) allowedDirs.add(dir);
  }
  return { chosen, texts, allowedDirs, notes };
}

// The checker writes paths with / on every OS, and a file it opened with a lowercase drive letter (c:/Users/…). The
// app's paths use the OS separator and an uppercase drive letter (C:\Users\…); both sides go through native() to compare.
const native = (name: string) => path.sep === '/' ? name : name.replaceAll('/', path.sep).replace(/^[a-z]:/, drive => drive.toUpperCase());
const slashed = (name: string) => path.sep === '/' ? name : name.replaceAll(path.sep, '/');

/**
 * How every file question of the checker is answered. A project file: only the ones read now. A dependency type
 * file: under the user's exception (files.ts), read here. The checker's own lib folder is the one place left to the
 * real file system. Anything else does not exist. A callback can only stop the checker's request by throwing, so
 * why it stopped is kept (`stopCode`).
 */
export function fileCallbacks(root: string, texts: ReadonlyMap<string, string>, allowedDirs: ReadonlySet<string>, libDir: string,
  slots: Int32Array, limits: ShapeLimits, readHooks?: Parameters<typeof readTypeFile>[3]) {
  root = native(root);
  libDir = native(libDir);
  const watch: TypeWatch = { files: [], links: [] };
  const watchedLinks = new Set<string>();
  // One answer per real file: a package reached through a link and through its real path gives the same text, and
  // a file left out for a limit (null) is not read again.
  const typeTexts = new Map<string, string | null>();
  const notes = new Set<string>();
  let typeBytes = 0;
  let stopCode: 'CANCELLED' | 'CHANGED' | null = null;
  const halt = (code: 'CANCELLED' | 'CHANGED'): never => { stopCode ??= code; throw new Error(code); };
  const checkStop = () => { if (stopRequested(slots)) halt('CANCELLED'); };
  const own = (name: string) => name.startsWith(libDir) || name + path.sep === libDir;
  const relativeOf = (name: string) =>
    name === root ? '' : name.startsWith(root + path.sep) && path.resolve(name) === name ? slashed(name.slice(root.length + 1)) : null;
  const aboveRoot = (name: string) => name === path.sep || root.startsWith(name.endsWith(path.sep) ? name : name + path.sep);
  const isFileAt = (real: string) => { try { return lstatSync(real).isFile(); } catch { return false; } };
  const isDirAt = (real: string) => { try { return lstatSync(real).isDirectory(); } catch { return false; } };

  /** A path in a dependency folder, resolved to where it really is and allowed there too; links on the way are kept to watch. */
  function dependency(name: string): string | null {
    const relative = relativeOf(name);
    if (relative === null || !inDependencyFolder(relative, allowedDirs)) return null;
    const resolved = resolveInside(root, name);
    if (!resolved) return null;
    const real = relativeOf(resolved.real);
    // A link out of node_modules may lead back to a project file or folder read now (a workspace package).
    if (real === null || !(inDependencyFolder(real, allowedDirs) || texts.has(resolved.real) || allowedDirs.has(real))) return null;
    for (const link of resolved.links) {
      if (!watchedLinks.has(link.path)) { watchedLinks.add(link.path); watch.links.push(link); }
    }
    return resolved.real;
  }

  const callbacks: FileSystem = {
    readFile(name) {
      name = native(name);
      checkStop();
      if (own(name)) return undefined;
      const text = texts.get(name);
      if (text !== undefined) return text;
      const real = dependency(name);
      if (!real) return null;
      if (texts.has(real)) return texts.get(real)!;
      if (!isTypeFileName(path.basename(real))) return null;
      const known = typeTexts.get(real);
      if (known !== undefined) return known;
      const left = limits.typeBytes - typeBytes;
      if (watch.files.length >= limits.typeFiles || left <= 0) { notes.add(typeLimitNote); typeTexts.set(real, null); return null; }
      let read: ReturnType<typeof readTypeFile>;
      // The bytes left are the limit of the read itself, so a file over them is not read at all.
      try { read = readTypeFile(root, real, Math.min(limits.typeFileBytes, left), readHooks); }
      catch (error) {
        if (error instanceof AppError && error.code === 'CHANGED') halt('CHANGED');
        if (error instanceof AppError && error.code === 'LIMIT') { notes.add(typeLimitNote); typeTexts.set(real, null); }
        return null;
      }
      // A link passed on the way may have been pointed elsewhere while the file was read.
      if (resolveInside(root, name)?.real !== real) halt('CHANGED');
      typeBytes += read.state.size;
      watch.files.push({ path: real, ...read.state });
      typeTexts.set(real, read.text);
      return read.text;
    },
    fileExists(name) {
      name = native(name);
      checkStop();
      if (own(name)) return undefined;
      if (texts.has(name)) return true;
      const real = dependency(name);
      return !!real && (texts.has(real) || (isTypeFileName(path.basename(real)) && isFileAt(real)));
    },
    directoryExists(name) {
      name = native(name);
      checkStop();
      if (own(name)) return undefined;
      // The checker looks up through parent folders for settings; nothing in them is shown to it.
      if (aboveRoot(name)) return true;
      const relative = relativeOf(name);
      if (relative === null) return false;
      if (allowedDirs.has(relative)) return true;
      const real = dependency(name);
      return !!real && isDirAt(real);
    },
    /** A project folder lists the files read now; a dependency folder lists from disk what the rules allow. */
    getAccessibleEntries(name) {
      name = native(name);
      checkStop();
      if (own(name)) return undefined;
      const relative = relativeOf(name);
      if (relative === null) return { files: [], directories: [] };
      if (allowedDirs.has(relative)) {
        const prefix = relative ? relative + '/' : '';
        const childOf = (item: string) => item.startsWith(prefix) && item.length > prefix.length && !item.slice(prefix.length).includes('/');
        const filesHere = [...texts.keys()].map(file => slashed(file.slice(root.length + 1))).filter(childOf).map(file => file.slice(prefix.length));
        const directories = [...allowedDirs].filter(childOf).map(dir => dir.slice(prefix.length));
        const modules = dependency(path.join(name, 'node_modules'));
        if (modules && isDirAt(modules)) directories.push('node_modules');
        return { files: filesHere, directories };
      }
      const real = dependency(name);
      const entries = { files: [] as string[], directories: [] as string[] };
      if (!real || !isDirAt(real)) return entries;
      let listed;
      try { listed = readdirSync(real, { withFileTypes: true }); } catch { return entries; }
      for (const entry of listed) {
        const child = dependency(path.join(name, entry.name));
        if (!child) continue;
        if (isDirAt(child)) entries.directories.push(entry.name);
        else if ((isTypeFileName(path.basename(child)) || texts.has(child)) && isFileAt(child)) entries.files.push(entry.name);
      }
      return entries;
    },
    realpath(checkerName) {
      const name = native(checkerName);
      checkStop();
      if (own(name)) return undefined;
      const real = dependency(name);
      return real ? slashed(real) : checkerName;
    },
  };
  return { callbacks, watch, notes, checkStop, stopCode: () => stopCode };
}

/** The tsgo binary for this platform and the folder of its own `lib.*.d.ts` files, outside the app archive. */
function tsgoPaths(): { exe: string; libDir: string } {
  // The worker bundle is CommonJS, where import.meta is left empty; the tests load this file as an ES module.
  const resolver = typeof require === 'function' ? require : createRequire(import.meta.url);
  const manifest = resolver.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
  // A packaged app keeps it unpacked next to the archive (forge.config.ts), where it can run and be read directly.
  const unpacked = path.dirname(manifest).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const libDir = path.join(unpacked, 'lib');
  return { exe: path.join(libDir, process.platform === 'win32' ? 'tsc.exe' : 'tsc'), libDir: native(libDir + path.sep) };
}

/** The tsgo process behind the API. Not public in typescript 7.0.2 (pinned); any other form fails closed. */
function processOf(api: TsApi): ChildProcess {
  const child = (api as unknown as { client?: { channel?: { child?: ChildProcess } } }).client?.channel?.child;
  if (!child || !Number.isInteger(child.pid) || child.pid! <= 0) throw new AppError('INTERNAL', '값의 모양 분석기를 시작하지 못했어요.');
  return child;
}
