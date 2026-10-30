import path from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { COMPLEXITY_LIMITS, type MapExport, type MapFile, type MapImport, type ProjectFile, type ProjectMap } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { assertAllowedFile, MAX_FILE_BYTES, readAllowed, textExtensions } from '../project/files';
import { functionName, functionTypes, importOf, measureFunction } from './syntax';
import { readPathAliases, resolveImport } from './path-aliases';
import { scriptFilesOf, unusedFiles } from './unused-files';

export const codeFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
// Plan v2.3 A: a relative path without an extension may name one of these files or its folder's index file.
// TS importers also consider the TS counterpart of an explicit JS extension; multiple files stay ambiguous.
export const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_TEXT = 300;

export interface MapLimits { files: number; bytes: number; nodesPerFile: number }
// Files as many as the folder scan allows; 16 MiB confirmed by the user (2026-10-19) so a large project
// still finishes inside the map worker's 30 seconds; the node budget keeps one huge file from taking it all.
export const MAP_LIMITS: MapLimits = { files: 1000, bytes: 16 * 1024 * 1024, nodesPerFile: 200_000 };

export function parse(text: string, relativePath: string): Parser.SyntaxNode {
  const extension = path.extname(relativePath).toLowerCase();
  const parser = new Parser();
  parser.setLanguage(['.js', '.jsx', '.mjs', '.cjs'].includes(extension) ? JavaScript
    : extension === '.tsx' ? TypeScript.tsx : TypeScript.typescript);
  // This binding's string callback needs room for the source plus its terminator (as in syntax.ts).
  return parser.parse(text, undefined, { bufferSize: Math.max(32 * 1024, text.length + 1) }).rootNode;
}

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
    if (isFunction && !inBroken && !node.hasError && node.childForFieldName('body')) functions.push(node);
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
  return { found, functions, exports, reason: reason ?? (root.hasError ? '구문 오류가 있어 오류 구역 안의 import와 함수는 놓쳤을 수 있어요.' : null) };
}

// Line numbers as the analyzer's evidence gives them: a range ending at a line start does not take that line.
const linesOf = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1,
  endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)) });

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
  const map: Omit<ProjectMap, 'unused'> = { projectId, files: [], edges: [], unresolved: [], external: [], complexFunctions: [], exports: [], limited: false, notes: [] };
  // A target may have been deleted, excluded or swapped for a link since the folder was opened.
  const availability = new Map<string, Promise<boolean>>();
  const available = (relative: string): Promise<boolean> => {
    if (!availability.has(relative)) availability.set(relative, assertAllowedFile(root, relative).then(() => true, () => false));
    return availability.get(relative)!;
  };

  let filesRead = 0;
  const aliases = await readPathAliases(root, files, limits.bytes, shouldStop);
  map.notes.push(...aliases.notes);
  const aliasCount = aliases.configs.filter(config => config.readable && (config.paths.length || config.baseUrl !== null)).length;
  if (aliasCount) map.notes.push(`tsconfig ${aliasCount}개의 경로 별칭을 따라갔어요.`);
  let bytesRead = aliases.bytesRead;
  const codeFiles = files.filter(file => codeFile.test(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of codeFiles) {
    // A cancel is checked between files: ending the thread while Tree-sitter parses aborts the whole process.
    if (shouldStop()) throw new AppError('CANCELLED', '지도 만들기를 취소했어요.');
    const skip = () => {
      map.limited = true;
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
    const { found, functions, exports, reason } = scanTree(source.text, file.relativePath, limits.nodesPerFile);
    place(file, reason ? 'partial' : 'full', reason);
    map.exports.push(...exports.map(item => ({ ...item, fileId: file.id, fileHash: source.hash })));
    for (const node of functions) {
      const { lines, depth } = measureFunction(node, source.text);
      if (lines <= COMPLEXITY_LIMITS.lines && depth <= COMPLEXITY_LIMITS.depth) continue;
      map.complexFunctions.push({ fileId: file.id, fileHash: source.hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        ...linesOf(node), name: functionName(node), lines, depth });
    }
    for (const { node, kind, specifier } of found) {
      const text = source.text.slice(node.startIndex, node.endIndex);
      // tree-sitter's Node binding reports UTF-16 indices, the same ranges the analyzer's evidence uses.
      const item: MapImport = { fromFileId: file.id, fileHash: source.hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        ...linesOf(node), text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, specifier };
      if (kind !== 'static') { map.unresolved.push({ ...item, reason: kind, candidates: [] }); continue; }
      if (specifier === null) { map.unresolved.push({ ...item, reason: 'unreadable', candidates: [] }); continue; }
      if (specifier.startsWith('/')) { map.unresolved.push({ ...item, reason: 'outside', candidates: [] }); continue; }
      const resolved = resolveImport(file.relativePath, specifier, known, aliases);
      if (resolved.kind === 'external') { map.external.push(item); continue; }
      if (resolved.kind === 'outside') { map.unresolved.push({ ...item, reason: 'outside', candidates: [] }); continue; }
      const named = resolved.candidates;
      if (!resolved.sure) {
        map.unresolved.push({ ...item, reason: 'ambiguous', candidates: named,
          reasonText: '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.' });
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
        map.edges.push({ ...item, toFileId: target.id, names: all ? 'all' : names });
        if (!codeFile.test(target.relativePath) && !placed.has(target.id)) place(target, 'not-code', null);
        continue;
      }
      map.unresolved.push({ ...item, reason: !named.length ? 'not-found' : !usable.length ? 'unavailable' : 'ambiguous',
        candidates: usable.length ? usable : named });
    }
  }
  if (map.limited) map.notes.push(`지도는 파일 ${limits.files}개·합계 ${limits.bytes / 1024 / 1024} MiB까지만 읽어요. 나머지 파일의 연결은 보지 않았어요.`);
  map.files = [...placed.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const scripts = await scriptFilesOf(root, files, known, limits.bytes - bytesRead, shouldStop);
  return { ...map, unused: unusedFiles(map, scripts, aliases) };
}
