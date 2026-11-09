import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { compareWith, findGit, GIT_LIMITS, gitJob, gitLaunch, repositoryOf, type Repository } from '../src/core/project/git';
import { AppError } from '../src/shared/errors';
import type { FileDiff, GitHistory, ProjectChanges, ProjectFiles } from '../src/shared/contracts';

// Plan v2.3 C-2 test repositories, made with the real git. The test's own git calls use no user config.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
// With paths, only those are committed (whatever else is staged stays staged).
const commit = (cwd: string, message: string, ...only: string[]) =>
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', message, ...(only.length ? ['--', ...only] : []));
const write = (root: string, relative: string, text: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
};
const never = () => false;

let root: string;
let temp: string[];
beforeEach(async () => {
  temp = [];
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-test-')));
  temp.push(root);
});
afterEach(async () => { for (const folder of temp) await rm(folder, { recursive: true, force: true }); });

async function open(folder: string): Promise<ProjectFiles> { return scanProject(folder, randomUUID()); }
const history = async (folder: string, project: ProjectFiles) => await gitJob(folder, project.id, { mode: 'history' }, never) as GitHistory;
const compare = async (folder: string, project: ProjectFiles, oid: string, stop = never) =>
  await gitJob(folder, project.id, { mode: 'changes', files: project.files, commit: oid }, stop) as ProjectChanges;
/** The old side of a change alone; a side the rules refuse comes back as its error. */
async function oldCode(folder: string, project: ProjectFiles, oid: string, relative: string) {
  const old = (await gitJob(folder, project.id, { mode: 'diff', commit: oid, oldPath: relative, nowPath: null }, never) as FileDiff).old!;
  if ('code' in old) throw new AppError(old.code, old.message);
  return old.text;
}
const kinds = (found: Pick<ProjectChanges, 'changes'>) => found.changes.map(change => `${change.kind} ${change.oldPath ? `${change.oldPath} → ` : ''}${change.path}`);

/** The five kinds of change and the cases that must not be called one of them. */
function fiveKinds() {
  git(root, 'init', '-q');
  write(root, 'src/keep.ts', 'export const keep = 1;\n');
  write(root, 'src/edit.ts', 'export const edit = 1;\n');
  write(root, 'src/gone.ts', 'export const gone = 1;\n');
  write(root, 'src/old-name.ts', 'export const moved = 1;\n');
  write(root, 'src/moved-edit.ts', 'export const movedEdit = 1;\n');
  write(root, 'src/dup-a.ts', 'export const same = 1;\n');
  write(root, 'src/dup-b.ts', 'export const same = 1;\n');
  write(root, '.env', 'SECRET=1\n');
  write(root, 'dist/out.js', 'built\n');
  write(root, 'ignored-tracked.txt', 'tracked, then ignored\n');
  symlinkSync('keep.ts', path.join(root, 'src/link.ts'));
  git(root, 'add', '-A');
  commit(root, 'first');
  const first = git(root, 'rev-parse', 'HEAD');
  write(root, '.gitignore', 'ignored-tracked.txt\n');
  write(root, 'src/edit.ts', 'export const edit = 2;\n');
  rmSync(path.join(root, 'src/gone.ts'));
  git(root, 'mv', 'src/old-name.ts', 'src/new-name.ts');
  rmSync(path.join(root, 'src/moved-edit.ts'));
  write(root, 'src/moved-edited.ts', 'export const movedEdit = 2;\n');
  rmSync(path.join(root, 'src/dup-a.ts'));
  rmSync(path.join(root, 'src/dup-b.ts'));
  write(root, 'src/dup-c.ts', 'export const same = 1;\n');
  write(root, 'src/staged.ts', 'export const staged = 1;\n');
  git(root, 'add', 'src/staged.ts');
  write(root, 'src/fresh.ts', 'export const fresh = 1;\n');
  rmSync(path.join(root, '.env'));
  return first;
}

describe('git launch (M2-2c)', () => {
  it('always launches macOS git through its sandbox and refuses a missing profile', () => {
    const tool = { exe: '/installed/git', profile: '(version 1)' };
    const launch = gitLaunch('darwin', tool, ['--version']);
    expect(launch.file).toBe('/usr/bin/sandbox-exec');
    expect(launch.args).toEqual(['-p', tool.profile, tool.exe, '--no-pager', '-c', 'core.fsmonitor=false', '-c',
      'core.hooksPath=/dev/null', '-c', 'log.showSignature=false', '-c', 'protocol.allow=never', '-c', 'core.unsetenvvars=',
      '-c', 'safe.bareRepository=explicit', '--version']);
    expect(launch.env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' });
    expect(() => gitLaunch('darwin', { ...tool, profile: '' }, [])).toThrow();
  });

  it.each(['win32', 'linux'] as const)('refuses %s even with a profile', platform => {
    expect(() => gitLaunch(platform, { exe: '/installed/git', profile: '(version 1)' }, [])).toThrow();
    expect(() => gitLaunch(platform, { exe: '/installed/git', profile: '' }, [])).toThrow();
  });

  it.runIf(process.platform === 'win32')('explains that changes are unavailable on Windows', async () => {
    const project = await open(root);
    expect(await history(root, project)).toEqual({
      projectId: project.id, available: false, reason: 'Windows에서는 아직 변경 보기를 쓸 수 없어요.', commits: [],
    });
  });
});

describe.runIf(process.platform === 'darwin')('cancelling a running git', () => {
  it('rejects promptly with CANCELLED after the running process has ended', async () => {
    const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-cancel-')));
    temp.push(folder);
    const exe = path.join(folder, 'git.sh');
    const pidFile = path.join(folder, 'git.pid');
    writeFileSync(exe, `#!/bin/sh\necho $$ > '${pidFile.replaceAll("'", "'\\''")}'\nexec /bin/sleep 30\n`);
    chmodSync(exe, 0o755);
    const profile = '(version 1)\n(allow default)\n';
    const stop = () => existsSync(pidFile);

    try {
      const started = performance.now();
      await expect(repositoryOf({ exe, profile }, root, stop)).rejects.toMatchObject({
        code: 'CANCELLED', message: '작업을 취소했습니다.',
      });
      expect(performance.now() - started).toBeLessThan(2000);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      // execFile reports the abort as soon as SIGKILL is sent (8 of 8 local runs still saw the pid then); it is gone a moment later.
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = performance.now() + 1000;
      while (alive() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(alive()).toBe(false);
    } finally {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  });
});

describe.runIf(process.platform === 'darwin')('changes against a chosen commit (plan v2.3 C-2)', () => {
  it('finds the five kinds of change, and leaves out what the rules exclude without calling it deleted', async () => {
    const first = fiveKinds();
    const project = await open(root);
    const found = await compare(root, project, first);
    expect(kinds(found)).toEqual([
      'deleted src/dup-a.ts', 'deleted src/dup-b.ts', 'untracked src/dup-c.ts', 'modified src/edit.ts', 'untracked src/fresh.ts',
      'deleted src/gone.ts', 'deleted src/moved-edit.ts', 'untracked src/moved-edited.ts',
      'renamed src/old-name.ts → src/new-name.ts', 'added src/staged.ts',
      // .gitignore is new and not added.
      'untracked .gitignore',
    ].sort((a, b) => a.split(' ').at(-1)!.localeCompare(b.split(' ').at(-1)!)));
    expect(found.notCompared).toEqual(expect.arrayContaining([
      { reason: '제외 규칙(인증·비밀·데이터 파일)', count: 1 },
      { reason: '제외 규칙(의존성·생성물·설정 폴더)', count: 1 },
      { reason: '제외 규칙(.gitignore)', count: 1 },
      { reason: '링크·서브모듈', count: 1 },
    ]));
    const fileOf = (relative: string) => project.files.find(file => file.relativePath === relative)!.id;
    expect(found.changes.find(change => change.path === 'src/edit.ts')!.fileId).toBe(fileOf('src/edit.ts'));
    expect(found.changes.find(change => change.kind === 'deleted')!.fileId).toBeNull();
  });

  it('opens the old code of a modified, deleted and renamed file, and refuses what a file now would be refused', async () => {
    const first = fiveKinds();
    write(root, 'big.txt', 'x');
    write(root, 'blob.txt', 'x');
    git(root, 'add', '-f', 'big.txt', 'blob.txt');
    commit(root, 'more', 'big.txt', 'blob.txt');
    const second = git(root, 'rev-parse', 'HEAD');
    write(root, 'big.txt', 'x'.repeat(300 * 1024));
    write(root, 'blob.txt', Buffer.from([0x68, 0x00, 0x69]));
    git(root, 'add', '-f', 'big.txt', 'blob.txt');
    commit(root, 'big and binary', 'big.txt', 'blob.txt');
    const third = git(root, 'rev-parse', 'HEAD');
    const project = await open(root);
    expect(await oldCode(root, project, first, 'src/edit.ts')).toBe('export const edit = 1;\n');
    expect(await oldCode(root, project, first, 'src/gone.ts')).toBe('export const gone = 1;\n');
    expect(await oldCode(root, project, first, 'src/old-name.ts')).toBe('export const moved = 1;\n');
    await expect(oldCode(root, project, first, '.env')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(oldCode(root, project, first, 'dist/out.js')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(oldCode(root, project, third, 'big.txt')).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(oldCode(root, project, third, 'blob.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await oldCode(root, project, second, 'big.txt')).toBe('x');
    await expect(oldCode(root, project, first, '../outside.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    // A folder of the commit: no file type the app reads, so the rules refuse it before git is asked.
    await expect(oldCode(root, project, first, 'src')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(oldCode(root, project, first, 'src/never.ts')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an object number that is a tree or a file, not a commit', async () => {
    const first = fiveKinds();
    const project = await open(root);
    const tree = git(root, 'rev-parse', `${first}^{tree}`);
    const blob = git(root, 'rev-parse', `${first}:src/keep.ts`);
    const srcTree = git(root, 'rev-parse', `${first}:src`);
    for (const oid of [tree, blob, srcTree, '0'.repeat(40)]) {
      await expect(compare(root, project, oid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(oldCode(root, project, oid, 'keep.ts')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(compare(root, project, 'HEAD')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('lists the commits of the opened folder, HEAD first, with no commit or no repository said plainly', async () => {
    fiveKinds();
    commit(root, 'second', 'src/staged.ts');
    const project = await open(root);
    const found = await history(root, project);
    expect(found).toMatchObject({ available: true, reason: null });
    expect(found.commits.map(item => [item.subject, item.head])).toEqual([['second', true], ['first', false]]);
    const plain = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-plain-')));
    temp.push(plain);
    write(plain, 'a.ts', 'export const a = 1;\n');
    expect(await history(plain, await open(plain))).toMatchObject({ available: false, reason: '이 폴더는 Git 저장소가 아니에요.', commits: [] });
    const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-empty-')));
    temp.push(empty);
    git(empty, 'init', '-q');
    write(empty, 'a.ts', 'export const a = 1;\n');
    expect(await history(empty, await open(empty))).toMatchObject({ available: false, reason: '아직 커밋이 없어 비교할 기준이 없어요.' });
  });

  it('uses a repository above the opened folder only for the paths inside it', async () => {
    const first = fiveKinds();
    write(root, 'docs/readme.md', 'outside the opened folder\n');
    git(root, 'add', 'docs/readme.md');
    commit(root, 'outside only', 'docs/readme.md');
    const src = path.join(root, 'src');
    const project = await open(src);
    const found = await history(src, project);
    // The commit that changed only docs/ is HEAD: listed as HEAD, without its subject.
    expect(found.commits.map(item => [item.subject, item.head])).toEqual([[null, true], ['first', false]]);
    const changes = await compare(src, project, first);
    expect(kinds(changes).sort()).toEqual([
      'added staged.ts', 'deleted dup-a.ts', 'deleted dup-b.ts', 'deleted gone.ts', 'deleted moved-edit.ts', 'modified edit.ts',
      'renamed old-name.ts → new-name.ts', 'untracked dup-c.ts', 'untracked fresh.ts', 'untracked moved-edited.ts',
    ]);
    expect(await oldCode(src, project, first, 'edit.ts')).toBe('export const edit = 1;\n');
    await expect(oldCode(src, project, first, 'docs/readme.md')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reads history, changes and old code from a folder two levels below the repository', async () => {
    git(root, 'init', '-q');
    write(root, 'src/nested/edit.ts', 'export const edit = 1;\n');
    write(root, 'outside.ts', 'export const outside = 1;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    write(root, 'src/nested/edit.ts', 'export const edit = 2;\n');
    write(root, 'outside.ts', 'export const outside = 2;\n');
    const folder = path.join(root, 'src', 'nested');
    const project = await open(folder);
    expect(await history(folder, project)).toMatchObject({ available: true, commits: [{ oid: first, subject: 'first', head: true }] });
    expect(kinds(await compare(folder, project, first))).toEqual(['modified edit.ts']);
    expect(await oldCode(folder, project, first, 'edit.ts')).toBe('export const edit = 1;\n');
  });

  it('leaves a submodule\'s own files out instead of calling them new', async () => {
    git(root, 'init', '-q');
    write(root, 'a.ts', 'export const a = 1;\n');
    const inner = path.join(root, 'sub');
    mkdirSync(inner);
    git(inner, 'init', '-q');
    write(inner, 'inner.ts', 'export const inner = 1;\n');
    git(inner, 'add', '-A');
    commit(inner, 'inner');
    // Adding the inner repository records it as a submodule entry (mode 160000).
    git(root, 'add', 'a.ts', 'sub');
    commit(root, 'outer');
    const first = git(root, 'rev-parse', 'HEAD');
    expect(git(root, 'ls-tree', first)).toMatch(/^160000 commit [0-9a-f]+\tsub$/m);
    write(root, 'a.ts', 'export const a = 2;\n');
    const project = await open(root);
    expect(project.files.map(file => file.relativePath)).toContain('sub/inner.ts');
    const found = await compare(root, project, first);
    expect(kinds(found)).toEqual(['modified a.ts']);
    expect(found.notCompared).toEqual(expect.arrayContaining([{ reason: '링크·서브모듈', count: 1 }, { reason: '서브모듈 안', count: 1 }]));
  });

  it('finds a rename that only changes case, on a folder that ignores case', async () => {
    git(root, 'init', '-q');
    write(root, 'readme.md', 'read me\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    git(root, 'mv', 'readme.md', 'README.md');
    const project = await open(root);
    expect(kinds(await compare(root, project, first))).toEqual(['renamed readme.md → README.md']);
    expect(await oldCode(root, project, first, 'readme.md')).toBe('read me\n');
  });

  it('counts a link of the commit that is now a plain file once, and does not call it new', async () => {
    git(root, 'init', '-q');
    write(root, 'target.ts', 'export const t = 1;\n');
    symlinkSync('target.ts', path.join(root, 'alias.ts'));
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    rmSync(path.join(root, 'alias.ts'));
    write(root, 'alias.ts', 'export const alias = 1;\n');
    const project = await open(root);
    const found = await compare(root, project, first);
    expect(kinds(found)).toEqual([]);
    expect(found.notCompared).toEqual([{ reason: '링크·서브모듈', count: 1 }]);
  });

  it('still gives the old side when the file now was deleted after the comparison', async () => {
    const first = fiveKinds();
    const project = await open(root);
    rmSync(path.join(root, 'src/edit.ts'));
    const both = await gitJob(root, project.id, { mode: 'diff', commit: first, oldPath: 'src/edit.ts', nowPath: 'src/edit.ts' }, never) as FileDiff;
    expect(both.old).toEqual({ text: 'export const edit = 1;\n' });
    expect(both.now).toMatchObject({ code: expect.any(String) });
  });

  it('gives both sides of a change at once, the file now read under the same rules', async () => {
    const first = fiveKinds();
    const project = await open(root);
    const both = await gitJob(root, project.id, { mode: 'diff', commit: first, oldPath: 'src/edit.ts', nowPath: 'src/edit.ts' }, never) as FileDiff;
    expect(both.old).toEqual({ text: 'export const edit = 1;\n' });
    expect(both.now).toEqual({ text: 'export const edit = 2;\n' });
    const refused = await gitJob(root, project.id, { mode: 'diff', commit: first, oldPath: null, nowPath: '.env' }, never) as FileDiff;
    expect(refused.old).toBeNull();
    expect(refused.now).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('limits the bytes read by the read itself: a file grown since opening is left out, one shrunk is read', async () => {
    git(root, 'init', '-q');
    write(root, 'a.txt', 'a'.repeat(40));
    write(root, 'b.txt', 'b'.repeat(400));
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    const project = await open(root);
    // After opening: a.txt grows past what is left, b.txt shrinks well under it.
    write(root, 'a.txt', 'A'.repeat(400));
    write(root, 'b.txt', 'B'.repeat(20));
    const tool = (await findGit())!;
    const repo = await repositoryOf(tool, root) as Repository;
    const found = await compareWith(tool, repo, root, project.files, first, never, { ...GIT_LIMITS, bytes: 100 });
    expect(kinds(found)).toEqual(['modified b.txt']);
    expect(found.notCompared).toEqual([{ reason: '읽기 한도', count: 1 }]);
  });

  it('does not call a file deleted when its folder cannot be listed', async () => {
    git(root, 'init', '-q');
    write(root, 'src/locked/x.ts', 'export const x = 1;\n');
    write(root, 'src/open.ts', 'export const open = 1;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    const locked = path.join(root, 'src/locked');
    // No permission at all: its .gitignore cannot be read, so the rules leave it out first. Enter-only: the rules
    // pass (no .gitignore there), but the folder cannot be listed to see whether x.ts is still there.
    for (const [mode, reason] of [[0o000, '제외 규칙(.gitignore를 읽을 수 없음)'], [0o111, '있는지 확인할 수 없음(폴더 권한)']] as const) {
      chmodSync(locked, mode);
      try {
        const project = await open(root);
        const found = await compare(root, project, first);
        expect(kinds(found)).toEqual([]);
        expect(found.notCompared).toEqual([{ reason, count: 1 }]);
      } finally { chmodSync(locked, 0o755); }
    }
  });

  it.each([
    ['1,024 units', Array(10).fill('a'.repeat(100)).join('/') + '/abcdefghijk.ts', false],
    ['1,025 units', Array(10).fill('a'.repeat(100)).join('/') + '/abcdefghijkl.ts', true],
    ['21 components', Array(20).fill('a').join('/') + '/main.ts', false],
    ['22 components', Array(21).fill('a').join('/') + '/main.ts', true],
    ['NFC 1,024 units', Array(20).fill('가'.repeat(50)).join('/') + '/a.ts', false],
    ['NFC 1,025 units', Array(20).fill('가'.repeat(50)).join('/') + '/aa.ts', true],
    ['NFD 1,025 units', Array(20).fill('가'.repeat(25).normalize('NFD')).join('/') + '/aa.ts', true],
  ])('applies path limits to historical paths with %s', async (_name, relative, excluded) => {
    git(root, 'init', '-q');
    // Build git objects directly: these historical paths need not fit the host filesystem's limits.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env, input: 'old code' }).toString().trim();
    const parts = relative.split('/');
    let entry = `100644 blob ${blob}\t${parts.pop()}\0`;
    let tree = execFileSync('git', ['mktree', '-z'], { cwd: root, env, input: entry }).toString().trim();
    for (const folder of parts.reverse()) {
      entry = `040000 tree ${tree}\t${folder}\0`;
      tree = execFileSync('git', ['mktree', '-z'], { cwd: root, env, input: entry }).toString().trim();
    }
    const oid = git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'historical path');
    git(root, 'update-ref', 'HEAD', oid);
    const project = await open(root);
    const found = await compare(root, project, oid);
    if (excluded) {
      expect(found.changes).toEqual([]);
      expect(found.notCompared).toEqual([{ reason: '제외 규칙(경로 길이·깊이 제한)', count: 1 }]);
      await expect(oldCode(root, project, oid, relative)).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: expect.stringContaining('경로 길이·깊이 제한') });
      return;
    }
    expect(found.notCompared).toEqual([]);
    expect(found.changes).toMatchObject([{ kind: 'deleted', path: relative }]);
    expect(await oldCode(root, project, oid, relative)).toBe('old code');
  });

  it('matches Korean names however they are normalized on disk', async () => {
    git(root, 'init', '-q');
    const nfd = (value: string) => value.normalize('NFD');
    write(root, nfd('폴더/같음.ts'), 'export const same = 1;\n');
    write(root, nfd('폴더/고침.ts'), 'export const edit = 1;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    write(root, nfd('폴더/고침.ts'), 'export const edit = 2;\n');
    const nfc = (found: Pick<ProjectChanges, 'changes'>) => kinds(found).map(item => item.normalize('NFC'));
    const project = await open(root);
    expect(nfc(await compare(root, project, first))).toEqual(['modified 폴더/고침.ts']);
    expect(await oldCode(root, project, first, nfd('폴더/고침.ts'))).toBe('export const edit = 1;\n');
    // Opened at the decomposed folder itself, below the repository's top.
    const folder = path.join(root, nfd('폴더'));
    const inner = await open(folder);
    expect(nfc(await compare(folder, inner, first))).toEqual(['modified 고침.ts']);
    expect(await oldCode(folder, inner, first, nfd('고침.ts'))).toBe('export const edit = 1;\n');
  });

  it('applies a .gitignore to a Korean name whichever way either side spells it', async () => {
    git(root, 'init', '-q');
    write(root, '비밀.ts', 'export const hidden = 1;\n');
    write(root, '숨김.ts', 'export const hidden = 2;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    write(root, '가나.ts', 'export const hidden = 3;\n');
    git(root, 'add', '가나.ts');
    commit(root, 'third', '가나.ts');
    const third = git(root, 'rev-parse', 'HEAD');
    // git keeps the names composed; the .gitignore spells one decomposed, one composed and one mixed. All are then deleted.
    write(root, '.gitignore', `${'비밀.ts'.normalize('NFD')}\n${'숨김.ts'.normalize('NFC')}\n${'가'.normalize('NFC')}${'나.ts'.normalize('NFD')}\n`);
    rmSync(path.join(root, '비밀.ts'));
    rmSync(path.join(root, '숨김.ts'));
    rmSync(path.join(root, '가나.ts'));
    const project = await open(root);
    const found = await compare(root, project, first);
    expect(kinds(found)).toEqual(['untracked .gitignore']);
    expect(found.notCompared).toEqual([{ reason: '제외 규칙(.gitignore)', count: 2 }]);
    for (const name of ['비밀.ts', '숨김.ts']) {
      for (const spelling of [name.normalize('NFC'), name.normalize('NFD')]) {
        await expect(oldCode(root, project, first, spelling)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
      }
    }
    const mixed = await compare(root, project, third);
    expect(kinds(mixed)).toEqual(['untracked .gitignore']);
    expect(mixed.notCompared).toEqual([{ reason: '제외 규칙(.gitignore)', count: 3 }]);
    for (const spelling of ['가나.ts'.normalize('NFC'), '가나.ts'.normalize('NFD')]) {
      await expect(oldCode(root, project, third, spelling)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
  });

  it('counts a file refused after reading toward the byte limit', async () => {
    git(root, 'init', '-q');
    write(root, 'keep.txt', 'k\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    const project0 = await open(root);
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(root, name, Buffer.from([0x61, 0, 0x62, 0, 0x63, 0, 0x64, 0]));
    const project = { ...project0, files: (await open(root)).files.filter(file => file.relativePath !== 'keep.txt') };
    const tool = (await findGit())!;
    const repo = await repositoryOf(tool, root) as Repository;
    const found = await compareWith(tool, repo, root, project.files, first, never, { ...GIT_LIMITS, bytes: 16 });
    expect(found.notCompared).toEqual(expect.arrayContaining([{ reason: '읽을 수 없음', count: 1 }, { reason: '읽기 한도', count: 2 }]));
  });

  it('refuses history kept outside the repository folder: a .git link or gitdir file, and borrowed objects', async () => {
    // B: another repository with a private file in its history.
    const other = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-other-')));
    temp.push(other);
    git(other, 'init', '-q');
    write(other, 'private.ts', 'export const privateValue = 1;\n');
    git(other, 'add', '-A');
    commit(other, 'private');
    const privateCommit = git(other, 'rev-parse', 'HEAD');
    write(root, 'a.ts', 'export const a = 1;\n');
    const refused = 'Git 기록이 저장소 폴더 밖에 있어(.git 링크·gitdir 파일·작업 트리·서브모듈) 읽지 않아요.';
    for (const point of ['gitdir file', 'link'] as const) {
      rmSync(path.join(root, '.git'), { recursive: true, force: true });
      if (point === 'gitdir file') writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
      else symlinkSync(path.join(other, '.git'), path.join(root, '.git'));
      const project = await open(root);
      expect(await history(root, project)).toMatchObject({ available: false, reason: refused, commits: [] });
      await expect(compare(root, project, privateCommit)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: refused });
      await expect(oldCode(root, project, privateCommit, 'private.ts')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    }
    rmSync(path.join(root, '.git'), { recursive: true, force: true });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    commit(root, 'own');
    const own = git(root, 'rev-parse', 'HEAD');
    write(root, '.git/objects/info/alternates', `${path.join(other, '.git', 'objects')}\n`);
    const project = await open(root);
    expect(await history(root, project)).toMatchObject({ available: false, reason: '다른 저장소의 개체를 빌려 쓰는 저장소(alternates)라 읽지 않아요.' });
    rmSync(path.join(root, '.git/objects/info/alternates'));
    expect(await history(root, project)).toMatchObject({ available: true });
    // A linked hook is common and lends no history: still read.
    symlinkSync(path.join(other, '.git/HEAD'), path.join(root, '.git/hooks/pre-commit'));
    expect(await history(root, project)).toMatchObject({ available: true });
    // A link anywhere in the history folder: the objects folder itself, or one file deep inside it.
    const linked = 'Git 기록 폴더 안에 링크가 있어(다른 저장소와 이어질 수 있어요) 읽지 않아요.';
    const objects = path.join(root, '.git/objects');
    rmSync(`${objects}-own`, { recursive: true, force: true });
    renameSync(objects, `${objects}-own`);
    symlinkSync(path.join(other, '.git/objects'), objects);
    expect(await history(root, project)).toMatchObject({ available: false, reason: linked });
    await expect(compare(root, project, privateCommit)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: linked });
    await expect(oldCode(root, project, privateCommit, 'private.ts')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    rmSync(objects);
    renameSync(`${objects}-own`, objects);
    expect(await history(root, project)).toMatchObject({ available: true });
    mkdirSync(path.join(objects, 'pack'), { recursive: true });
    symlinkSync(path.join(other, '.git/HEAD'), path.join(objects, 'pack', 'borrowed.pack'));
    expect(await history(root, project)).toMatchObject({ available: false, reason: linked });
    await expect(compare(root, project, own)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: linked });
  });

  it('keeps to the history folder it checked, even when that repository\'s core.worktree points to a folder above', async () => {
    // X: another repository with a file under A/ in its history. P/.git points at X; P/A is its own repository whose
    // core.worktree is P, so git reports P as A's top. Commands run at P must still read A's history, never X's.
    const other = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-git-other-')));
    temp.push(other);
    git(other, 'init', '-q');
    write(other, 'A/private.ts', 'export const privateValue = 1;\n');
    git(other, 'add', '-A');
    commit(other, 'private');
    const privateCommit = git(other, 'rev-parse', 'HEAD');
    writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    const inner = path.join(root, 'A');
    mkdirSync(inner);
    git(inner, 'init', '-q');
    git(inner, 'config', 'core.worktree', root);
    git(inner, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'own');
    write(inner, 'mine.ts', 'export const mine = 1;\n');
    const project = await open(inner);
    const found = await history(inner, project);
    expect(found.commits.map(item => item.oid)).not.toContain(privateCommit);
    expect(found.commits.every(item => item.subject !== 'private')).toBe(true);
    await expect(compare(inner, project, privateCommit)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(oldCode(inner, project, privateCommit, 'private.ts')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reads a SHA-256 repository', async () => {
    git(root, 'init', '-q', '--object-format=sha256');
    write(root, 'a.ts', 'export const a = 1;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    expect(first).toHaveLength(64);
    write(root, 'a.ts', 'export const a = 2;\n');
    write(root, 'b.ts', 'export const b = 1;\n');
    const project = await open(root);
    expect(kinds(await compare(root, project, first))).toEqual(['modified a.ts', 'untracked b.ts']);
  });

  it('stops when asked and leaves no git process', async () => {
    const first = fiveKinds();
    const project = await open(root);
    await expect(compare(root, project, first, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    let running = '';
    try { running = execFileSync('pgrep', ['-f', root]).toString(); } catch { /* none */ }
    expect(running).toBe('');
  });

});

describe.runIf(process.platform === 'darwin')('a repository cannot make the app run programs or change it (plan v2.3 C-2 security)', () => {
  it('runs nothing the repository\'s config names, and leaves .git as it was', async () => {
    const first = fiveKinds();
    const marks = path.join(root, '..', `${path.basename(root)}-marks`);
    mkdirSync(marks);
    temp.push(marks);
    const scripts = path.join(root, '..', `${path.basename(root)}-scripts`);
    mkdirSync(scripts);
    temp.push(scripts);
    const script = (name: string) => {
      const file = path.join(scripts, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\ntouch '${path.join(marks, name).split(path.sep).join('/')}'\ncat\n`);
      chmodSync(file, 0o755);
      return `'${file.split(path.sep).join('/')}'`;
    };
    write(root, '.gitattributes', '*.ts filter=evil diff=evil\n');
    git(root, 'config', 'core.fsmonitor', script('fsmonitor'));
    git(root, 'config', 'filter.evil.clean', script('clean'));
    git(root, 'config', 'filter.evil.smudge', script('smudge'));
    git(root, 'config', 'log.showSignature', 'true');
    git(root, 'config', 'gpg.program', script('gpg'));
    git(root, 'config', 'diff.evil.textconv', script('textconv'));
    git(root, 'config', 'diff.external', script('extdiff'));
    git(root, 'config', 'core.pager', script('pager'));
    git(root, 'config', 'core.hooksPath', scripts);
    script('post-index-change');
    git(root, 'status');
    expect(existsSync(path.join(marks, 'fsmonitor'))).toBe(true);
    expect(existsSync(path.join(marks, 'clean'))).toBe(true);
    git(root, 'diff', first);
    expect(existsSync(path.join(marks, 'extdiff'))).toBe(true);
    git(root, 'diff', '--no-ext-diff', first);
    expect(existsSync(path.join(marks, 'textconv'))).toBe(true);
    for (const name of readdirSync(marks)) rmSync(path.join(marks, name));
    const before = snapshot(path.join(root, '.git'));
    const project = await open(root);
    await history(root, project);
    await compare(root, project, first);
    await oldCode(root, project, first, 'src/edit.ts');
    expect(readdirSync(marks)).toEqual([]);
    expect(snapshot(path.join(root, '.git'))).toEqual(before);
  });

  it.each(['ext', 'ssh'] as const)('blocks %s lazy fetch even when repository config allows that transport', async transport => {
    git(root, 'init', '-q');
    write(root, 'a.ts', 'export const a = 1;\n');
    git(root, 'add', '-A');
    commit(root, 'first');
    const first = git(root, 'rev-parse', 'HEAD');
    const blob = git(root, 'rev-parse', `${first}:a.ts`);
    rmSync(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    write(root, 'a.ts', 'export const a = 2;\n');
    git(root, 'config', 'core.repositoryformatversion', '1');
    git(root, 'config', 'extensions.partialClone', 'origin');
    git(root, 'config', 'remote.origin.promisor', 'true');
    git(root, 'config', 'core.unsetenvvars', 'GIT_ALLOW_PROTOCOL,GIT_NO_LAZY_FETCH');
    git(root, 'config', `protocol.${transport}.allow`, 'always');
    const mark = path.join(root, 'fetched');
    const script = path.join(root, '.git', 'fetch marker.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${mark.split(path.sep).join('/')}'\nexit 1\n`);
    chmodSync(script, 0o755);
    const scriptPath = script.split(path.sep).join('/');
    if (transport === 'ext') {
      // remote-ext splits arguments itself; % escapes a space or percent, unlike shell quotes.
      git(root, 'config', 'remote.origin.url', `ext::sh ${scriptPath.replaceAll('%', '%%').replaceAll(' ', '% ')}`);
    } else {
      git(root, 'config', 'remote.origin.url', 'ssh://example.invalid/repo');
      git(root, 'config', 'core.sshCommand', `'${scriptPath}'`);
    }
    expect(() => git(root, 'cat-file', '-p', blob)).toThrow();
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);
    const project = await open(root);
    expect(kinds(await compare(root, project, first))).toEqual(['modified a.ts']);
    await expect(oldCode(root, project, first, 'a.ts')).rejects.toMatchObject({ code: 'IO', message: 'Git 명령이 실패했어요.' });
    expect(existsSync(mark)).toBe(false);
  });

  it('keeps the app\'s environment from git', async () => {
    const first = fiveKinds();
    const project = await open(root);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = '/nonexistent';
    process.env.GIT_INDEX_FILE = '/nonexistent/index';
    try {
      expect((await history(root, project)).available).toBe(true);
      expect(kinds(await compare(root, project, first))).toContain('added src/staged.ts');
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it('lets git start no other program inside its sandbox', async () => {
    const tool = (await findGit())!;
    expect(tool).toBeTruthy();
    const mark = path.join(root, 'started');
    let failed = false;
    try { execFileSync('/usr/bin/sandbox-exec', ['-p', tool.profile, '/bin/sh', '-c', `touch ${mark}`], { stdio: 'pipe' }); }
    catch { failed = true; }
    expect(failed).toBe(true);
    expect(existsSync(mark)).toBe(false);
    // git itself runs; writing a file does not.
    expect(execFileSync('/usr/bin/sandbox-exec', ['-p', tool.profile, tool.exe, '--version']).toString()).toMatch(/^git version/);
    let wrote = true;
    try { execFileSync('/usr/bin/sandbox-exec', ['-p', tool.profile, tool.exe, 'init', '-q', path.join(root, 'new-repo')], { stdio: 'pipe' }); }
    catch { wrote = false; }
    expect(wrote).toBe(false);
    expect(existsSync(path.join(root, 'new-repo', '.git', 'HEAD'))).toBe(false);
  });
});

/** Every entry under a folder with its size and modification time. */
function snapshot(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const info = lstatSync(full);
      out.push(`${path.relative(folder, full)} ${info.size} ${info.mtimeMs}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(folder);
  return out;
}
