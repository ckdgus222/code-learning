import path from 'node:path';
import type { ProjectFile, ProjectMap, UnusedExcludeKind, UnusedFiles } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, readAllowed } from '../project/files';
import { candidatesFor, codeFile, isRelative } from './project-map';
import { isTestFile } from './routes';
import { isNextConfig } from './next-routes';

export type { UnusedExcludeKind, UnusedFiles } from '../../shared/contracts';
export interface ScriptFiles { files: Set<string>; failed: { relativePath: string; reason: string }[] }

const excludeKinds: UnusedExcludeKind[] = ['start', 'test', 'config', 'types', 'framework', 'script'];
const nextAppFile = /^(?:page|layout|route|loading|error|global-error|not-found|template|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[^.]+$/;
// Apply the same cleanup to alias tails and file paths, including aliases that name an index file.
const aliasPath = (name: string) => name.replace(codeFile, '').replace(/\/index$/, '');

export function unusedFiles(map: Omit<ProjectMap, 'unused'>, scripts: ScriptFiles): UnusedFiles {
  const result: UnusedFiles = { candidates: [], unsure: [], excluded: [], notes: [] };
  const files = map.files.filter(file => file.checked !== 'not-code' && codeFile.test(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const known = new Map(files.map(file => [file.relativePath, { id: file.id, relativePath: file.relativePath, size: 0 }]));
  const pathsById = new Map(files.map(file => [file.id, file.relativePath]));
  const used = new Set(map.edges.filter(edge => edge.fromFileId !== edge.toFileId).map(edge => edge.toFileId));
  const unresolved = new Set(map.unresolved.flatMap(item => item.candidates));
  const dynamic = new Set<string>();
  for (const item of map.unresolved) {
    if (item.reason !== 'not-static' || !item.specifier || !isRelative(item.specifier)) continue;
    const from = pathsById.get(item.fromFileId);
    if (!from) continue;
    for (const name of candidatesFor(from, item.specifier, known) ?? []) dynamic.add(name);
  }
  const aliases = [...new Set(map.external.map(item => aliasPath(item.specifier?.split('/').slice(1).join('/') ?? '')).filter(Boolean))];
  const nextRoots = [...new Set(map.files.filter(file => isNextConfig(file.relativePath)).map(file => {
    const folder = path.posix.dirname(file.relativePath);
    return folder === '.' ? '' : `${folder}/`;
  }))];
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
    const kind: UnusedExcludeKind | null = file.start ? 'start'
      // Playwright projects often name tests `*.e2e.ts` or keep them in an `e2e/` folder (dog-walk does both).
      : isTestFile(name) || /[.-](?:spec|test|e2e)\.[^/]+$/.test(name) || /(?:^|\/)e2e\//.test(name) ? 'test'
      : /\.config\./.test(basename) || /^\..*rc\./.test(basename) || isNextConfig(name) ? 'config'
      : /\.d\.(?:ts|mts|cts)$/i.test(name) ? 'types'
      : framework ? 'framework'
      : scripts.files.has(name) ? 'script' : null;
    if (kind) { counts.set(kind, (counts.get(kind) ?? 0) + 1); continue; }
    if (used.has(file.id)) continue;
    const normalized = aliasPath(name);
    const reason = unresolved.has(name) ? '대상을 확정하지 못한 import가 이 파일을 가리킬 수 있어요.'
      : dynamic.has(name) ? '동적 import(또는 require)로 쓰일 수 있어요.'
      : aliases.some(tail => normalized === tail || normalized.endsWith(`/${tail}`)) ? '경로 별칭으로 쓰일 수 있어요.' : null;
    const entry = { fileId: file.id, relativePath: name };
    if (reason) { result.unsure.push({ ...entry, reason }); continue; }
    result.candidates.push(entry);
  }
  result.excluded = excludeKinds.filter(kind => counts.has(kind)).map(kind => ({ kind, count: counts.get(kind)! }));
  const unread = files.filter(file => ['partial', 'failed', 'skipped'].includes(file.checked)).length;
  if (unread) result.notes.push(`끝까지 읽지 못한 파일 ${unread}개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.`);
  const computed = map.unresolved.filter(item => item.reason === 'not-static' && (!item.specifier || !isRelative(item.specifier))).length;
  if (computed) result.notes.push(`코드로 정하는 가져오기가 ${computed}곳 있어 후보가 실제로 쓰일 수 있어요.`);
  if (scripts.failed.length) {
    const names = scripts.failed.slice(0, 5).map(file => `${file.relativePath}(${file.reason})`).join(', ');
    const rest = scripts.failed.length > 5 ? ` 외 ${scripts.failed.length - 5}개` : '';
    result.notes.push(`package.json ${scripts.failed.length}개를 읽지 못해 실행 명령에 적힌 파일을 확인하지 못했어요: ${names}${rest}`);
  }
  result.notes.push('안 쓰는 파일이 가져다 쓰는 파일은 후보에 나오지 않아요(그 파일이 아직 import하고 있으므로).');
  return result;
}

export async function scriptFilesOf(root: string, files: ProjectFile[], known: Map<string, ProjectFile>,
  bytesLeft: number, shouldStop: () => boolean): Promise<ScriptFiles> {
  const result: ScriptFiles = { files: new Set(), failed: [] };
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
  return result;
}
