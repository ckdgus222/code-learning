import path from 'node:path';
import type Parser from 'tree-sitter';
import { PYTHON_STDLIB } from './python-stdlib';
import { stringOnly } from './python-syntax';

/** One module an import statement names, as written. */
export interface PythonImport {
  /** Leading dots; zero for an absolute import. */
  level: number;
  /** Module parts as written, empty for `from . import x`. */
  module: string[];
  /** null for a plain import, all for a star import. */
  names: string[] | 'all' | null;
}

export type PythonTarget =
  | { kind: 'file'; relativePath: string; specifier: string; names: string[] | 'all' }
  | { kind: 'external'; specifier: string }
  | { kind: 'unresolved'; reason: 'not-found' | 'ambiguous' | 'outside'; candidates: string[]; reasonText?: string; specifier: string };

/** Names bound by an import-only initializer. */
export type InitFacts = ReadonlySet<string>;
export interface PythonFacts {
  /** null when the initializer is not import-only or was not completely read. */
  init(initPath: string): InitFacts | null;
  /** Completely read, free of syntax errors and machinery names. */
  plain(path: string): boolean;
}

/** Python compares identifiers after NFKC: `ａｐｐ` and `app` are one name. */
export const normalize = (name: string) => name.normalize('NFKC');
const importedName = (node: Parser.SyntaxNode) => node.type === 'aliased_import' ? node.childForFieldName('name')! : node;
const partsOf = (node: Parser.SyntaxNode) => node.namedChildren.filter(child => child.type === 'identifier').map(child => child.text);

/** The modules of an import node; future imports do not name a file. */
export function pythonImportsOf(node: Parser.SyntaxNode): PythonImport[] {
  if (node.hasError) return [];
  if (node.type === 'import_statement') {
    return node.childrenForFieldName('name').map(name => ({ level: 0, module: partsOf(importedName(name)), names: null }));
  }
  if (node.type !== 'import_from_statement') return [];
  const module = node.childForFieldName('module_name')!;
  const prefix = module.namedChildren.find(child => child.type === 'import_prefix');
  const dotted = module.type === 'relative_import' ? module.namedChildren.find(child => child.type === 'dotted_name') : module;
  const parts = dotted ? partsOf(dotted) : [];
  if (!prefix && parts.length === 1 && normalize(parts[0]) === '__future__') return [];
  const names = node.namedChildren.some(child => child.type === 'wildcard_import') ? 'all'
    : node.childrenForFieldName('name').map(name => importedName(name).text);
  // Dots may be written apart (`from . . import x`), so they are counted rather than measured.
  return [{ level: prefix ? prefix.text.split('.').length - 1 : 0, module: parts, names }];
}

/** A literal cannot run code or introduce names through an assignment's value. */
function literal(root: Parser.SyntaxNode): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (['integer', 'float', 'true', 'false', 'none'].includes(node.type)) continue;
    if (node.type === 'string') {
      if (node.namedChildren.some(child => child.type === 'interpolation') || /f/i.test(node.firstNamedChild?.text ?? '')) return false;
      continue;
    }
    if (node.type === 'unary_operator') {
      const argument = node.childForFieldName('argument');
      if (!['+', '-'].includes(node.childForFieldName('operator')?.text ?? '') || !argument || !['integer', 'float'].includes(argument.type)) return false;
      continue;
    }
    if (!['list', 'tuple', 'set', 'parenthesized_expression', 'concatenated_string'].includes(node.type)) return false;
    for (const child of node.namedChildren) if (child.type !== 'comment') pending.push(child);
  }
  return true;
}

/** Bound names, or null when a package initializer does more than imports and literal assignments. */
export function initFactsOf(root: Parser.SyntaxNode): InitFacts | null {
  if (root.hasError) return null;
  const bound = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type === 'comment' || node.type === 'pass_statement') continue;
    if (['import_statement', 'import_from_statement', 'future_import_statement'].includes(node.type)) {
      if (node.namedChildren.some(child => child.type === 'wildcard_import')) return null;
      const item = pythonImportsOf(node)[0];
      for (const name of node.childrenForFieldName('name')) {
        const alias = name.childForFieldName('alias');
        if (!alias && item?.level === 1 && !item.module.length) continue;
        bound.add(normalize(alias?.text ?? (node.type === 'import_statement' ? partsOf(importedName(name))[0] : importedName(name).text)));
      }
      continue;
    }
    if (stringOnly(node)) continue;
    if (node.type !== 'expression_statement' || node.namedChildCount !== 1) return null;
    const value = node.firstNamedChild!;
    if (value.type !== 'assignment') return null;
    const left = value.childForFieldName('left'), right = value.childForFieldName('right');
    if (left?.type !== 'identifier' || !right || !literal(right) || value.childForFieldName('type')) return null;
    bound.add(normalize(left.text));
  }
  return bound;
}

const machinery = new Set(['__getattr__', '__path__', '__package__', '__spec__', '__loader__', '__import__', '__builtins__', '__dict__', '__class__']);

/** Accept __name__ only as a direct, plainly read comparison or call argument. */
export function mentionsMachinery(root: Parser.SyntaxNode): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'identifier') {
      const name = normalize(node.text);
      if (machinery.has(name)) return true;
      const parent = node.parent;
      const read = parent?.type === 'comparison_operator' || (parent?.type === 'argument_list' && parent.parent?.type === 'call')
        || (parent?.type === 'keyword_argument' && parent.childForFieldName('value')?.id === node.id);
      if (name === '__name__' && !read) return true;
    }
    for (const child of node.namedChildren) pending.push(child);
  }
  return false;
}

type Step =
  | { kind: 'module'; file: string }
  | { kind: 'package'; dir: string; file: string }
  | { kind: 'folder'; dir: string }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'missing' }
  | { kind: 'blocked' };

// Every folder that holds a listed file, worked out once per file list: most imports name no project
// file at all, and each of those asks about a folder at every candidate root.
const foldersByList = new WeakMap<ReadonlySet<string>, Set<string>>();
function foldersOf(known: ReadonlySet<string>): Set<string> {
  let folders = foldersByList.get(known);
  if (folders) return folders;
  folders = new Set();
  for (const file of known) {
    for (let dir = path.posix.dirname(file); dir !== '.' && !folders.has(dir); dir = path.posix.dirname(dir)) folders.add(dir);
  }
  foldersByList.set(known, folders);
  return folders;
}

// Files by the module name their path ends in (`x/b.py` and `x/b/__init__.py` are both `b`), in path
// order, worked out once per file list like the folders.
const modulesByList = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();
function modulesNamed(known: ReadonlySet<string>, name: string): string[] {
  let modules = modulesByList.get(known);
  if (!modules) {
    modules = new Map();
    for (const file of [...known].sort()) {
      if (!file.endsWith('.py')) continue;
      const base = path.posix.basename(file, '.py');
      const module = base === '__init__' ? path.posix.basename(path.posix.dirname(file)) : base;
      modules.set(module, [...modules.get(module) ?? [], file]);
    }
    modulesByList.set(known, modules);
  }
  return modules.get(name) ?? [];
}

/** One part of a dotted path, in the order Python looks: a package, then a module, then a folder without `__init__.py`. */
function step(dir: string, name: string, known: ReadonlySet<string>): Step {
  const base = path.posix.join(dir, name);
  const module = `${base}.py`, init = `${base}/__init__.py`;
  if (known.has(init) && known.has(module)) return { kind: 'conflict', files: [module, init] };
  if (known.has(init)) return { kind: 'package', dir: base, file: init };
  if (known.has(module)) return { kind: 'module', file: module };
  return foldersOf(known).has(base) ? { kind: 'folder', dir: base } : { kind: 'missing' };
}

// One import can match a file in every folder of a project, and a file can hold thousands of imports, so
// each entry keeps only a few candidates (the map also bounds their total).
export const MAX_CANDIDATES = 5;
// Names looked at in one from-import, and the length kept of a dotted module path: both bound what one
// statement can cost. Real code stays far below them.
export const MAX_NAMES = 2_000;
const MAX_SPECIFIER = 300;
const MORE_CANDIDATES = `후보가 더 있지만 처음 ${MAX_CANDIDATES}개만 적었어요.`;
const machineryReason = 'import 동작을 바꿀 수 있는 이름(__name__, __path__, __getattr__ 등)이 얽혀 있어 확정하지 않았어요.';
const unsettledReason = '코드만으로는 확정하지 못했어요. 실행 방법, Python 버전, 설치된 패키지에 따라 이 파일이 아닐 수 있어요.';
const attributeReason = '패키지가 같은 이름을 따로 가질 수 있어, 하위 파일인지 그 이름인지 정하지 못했어요.';

/**
 * Where one import leads: arrows only for relative imports and imports of the importing file's own
 * top-level package; any other import that could mean project files is one entry listing them.
 * The result is bounded by the project, not by the statement: repeated names count once, at most
 * MAX_NAMES names are looked at, equal results are merged, and an entry keeps MAX_CANDIDATES candidates.
 */
export function resolvePythonImport(fromPath: string, item: PythonImport, known: ReadonlySet<string>, facts: PythonFacts): PythonTarget[] {
  const parts = item.module.map(normalize);
  const written = Array.isArray(item.names) ? [...new Set(item.names.map(normalize))] : item.names;
  const names = Array.isArray(written) ? written.slice(0, MAX_NAMES) : written;
  const dotted = '.'.repeat(item.level) + parts.join('.');
  const cut = (text: string) => text.length > MAX_SPECIFIER ? `${text.slice(0, MAX_SPECIFIER)}…` : text;
  const specifier = cut(dotted);
  const external = (): PythonTarget => ({ kind: 'external', specifier: cut(parts[0]) });
  const unresolved = (reason: 'not-found' | 'ambiguous' | 'outside', candidates: string[] = [], reasonText?: string): PythonTarget => {
    const text = candidates.length > MAX_CANDIDATES ? `${reasonText ?? ''} ${MORE_CANDIDATES}`.trim() : reasonText;
    return { kind: 'unresolved', reason, candidates: candidates.slice(0, MAX_CANDIDATES), specifier, ...(text ? { reasonText: text } : {}) };
  };
  const file = (relativePath: string, taken: string[] | 'all' = 'all'): PythonTarget => ({ kind: 'file', relativePath, names: taken, specifier });
  const special = [...parts, ...(Array.isArray(names) ? names : [])].some(name => name.startsWith('__') && name.endsWith('__'));
  const directory = (dir: string): Step => known.has(path.posix.join(dir, '__init__.py'))
    ? { kind: 'package', dir, file: path.posix.join(dir, '__init__.py') } : { kind: 'folder', dir };

  // What the walk's result means, one target at a time, so a caller that only collects candidates can stop early.
  function* entries(result: Step): Generator<PythonTarget> {
    if (result.kind === 'missing' || result.kind === 'blocked') { yield unresolved('not-found'); return; }
    if (result.kind === 'conflict') { yield unresolved('ambiguous', result.files); return; }
    if (result.kind === 'module') { yield file(result.file, names ?? 'all'); return; }
    if (!Array.isArray(names)) { if (result.kind === 'package') yield file(result.file); return; }
    const bound = result.kind === 'package' ? facts.init(result.file) : null;
    for (const name of names) {
      const sub = step(result.dir, name, known);
      if (sub.kind === 'folder') continue;
      if (sub.kind === 'missing' || sub.kind === 'blocked') {
        yield result.kind === 'package' ? file(result.file, [name]) : unresolved('not-found');
        continue;
      }
      const candidates = sub.kind === 'conflict' ? sub.files : [sub.file];
      if (result.kind === 'package' && (bound === null || bound.has(name))) yield unresolved('ambiguous', [...candidates, result.file], attributeReason);
      else yield sub.kind === 'conflict' ? unresolved('ambiguous', candidates) : file(sub.file);
    }
  }

  // The module path walked from one directory, and every `__init__.py` passed on the way (the start included).
  const walk = (root: string): { result: Step; inits: string[] } => {
    let result = directory(root);
    const inits: string[] = result.kind === 'package' ? [result.file] : [];
    for (const part of parts) {
      if (result.kind === 'module') { result = { kind: 'blocked' }; break; }
      if (result.kind !== 'package' && result.kind !== 'folder') break;
      result = step(result.dir, part, known);
      if (result.kind === 'package') inits.push(result.file);
    }
    return { result, inits };
  };
  const candidatesOf = (target: PythonTarget): string[] =>
    target.kind === 'file' ? [target.relativePath] : target.kind === 'unresolved' ? target.candidates : [];

  // Equal results are kept once, in the order first met; names taken from one file are gathered in a set.
  const merged = new Map<string, PythonTarget | { relativePath: string; names: Set<string> | 'all' }>();
  const add = (target: PythonTarget) => {
    if (target.kind !== 'file') {
      merged.set(JSON.stringify([target.kind, 'reason' in target ? [target.reason, target.reasonText, target.candidates] : null]), target);
      return;
    }
    const key = `file\n${target.relativePath}`;
    const previous = merged.get(key) as { relativePath: string; names: Set<string> | 'all' } | undefined;
    if (!previous) { merged.set(key, { relativePath: target.relativePath, names: target.names === 'all' ? 'all' : new Set(target.names) }); return; }
    if (previous.names === 'all' || target.names === 'all') previous.names = 'all';
    else for (const name of target.names) previous.names.add(name);
  };
  const settle = (root: string) => {
    const { result, inits } = walk(root);
    const unsafe = special || !facts.plain(fromPath) || inits.some(init => !facts.plain(init));
    for (const target of entries(result)) {
      const candidates = candidatesOf(target);
      const unsafeTarget = candidates.some(candidate => path.posix.basename(candidate) === '__init__.py' && !facts.plain(candidate));
      if ((unsafe || unsafeTarget) && candidates.length) for (const candidate of candidates) add(unresolved('ambiguous', [candidate], machineryReason));
      else add(target);
    }
  };

  if (item.level > 0) {
    let anchor = path.posix.dirname(fromPath);
    for (let up = 1; up < item.level; up++) {
      if (anchor === '.') return [unresolved('outside')];
      anchor = path.posix.dirname(anchor);
    }
    settle(anchor);
  } else {
    const roots = new Set<string>();
    let ancestor = path.posix.dirname(fromPath);
    while (true) {
      roots.add(ancestor);
      roots.add(path.posix.join(ancestor, 'src'));
      if (ancestor === '.') break;
      ancestor = path.posix.dirname(ancestor);
    }
    const hits = [...roots].filter(root => step(root, parts[0], known).kind !== 'missing');
    if (!hits.length) {
      if (PYTHON_STDLIB.has(parts[0])) return [external()];
      const suffix = parts.join('/');
      const candidates: string[] = [];
      for (const name of modulesNamed(known, parts.at(-1)!)) {
        if (name.endsWith(`/${suffix}.py`) || name.endsWith(`/${suffix}/__init__.py`)) candidates.push(name);
        // One more than is kept, so the entry can say that there are more.
        if (candidates.length > MAX_CANDIDATES) break;
      }
      return candidates.length ? [unresolved('not-found', candidates,
        '프로젝트 안에 같은 이름이 있지만 이 import 경로로는 닿지 않아요. 실행 위치나 설치 방식에 따라 이어질 수 있어요.')]
        : [external()];
    }
    const top = step(hits[0], parts[0], known);
    const own = hits.length === 1 && top.kind === 'package' && fromPath.startsWith(`${top.dir}/`)
      && !known.has(path.posix.join(hits[0], '__init__.py')) && !PYTHON_STDLIB.has(parts[0]);
    if (own) settle(hits[0]);
    else {
      // Not settled: one entry for the import with the files it could mean, however many roots and names there are.
      const candidates = new Set<string>();
      collect: for (const root of hits) {
        for (const target of entries(walk(root).result)) {
          for (const candidate of candidatesOf(target)) candidates.add(candidate);
          if (candidates.size > MAX_CANDIDATES) break collect;
        }
      }
      add(candidates.size ? unresolved('ambiguous', [...candidates], unsettledReason) : unresolved('not-found'));
    }
  }
  if (Array.isArray(written) && written.length > MAX_NAMES) {
    add(unresolved('ambiguous', [], `한 문장이 가져오는 이름이 ${MAX_NAMES.toLocaleString('en-US')}개를 넘어, 그 뒤의 이름은 보지 않았어요.`));
  }
  return [...merged.values()].map(target => 'kind' in target ? target
    : file(target.relativePath, target.names === 'all' ? 'all' : [...target.names]));
}
