import path from 'node:path';
import type { ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, readAllowed, textExtensions } from '../project/files';
import { candidatesFor, EXTENSIONS, isRelative } from './project-map';

/** One config's folder boundary, including configs that could not be read. */
export interface AliasConfig {
  folder: string;
  readable: boolean;
  baseUrl: string | null;
  paths: { pattern: string; targets: string[] }[];
}
export interface PathAliases { configs: AliasConfig[]; notes: string[]; bytesRead: number }
export const NO_ALIASES: PathAliases = { configs: [], notes: [], bytesRead: 0 };
export type Resolved =
  | { kind: 'project'; candidates: string[]; via: 'relative' | 'alias'; sure: boolean }
  | { kind: 'outside' }
  | { kind: 'external' };

const outside = (name: string) => name === '..' || name.startsWith('../') || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name);
const folderOf = (name: string) => path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
const join = (base: string, name: string) => {
  const normalized = name.replace(/\\/g, '/');
  return path.posix.normalize(path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) ? normalized : path.posix.join(base, normalized));
};
// Real configs have a few patterns with one to three targets each.
const MAX_PATTERNS = 100;
const MAX_TARGETS = 10;
// Characters of one pattern, base or joined target; real ones are a few dozen.
const MAX_ALIAS_PATH = 1024;
const MAX_EXTENDS = 10;
// The only compilerOptions alias resolution reads: merging just these keeps a config with thousands of options cheap.
const ALIAS_OPTIONS = ['paths', 'baseUrl', 'moduleSuffixes', 'module', 'moduleResolution'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Strip comments and trailing commas without changing quoted strings, in one pass over the text: a regular
 * expression backtracks for seconds on an unclosed string and cannot be cancelled meanwhile. Invalid JSON still fails.
 */
function parseConfig(text: string): Record<string, unknown> {
  let out = '';
  let pendingComma = false;
  for (let at = text.charCodeAt(0) === 0xfeff ? 1 : 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (pendingComma) { out += ','; pendingComma = false; }
      out += text.slice(at, end + 1);
      at = end;
    } else if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++;
      out += ' ';
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end < 0 ? text.length : end + 1;
      out += ' ';
    } else if (char === ',') {
      if (pendingComma) out += ',';
      pendingComma = true;
    } else if (/\s/.test(char)) {
      out += char;
    } else {
      // A comma right before a closing bracket is a trailing comma and is dropped.
      if (pendingComma && char !== '}' && char !== ']') out += ',';
      pendingComma = false;
      out += char;
    }
  }
  if (pendingComma) out += ',';
  const value: unknown = JSON.parse(out);
  if (!record(value)) throw new Error('config');
  return value;
}

interface Options {
  values: Record<string, unknown>;
  baseUrl?: string;
  pathsFolder?: string;
}

export async function readPathAliases(root: string, files: ProjectFile[], bytesLeft: number,
  shouldStop: () => boolean = () => false): Promise<PathAliases> {
  const result: PathAliases = { configs: [], notes: [], bytesRead: 0 };
  const known = new Set(files.map(file => file.relativePath));
  const configs = files.filter(file => path.posix.basename(file.relativePath) === 'tsconfig.json'
    || path.posix.basename(file.relativePath) === 'jsconfig.json' && !known.has(join(folderOf(file.relativePath), 'tsconfig.json')));
  const cache = new Map<string, Record<string, unknown> | null>();
  const note = (text: string) => { if (!result.notes.includes(text)) result.notes.push(text); };
  const stop = () => { if (shouldStop()) throw new AppError('CANCELLED', '경로 별칭 읽기를 취소했어요.'); };
  const read = async (name: string): Promise<Record<string, unknown> | null> => {
    stop();
    if (cache.has(name)) return cache.get(name)!;
    try {
      const left = Math.min(MAX_FILE_BYTES, Math.max(0, bytesLeft - result.bytesRead));
      if (left <= 0) throw new AppError('LIMIT', '');
      const source = await readAllowed(root, name, left);
      result.bytesRead += Buffer.byteLength(source.text);
      const config = parseConfig(source.text);
      cache.set(name, config);
      stop();
      return config;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CANCELLED') throw error;
      const reason = error instanceof AppError && error.code === 'LIMIT' ? '읽기 한도' : error instanceof SyntaxError ? 'JSON 형식 오류' : '파일 읽기 또는 설정 형식 오류';
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(${reason}).`);
      cache.set(name, null);
      return null;
    }
  };
  // Each config is merged once: configs that extend the same parents many times would otherwise multiply the work.
  const merges = new Map<string, Promise<Options | null>>();
  const merge = (name: string, chain: string[]): Promise<Options | null> => {
    stop();
    if (chain.includes(name) || chain.length >= 10) {
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(${chain.includes(name) ? 'extends 순환' : 'extends 10단계 초과'}).`);
      return Promise.resolve(null);
    }
    if (!merges.has(name)) merges.set(name, mergeOnce(name, chain));
    return merges.get(name)!;
  };
  const mergeOnce = async (name: string, chain: string[]): Promise<Options | null> => {
    const config = await read(name);
    if (!config) return null;
    const folder = folderOf(name);
    let merged: Options = { values: {} };
    const parents = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
    // Real configs extend one or two files; thousands of entries would each add a note and a lookup.
    if (parents.length > MAX_EXTENDS) {
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(extends가 ${MAX_EXTENDS}개를 넘음).`);
      return null;
    }
    for (const parent of parents) {
      if (typeof parent !== 'string') throw new Error('config');
      if (!isRelative(parent)) {
        note(`tsconfig ${name}의 extends가 패키지(${parent})를 가리켜 거기 적힌 별칭은 읽지 못했어요.`);
        continue;
      }
      const target = join(folder, parent);
      const file = known.has(target) ? target : !target.endsWith('.json') && known.has(`${target}.json`) ? `${target}.json` : null;
      if (outside(target) || !file) {
        note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(extends 파일이 프로젝트 목록에 없음).`);
        return null;
      }
      const inherited = await merge(file, [...chain, name]);
      if (!inherited) return null;
      merged = { ...merged, ...inherited, values: { ...merged.values, ...inherited.values } };
    }
    if (config.compilerOptions !== undefined && !record(config.compilerOptions)) throw new Error('config');
    const options = record(config.compilerOptions) ? config.compilerOptions : {};
    const own = Object.fromEntries(ALIAS_OPTIONS.filter(key => key in options).map(key => [key, options[key]]));
    if ('baseUrl' in own && typeof own.baseUrl !== 'string') throw new Error('config');
    return { ...merged, values: { ...merged.values, ...own },
      ...('paths' in own ? { pathsFolder: folder } : {}),
      ...(typeof own.baseUrl === 'string' ? { baseUrl: join(folder, own.baseUrl) } : {}) };
  };
  stop();
  for (const file of configs.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const name = file.relativePath;
    const config: AliasConfig = { folder: folderOf(name), readable: false, baseUrl: null, paths: [] };
    result.configs.push(config);
    let merged: Options | null;
    try { merged = await merge(name, []); }
    catch (error) {
      if (error instanceof AppError && error.code === 'CANCELLED') throw error;
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(설정 형식 오류).`);
      continue;
    }
    if (!merged) continue;
    config.readable = true;
    const options = merged.values;
    // A config without aliases resolves nothing either way, so its resolution options are not worth a note.
    if (options.paths === undefined && merged.baseUrl === undefined) {
      if (cache.get(name)?.references) note(`tsconfig ${name}는 다른 설정을 참조해요. 거기 적힌 경로 별칭은 아직 따라가지 않아요.`);
      continue;
    }
    if ('moduleSuffixes' in options && !(Array.isArray(options.moduleSuffixes) && options.moduleSuffixes.length === 1 && options.moduleSuffixes[0] === '')) {
      note(`tsconfig ${name}에 moduleSuffixes가 있어 경로 별칭을 따라가지 않았어요.`);
      continue;
    }
    if ([options.moduleResolution, options.module].some(value => typeof value === 'string' && /^(node16|nodenext)$/i.test(value))) {
      note(`tsconfig ${name}가 Node ESM 방식(node16/nodenext)이라 경로 별칭을 따라가지 않았어요.`);
      continue;
    }
    const paths = options.paths;
    const valid = paths === undefined || record(paths) && Object.entries(paths).every(([pattern, targets]) => pattern.split('*').length <= 2
      && Array.isArray(targets) && targets.length > 0 && targets.every(target => typeof target === 'string' && target.split('*').length <= 2));
    if (!valid) {
      config.readable = false;
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(paths 형식 오류).`);
      continue;
    }
    // Every import is matched against every pattern and tries each target's names, so both are bounded.
    if (paths !== undefined && (Object.keys(paths).length > MAX_PATTERNS
      || Object.values(paths).some(targets => (targets as string[]).length > MAX_TARGETS))) {
      config.readable = false;
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(paths가 너무 큼).`);
      continue;
    }
    const base = merged.baseUrl ?? merged.pathsFolder ?? config.folder;
    // Every import builds names from each target joined with its base, so a long base or target would repeat long strings.
    const tooLong = base.length > MAX_ALIAS_PATH || Object.entries(paths ?? {}).some(([pattern, targets]) => pattern.length > MAX_ALIAS_PATH
      || (targets as string[]).some(target => base.length + target.length > MAX_ALIAS_PATH));
    if (tooLong) {
      config.readable = false;
      note(`tsconfig ${name}를 읽지 못해 경로 별칭을 확인하지 못했어요(paths가 너무 큼).`);
      continue;
    }
    config.baseUrl = merged.baseUrl ?? null;
    config.paths = Object.entries(paths ?? {}).map(([pattern, targets]) => ({ pattern,
      targets: (targets as string[]).map(target => join(base, target)) }));
  }
  stop();
  return result;
}

/** Alias candidates deliberately include competing runtime and declaration files. */
function aliasTarget(target: string, specifier: string, known: Map<string, ProjectFile>): Resolved | null {
  const normalized = path.posix.normalize(target);
  if (outside(normalized)) return { kind: 'outside' };
  const base = normalized === '.' ? '' : normalized.replace(/\/$/, '');
  const extensions = [...EXTENSIONS, '.mts', '.cts'];
  const names = [base, ...extensions.map(extension => base + extension),
    ...extensions.map(extension => `${base ? `${base}/` : ''}index${extension}`)];
  if (/\.(js|jsx|mjs|cjs)$/i.test(base)) names.push(...['.ts', '.tsx', '.mts', '.cts'].map(extension => base.replace(/\.[^.]+$/, extension)));
  const declarations = names.flatMap(name => {
    const extension = path.posix.extname(name).toLowerCase();
    const stem = textExtensions.has(extension) ? name.slice(0, -extension.length) : name;
    return ['.d.ts', '.d.mts', '.d.cts'].map(suffix => stem + suffix);
  });
  const candidates = [...new Set([...names, ...declarations])].filter(name => known.has(name));
  const packageFile = known.has(`${base ? `${base}/` : ''}package.json`);
  if (!candidates.length && !packageFile) return null;
  const sure = candidates.length === 1 && !/\.d\.(ts|mts|cts)$/i.test(candidates[0])
    && !packageFile && (candidates[0] === base
      || !path.posix.extname(specifier) && !path.posix.extname(base) && /\.(ts|tsx|js|jsx)$/i.test(candidates[0]));
  return { kind: 'project', candidates, via: 'alias', sure };
}

export function resolveImport(fromPath: string, specifier: string, known: Map<string, ProjectFile>, aliases: PathAliases): Resolved {
  if (specifier.startsWith('/')) return { kind: 'outside' };
  // A name longer than any real path is copied into every target's names; it is left unresolved as before aliases.
  if (!isRelative(specifier) && specifier.length > MAX_ALIAS_PATH) return { kind: 'external' };
  if (isRelative(specifier)) {
    const candidates = candidatesFor(fromPath, specifier, known);
    return candidates === null ? { kind: 'outside' } : { kind: 'project', candidates, via: 'relative', sure: true };
  }
  const config = aliases.configs.filter(item => !item.folder || fromPath.startsWith(`${item.folder}/`))
    .sort((a, b) => b.folder.length - a.folder.length)[0];
  if (!config?.readable) return { kind: 'external' };
  const exact = config.paths.find(item => !item.pattern.includes('*') && item.pattern === specifier);
  const matched = exact ?? config.paths.filter(({ pattern }) => {
    const star = pattern.indexOf('*');
    return star >= 0 && specifier.length >= pattern.length - 1 && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  }).sort((a, b) => b.pattern.indexOf('*') - a.pattern.indexOf('*'))[0];
  if (matched) {
    const star = matched.pattern.indexOf('*');
    const capture = star < 0 ? '' : specifier.slice(star, specifier.length - (matched.pattern.length - star - 1));
    for (const target of matched.targets) {
      const resolved = aliasTarget(target.replace('*', () => capture), specifier, known);
      if (resolved) return resolved;
    }
    return { kind: 'project', candidates: [], via: 'alias', sure: true };
  }
  if (config.baseUrl !== null) return aliasTarget(join(config.baseUrl, specifier), specifier, known) ?? { kind: 'external' };
  return { kind: 'external' };
}
