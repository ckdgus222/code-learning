import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, open, realpath, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import type { ProjectFiles } from '../../shared/contracts';
import { AppError } from '../../shared/errors';

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 1000;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 20;
// Folders of secrets and tool state: never read, not even inside a dependency folder (plan v2.3 V-2).
const secretDirs = new Set(['.git', '.svn', '.hg', '.ssh', '.aws', '.azure', '.gcloud', '.codex', '.claude', '.gemini']);
const excludedDirs = new Set([...secretDirs,
  '.idea', '.vscode', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
/** The file types a project scan lists; anything else is excluded as unsupported or binary. */
export const textExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.py', '.java', '.dart',
  '.yaml', '.yml', '.toml', '.css', '.html', '.sql', '.conf']);
const textNames = new Set(['Dockerfile', 'Makefile', 'LICENSE', '.gitignore']);
type Rules = { base: string; matcher: Ignore }[];

export function validateRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new AppError('NOT_ALLOWED', '허용된 프로젝트 파일만 읽을 수 있습니다.');
  }
}

/** Whether the last part of a path names a secret, a key or a data dump, or any part is an .env file or folder. */
export function isSecretPath(relative: string): boolean {
  const parts = relative.split('/');
  const name = parts.at(-1)!;
  return parts.some(part => /^\.env(?:\.|$)/i.test(part)) ||
    /(?:^|[._-])(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519|dump|backup)(?:[._-]|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|db|sqlite|sqlite3|dump|bak)$/i.test(name) ||
    ['.npmrc', '.netrc', '.pypirc', 'auth.json'].includes(name.toLowerCase()) ||
    name.toLowerCase() === 'config.json' && relative.startsWith('.');
}

export function exclusionReason(relative: string, directory: boolean): string | null {
  const parts = relative.split('/');
  const name = parts.at(-1)!;
  if (parts.some(part => excludedDirs.has(part.toLowerCase()))) return '의존성·생성물·설정 폴더';
  if (isSecretPath(relative)) return '인증·비밀·데이터 파일';
  if (!directory && !textNames.has(name) && !textExtensions.has(path.extname(name).toLowerCase())) return '미지원·바이너리 파일';
  return null;
}

async function inspectPath(root: string, relative: string) {
  validateRelative(relative);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
    throw new AppError('NOT_ALLOWED', '프로젝트 폴더가 바뀌었습니다. 다시 열어 주세요.');
  }
  const identities = [`${rootStat.dev}:${rootStat.ino}`];
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    const current = path.join(root, ...parts.slice(0, i + 1));
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new AppError('NOT_ALLOWED', '심볼릭 링크와 폴더 밖 파일은 읽지 않습니다.');
    }
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  const absolute = path.join(root, relative);
  if (await realpath(absolute) !== absolute) throw new AppError('NOT_ALLOWED', '파일 경계를 확인할 수 없습니다.');
  return { absolute, identity: identities.join('/'), fileIdentity: identities.at(-1)! };
}

// Bound memory, reject links/special files, and compare the opened descriptor and path again.
// Node has no portable openat API: concurrent malicious ancestor replacement remains a documented limitation.
export async function readStable(root: string, relative: string, limit = MAX_FILE_BYTES): Promise<{ text: string; hash: string }> {
  const first = await inspectPath(root, relative);
  const handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || `${before.dev}:${before.ino}` !== first.fileIdentity) {
      throw new AppError('NOT_ALLOWED', '일반 파일만 읽을 수 있습니다. 링크·특수 파일은 제외합니다.');
    }
    if (before.size > limit) throw new AppError('LIMIT', '파일이 초기 읽기 크기 제한을 넘습니다.');
    if ((await inspectPath(root, relative)).identity !== first.identity) throw new AppError('CHANGED', '파일 경로가 바뀌었습니다.');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > limit) throw new AppError('LIMIT', '파일이 초기 읽기 크기 제한을 넘습니다.');
    const after = await handle.stat();
    const last = await inspectPath(root, relative);
    if (before.size !== count || after.size !== count || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        first.identity !== last.identity) throw new AppError('CHANGED', '읽는 동안 파일이 바뀌었습니다. 다시 열어 주세요.');
    const data = bytes.subarray(0, count);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new AppError('UNSUPPORTED', 'UTF-8로 읽을 수 없는 파일입니다.'); }
    if (text.includes('\0')) throw new AppError('UNSUPPORTED', '바이너리 파일은 읽지 않습니다.');
    return { text, hash: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
}

/** A folder's .gitignore added to the rules above it; `composed` keeps its patterns and folder in NFC (pathPolicy). */
async function addRules(root: string, base: string, inherited: Rules, composed = false): Promise<Rules> {
  const relative = base ? `${base}/.gitignore` : '.gitignore';
  try {
    const { text } = await readStable(root, relative, 64 * 1024);
    return [...inherited, composed ? { base: base.normalize('NFC'), matcher: ignore().add(text.normalize('NFC')) } : { base, matcher: ignore().add(text) }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return inherited;
    throw new AppError('NOT_ALLOWED', '.gitignore 규칙을 안전하게 읽을 수 없어 이 범위를 열지 않습니다.');
  }
}

// The public test() of `ignore` also applies that one file's verdict on every parent folder, so a folder
// excluded by an upper .gitignore stayed excluded for its children even after a deeper .gitignore
// re-included it (git shows those children). Both callers already stop at an excluded folder level by
// level, so each .gitignore only needs to judge the path itself. That single-path check is internal to
// ignore@7.0.12 (pinned in package.json); if it is missing, fail closed instead of guessing.
type OwnDecision = { ignored: boolean; unignored: boolean };
function decideOwnPath(matcher: Ignore, local: string): OwnDecision {
  const rules = (matcher as unknown as { _rules?: { test?(path: string, checkUnignored: boolean, mode: string): OwnDecision } })._rules;
  if (typeof rules?.test !== 'function') throw new AppError('INTERNAL', '.gitignore 규칙을 확인할 수 없어 이 범위를 열지 않습니다.');
  return rules.test(local, true, 'regex');
}

function ignored(relative: string, directory: boolean, rules: Rules): boolean {
  let result = false;
  for (const rule of rules) {
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative;
    const decision = decideOwnPath(rule.matcher, local + (directory ? '/' : ''));
    if (decision.ignored) result = true;
    else if (decision.unignored) result = false;
  }
  return result;
}

export async function assertAllowed(root: string, relative: string): Promise<void> {
  validateRelative(relative);
  const parts = relative.split('/');
  let rules = await addRules(root, '', []);
  for (let i = 0; i < parts.length; i++) {
    const current = parts.slice(0, i + 1).join('/');
    const directory = i < parts.length - 1;
    if (exclusionReason(current, directory) || ignored(current, directory, rules)) {
      throw new AppError('NOT_ALLOWED', '현재 제외 규칙에 해당하는 파일입니다. 폴더를 다시 열어 주세요.');
    }
    if (directory) rules = await addRules(root, current, rules);
  }
}

/**
 * The judgement of assertAllowed for many paths at once, by path only (plan v2.3 C-2: a path in a commit need not
 * exist now): why a path is excluded under the current rules, or null. Each folder's .gitignore is read once.
 * A Korean name may be spelled composed (NFC) or decomposed (NFD), or both mixed, in git, on disk and in a .gitignore.
 * So a path is judged twice: as written against the patterns as written, and with both path and patterns in NFC.
 * Excluded by either is excluded.
 */
export function pathPolicy(root: string): (relative: string) => Promise<string | null> {
  const rulesOf = new Map<string, Promise<Rules>>();
  // `dir` is the folder as the path spells it, which is how its .gitignore is read.
  const rulesFor = (dir: string, composed: boolean): Promise<Rules> => {
    let rules = rulesOf.get(`${composed}:${dir}`);
    if (!rules) {
      rules = dir ? rulesFor(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '', composed).then(inherited => addRules(root, dir, inherited, composed))
        : addRules(root, '', [], composed);
      rulesOf.set(`${composed}:${dir}`, rules);
    }
    return rules;
  };
  const judge = async (relative: string, composed: boolean) => {
    try { validateRelative(relative); } catch { return '경로 형식'; }
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const written = parts.slice(0, i + 1).join('/');
      const current = composed ? written.normalize('NFC') : written;
      const directory = i < parts.length - 1;
      const reason = exclusionReason(current, directory);
      if (reason) return reason;
      let rules: Rules;
      try { rules = await rulesFor(parts.slice(0, i).join('/'), composed); } catch { return '.gitignore를 읽을 수 없음'; }
      if (ignored(current, directory, rules)) return '.gitignore';
    }
    return null;
  };
  return async relative => await judge(relative, false) ?? await judge(relative, true);
}

export async function readAllowed(root: string, relative: string, limit = MAX_FILE_BYTES) {
  await assertAllowed(root, relative);
  const result = await readStable(root, relative, limit);
  await assertAllowed(root, relative);
  return result;
}

/** The same policy and path checks as reading, without reading: the file is still allowed and a plain file. */
export async function assertAllowedFile(root: string, relative: string): Promise<void> {
  await assertAllowed(root, relative);
  const { absolute, fileIdentity } = await inspectPath(root, relative);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.nlink !== 1 || `${stat.dev}:${stat.ino}` !== fileIdentity) {
    throw new AppError('NOT_ALLOWED', '일반 파일만 읽을 수 있습니다. 링크·특수 파일은 제외합니다.');
  }
}

export async function scanProject(root: string, projectId: string): Promise<ProjectFiles> {
  const result: ProjectFiles = { id: projectId, name: path.basename(root), files: [], excluded: {}, warnings: [] };
  let visited = 0;
  let limited = false;
  const exclude = (why: string) => { result.excluded[why] = (result.excluded[why] ?? 0) + 1; };
  async function walk(base: string, inherited: Rules, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) { limited = true; return; }
    if (base) await inspectPath(root, base);
    const rules = await addRules(root, base, inherited);
    const directory = await opendir(path.join(root, base));
    for await (const entry of directory) {
      if (++visited > MAX_ENTRIES || result.files.length >= MAX_FILES) { limited = true; break; }
      const relative = base ? `${base}/${entry.name}` : entry.name;
      const reason = exclusionReason(relative, entry.isDirectory());
      if (entry.isSymbolicLink()) { exclude('심볼릭 링크'); continue; }
      if (reason) { exclude(reason); continue; }
      if (ignored(relative, entry.isDirectory(), rules)) { exclude('.gitignore'); continue; }
      try {
        if (entry.isDirectory()) await walk(relative, rules, depth + 1);
        else if (entry.isFile()) {
          const checked = await inspectPath(root, relative);
          const stat = await lstat(checked.absolute);
          if (stat.nlink !== 1) { exclude('하드 링크'); continue; }
          if (stat.size > MAX_FILE_BYTES) { exclude('크기 제한'); continue; }
          result.files.push({ id: randomUUID(), relativePath: relative, size: stat.size });
        } else exclude('특수 파일');
      } catch { exclude('읽기 권한·경로·제외 규칙 확인 실패'); }
    }
  }
  await walk('', [], 0);
  result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (limited) result.warnings.push('초기 탐색 제한(파일 1,000개·항목 5,000개·깊이 20)에 도달했습니다. 더 작은 폴더를 선택해 주세요.');
  result.warnings.push('파일별 최대 256 KiB. UTF-8 텍스트만 읽으며 소스·설정·스크립트를 실행하지 않습니다.');
  return result;
}

/*
 * Plan v2.3 V-2: the one exception the user allowed to "dependency folders are not read". The type checker may
 * read type files (`.d.ts`, `.d.mts`, `.d.cts`, `package.json`) in a `node_modules` folder, for types only:
 * their text is never shown or sent anywhere. It asks through synchronous callbacks, so this part is synchronous.
 */
export const TYPE_FILE_BYTES = 4 * 1024 * 1024;
export const isTypeFileName = (name: string) => /\.d\.(?:ts|mts|cts)$/.test(name) || name === 'package.json';

/**
 * Whether a project-relative path lies in a dependency folder the type checker may look into: the part before
 * its first `node_modules` is the project folder ('') or one of `allowedDirs` (folders allowed by the current
 * rules), and no part after it is a secret folder or a secret name.
 */
export function inDependencyFolder(relative: string, allowedDirs: ReadonlySet<string>): boolean {
  const parts = relative.split('/');
  const at = parts.indexOf('node_modules');
  if (at === -1 || parts.some(part => !part || part === '.' || part === '..')) return false;
  if (!allowedDirs.has(parts.slice(0, at).join('/'))) return false;
  for (let i = at + 1; i < parts.length; i++) {
    if (secretDirs.has(parts[i].toLowerCase()) || isSecretPath(parts.slice(0, i + 1).join('/'))) return false;
  }
  return true;
}

export interface LinkStep { path: string; target: string }
const partsInside = (root: string, absolute: string) =>
  absolute === root ? [] : absolute.startsWith(root + '/') ? absolute.slice(root.length + 1).split('/') : null;

/**
 * Follows a path in the project folder part by part and resolves each link itself, so that every link on the way
 * and where it pointed are known (a package manager such as pnpm links packages inside node_modules). Null when a
 * part is missing, a link points out of the folder, or there are more than 40 links. The path returned has no links.
 */
export function resolveInside(root: string, absolute: string): { real: string; links: LinkStep[] } | null {
  let pending = path.resolve(absolute) === absolute ? partsInside(root, absolute) : null;
  if (!pending) return null;
  const links: LinkStep[] = [];
  let current = root;
  while (pending.length) {
    const next = path.join(current, pending.shift()!);
    let stat;
    try { stat = lstatSync(next); } catch { return null; }
    if (stat.isSymbolicLink()) {
      if (links.length >= 40) return null;
      const target = readlinkSync(next);
      const parts = partsInside(root, path.resolve(path.dirname(next), target));
      if (!parts) return null;
      links.push({ path: next, target });
      pending = [...parts, ...pending];
      current = root;
    } else if (pending.length && !stat.isDirectory()) return null;
    else current = next;
  }
  return { real: current, links };
}

export interface FileState { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }

/** The synchronous twin of inspectPath for a path that has no links (see resolveInside). */
function inspectSync(root: string, relative: string) {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new AppError('NOT_ALLOWED', '프로젝트 폴더가 바뀌었습니다. 다시 열어 주세요.');
  }
  const identities = [`${rootStat.dev}:${rootStat.ino}`];
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    let stat;
    try { stat = lstatSync(path.join(root, ...parts.slice(0, i + 1))); }
    catch { throw new AppError('CHANGED', '읽는 동안 파일이 바뀌었습니다.'); }
    // The path was resolved without links a moment ago: a link or a file in the way now means it changed.
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new AppError('CHANGED', '읽는 동안 파일 경로가 바뀌었습니다.');
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  return { absolute: path.join(root, relative), identity: identities.join('/'), fileIdentity: identities.at(-1)! };
}

/**
 * The synchronous twin of readStable for a type file at a path without links: the same checks before and after
 * reading, opened without following a link or waiting on a special file. `hooks` lets tests change the file midway.
 */
export function readTypeFile(root: string, real: string, limit = TYPE_FILE_BYTES,
  hooks: { beforeOpen?(): void; afterRead?(): void } = {}): { text: string; state: FileState } {
  const relative = real.slice(root.length + 1);
  const first = inspectSync(root, relative);
  hooks.beforeOpen?.();
  let fd: number;
  try { fd = openSync(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new AppError('CHANGED', '읽는 동안 파일이 바뀌었습니다.'); }
  try {
    const before = fstatSync(fd);
    if (`${before.dev}:${before.ino}` !== first.fileIdentity) throw new AppError('CHANGED', '읽는 동안 파일이 바뀌었습니다.');
    if (!before.isFile() || before.nlink !== 1) throw new AppError('NOT_ALLOWED', '일반 파일만 읽을 수 있습니다. 링크·특수 파일은 제외합니다.');
    if (before.size > limit) throw new AppError('LIMIT', '타입 파일이 크기 제한을 넘습니다.');
    // One byte more than the size it had: a file that grew while being read is caught below.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    hooks.afterRead?.();
    const after = fstatSync(fd);
    const last = inspectSync(root, relative);
    if (count !== before.size || after.size !== count || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        first.identity !== last.identity) throw new AppError('CHANGED', '읽는 동안 파일이 바뀌었습니다.');
    const data = bytes.subarray(0, count);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new AppError('UNSUPPORTED', 'UTF-8로 읽을 수 없는 파일입니다.'); }
    if (text.includes('\0')) throw new AppError('UNSUPPORTED', '바이너리 파일은 읽지 않습니다.');
    return { text, state: { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, dev: before.dev, ino: before.ino } };
  } finally { closeSync(fd); }
}
