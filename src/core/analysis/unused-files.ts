import path from 'node:path';
import type { ProjectFile, ProjectMap, UnusedExcludeKind, UnusedFiles } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, readAllowed } from '../project/files';
import { candidatesFor, codeFile, pythonFile } from './project-map';
import { NO_ALIASES, resolveImport, type PathAliases } from './path-aliases';
import { isTestFile } from './routes';
import { isNextConfig } from './next-routes';

export type { UnusedExcludeKind, UnusedFiles, UnusedExports } from '../../shared/contracts';
export interface ScriptFiles {
  files: Set<string>;
  failed: { relativePath: string; reason: string }[];
  references: Set<string>;
  referenceFailed: { relativePath: string; reason: string }[];
}

const excludeKinds: UnusedExcludeKind[] = ['start', 'test', 'config', 'types', 'framework', 'script', 'reference'];
const nextAppFile = /^(?:page|layout|route|loading|error|global-error|not-found|template|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[^.]+$/;
// Apply the same cleanup to alias tails and file paths, including aliases that name an index file.
const aliasPath = (name: string) => name.replace(codeFile, '').replace(/\/index$/, '');

function isConfigFile(name: string): boolean {
  const basename = path.posix.basename(name);
  return codeFile.test(name) && (/\.config\./.test(basename) || /^\..*rc\./.test(basename) || isNextConfig(name));
}

// The first five unread files with their reasons, then a count of the rest.
const failedNames = (failed: ScriptFiles['failed']) => failed.slice(0, 5).map(file => `${file.relativePath}(${file.reason})`).join(', ')
  + (failed.length > 5 ? ` 외 ${failed.length - 5}개` : '');

export function unusedFiles(map: Omit<ProjectMap, 'unused'>, scripts: ScriptFiles, pathAliases: PathAliases = NO_ALIASES): UnusedFiles {
  const result: UnusedFiles = { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } };
  if (map.files.some(file => pythonFile.test(file.relativePath))) {
    result.notes.push('Python 파일은 이 후보 목록에서 다루지 않아요.');
    result.exports.notes.push('Python 파일의 함수·클래스는 이 후보 목록에서 다루지 않아요.');
  }
  const files = map.files.filter(file => file.checked !== 'not-code' && codeFile.test(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const known = new Map(files.map(file => [file.relativePath, { id: file.id, relativePath: file.relativePath, size: 0 }]));
  const pathsById = new Map(files.map(file => [file.id, file.relativePath]));
  const used = new Set(map.edges.filter(edge => edge.fromFileId !== edge.toFileId).map(edge => edge.toFileId));
  const unresolved = new Set(map.unresolved.flatMap(item => item.candidates));
  const dynamic = new Set<string>();
  for (const item of map.unresolved) {
    if (item.reason !== 'not-static' || !item.specifier) continue;
    const from = pathsById.get(item.fromFileId);
    if (!from) continue;
    const resolved = resolveImport(from, item.specifier, known, pathAliases);
    if (resolved.kind === 'project') for (const name of resolved.candidates) dynamic.add(name);
  }
  const aliases = [...new Set(map.external.map(item => aliasPath(item.specifier?.split('/').slice(1).join('/') ?? '')).filter(Boolean))];
  const nextRoots = [...new Set(map.files.filter(file => isNextConfig(file.relativePath)).map(file => {
    const folder = path.posix.dirname(file.relativePath);
    return folder === '.' ? '' : `${folder}/`;
  }))];
  const uncertainty = (name: string) => {
    const normalized = aliasPath(name);
    if (unresolved.has(name)) return '대상을 확정하지 못한 import가 이 파일을 가리킬 수 있어요.';
    if (dynamic.has(name)) return '동적 import(또는 require)로 쓰일 수 있어요.';
    if (aliases.some(tail => normalized === tail || normalized.endsWith(`/${tail}`))) return '경로 별칭으로 쓰일 수 있어요.';
    return null;
  };
  const exportsByFile = new Map<string, ProjectMap['exports']>();
  for (const item of map.exports) {
    if (!exportsByFile.has(item.fileId)) exportsByFile.set(item.fileId, []);
    exportsByFile.get(item.fileId)!.push(item);
  }
  const incoming = new Map<string, ProjectMap['edges']>();
  for (const edge of map.edges) {
    if (edge.fromFileId === edge.toFileId) continue;
    if (!incoming.has(edge.toFileId)) incoming.set(edge.toFileId, []);
    incoming.get(edge.toFileId)!.push(edge);
  }
  const counts = new Map<UnusedExcludeKind, number>();
  for (const file of files) {
    const name = file.relativePath;
    const basename = path.posix.basename(name);
    const framework = nextRoots.some(root => {
      if (!name.startsWith(root)) return false;
      const local = name.slice(root.length).replace(/^src\//, '');
      return local.startsWith('pages/') || (local.startsWith('app/') && nextAppFile.test(basename))
        || /^(?:middleware|instrumentation)\.[^.]+$/.test(local);
    });
    const kind: UnusedExcludeKind | null = file.entry ? 'start'
      // Playwright projects often name tests `*.e2e.ts` or keep them in an `e2e/` folder (dog-walk does both).
      : isTestFile(name) || /[.-](?:spec|test|e2e)\.[^/]+$/.test(name) || /(?:^|\/)e2e\//.test(name) ? 'test'
      : isConfigFile(name) ? 'config'
      : /\.d\.(?:ts|mts|cts)$/i.test(name) ? 'types'
      : framework ? 'framework'
      : scripts.files.has(name) ? 'script'
      : scripts.references.has(name) ? 'reference' : null;
    if (kind) { counts.set(kind, (counts.get(kind) ?? 0) + 1); continue; }
    const reason = uncertainty(name);
    const entry = { fileId: file.id, relativePath: name };
    if (!used.has(file.id) && !reason) { result.candidates.push(entry); continue; }
    if (!used.has(file.id) && reason) result.unsure.push({ ...entry, reason });
    const exports = exportsByFile.get(file.id) ?? [];
    if (!exports.length) continue;
    const edges = incoming.get(file.id) ?? [];
    const exportReason = reason ?? (edges.some(edge => edge.names === 'all')
      ? '모두 가져오는 import(* as, export *)가 있어 어느 이름을 쓰는지 정할 수 없어요.' : null);
    if (exportReason) { result.exports.unsure.push({ ...entry, reason: exportReason, count: exports.length }); continue; }
    const names = new Set(edges.flatMap(edge => edge.names === 'all' ? [] : edge.names));
    result.exports.candidates.push(...exports.filter(item => !names.has(item.name))
      .sort((a, b) => a.startUtf16 - b.startUtf16).map(item => ({ ...item, relativePath: name })));
  }
  result.excluded = excludeKinds.filter(kind => counts.has(kind)).map(kind => ({ kind, count: counts.get(kind)! }));
  const unread = files.filter(file => ['partial', 'failed', 'skipped'].includes(file.checked)).length;
  if (unread) {
    const note = `끝까지 읽지 못한 파일 ${unread}개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.`;
    result.notes.push(note);
    result.exports.notes.push(note);
  }
  if (result.exports.candidates.length) result.exports.notes.push(
    "시험 파일이 가져다 쓰는 export도 '쓰임'으로 봐요.",
    'export 이름만 비교했어요. 객체 안 속성이나 클래스 메서드가 쓰이는지는 보지 않아요.',
  );
  const computed = map.unresolved.filter(item => {
    if (item.reason !== 'not-static') return false;
    const from = pathsById.get(item.fromFileId);
    return !item.specifier || item.specifier.startsWith('/')
      || resolveImport(from ?? '', item.specifier, known, pathAliases).kind === 'external';
  }).length;
  if (computed) result.notes.push(`코드로 정하는 가져오기가 ${computed}곳 있어 후보가 실제로 쓰일 수 있어요.`);
  if (scripts.failed.length) {
    result.notes.push(`package.json ${scripts.failed.length}개를 읽지 못해 실행 명령에 적힌 파일을 확인하지 못했어요: ${failedNames(scripts.failed)}`);
  }
  if (scripts.referenceFailed.length) {
    result.notes.push(`설정·HTML 파일 ${scripts.referenceFailed.length}개를 읽지 못해 거기 적힌 경로를 확인하지 못했어요: ${failedNames(scripts.referenceFailed)}`);
  }
  result.notes.push(...pathAliases.notes);
  result.notes.push('안 쓰는 파일이 가져다 쓰는 파일은 후보에 나오지 않아요(그 파일이 아직 import하고 있으므로).');
  return result;
}

export async function scriptFilesOf(root: string, files: ProjectFile[], known: Map<string, ProjectFile>,
  bytesLeft: number, shouldStop: () => boolean): Promise<ScriptFiles> {
  const result: ScriptFiles = { files: new Set(), failed: [], references: new Set(), referenceFailed: [] };
  const packages = files.filter(file => path.posix.basename(file.relativePath) === 'package.json')
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of packages) {
    if (shouldStop()) throw new AppError('CANCELLED', '지도 만들기를 취소했어요.');
    if (bytesLeft <= 0) {
      result.failed.push({ relativePath: file.relativePath, reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' });
      continue;
    }
    let manifest: unknown;
    try {
      const source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, bytesLeft));
      bytesLeft -= Buffer.byteLength(source.text);
      manifest = JSON.parse(source.text);
    } catch (error) {
      const reason = error instanceof AppError ? error.message
        : error instanceof SyntaxError ? 'JSON 형식으로 읽을 수 없어요.' : '파일을 읽지 못했어요.';
      result.failed.push({ relativePath: file.relativePath, reason });
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || !('scripts' in manifest)) continue;
    const scripts = manifest.scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) continue;
    const words = Object.values(scripts).filter((value): value is string => typeof value === 'string')
      .flatMap(command => (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
        .map(word => word.replace(/"([^"]*)"|'([^']*)'/g, (_match, double, single) => double ?? single)));
    const matches = words.filter(word => !path.posix.isAbsolute(word) && (word.includes('/') || codeFile.test(word)))
      .flatMap(word => candidatesFor(file.relativePath, word, known) ?? []).filter(name => codeFile.test(name));
    for (const name of matches) result.files.add(name);
  }
  const referenceSources = files.filter(file => isConfigFile(file.relativePath) || /\.html$/i.test(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of referenceSources) {
    if (shouldStop()) throw new AppError('CANCELLED', '지도 만들기를 취소했어요.');
    if (bytesLeft <= 0) {
      result.referenceFailed.push({ relativePath: file.relativePath, reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' });
      continue;
    }
    let text: string;
    try {
      const source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, bytesLeft));
      bytesLeft -= Buffer.byteLength(source.text);
      text = source.text;
    } catch (error) {
      const reason = error instanceof AppError ? error.message : '파일을 읽지 못했어요.';
      result.referenceFailed.push({ relativePath: file.relativePath, reason });
      continue;
    }
    // Quoted strings stop at a line end: an apostrophe in a comment ("0.21's" in forge.config.ts) must not pair
    // with the next real quote and flip every string after it.
    const matches = [...text.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g)]
      .flatMap(match => {
        const value = match[1] ?? match[2] ?? match[3];
        if (!value || value.includes('://') || value.includes('*') || (match[3] !== undefined && value.includes('${'))) return [];
        if (!value.includes('/') && !codeFile.test(value)) return [];
        const fromPaths = value.startsWith('/') ? [file.relativePath, path.posix.basename(file.relativePath)] : [file.relativePath];
        const relative = `./${value.replace(/^\/+/, '')}`;
        return fromPaths.flatMap(from => candidatesFor(from, relative, known) ?? []).filter(name => codeFile.test(name));
      });
    for (const name of matches) result.references.add(name);
  }
  return result;
}
