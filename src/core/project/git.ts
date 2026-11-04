import { execFile } from 'node:child_process';
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodeSide, FileChange, FileDiff, GitCommit, GitHistory, ProjectChanges, ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, pathPolicy, readAllowed, validateRelative } from './files';

/*
 * Plan v2.3 C-2: a chosen commit against the files now, read only. The installed git (user decision A) runs on macOS
 * inside a sandbox with no writes, no network and no other program, with a clean environment and settings that keep
 * the repository's own config from starting programs or fetching. Windows has no such sandbox, so v1.0 does not run
 * git there (user decision 2026-11-05). Only read commands are used: rev-parse, log, ls-tree, ls-files and cat-file.
 * diff and status run the repository's filters, so the comparison itself is worked out here.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// /usr/bin/git is a stub that offers to install the developer tools when they are missing, so it is not used.
const GIT_CANDIDATES = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  '/opt/homebrew/bin/git', '/usr/local/bin/git'];
// Nothing of the app's environment (secrets, GIT_DIR and the like) reaches git; no user or system config is read.
// A partial clone fetches a missing object on read, which can start the repository's ssh command: GIT_ALLOW_PROTOCOL
// left empty allows no transport, over any protocol.<name>.allow in the repository, and newer git skips the fetch.
const GIT_ENV = { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
const SAFE_ARGS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'log.showSignature=false', '-c', 'protocol.allow=never', '-c', 'core.unsetenvvars=', '-c', 'safe.bareRepository=explicit'];
const COMMAND_MS = 10_000;
export const GIT_LIMITS = { files: 1000, bytes: 16 * 1024 * 1024, treeEntries: 20_000 };
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitTool { exe: string; profile: string }

/** Git always runs inside the macOS sandbox; other platforms and missing profiles are refused. */
export function gitLaunch(platform: NodeJS.Platform, tool: GitTool, args: string[]): { file: string; args: string[]; env: Record<string, string> } {
  if (platform !== 'darwin') throw new AppError('UNSUPPORTED', '이 운영체제에서는 Git을 쓸 수 없어요.');
  if (!tool.profile) throw new AppError('UNSUPPORTED', 'Git 실행을 보호할 프로필이 없어요.');
  return { file: SANDBOX_EXEC, args: ['-p', tool.profile, tool.exe, ...SAFE_ARGS, ...args], env: GIT_ENV };
}
/**
 * Paths are compared by their NFC form: macOS may keep a Korean name decomposed (NFD) on disk while git records it
 * composed. Each path is still read and passed to git in its own form. Case is kept, so a case-only rename is seen.
 */
const key = (value: string) => value.normalize('NFC');
/** A repository found and checked: its top, the opened folder's place in it, and the very history folder checked. */
export interface Repository { top: string; gitDir: string; prefix: string; format: 'sha1' | 'sha256' }

/** An absolute path as an SBPL string; JSON escaping covers the quotes and backslashes SBPL needs. */
function sbpl(value: string) {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new AppError('UNSUPPORTED', 'Git 위치의 경로 형식을 확인할 수 없어요.');
  return JSON.stringify(value);
}
/** No writes but /dev/null, no network, and no program but git itself and its own helpers. */
export const gitProfile = (exe: string, helpers: string | null) => `(version 1)
(allow default)
(deny network*)
(deny file-write* (require-not (literal "/dev/null")))
(deny process-exec (require-not (require-any (literal ${sbpl(exe)})${helpers ? ` (subpath ${sbpl(helpers)})` : ''})))
`;

function run(tool: GitTool, cwd: string, args: string[], { maxBuffer = 1024 * 1024, stop = () => false }: { maxBuffer?: number; stop?: () => boolean } = {}) {
  return new Promise<Buffer>((resolve, reject) => {
    const launch = gitLaunch(process.platform, tool, args);
    const controller = new AbortController();
    // The worker waits for git asynchronously, so it can end its own child when asked to stop.
    const poll = setInterval(() => { if (stop()) controller.abort(); }, 50);
    execFile(launch.file, launch.args,
      { cwd, env: launch.env, encoding: 'buffer', maxBuffer, timeout: COMMAND_MS, killSignal: 'SIGKILL', signal: controller.signal, windowsHide: true },
      (error, stdout, stderr) => {
        clearInterval(poll);
        if (!error) { resolve(stdout); return; }
        if (controller.signal.aborted) reject(new AppError('CANCELLED', '작업을 취소했습니다.'));
        else if ((error as { killed?: boolean }).killed) reject(new AppError('LIMIT', 'Git이 너무 오래 걸리거나 너무 많이 답해 멈췄어요.'));
        else reject(Object.assign(new AppError('IO', 'Git 명령이 실패했어요.'), { stderr: stderr.toString('utf8').slice(0, 2000) }));
      });
  });
}

let located: Promise<GitTool | null> | undefined;
/** The installed git, found once per process in fixed places; null when there is none. */
export function findGit(): Promise<GitTool | null> {
  located ??= (async () => {
    if (process.platform !== 'darwin') return null;
    try { await access(SANDBOX_EXEC, constants.X_OK); } catch { return null; }
    for (const candidate of GIT_CANDIDATES) {
      try {
        await access(candidate, constants.X_OK);
        const exe = await realpath(candidate);
        if (!(await stat(exe)).isFile()) continue;
        // Its helper folder, asked with only the binary itself allowed to run.
        const helpers = (await run({ exe, profile: gitProfile(exe, null) }, '/', ['--exec-path'])).toString('utf8').trim();
        return { exe, profile: gitProfile(exe, await realpath(helpers)) };
      } catch { continue; }
    }
    return null;
  })();
  return located;
}

/**
 * The repository the opened folder is in: the folder itself or a folder above it (user decision). Only paths inside
 * the opened folder are ever compared or shown. Every later command runs at the repository's top.
 */
export async function repositoryOf(tool: GitTool, root: string, stop?: () => boolean): Promise<Repository | { reason: string }> {
  let lines: string[];
  try {
    lines = (await run(tool, root, ['rev-parse', '--show-toplevel', '--show-prefix', '--show-object-format', '--path-format=absolute', '--git-dir',
      '--git-common-dir'], { stop })).toString('utf8').split('\n');
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    if (error instanceof AppError && error.code !== 'IO') throw error;
    if (/dubious ownership/.test(stderr)) return { reason: '저장소 소유자가 지금 사용자와 달라 Git이 열기를 거절했어요.' };
    if (/not a git repository|must be run in a work tree/i.test(stderr)) return { reason: '이 폴더는 Git 저장소가 아니에요.' };
    // Anything else (the sandbox, a broken repository) is not passed off as "no repository".
    return { reason: 'Git을 실행하지 못해 이 폴더의 기록을 읽을 수 없어요.' };
  }
  const [topLine, prefix, format, gitDirLine, commonDirLine] = lines;
  if (!topLine || (format !== 'sha1' && format !== 'sha256') || !gitDirLine || !commonDirLine) return { reason: '이 폴더는 Git 저장소가 아니에요.' };
  const top = await realpath(topLine);
  // The history read must be this repository's own: a .git link or `gitdir:` file can point at another repository's
  // history (its files would then show as deleted, their old code openable), and alternates lend another one's objects.
  const inside = (folder: string) => folder === top || folder.startsWith(top + path.sep);
  const [gitDir, commonDir] = await Promise.all([gitDirLine, commonDirLine].map(folder => realpath(folder).catch(() => '')));
  if (!inside(gitDir) || !inside(commonDir)) {
    return { reason: 'Git 기록이 저장소 폴더 밖에 있어(.git 링크·gitdir 파일·작업 트리·서브모듈) 읽지 않아요.' };
  }
  if (await lstat(path.join(commonDir, 'objects', 'info', 'alternates')).then(() => true, () => false)) {
    return { reason: '다른 저장소의 개체를 빌려 쓰는 저장소(alternates)라 읽지 않아요.' };
  }
  const links = await linksIn(commonDir, stop);
  if (links !== 'none') {
    return { reason: links === 'found' ? 'Git 기록 폴더 안에 링크가 있어(다른 저장소와 이어질 수 있어요) 읽지 않아요.'
      : 'Git 기록 폴더의 항목이 너무 많아 링크가 있는지 확인하지 못해 읽지 않아요.' };
  }
  const [rootKey, topKey] = [key(root), key(top)];
  // A repository below the opened folder, or one found through a link elsewhere, is not this folder's.
  if (rootKey !== topKey && !rootKey.startsWith(topKey + path.sep)) return { reason: 'Git 저장소 위치가 열린 폴더와 맞지 않아요.' };
  const expected = rootKey === topKey ? '' : rootKey.slice(topKey.length + 1).split(path.sep).join('/') + '/';
  if (key(prefix) !== expected) return { reason: 'Git 저장소 위치가 열린 폴더와 맞지 않아요.' };
  return { top, gitDir, prefix, format };
}

// The parts of a history folder that hold or point at history. hooks/ and the like are left alone: a linked hook
// is common, and hooks never run here.
const HISTORY_PARTS = ['objects', 'refs', 'packed-refs', 'HEAD', 'info', 'shallow'];

/**
 * Whether a part that holds history is a link or has one inside: objects/, a pack or refs/ linked elsewhere would lend
 * another repository's history, so such a repository is not read at all (a normal one has none).
 */
async function linksIn(folder: string, stop?: () => boolean): Promise<'none' | 'found' | 'too-many'> {
  const pending: string[] = [];
  for (const part of HISTORY_PARTS) {
    const info = await lstat(path.join(folder, part)).catch(() => null);
    if (info?.isSymbolicLink()) return 'found';
    if (info?.isDirectory()) pending.push(path.join(folder, part));
  }
  let seen = 0;
  while (pending.length) {
    if (stop?.()) throw new AppError('CANCELLED', '작업을 취소했습니다.');
    const dir = pending.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++seen > 200_000) return 'too-many';
      if (entry.isSymbolicLink()) return 'found';
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
    }
  }
  return 'none';
}

/**
 * A command on the checked repository. Its history folder and top are given outright, so git never looks for a
 * repository again: settings such as core.worktree could otherwise lead it to another, unchecked history.
 */
const inRepo = (tool: GitTool, repo: Repository, args: string[], options?: Parameters<typeof run>[3]) =>
  run(tool, repo.top, [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.top}`, ...args], options);

/** A pathspec for the opened folder, taken literally; none when it is the repository's top. */
const folderSpec = (repo: Repository) => repo.prefix ? ['--', `:(literal)${repo.prefix.slice(0, -1)}`] : [];

/**
 * Up to 100 commits that changed the opened folder, newest first, then HEAD itself at the top when it did not:
 * a commit that changed only other folders is not listed, nor its subject.
 */
export async function commitsOf(tool: GitTool, repo: Repository, stop?: () => boolean): Promise<GitCommit[]> {
  let head: string;
  try { head = (await inRepo(tool, repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { stop })).toString('utf8').trim(); }
  catch (error) { if (error instanceof AppError && error.code !== 'IO') throw error; return []; }
  const log = (await inRepo(tool, repo, ['log', '-n', '100', '--no-show-signature', '--format=%H%x1f%ct%x1f%s%x1e', 'HEAD', ...folderSpec(repo)],
    { stop, maxBuffer: 4 * 1024 * 1024 })).toString('utf8');
  const commits: GitCommit[] = log.split('\x1e').map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [oid, time, ...subject] = record.split('\x1f');
    return { oid, time: Number(time), subject: subject.join('\x1f').slice(0, 200), head: oid === head };
  });
  if (!commits.some(commit => commit.head)) {
    const time = Number((await inRepo(tool, repo, ['log', '-n', '1', '--no-show-signature', '--format=%ct', head], { stop })).toString('utf8').trim());
    commits.unshift({ oid: head, time, subject: null, head: true });
  }
  return commits;
}

/** Refuses anything but a commit: a tree's number would make ls-tree show a folder as the top and hide its path. */
async function assertCommit(tool: GitTool, repo: Repository, commit: string, stop?: () => boolean) {
  if (!COMMIT_OID.test(commit)) throw new AppError('INVALID_REQUEST', '커밋 번호 형식이 아니에요.');
  let type = '';
  try { type = (await inRepo(tool, repo, ['cat-file', '-t', commit], { stop })).toString('utf8').trim(); }
  catch (error) { if (error instanceof AppError && error.code !== 'IO') throw error; }
  if (type !== 'commit') throw new AppError('INVALID_REQUEST', '이 저장소의 커밋이 아니에요.');
}

/** `mode type oid\tpath` records of ls-tree, paths made relative to the opened folder. */
function treeEntries(output: Buffer, repo: Repository) {
  return output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    return { mode, type, oid, path: record.slice(tab + 1).slice(repo.prefix.length) };
  });
}

/** Git's object number of a file's bytes, worked out here: no file is handed to git, so no filter runs. */
const blobId = (bytes: Buffer, format: Repository['format']) =>
  createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Whether a path is there spelled exactly so: a macOS folder ignores case, so lstat finds readme.md when only
 * README.md is there, and a rename that only changes case would be missed. Each folder is listed once. A folder
 * that cannot be listed (permissions) leaves it unknown, never "gone".
 */
function exactPaths(root: string) {
  const listings = new Map<string, Promise<Set<string> | 'missing' | 'unknown'>>();
  const names = (dir: string) => {
    let found = listings.get(dir);
    if (!found) {
      found = readdir(path.join(root, dir)).then(list => new Set(list.map(key)),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' as const : 'unknown' as const);
      listings.set(dir, found);
    }
    return found;
  };
  return async (relative: string): Promise<'there' | 'gone' | 'unknown'> => {
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const listed = await names(parts.slice(0, i).join('/'));
      if (listed === 'unknown') return 'unknown';
      if (listed === 'missing' || !listed.has(key(parts[i]))) return 'gone';
    }
    return 'there';
  };
}

export interface ChangesFound { changes: FileChange[]; notCompared: { reason: string; count: number }[]; notes: string[] }

/**
 * The opened folder's files now against a commit (plan v2.3 C-2). A commit's path excluded by the current rules is
 * only counted, whether or not it is on disk, and never read. A file now is read through readAllowed.
 */
export async function compareWith(tool: GitTool, repo: Repository, root: string, files: ProjectFile[], commit: string,
  stop: () => boolean, limits = GIT_LIMITS): Promise<ChangesFound> {
  await assertCommit(tool, repo, commit, stop);
  const tree = treeEntries(await inRepo(tool, repo, ['ls-tree', '-r', '-z', '--full-tree', commit, ...folderSpec(repo)],
    { stop, maxBuffer: 64 * 1024 * 1024 }), repo);
  if (tree.length > limits.treeEntries) {
    throw new AppError('LIMIT', `이 커밋의 열린 폴더 안 항목이 ${limits.treeEntries.toLocaleString()}개를 넘어 비교하지 않았어요.`);
  }
  const indexOutput = (await inRepo(tool, repo, ['ls-files', '-z', '-s', ...folderSpec(repo)], { stop, maxBuffer: 64 * 1024 * 1024 })).toString('utf8');
  const index = indexOutput.split('\0').filter(Boolean).map(record => ({
    mode: record.slice(0, record.indexOf(' ')), path: record.slice(record.indexOf('\t') + 1).slice(repo.prefix.length) }));
  const indexed = new Set(index.map(entry => key(entry.path)));
  // A submodule is another repository: its own files are not this one's changes (mode 160000 in the commit or the index).
  const submodules = [...new Set([...tree, ...index].filter(entry => entry.mode === '160000').map(entry => key(entry.path)))];
  const inSubmodule = (relative: string) => submodules.some(folder => key(relative).startsWith(folder + '/'));

  const notCompared = new Map<string, number>();
  const skip = (reason: string) => notCompared.set(reason, (notCompared.get(reason) ?? 0) + 1);
  const policy = pathPolicy(root);
  // Both sides are keyed by key(path); each keeps its own path (git's, or the one on disk).
  const committed = new Map<string, { path: string; oid: string }>();
  // Counted once, here, even when the file is also in the list of now.
  const counted = new Set<string>();
  for (const entry of tree) {
    if (stop()) throw new AppError('CANCELLED', '작업을 취소했습니다.');
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) { skip('링크·서브모듈'); counted.add(key(entry.path)); continue; }
    const reason = await policy(entry.path);
    if (reason) { skip(`제외 규칙(${reason})`); counted.add(key(entry.path)); continue; }
    committed.set(key(entry.path), { path: entry.path, oid: entry.oid });
  }

  // The files listed when the folder opened, read now within the map's limits.
  const current = new Map<string, { path: string; oid: string; fileId: string }>();
  const present = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (stop()) throw new AppError('CANCELLED', '작업을 취소했습니다.');
    if (inSubmodule(file.relativePath)) { skip('서브모듈 안'); continue; }
    // Left out on the commit's side already (a link there, now a plain file): counted once and not called new.
    if (counted.has(key(file.relativePath))) continue;
    const notNow = (reason: string) => { present.add(key(file.relativePath)); skip(reason); };
    // The size listed when the folder opened may be old: the bytes left are the limit of the read itself.
    const left = limits.bytes - bytes;
    if (current.size >= limits.files || left <= 0) { notNow('읽기 한도'); continue; }
    let text: string;
    try { ({ text } = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left))); }
    catch (error) {
      // A file refused after reading (not UTF-8, binary, changed meanwhile) still used up to the limit of its read. One
      // refused by the rules or found too big by its size is refused before reading.
      if (!(error instanceof AppError && (error.code === 'NOT_ALLOWED' || error.code === 'LIMIT'))) bytes += Math.min(MAX_FILE_BYTES, left);
      const gone = await lstat(path.join(root, file.relativePath)).then(() => false, () => true);
      if (!gone) {
        notNow(error instanceof AppError && error.code === 'LIMIT' ? '읽기 한도'
          : error instanceof AppError && error.code === 'NOT_ALLOWED' ? '지금 규칙으로 제외' : '읽을 수 없음');
      }
      continue;
    }
    // readAllowed decodes strict UTF-8 and keeps a BOM, so encoding the text again gives back the very bytes.
    const data = Buffer.from(text, 'utf8');
    bytes += data.length;
    current.set(key(file.relativePath), { path: file.relativePath, oid: blobId(data, repo.format), fileId: file.id });
  }

  const changes: FileChange[] = [];
  const deleted: { path: string; oid: string }[] = [];
  const isThere = exactPaths(root);
  for (const [name, old] of committed) {
    const now = current.get(name);
    if (now) {
      if (now.oid !== old.oid) changes.push({ kind: 'modified', path: now.path, oldPath: null, fileId: now.fileId });
    } else if (!present.has(name)) {
      // Only whether it is there, by name; nothing is read.
      const there = await isThere(old.path);
      if (there === 'there') skip('폴더를 열 때 목록에 없음(크기·탐색 한도)');
      else if (there === 'unknown') skip('있는지 확인할 수 없음(폴더 권한)');
      else deleted.push({ path: old.path, oid: old.oid });
    }
  }
  const added: { path: string; oid: string; fileId: string; kind: 'added' | 'untracked' }[] = [];
  for (const [name, now] of current) {
    if (!committed.has(name)) added.push({ path: now.path, oid: now.oid, fileId: now.fileId, kind: indexed.has(name) ? 'added' : 'untracked' });
  }
  // A rename only when exactly one deleted file and exactly one new file have the same content.
  const count = (items: { oid: string }[]) => items.reduce((counts, item) => counts.set(item.oid, (counts.get(item.oid) ?? 0) + 1), new Map<string, number>());
  const deletedCount = count(deleted);
  const addedCount = count(added);
  const renamed = new Set<string>();
  for (const item of added) {
    if (addedCount.get(item.oid) !== 1 || deletedCount.get(item.oid) !== 1) continue;
    const from = deleted.find(old => old.oid === item.oid)!;
    renamed.add(item.oid);
    changes.push({ kind: 'renamed', path: item.path, oldPath: from.path, fileId: item.fileId });
  }
  for (const item of added) if (!renamed.has(item.oid)) changes.push({ kind: item.kind, path: item.path, oldPath: null, fileId: item.fileId });
  for (const item of deleted) if (!renamed.has(item.oid)) changes.push({ kind: 'deleted', path: item.path, oldPath: null, fileId: null });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, notCompared: [...notCompared].map(([reason, count]) => ({ reason, count })), notes: [] };
}

export type GitJob = { mode: 'history' } | { mode: 'changes'; files: ProjectFile[]; commit: string }
  | { mode: 'diff'; commit: string; oldPath: string | null; nowPath: string | null };

/**
 * One side of a change, or why it cannot be opened: the rules, or the file gone or unreadable since the comparison.
 * Stopping is not a side's failure but the whole request's.
 */
async function side(read: () => Promise<string>): Promise<CodeSide> {
  try { return { text: await read() }; }
  catch (error) {
    if (error instanceof AppError && error.code === 'CANCELLED') throw error;
    if (error instanceof AppError) return { code: error.code, message: error.message };
    return { code: 'IO', message: '파일을 읽을 수 없어요(비교한 뒤 지웠거나 권한이 없어요).' };
  }
}

/** One request of the changes view, in a side worker: git and the repository are found again each time. */
export async function gitJob(root: string, projectId: string, job: GitJob, stop: () => boolean): Promise<GitHistory | ProjectChanges | FileDiff> {
  const tool = await findGit();
  const repo = tool ? await repositoryOf(tool, root, stop) : { reason: process.platform === 'win32'
    ? 'Windows에서는 아직 변경 보기를 쓸 수 없어요.' : '이 컴퓨터에서 Git을 찾지 못해 변경 보기를 쓸 수 없어요.' };
  if (!tool || 'reason' in repo) {
    if (job.mode === 'history') return { projectId, available: false, reason: 'reason' in repo ? repo.reason : null, commits: [] };
    throw new AppError('UNSUPPORTED', 'reason' in repo ? repo.reason : 'Git을 쓸 수 없어요.');
  }
  if (job.mode === 'history') {
    const commits = await commitsOf(tool, repo, stop);
    return { projectId, available: commits.length > 0, reason: commits.length ? null : '아직 커밋이 없어 비교할 기준이 없어요.', commits };
  }
  if (job.mode === 'changes') return { projectId, commit: job.commit, ...await compareWith(tool, repo, root, job.files, job.commit, stop) };
  // The file now goes through readAllowed like any read, here in this worker.
  const { commit, oldPath, nowPath } = job;
  return { projectId, commit, old: oldPath === null ? null : await side(() => oldCodeOf(tool, repo, root, commit, oldPath, stop)),
    now: nowPath === null ? null : await side(async () => (await readAllowed(root, nowPath)).text) };
}

/**
 * A file as it was in a commit, under the same rules as a file now: its path (in the opened folder) allowed by the
 * current exclusions and .gitignore, found again in that commit as a plain file, at most 256 KiB of UTF-8 text.
 */
export async function oldCodeOf(tool: GitTool, repo: Repository, root: string, commit: string, relative: string, stop?: () => boolean): Promise<string> {
  validateRelative(relative);
  await assertCommit(tool, repo, commit, stop);
  const reason = await pathPolicy(root)(relative);
  if (reason) throw new AppError('NOT_ALLOWED', `제외 규칙에 해당하는 경로라 이전 코드를 열지 않아요(${reason}).`);
  // Found by key in the folder's listing: the path asked may be spelled in another Unicode form than git keeps.
  const listing = treeEntries(await inRepo(tool, repo, ['ls-tree', '-r', '-z', '--full-tree', commit, ...folderSpec(repo)],
    { stop, maxBuffer: 64 * 1024 * 1024 }), repo);
  const [entry, ...others] = listing.filter(item => key(item.path) === key(relative));
  if (!entry || others.length || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
    throw new AppError('INVALID_REQUEST', '그 커밋에 이 파일이 없어요.');
  }
  // The path as git keeps it is judged too: it may be spelled otherwise than the one asked.
  const kept = await pathPolicy(root)(entry.path);
  if (kept) throw new AppError('NOT_ALLOWED', `제외 규칙에 해당하는 경로라 이전 코드를 열지 않아요(${kept}).`);
  const size = Number((await inRepo(tool, repo, ['cat-file', '-s', entry.oid], { stop })).toString('utf8').trim());
  if (!(size <= MAX_FILE_BYTES)) throw new AppError('LIMIT', '이전 코드가 256 KiB를 넘어 열지 않아요.');
  const data = await inRepo(tool, repo, ['cat-file', 'blob', entry.oid], { stop, maxBuffer: MAX_FILE_BYTES + 1 });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new AppError('UNSUPPORTED', 'UTF-8로 읽을 수 없는 이전 코드예요.'); }
  if (text.includes('\0')) throw new AppError('UNSUPPORTED', '바이너리 파일이라 이전 코드를 열지 않아요.');
  return text;
}
