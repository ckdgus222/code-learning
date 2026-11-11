import path from 'node:path';
import type Parser from 'tree-sitter';
import { COMPLEXITY_LIMITS, type MapExport, type MapFile, type MapImport, type ProjectFile, type ProjectMap } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { assertAllowedFile, MAX_FILE_BYTES, readAllowed, textExtensions } from '../project/files';
import { classTypes, functionName, functionTypes, importOf, measureFunction, namedFunction, parse } from './syntax';
import { readPathAliases, resolveImport } from './path-aliases';
import { scriptFilesOf, unusedFiles } from './unused-files';
import { readingOrder } from './reading-order';
import { initFactsOf, mentionsMachinery, pythonImportsOf, resolvePythonImport, type InitFacts, type PythonImport } from './python-imports';
import { declarationName, measurePythonFunction, pythonFunction } from './python-syntax';
import { clip } from './syntax-tools';

export const codeFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
export const pythonFile = /\.py$/i;
// The files the map reads. `codeFile` keeps meaning TS/JS only: the TS/JS-only analyses filter by it.
const mapFile = (relativePath: string) => codeFile.test(relativePath) || pythonFile.test(relativePath);
// Plan v2.3 A: a relative path without an extension may name one of these files or its folder's index file.
// TS importers also consider the TS counterpart of an explicit JS extension; multiple files stay ambiguous.
export const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_TEXT = 300;

export interface MapLimits {
  files: number;
  bytes: number;
  nodesPerFile: number;
  /**
   * Characters of import material one map may keep. Counted separately, each against this number, for:
   * TS/JS results (imports and exports), the Python statements kept while files are read, and Python results.
   */
  results: number;
  /** Characters of hard functions one map may list, all languages together. */
  functions: number;
  /** Characters of function and class names one map may list for the search, all languages together. */
  symbols: number;
}
// Files as many as the folder scan allows; 16 MiB confirmed by the user (2026-10-19) so a large project
// still finishes inside the map worker's 30 seconds; the node budget keeps one huge file from taking it all.
// The result sizes keep a folder of nothing but imports from making a map many times larger than the code it
// was read from: 8,000,000 (confirmed by the user, 2026-11-11) is about five times what 1,000 files as
// dense as this repository yield.
export const MAP_LIMITS: MapLimits = { files: 1000, bytes: 16 * 1024 * 1024, nodesPerFile: 200_000, results: 8_000_000, functions: 500_000, symbols: 4_000_000 };

/** Binding names only: object keys and default-value expressions are not declarations. */
function bindingNames(pattern: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const names: Parser.SyntaxNode[] = [];
  const pending = pattern ? [pattern] : [];
  while (pending.length) {
    const part = pending.pop()!;
    if (part.type === 'identifier' || part.type === 'type_identifier' || part.type === 'shorthand_property_identifier_pattern') { names.push(part); continue; }
    if (part.type === 'pair_pattern') { const value = part.childForFieldName('value'); if (value) pending.push(value); continue; }
    if (part.type === 'assignment_pattern' || part.type === 'object_assignment_pattern') {
      const left = part.childForFieldName('left');
      if (left) pending.push(left);
      continue;
    }
    if (['rest_pattern', 'object_pattern', 'array_pattern'].includes(part.type)) pending.push(...part.namedChildren.toReversed());
  }
  return names;
}

type ExportDeclaration = { node: Parser.SyntaxNode; local: string | null; kind: MapExport['kind'] };

/** Every import node and every function the analyzer would list, in source order, and whether the whole tree was examined. */
function scanTree(text: string, relativePath: string, nodeBudget: number) {
  const root = parse(text, relativePath);
  const found: { node: Parser.SyntaxNode; kind: 'static' | 'not-static' | 'syntax'; specifier: string | null }[] = [];
  const functions: Parser.SyntaxNode[] = [];
  const symbols: Parser.SyntaxNode[] = [];
  const declarations = new Map<string, ExportDeclaration>();
  const exported: (ExportDeclaration & { name: string })[] = [];
  const aliases: { local: string; name: string }[] = [];
  const declarationNames = new Set<number>();
  const references = new Set<string>();
  let reason: string | null = null;
  // `inBroken`: inside a function with a syntax error, which the analyzer neither lists nor goes into.
  const pending = [{ node: root, inBroken: false, exportNames: false }];
  let visited = 0;
  while (pending.length) {
    if (++visited > nodeBudget) { reason = '분석량 한도에 닿아 파일 뒷부분의 import와 함수는 보지 않았어요.'; break; }
    const { node, inBroken, exportNames } = pending.pop()!;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, inBroken, exportNames });
    // As in the analyzer, nothing inside an error node is trusted.
    if (node.isError || node.isMissing) continue;
    const imported = importOf(node);
    const variable = node.type === 'variable_declarator';
    const namedDeclaration = ['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration', 'enum_declaration'].includes(node.type);
    const names = bindingNames(variable || namedDeclaration || functionTypes.has(node.type) || node.type === 'class'
      ? node.childForFieldName('name') : ['required_parameter', 'optional_parameter'].includes(node.type) ? node.childForFieldName('pattern') : null);
    const parameter = node.type === 'arrow_function' ? node.childForFieldName('parameter') : null;
    const parameters = node.type === 'formal_parameters' ? node.namedChildren.flatMap(bindingNames) : bindingNames(parameter);
    for (const name of parameters) declarationNames.add(name.startIndex);
    for (const name of names) declarationNames.add(name.startIndex);
    const outer = variable ? node.parent?.parent : node.parent;
    const top = outer?.type === 'program' || (outer?.type === 'export_statement' && outer.parent?.type === 'program');
    if (top && !node.hasError && !(outer?.type === 'export_statement' && outer.hasError) && (variable || namedDeclaration)) {
      const kind = node.type.includes('function') ? 'function' : node.type.includes('class') ? 'class' : 'value';
      const isDefault = outer?.type === 'export_statement' && outer.children.some(child => child.type === 'default');
      for (const name of names) {
        const declaration = { node, local: name.text, kind } satisfies ExportDeclaration;
        declarations.set(name.text, declaration);
        if (outer?.type === 'export_statement') exported.push({ ...declaration, name: isDefault ? 'default' : name.text });
      }
    }
    if (node.type === 'export_statement' && node.parent?.type === 'program' && !node.hasError && !node.childForFieldName('source')
      && !node.children.some(child => child.type === 'type')) {
      const clause = node.namedChildren.find(child => child.type === 'export_clause');
      for (const item of clause?.namedChildren ?? []) {
        if (item.type !== 'export_specifier' || item.children.some(child => child.type === 'type')) continue;
        const local = item.childForFieldName('name')?.text;
        if (local) aliases.push({ local, name: item.childForFieldName('alias')?.text ?? local });
      }
    }
    // Default expressions have no declaration field; reaching the expression also respects the node budget.
    if (node.parent?.type === 'export_statement' && node.parent.parent?.type === 'program'
      && node.parent.childForFieldName('value')?.id === node.id && !node.parent.hasError) {
      const local = node.childForFieldName('name')?.text ?? (node.type === 'identifier' ? node.text : null);
      const kind = functionTypes.has(node.type) ? 'function' : node.type === 'class' ? 'class' : 'value';
      exported.push({ node, local, kind, name: 'default' });
      const name = node.childForFieldName('name');
      if (name) declarationNames.add(name.startIndex);
    }
    const defaultName = node.type === 'identifier' && node.parent?.type === 'export_statement';
    if (['identifier', 'type_identifier', 'shorthand_property_identifier'].includes(node.type)
      && !declarationNames.has(node.startIndex) && !exportNames && !defaultName) references.add(node.text);
    if (imported) found.push({ node, ...imported });
    const isFunction = functionTypes.has(node.type);
    if (isFunction && !inBroken && !node.hasError && node.childForFieldName('body')) {
      functions.push(node);
      symbols.push(node);
    }
    if (!inBroken && !node.hasError && classTypes.has(node.type) && node.childForFieldName('name')) symbols.push(node);
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild, inBroken: inBroken || (isFunction && node.hasError),
      exportNames: exportNames || node.type === 'export_clause' });
  }
  for (const alias of aliases) {
    const declaration = declarations.get(alias.local);
    if (declaration) exported.push({ ...declaration, name: alias.name });
  }
  const exports = exported.map(item => ({ name: item.name,
    displayName: item.name === 'default' && item.local ? `default (${item.local})` : item.name,
    kind: item.kind, startUtf16: item.node.startIndex, endUtf16: item.node.endIndex,
    ...linesOf(item.node), usedInFile: item.local !== null && references.has(item.local) }))
    .sort((a, b) => a.startUtf16 - b.startUtf16);
  return { found, functions, symbols, exports, reason: reason ?? (root.hasError ? '구문 오류가 있어 오류 구역 안의 import와 함수는 놓쳤을 수 있어요.' : null) };
}

// Line numbers as the analyzer's evidence gives them: a range ending at a line start does not take that line.
const linesOf = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1,
  endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)) });

const RESULT_NOTE = '지도에 담을 TS/JS import·export가 너무 많아 일부 파일만 읽었어요. 나머지 파일의 연결은 보지 않았어요.';
const PYTHON_RESULT_NOTE = 'Python import 결과가 너무 많아 일부만 적었어요. 그 뒤의 Python import는 연결을 보지 않았어요.';
const SYMBOLS_NOTE = '함수·클래스 이름이 너무 많아 일부만 모았어요. 검색에 나오지 않는 이름이 있을 수 있어요.';
const FUNCTIONS_NOTE = '어려운 함수가 너무 많아 일부만 적었어요.';
// Fixed fields of one kept entry (ids, hash, numbers) are counted as this many characters.
const ENTRY_SIZE = 100;
// A name inside an entry counts its own characters and these, for the list or set that holds it.
const NAME_SIZE = 10;

/** Characters still free for Python statements, hard functions and search names. Below zero: the rest was left out. */
interface MapRoom { imports: number; functions: number; symbols: number }

interface PythonScan {
  relativePath: string;
  statements: { evidence: MapImport; imports: PythonImport[]; syntax: boolean }[];
  functions: ProjectMap['complexFunctions'];
  symbols: ProjectMap['symbols'];
  plain: boolean;
  init: InitFacts | null;
  reason: string | null;
}

/** Retain values, never tree nodes: package facts must be known before resolving any Python import. */
function scanPython(text: string, hash: string, file: ProjectFile, nodeBudget: number, room: MapRoom): PythonScan {
  const root = parse(text, file.relativePath);
  const scan: PythonScan = { relativePath: file.relativePath, statements: [], functions: [], symbols: [], plain: false, init: null, reason: null };
  const pending = [{ node: root, inBroken: false }];
  let visited = 0;
  let machinery = false;
  while (pending.length) {
    if (++visited > nodeBudget) { scan.reason = '분석량 한도에 닿아 파일 뒷부분의 import와 함수는 보지 않았어요.'; break; }
    const { node, inBroken } = pending.pop()!;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, inBroken });
    if (node.isError || node.isMissing) continue;
    // Checked name by name inside this walk, so the node budget also bounds the check.
    if (node.type === 'identifier' && mentionsMachinery(node)) machinery = true;
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      // Counted before anything is built from it: its length in the file, an entry for each module of
      // `import a, b` (each becomes a result), and a name's share for each name of a from-import.
      const listed = node.childrenForFieldName('name').length;
      room.imports -= node.endIndex - node.startIndex + (node.type === 'import_statement'
        ? ENTRY_SIZE * Math.max(1, listed) : ENTRY_SIZE + NAME_SIZE * listed);
      if (room.imports >= 0) {
        const statement = node.text;
        scan.statements.push({ imports: pythonImportsOf(node), syntax: node.hasError,
          evidence: { fromFileId: file.id, fileHash: hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
            ...linesOf(node), text: statement.length > MAX_TEXT ? `${statement.slice(0, MAX_TEXT)}…` : statement, specifier: null } });
      }
    }
    const fn = inBroken ? null : pythonFunction(node);
    const isClass = !inBroken && node.type === 'class_definition' && !node.hasError;
    if (fn || isClass) {
      const declaration = fn?.declaration ?? (node.parent?.type === 'decorated_definition' ? node.parent : node);
      const name = fn?.name ?? declarationName(node, declaration);
      room.symbols -= name.length + ENTRY_SIZE;
      if (room.symbols >= 0) scan.symbols.push({ fileId: file.id, fileHash: hash,
        startUtf16: declaration.startIndex, endUtf16: declaration.endIndex, ...linesOf(declaration),
        name, kind: fn ? 'function' : 'class' });
    }
    const size = fn && measurePythonFunction(fn.body, text);
    if (fn && size && (size.lines > COMPLEXITY_LIMITS.lines || size.depth > COMPLEXITY_LIMITS.depth)) {
      room.functions -= fn.name.length + ENTRY_SIZE;
      if (room.functions >= 0) {
        scan.functions.push({ fileId: file.id, fileHash: hash, startUtf16: fn.declaration.startIndex, endUtf16: fn.declaration.endIndex,
          ...linesOf(fn.declaration), name: fn.name, ...size });
      }
    }
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild,
      inBroken: inBroken || (node.type === 'function_definition' && node.hasError) });
  }
  scan.reason ??= root.hasError ? '구문 오류가 있어 오류 구역 안의 import와 함수는 놓쳤을 수 있어요.' : null;
  scan.plain = !scan.reason && !machinery;
  if (!scan.reason && room.imports >= 0 && path.posix.basename(file.relativePath) === '__init__.py') {
    // Kept as long as the statements, so the names share their room, and only when all of them fit.
    // A package left without facts has its imports listed as candidates, never drawn.
    const init = initFactsOf(root);
    for (const name of init ?? []) room.imports -= name.length + NAME_SIZE;
    if (room.imports >= 0) scan.init = init;
  }
  return scan;
}

const lengthOf = (texts: string[]) => texts.reduce((total, text) => total + text.length, 0);

/** Adds the kept statements' results to the map; false when the map's size limit stopped it. */
async function settlePythonImports(scans: PythonScan[], known: Map<string, ProjectFile>, map: Omit<ProjectMap, 'unused'>,
  available: (relative: string) => Promise<boolean>, shouldStop: () => boolean, left: number): Promise<boolean> {
  // False once the next entry no longer fits.
  const fits = (size: number) => { if (size > left) return false; left -= size; return true; };
  const cancelled = () => new AppError('CANCELLED', '지도 만들기를 취소했어요.');
  const byPath = new Map(scans.map(scan => [scan.relativePath, scan]));
  const paths = new Set(known.keys());
  const facts = { init: (name: string) => byPath.get(name)?.init ?? null, plain: (name: string) => byPath.get(name)?.plain ?? false };

  /** Adds one statement's entries to the map; false when the map's size limit stopped it. */
  const settle = async (relativePath: string, { evidence, imports, syntax }: PythonScan['statements'][number]): Promise<boolean> => {
    const base = evidence.text.length + ENTRY_SIZE;
    if (syntax) {
      if (!fits(base)) return false;
      map.unresolved.push({ ...evidence, reason: 'syntax', candidates: [] });
      return true;
    }
    const seen = new Set<string>();
    // One module of the statement at a time (`import a, b, c` names several), so a cancel or the size limit
    // stops before the rest is worked out.
    for (const imported of imports) {
      for (const target of resolvePythonImport(relativePath, imported, paths, facts)) {
        if (shouldStop()) throw cancelled();
        if (target.kind === 'file' && seen.has(target.relativePath)) continue;
        const size = base + target.specifier.length + (target.kind === 'unresolved'
          ? (target.reasonText?.length ?? 0) + lengthOf(target.candidates)
          : target.kind === 'file' && target.names !== 'all' ? lengthOf(target.names) : 0);
        if (!fits(size)) return false;
        const item = { ...evidence, specifier: target.specifier };
        if (target.kind === 'external') { map.external.push(item); continue; }
        if (target.kind === 'unresolved') {
          map.unresolved.push({ ...item, reason: target.reason, candidates: target.candidates, reasonText: target.reasonText });
          continue;
        }
        seen.add(target.relativePath);
        if (!await available(target.relativePath)) {
          map.unresolved.push({ ...item, reason: 'unavailable', candidates: [target.relativePath] });
          continue;
        }
        map.edges.push({ ...item, toFileId: known.get(target.relativePath)!.id, names: target.names });
      }
    }
    return true;
  };

  for (const scan of scans) {
    for (const statement of scan.statements) {
      // One file can hold very many imports, so a cancel is checked for each statement and each result.
      if (shouldStop()) throw cancelled();
      if (!await settle(scan.relativePath, statement)) return false;
    }
  }
  return true;
}

export const isRelative = (specifier: string) =>
  specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

/**
 * The allowed files a relative specifier may name, or null when it leaves the project folder. A path
 * ending in `/`, `.` or `..` (`./foo/`, `./foo/.`, `./a/..`) names a folder, so only its index file fits. A path ending in a listed
 * file type (`./b.js`, `./s.css`) names only itself; any other name, including a dotted one like
 * `./vite.config`, may also name a code file or its folder's index file.
 */
export function candidatesFor(fromPath: string, specifier: string, known: Map<string, ProjectFile>): string[] | null {
  const last = specifier.split('/').at(-1);
  const folderOnly = last === '' || last === '.' || last === '..';
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier)).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../')) return null;
  const base = joined === '.' ? '' : joined;
  const indexes = EXTENSIONS.map(extension => `${base ? `${base}/` : ''}index${extension}`);
  const names = folderOnly ? indexes : textExtensions.has(path.posix.extname(base).toLowerCase()) ? [base]
    : [base, ...EXTENSIONS.map(extension => base + extension), ...indexes];
  if (!folderOnly && /\.(?:ts|tsx|mts|cts)$/i.test(fromPath)) {
    const extension = path.posix.extname(base).toLowerCase();
    const counterparts: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
    for (const replacement of counterparts[extension] ?? []) names.push(base.slice(0, -extension.length) + replacement);
  }
  return [...new Set(names)].filter(name => !/\.d\.(?:ts|mts|cts)$/i.test(name) && known.has(name));
}

/**
 * Who imports whom, read from the files the folder scan allowed (their IDs are the ones the open
 * session knows). Files are only read; an arrow is drawn only when exactly one file fits.
 */
export async function buildProjectMap(root: string, projectId: string, files: ProjectFile[], startFileIds: string[],
  limits: MapLimits = MAP_LIMITS, shouldStop: () => boolean = () => false, entryFileIds: string[] = []): Promise<ProjectMap> {
  const known = new Map(files.map(file => [file.relativePath, file]));
  const starts = new Set(startFileIds);
  const entries = new Set(entryFileIds);
  const placed = new Map<string, MapFile>();
  const place = (file: ProjectFile, checked: MapFile['checked'], reason: string | null) => {
    const folder = path.posix.dirname(file.relativePath);
    placed.set(file.id, { id: file.id, relativePath: file.relativePath, folder: folder === '.' ? '' : folder,
      start: starts.has(file.id), entry: entries.has(file.id), checked, reason });
  };
  const map: Omit<ProjectMap, 'unused'> = { projectId, files: [], edges: [], unresolved: [], external: [], complexFunctions: [], symbols: [], symbolsCut: false, exports: [], limited: false, notes: [],
    reading: { steps: [], total: 0, incomplete: false } };
  // A target may have been deleted, excluded or swapped for a link since the folder was opened.
  const availability = new Map<string, Promise<boolean>>();
  const available = (relative: string): Promise<boolean> => {
    if (!availability.has(relative)) availability.set(relative, assertAllowedFile(root, relative).then(() => true, () => false));
    return availability.get(relative)!;
  };

  const python: PythonScan[] = [];
  const room: MapRoom = { imports: limits.results, functions: limits.functions, symbols: limits.symbols };
  // The one gate every TS/JS export and import result passes before it is kept. Once it has failed it
  // keeps failing, so nothing smaller slips in after what was left out.
  let resultsLeft = limits.results;
  const keep = (size: number) => { resultsLeft -= size; return resultsLeft >= 0; };
  let readLimited = false;
  let filesRead = 0;
  const aliases = await readPathAliases(root, files, limits.bytes, shouldStop);
  map.notes.push(...aliases.notes);
  const aliasCount = aliases.configs.filter(config => config.readable && (config.paths.length || config.baseUrl !== null)).length;
  if (aliasCount) map.notes.push(`tsconfig ${aliasCount}개의 경로 별칭을 따라갔어요.`);
  let bytesRead = aliases.bytesRead;
  const codeFiles = files.filter(file => mapFile(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of codeFiles) {
    // A cancel is checked between files: ending the thread while Tree-sitter parses aborts the whole process.
    if (shouldStop()) throw new AppError('CANCELLED', '지도 만들기를 취소했어요.');
    if (resultsLeft < 0 && codeFile.test(file.relativePath)) {
      place(file, 'skipped', '지도의 결과 한도에 닿아 이 파일은 읽지 않았어요.');
      continue;
    }
    const skip = () => {
      map.limited = true;
      readLimited = true;
      place(file, 'skipped', '지도의 읽기 한도에 닿아 이 파일은 읽지 않았어요.');
    };
    // The size seen when the folder opened may be old, so the bytes left bound the read itself.
    const left = limits.bytes - bytesRead;
    if (filesRead >= limits.files || left <= 0) { skip(); continue; }
    filesRead++;
    let source: { text: string; hash: string };
    try {
      source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
    } catch (error) {
      if (error instanceof AppError && error.code === 'LIMIT' && left < MAX_FILE_BYTES) { skip(); continue; }
      place(file, 'failed', error instanceof AppError ? error.message : '파일을 읽지 못했어요.');
      continue;
    }
    bytesRead += Buffer.byteLength(source.text);
    if (pythonFile.test(file.relativePath)) {
      const scan = scanPython(source.text, source.hash, file, limits.nodesPerFile, room);
      python.push(scan);
      place(file, scan.reason ? 'partial' : 'full', scan.reason);
      map.complexFunctions.push(...scan.functions);
      map.symbols.push(...scan.symbols);
      continue;
    }
    const { found, functions, symbols, exports, reason } = scanTree(source.text, file.relativePath, limits.nodesPerFile);
    place(file, reason ? 'partial' : 'full', reason);
    for (const node of symbols) {
      const isFunction = functionTypes.has(node.type);
      const name = isFunction ? namedFunction(node, clip) : clip(node.childForFieldName('name')!.text);
      if (name === null) continue;
      room.symbols -= name.length + ENTRY_SIZE;
      if (room.symbols < 0) break;
      map.symbols.push({ fileId: file.id, fileHash: source.hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        ...linesOf(node), name, kind: isFunction ? 'function' : 'class' });
    }
    for (const item of exports) {
      if (!keep(item.name.length + item.displayName.length + ENTRY_SIZE)) break;
      map.exports.push({ ...item, fileId: file.id, fileHash: source.hash });
    }
    for (const node of functions) {
      const { lines, depth } = measureFunction(node, source.text);
      if (lines <= COMPLEXITY_LIMITS.lines && depth <= COMPLEXITY_LIMITS.depth) continue;
      const name = functionName(node, clip);
      room.functions -= name.length + ENTRY_SIZE;
      if (room.functions < 0) continue;
      map.complexFunctions.push({ fileId: file.id, fileHash: source.hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        ...linesOf(node), name, lines, depth });
    }
    for (const { node, kind, specifier } of found) {
      const text = source.text.slice(node.startIndex, node.endIndex);
      // tree-sitter's Node binding reports UTF-16 indices, the same ranges the analyzer's evidence uses.
      const item: MapImport = { fromFileId: file.id, fileHash: source.hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        ...linesOf(node), text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, specifier };
      const size = item.text.length + (specifier?.length ?? 0) + ENTRY_SIZE;
      if (kind !== 'static' || specifier === null || specifier.startsWith('/')) {
        if (!keep(size)) break;
        map.unresolved.push({ ...item, reason: kind !== 'static' ? kind : specifier === null ? 'unreadable' : 'outside', candidates: [] });
        continue;
      }
      const resolved = resolveImport(file.relativePath, specifier, known, aliases);
      if (resolved.kind === 'external' || resolved.kind === 'outside') {
        if (!keep(size)) break;
        if (resolved.kind === 'external') map.external.push(item);
        if (resolved.kind === 'outside') map.unresolved.push({ ...item, reason: 'outside', candidates: [] });
        continue;
      }
      const named = resolved.candidates;
      if (!resolved.sure) {
        const reasonText = '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.';
        if (!keep(size + lengthOf(named) + reasonText.length)) break;
        map.unresolved.push({ ...item, reason: 'ambiguous', candidates: named, reasonText });
        continue;
      }
      const usable: string[] = [];
      for (const name of named) if (await available(name)) usable.push(name);
      if (usable.length === 1) {
        const target = known.get(usable[0])!;
        const clause = node.namedChildren.find(child => child.type === 'import_clause' || child.type === 'export_clause');
        const all = node.type === 'export_statement' && !clause
          || clause?.namedChildren.some(child => child.type === 'namespace_import');
        // Type-only imports also count: a value declaration can be referenced as a type.
        const names = clause?.namedChildren.flatMap(child => {
          if (child.type === 'identifier') return ['default'];
          if (child.type === 'export_specifier') return child.childForFieldName('name')?.text ?? [];
          if (child.type !== 'named_imports') return [];
          return child.namedChildren.filter(part => part.type === 'import_specifier')
            .flatMap(part => part.childForFieldName('name')?.text ?? []);
        }) ?? [];
        if (!keep(size + (all ? 0 : lengthOf(names) + NAME_SIZE * names.length))) break;
        map.edges.push({ ...item, toFileId: target.id, names: all ? 'all' : names });
        if (!mapFile(target.relativePath) && !placed.has(target.id)) place(target, 'not-code', null);
        continue;
      }
      const candidates = usable.length ? usable : named;
      if (!keep(size + lengthOf(candidates))) break;
      map.unresolved.push({ ...item, reason: !named.length ? 'not-found' : !usable.length ? 'unavailable' : 'ambiguous', candidates });
    }
    if (resultsLeft < 0) {
      map.limited = true;
      place(file, 'partial', '지도의 결과 한도에 닿아 이 파일의 import와 export 일부는 적지 않았어요.');
    }
  }
  map.symbolsCut = room.symbols < 0;
  if (map.symbolsCut) map.notes.push(SYMBOLS_NOTE);
  if (resultsLeft < 0) map.notes.push(RESULT_NOTE);
  if (room.functions < 0) map.notes.push(FUNCTIONS_NOTE);
  const settled = await settlePythonImports(python, known, map, available, shouldStop, limits.results);
  const pythonLinksCut = !settled || room.imports < 0;
  if (pythonLinksCut) map.notes.push(PYTHON_RESULT_NOTE);
  if (python.length) map.notes.push('Python import는 점으로 시작하는 상대 import와, 파일이 속한 최상위 패키지 이름으로 시작하는 import만 확실한 선으로 이었어요. 그 밖의 import는 실행 방법·Python 버전·설치된 패키지에 따라 달라져서, 후보 파일을 ‘확인 못 함’에 적고 지도에는 추정(촘촘한 점선)으로 이었어요. importlib처럼 실행 중에 정하는 import는 보지 않았어요.');
  if (readLimited) map.notes.push(`지도는 파일 ${limits.files}개·합계 ${limits.bytes / 1024 / 1024} MiB까지만 읽어요. 나머지 파일의 연결은 보지 않았어요.`);
  map.files = [...placed.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  // The other limits mark the files they cut short; only this one leaves every file looking fully read.
  map.reading = readingOrder(map.files, map.edges, pythonLinksCut);
  const scripts = await scriptFilesOf(root, files, known, limits.bytes - bytesRead, shouldStop);
  return { ...map, unused: unusedFiles(map, scripts, aliases) };
}
