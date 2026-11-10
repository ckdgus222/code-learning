import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, link, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE_BYTES, readAllowed, readStable, scanProject } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';

let root: string;
let sandbox: string;
async function put(relative: string, data: string | Buffer) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), data);
}
async function paths() { return (await scanProject(root, randomUUID())).files.map(file => file.relativePath); }
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    if ((await lstat(absolute)).isDirectory()) {
      for (const [child, hash] of Object.entries(await snapshot(absolute))) result[`${name}/${child}`] = hash;
    } else result[name] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return result;
}
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-files-test-')));
  root = path.join(sandbox, 'project');
  await mkdir(root);
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe('project file boundary', () => {
  it('opens additional source types as plain text while excluding general XML, properties and binaries', async () => {
    const names = ['main.go', 'lib.rs', 'App.vue', 'go.mod', 'pom.xml', 'Gemfile', 'Main.kt', 'build.kts', 'Main.cs',
      'main.rb', 'index.php', 'Main.swift', 'main.c', 'main.h', 'main.cpp', 'main.hpp', 'App.svelte', 'theme.scss', 'run.sh', 'build.gradle'];
    for (const name of [...names, 'logo.png', 'layout.xml', 'app.properties']) await put(name, 'plain source');
    const project = await scanProject(root, randomUUID());
    expect(project.files.map(file => file.relativePath).sort()).toEqual([...names].sort());
    expect(project.excluded['미지원·바이너리 파일']).toBe(3);
    for (const name of names) {
      const read = await readAllowed(root, name);
      const analysis = analyzeSource(read.text, name, { projectId: project.id, fileId: name, fileHash: read.hash });
      expect(analysis.language).toBe('text');
      expect(analysis.warnings).toContain('이 파일은 원문만 표시합니다. 현재 구문 분석은 TypeScript와 JavaScript만 지원합니다.');
    }
    for (const name of ['logo.png', 'layout.xml', 'app.properties']) {
      await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
  });

  it('reads exact UTF-8 source and preserves project bytes without running scripts', async () => {
    const source = '\uFEFFexport const hello = "안녕 🌱";\r\n';
    await put('src/main.ts', source);
    await put('package.json', JSON.stringify({ scripts: { prepare: 'touch executed.txt', start: 'touch executed.txt' } }));
    await put('danger.js', 'require("node:fs").writeFileSync("executed.txt", "ran");');
    const before = await snapshot(root);
    expect(await paths()).toEqual(['danger.js', 'package.json', 'src/main.ts']);
    const read = await readAllowed(root, 'src/main.ts');
    expect(read.text).toBe(source);
    expect(read.hash).toBe(createHash('sha256').update(source).digest('hex'));
    await readAllowed(root, 'danger.js');
    expect(await snapshot(root)).toEqual(before);
  });

  it('hard exclusions cannot be reopened by ignore negation', async () => {
    const blocked = ['.env', '.env.local', 'secret.ts', 'credentials.json', 'db.dump.sql', 'backup.sql',
      'token.txt', 'key.pem', '.npmrc', '.aws/config', 'node_modules/pkg/main.js', 'dist/main.js', 'vendor/a.ts', '.git/config'];
    for (const name of blocked) await put(name, 'sensitive');
    await put('.gitignore', blocked.map(name => `!${name}`).join('\n'));
    await put('src/safe.ts', 'export const ok = true;');
    expect(await paths()).toEqual(['.gitignore', 'src/safe.ts']);
    for (const name of blocked) await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('excludes auth.json at every depth while retaining ordinary config.json', async () => {
    await put('auth.json', 'sensitive root authentication');
    await put('sub/auth.json', 'sensitive nested authentication');
    await put('sub/AUTH.JSON', 'sensitive uppercase authentication');
    await put('config.json', '{"feature":true}');
    await put('sub/config.json', '{"feature":false}');
    expect(await paths()).toEqual(['config.json', 'sub/config.json']);
    for (const name of ['auth.json', 'sub/auth.json', 'sub/AUTH.JSON']) {
      await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
    expect((await readAllowed(root, 'config.json')).text).toBe('{"feature":true}');
    expect((await readAllowed(root, 'sub/config.json')).text).toBe('{"feature":false}');
  });

  it('still excludes auth.json when the user selects .codex itself as the root', async () => {
    await put('.codex/auth.json', 'sensitive authentication');
    await put('.codex/readme.md', 'ordinary text');
    const selectedRoot = path.join(root, '.codex');
    const result = await scanProject(selectedRoot, randomUUID());
    expect(result.files.map(file => file.relativePath)).toEqual(['readme.md']);
    await expect(readAllowed(selectedRoot, 'auth.json')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('honors nested ignore rules, negation and ignored parent directories', async () => {
    await put('.gitignore', '*.ts\n!keep.ts\nblocked/\n!blocked/allowed.ts\n');
    await put('keep.ts', 'keep');
    await put('drop.ts', 'drop');
    await put('blocked/allowed.ts', 'blocked');
    await put('blocked/.gitignore', '!allowed.ts');
    await put('src/.gitignore', '!nested.ts\nprivate/\n');
    await put('src/nested.ts', 'nested');
    await put('src/drop.ts', 'drop');
    await put('src/private/readme.md', 'private');
    expect(await paths()).toEqual(['.gitignore', 'keep.ts', 'src/.gitignore', 'src/nested.ts']);
    expect((await readAllowed(root, 'src/nested.ts')).text).toBe('nested');
    for (const name of ['drop.ts', 'blocked/allowed.ts', 'src/drop.ts', 'src/private/readme.md']) {
      await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
  });

  it('lets a deeper .gitignore re-include a folder that an upper one excluded, like git', async () => {
    // .txt is a readable type, so only the *.txt rule (not the unsupported-type check) can hide debug.txt.
    await put('.gitignore', 'foo/\n*.txt\nlocked/\n');
    await put('src/.gitignore', '!foo/\n');
    await put('src/foo/main.ts', 'shown');
    await put('src/foo/debug.txt', 'still ignored by *.txt');
    await put('src/locked/inner.ts', 'still ignored: locked/ is never re-included');
    await put('foo/top.ts', 'still ignored: the root foo/ has no deeper re-include');
    expect(await paths()).toEqual(['.gitignore', 'src/.gitignore', 'src/foo/main.ts']);
    expect((await readAllowed(root, 'src/foo/main.ts')).text).toBe('shown');
    for (const name of ['src/foo/debug.txt', 'src/locked/inner.ts', 'foo/top.ts']) {
      await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
    // Same answer as git itself, so this test fails if the pinned ignore package changes behaviour.
    execFileSync('git', ['init', '-q'], { cwd: root });
    const gitIgnored = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: root, encoding: 'utf8' });
    expect(gitIgnored).toContain('?? src/foo/main.ts');
    expect(gitIgnored).toContain('!! src/foo/debug.txt');
  });

  it('rechecks modified root and nested rules on each read', async () => {
    await put('src/main.ts', 'ok');
    expect(await paths()).toContain('src/main.ts');
    await put('src/.gitignore', 'main.ts');
    await expect(readAllowed(root, 'src/main.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await put('src/.gitignore', '');
    expect((await readAllowed(root, 'src/main.ts')).text).toBe('ok');
    await put('.gitignore', 'src/');
    await expect(readAllowed(root, 'src/main.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('fails closed for unreadable ignore content at root and nested scope', async () => {
    await put('safe.ts', 'ok');
    await put('.gitignore', Buffer.from([0xff]));
    await expect(scanProject(root, randomUUID())).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(readAllowed(root, 'safe.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await put('.gitignore', '');
    await put('src/main.ts', 'private');
    await put('src/.gitignore', Buffer.alloc(64 * 1024 + 1, 97));
    expect(await paths()).not.toContain('src/main.ts');
    await expect(readAllowed(root, 'src/main.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect((await readAllowed(root, 'safe.ts')).text).toBe('ok');
  });

  it('rejects symlink files, directories, roots and hard links', async () => {
    await writeFile(path.join(sandbox, 'outside.ts'), 'outside');
    await mkdir(path.join(sandbox, 'outside'));
    await writeFile(path.join(sandbox, 'outside', 'main.ts'), 'outside');
    await symlink(path.join(sandbox, 'outside.ts'), path.join(root, 'linked.ts'));
    await symlink(path.join(sandbox, 'outside'), path.join(root, 'linked-dir'));
    await link(path.join(sandbox, 'outside.ts'), path.join(root, 'hard.ts'));
    await symlink(root, path.join(sandbox, 'linked-root'));
    await put('normal.ts', 'ok');
    expect(await paths()).toEqual(['normal.ts']);
    for (const name of ['linked.ts', 'linked-dir/main.ts', 'hard.ts']) {
      await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
    await expect(readAllowed(path.join(sandbox, 'linked-root'), 'normal.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(scanProject(path.join(sandbox, 'linked-root'), randomUUID())).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it.skipIf(process.platform === 'win32')('rejects a named pipe without waiting for a writer', async () => {
    execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe.ts')]);
    expect(await paths()).not.toContain('pipe.ts');
    await expect(readAllowed(root, 'pipe.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  }, 2000);

  it('rejects invalid UTF-8, binary content and oversize files, accepts exact size limit', async () => {
    await put('invalid.ts', Buffer.from([0xc3, 0x28]));
    await put('binary.ts', 'text\0binary');
    await put('huge.ts', 'a'.repeat(MAX_FILE_BYTES + 1));
    await put('limit.ts', 'a'.repeat(MAX_FILE_BYTES));
    for (const name of ['invalid.ts', 'binary.ts']) await expect(readAllowed(root, name)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(readAllowed(root, 'huge.ts')).rejects.toMatchObject({ code: 'LIMIT' });
    expect((await readAllowed(root, 'limit.ts')).text.length).toBe(MAX_FILE_BYTES);
    expect(await paths()).not.toContain('huge.ts');
  });

  it.each(['../outside.ts', '/etc/passwd', 'src/../main.ts', './main.ts', 'src//main.ts', 'src\\main.ts', 'bad\0.ts', ''])('rejects invalid relative path %j', async relative => {
    await expect(readAllowed(root, relative)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('low-level stable reader enforces a caller-supplied byte limit', async () => {
    await put('small.txt', '한글');
    expect((await readStable(root, 'small.txt', 6)).text).toBe('한글');
    await expect(readStable(root, 'small.txt', 5)).rejects.toMatchObject({ code: 'LIMIT' });
  });
});
