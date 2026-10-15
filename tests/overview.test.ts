import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { buildOverview } from '../src/core/analysis/overview';

let sandbox: string;
let root: string;
async function put(relative: string, data: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), data);
}
async function overview() { return buildOverview(root, await scanProject(root, randomUUID())); }
const picked = async () => (await overview()).candidates.map(item => [item.relativePath, item.name, item.reason]);

beforeEach(async () => {
  sandbox = await mkdtemp('/private/tmp/learning-overview-test-');
  root = path.join(sandbox, 'project');
  await mkdir(root);
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe('README introduction', () => {
  it('takes the first heading and the first prose paragraph with its lines', async () => {
    await put('README.md', '﻿# 주문 예제\r\n\r\n[![build](https://x/y.svg)](https://x)\r\n\r\n주문 수량을 확인하는\r\n작은 자료입니다. 📦\r\n\r\n## 설치\r\n다른 문단');
    expect((await overview()).intro).toMatchObject({
      relativePath: 'README.md', title: '주문 예제', text: '주문 수량을 확인하는\n작은 자료입니다. 📦', startLine: 5, endLine: 6,
    });
  });

  it('skips fenced code with blank lines, indented code, HTML and tables before the prose', async () => {
    await put('readme.md', [
      'Project Name', '============', '',
      '```sh', 'npm install', '', 'npm start', '```', '',
      '    indented code', '',
      '<p align="center">', '<img src="logo.png">', '</p>', '',
      '| a | b |', '', '---', '',
      'Real introduction.',
    ].join('\n'));
    expect((await overview()).intro).toMatchObject({ title: 'Project Name', text: 'Real introduction.', startLine: 20, endLine: 20 });
  });

  it('skips HTML comments and pre/script blocks through blank lines, but not a <div> block', async () => {
    await put('README.md', [
      '<!--', '', 'internal note', '-->', '',
      '<pre>', '', 'pre text', '</pre>', '',
      '<SCRIPT>', '', 'script text', '</STYLE>', '',
      '<!-- one line --> trailing', '',
      '<div align="center">', '', 'Shown after a div.',
    ].join('\n'));
    expect((await overview()).intro).toMatchObject({ title: null, text: 'Shown after a div.', startLine: 20 });
    // An unclosed comment hides everything after it.
    await put('README.md', '# Title\n\n<!--\n\nnever closed\n\nalso hidden');
    expect((await overview()).intro).toMatchObject({ title: 'Title', text: null });
  });

  it('closes a code fence only with the same character and enough length', async () => {
    await put('README.md', ['````md', '```js', 'EXAMPLE CODE', '```', '', '~~~', 'still code', '````', '', 'Real intro.'].join('\n'));
    expect((await overview()).intro).toMatchObject({ title: null, text: 'Real intro.', startLine: 10 });
    await put('README.md', ['~~~', '```', 'inside tilde fence', '```', '~~~', '', 'After tildes.'].join('\n'));
    expect((await overview()).intro).toMatchObject({ text: 'After tildes.' });
  });

  it('never reads headings or fences inside an HTML block or indented code', async () => {
    await put('README.md', '<div>\n# hidden heading\nhidden text\n</div>\n\nReal introduction.');
    expect((await overview()).intro).toMatchObject({ title: null, text: 'Real introduction.', startLine: 6 });
    await put('README.md', '    # example comment\n\n    ```\n\nReal intro.');
    expect((await overview()).intro).toMatchObject({ title: null, text: 'Real intro.', startLine: 5 });
    // Inside a paragraph an indented line only continues it.
    await put('README.md', 'First line\n    continued');
    expect((await overview()).intro).toMatchObject({ text: 'First line\ncontinued' });
  });

  it('ends indented code at the first less indented line and reads that line again', async () => {
    await put('README.md', '    example\nReal introduction.');
    expect((await overview()).intro).toMatchObject({ text: 'Real introduction.', startLine: 2 });
    await put('README.md', '    example\n```\nfenced code\n```\n\nAfter the fence.');
    expect((await overview()).intro).toMatchObject({ text: 'After the fence.' });
    await put('README.md', '    example\n# Heading\nText');
    expect((await overview()).intro).toMatchObject({ title: 'Heading', text: 'Text' });
  });

  it('keeps inline tags and autolinks that start a sentence as prose', async () => {
    await put('README.md', '<strong>Project</strong> helps you learn code.\n\n## Install\n\nnpm i');
    expect((await overview()).intro).toMatchObject({ title: 'Install', text: '<strong>Project</strong> helps you learn code.' });
    await put('README.md', '<https://example.com> is the home page.');
    expect((await overview()).intro).toMatchObject({ text: '<https://example.com> is the home page.' });
    await put('README.md', '[![build](https://x/b.svg)](https://x)\nTools for reading code.\n\n- - -\n\nLater.');
    expect((await overview()).intro).toMatchObject({ text: 'Tools for reading code.', startLine: 2 });
    await put('README.md', 'Title text\n- - -\n\nBody.');
    expect((await overview()).intro).toMatchObject({ title: null, text: 'Title text' });
    // A tag alone on its line is an HTML block, but it cannot cut into a paragraph.
    await put('README.md', '<img src="logo.png">\n\nIntro\n<br>\nstill intro');
    expect((await overview()).intro).toMatchObject({ text: 'Intro\n<br>\nstill intro', startLine: 3 });
  });

  it('cuts a long paragraph and reports no introduction when there is nothing to show', async () => {
    await put('README.txt', 'a'.repeat(500));
    expect((await overview()).intro?.text).toBe('a'.repeat(400) + '…');
    await rm(path.join(root, 'README.txt'));
    expect((await overview()).intro).toBeNull();
    // The file policy excludes an extensionless README, so it is never read for the introduction.
    await put('README', 'not shown');
    expect((await overview()).intro).toBeNull();
    await put('README.md', '```\nonly code\n```');
    expect((await overview()).intro).toBeNull();
  });
});

describe('start candidates', () => {
  it('orders package.json targets, entry names, then other exported functions', async () => {
    await put('package.json', JSON.stringify({ main: './lib/start.js', bin: { tool: 'bin/cli.ts', gone: 'dist/cli.js' } }));
    await put('lib/start.js', 'export function start() {}\nfunction hidden() {}');
    await put('bin/cli.ts', 'console.log("run");');
    await put('src/index.ts', 'export const boot = () => 1;');
    await put('src/deep/util.ts', 'export function helper() {}\nexport class C { m() {} }');
    await put('src/plain.ts', 'function notExported() {}');
    expect(await picked()).toEqual([
      ['lib/start.js', 'start', 'package-main'],
      ['bin/cli.ts', null, 'package-bin'],
      ['src/index.ts', 'boot', 'entry-name'],
      ['src/deep/util.ts', 'helper', 'exported'],
    ]);
    const result = await overview();
    expect(result.notes).toEqual(['package.json의 bin(dist/cli.js)은 제외되었거나 없는 파일이라 살펴보지 않았어요.']);
    expect(result.checkedFiles).toBe(5);
    expect(result.limited).toBe(false);
    // The same start as the function's own evidence, so the screen can find it again after re-reading.
    expect(result.candidates[0]).toMatchObject({ startLine: 1, startUtf16: 'export '.length });
    expect(result.candidates[0].fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('notes unreadable package.json and never offers ignored or path-escaping targets', async () => {
    await put('package.json', '{ broken');
    await put('.gitignore', 'secret-entry.ts\n');
    await put('secret-entry.ts', 'export function hidden() {}');
    await put('app.ts', 'export function visible() {}');
    expect(await picked()).toEqual([['app.ts', 'visible', 'entry-name']]);
    expect((await overview()).notes).toEqual(['package.json을 읽거나 해석하지 못해 그 안의 시작 파일은 살펴보지 않았어요.']);
    await put('package.json', JSON.stringify({ main: '../outside.js', bin: '/etc/passwd' }));
    expect((await overview()).notes).toHaveLength(2);
    expect(await picked()).toEqual([['app.ts', 'visible', 'entry-name']]);
  });

  it('checks at most 20 files, offers at most 8 candidates and says when it stopped early', async () => {
    for (let i = 0; i < 30; i++) await put(`f${String(i).padStart(2, '0')}.ts`, i % 2 ? 'function quiet() {}' : `export function e${i}() {}`);
    let result = await overview();
    expect(result.checkedFiles).toBe(15);
    expect(result.candidates).toHaveLength(8);
    expect(result.limited).toBe(true);
    for (let i = 0; i < 30; i++) await put(`f${String(i).padStart(2, '0')}.ts`, 'function quiet() {}');
    result = await overview();
    expect(result.checkedFiles).toBe(20);
    expect(result.candidates).toEqual([]);
    expect(result.limited).toBe(true);
  });

  it('skips a file that cannot be read without failing the overview', async () => {
    await put('index.ts', 'export function ok() {}');
    await put('broken.ts', 'export function x() {}');
    await writeFile(path.join(root, 'broken.ts'), Buffer.from([0xff, 0xfe]));
    const result = await overview();
    expect(result.candidates.map(item => item.name)).toEqual(['ok']);
    expect(result.notes).toEqual(['읽지 못한 파일 1개는 건너뛰었어요.']);
  });
});
