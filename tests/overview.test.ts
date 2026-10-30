import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { restoreSpot, spotOf, type Topic, type Place } from '../src/renderer/overview';
import { learningSpotSchema } from '../src/shared/contracts';
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
  it('skips the whole taxonomy notice and keeps the introduction source lines', async () => {
    await put('README.md', [
      '> [!NOTE]', '> This project has been officially archived and will no longer receive updates.',
      '> ', '> Use a newer template.', '', '# Taxonomy', '',
      'An open source application built using the new router, server components and everything new in Next.js 13.',
    ].join('\n'));
    expect((await overview()).intro).toMatchObject({ title: 'Taxonomy',
      text: 'An open source application built using the new router, server components and everything new in Next.js 13.',
      startLine: 8, endLine: 8 });
  });

  it('takes the NestJS quoted introduction before the later installation prose', async () => {
    await put('README.md', [
      '# ![Node/Express/Mongoose Example App](project-logo.png)', '',
      '[![Build Status](https://travis-ci.org/anishkny/node-express-realworld-example-app.svg?branch=master)](https://travis-ci.org/anishkny/node-express-realworld-example-app)', '',
      '> ### NestJS codebase containing real world examples (CRUD, auth, advanced patterns, etc) that adheres to the [RealWorld](https://github.com/gothinkster/realworld-example-apps) API spec.',
      '', '', '----------', '', '# Getting started', '', '## Installation', '', 'Clone the repository',
    ].join('\n'));
    expect((await overview()).intro).toMatchObject({ title: 'Node/Express/Mongoose Example App',
      text: 'NestJS codebase containing real world examples (CRUD, auth, advanced patterns, etc) that adheres to the RealWorld API spec.',
      startLine: 5, endLine: 5 });
  });

  it('removes display markup while preserving words, arithmetic, URLs and inline HTML', async () => {
    await put('README.md', '# **Title** [link](u) `code`\n\n**굵게** __굵게__ *기울임* _기울임_ [링크](u) `코드` ![그림](image.png)\nsnake_case a*b*c 2*3*4 https://example.com/_path_/*name* <strong>HTML</strong>');
    expect((await overview()).intro).toMatchObject({ title: 'Title link code',
      text: '굵게 굵게 기울임 기울임 링크 코드 그림\nsnake_case a*b*c 2*3*4 https://example.com/_path_/*name* <strong>HTML</strong>',
      startLine: 3, endLine: 4 });
    await put('README.md', '<a title="[link](u) *tag*">HTML</a> https://example.com/[path](u)');
    expect((await overview()).intro?.text).toBe('<a title="[link](u) *tag*">HTML</a> https://example.com/[path](u)');
  });

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('excludes an isolated %s alert and its continuation', async kind => {
    await put('README.md', `   > [!${kind}]\n   > Notice text\n\n> Actual introduction\n> on two lines\n\nLater prose`);
    expect((await overview()).intro).toMatchObject({ text: 'Actual introduction\non two lines', startLine: 4, endLine: 5 });
    await put('README.md', `> [!${kind}]`);
    expect((await overview()).intro).toBeNull();
  });

  it('keeps prose and non-alert quotes in document order', async () => {
    await put('README.md', 'First prose\n\n> Quoted text');
    expect((await overview()).intro).toMatchObject({ text: 'First prose', startLine: 1, endLine: 1 });
    await put('README.md', '> [!NOTE] is part of this sentence\n\nLater prose');
    expect((await overview()).intro).toMatchObject({ text: '[!NOTE] is part of this sentence', startLine: 1 });
    await put('README.md', '    > Indented code\n\nReal introduction');
    expect((await overview()).intro).toMatchObject({ text: 'Real introduction', startLine: 3 });
    await put('README.md', '> Introduction\n----------\nLater prose');
    expect((await overview()).intro).toMatchObject({ text: 'Introduction', startLine: 1, endLine: 1 });
  });

  it('skips headings and paragraphs whose display text is empty', async () => {
    await put('README.md', '# ![](logo.png)\n\n# [Title](u)\n\n> ### []()\n\n[]()\n\nReal introduction');
    expect((await overview()).intro).toMatchObject({ title: 'Title', text: 'Real introduction', startLine: 9, endLine: 9 });
    await put('README.md', '# ![](logo.png)\n\n[]()');
    expect((await overview()).intro).toBeNull();
  });

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
      ['src/deep/util.ts', 'C.m', 'exported'],
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

describe('nested entry files and exported class methods', () => {
  it('includes one project folder, preserving depth and path order', async () => {
    for (const file of ['api/src/main.ts', 'web/src/index.tsx', 'server/main.ts', 'main.ts', 'src/app.ts', 'web/src/components/index.ts']) await put(file, 'const value = 1;');
    expect((await picked()).map(([file]) => file)).toEqual(['main.ts', 'server/main.ts', 'src/app.ts', 'api/src/main.ts', 'web/src/index.tsx']);
  });

  it('includes public exported methods but not constructors, accessors or private methods', async () => {
    await put('controller.ts', `export class Controller {
      constructor() {} public login() {} private hidden() {} protected internal() {} #secret() {}
      get value() { return 1; } set value(x: number) {} handle = () => {};
    }
    class Local { run() {} }
    export default class Default { run() {} }
    export abstract class Abstract { public run() {} }
    export class Keywords { private() {} protected() {} get() {} set() {} }`);
    expect((await picked()).map(([, name]) => name)).toEqual(['Controller.login', 'Default.run', 'Abstract.run', 'Keywords.private', 'Keywords.protected', 'Keywords.get', 'Keywords.set']);
  });
});

describe('entry files independent of learning candidates', () => {
  it('keeps every main, bin and entry-name ID before the eight-candidate limit', async () => {
    await put('package.json', JSON.stringify({ main: 'boot.ts', bin: { run: 'cli.ts' } }));
    await put('boot.ts', Array.from({ length: 8 }, (_, i) => `export function f${i}() {}`).join('\n'));
    await put('cli.ts', 'console.log("cli");');
    await put('src/index.ts', '');
    await put('helper.ts', 'export function helper() {}');
    const project = await scanProject(root, randomUUID());
    const result = await buildOverview(root, project);
    const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
    expect(result.candidates).toHaveLength(8);
    expect(result.candidates.every(item => item.relativePath === 'boot.ts')).toBe(true);
    expect(result.entryFileIds.map(pathOf)).toEqual(['boot.ts', 'cli.ts', 'src/index.ts']);
  });

  it('keeps entry-name files beyond the read limit but excludes exported-only candidates', async () => {
    for (let i = 0; i < 22; i++) await put(`p${i}/index.ts`, '');
    await put('helper.ts', 'export function helper() {}');
    const result = await overview();
    expect(result.entryFileIds).toHaveLength(22);
    await rm(root, { recursive: true });
    await mkdir(root);
    await put('helper.ts', 'export function helper() {}');
    const exportedOnly = await overview();
    expect(exportedOnly.candidates[0].reason).toBe('exported');
    expect(exportedOnly.entryFileIds).toEqual([]);
  });
});


describe('saved learning locations', () => {
  const files = [{ id: 'old-start', relativePath: 'start.ts', size: 20 }, { id: 'old-last', relativePath: 'last.ts', size: 30 }];
  const topic: Topic = { name: 'My topic', original: 'start', origin: 'start', anchor: 'start:old-start:0',
    start: { fileId: 'old-start', relativePath: 'start.ts', fileHash: 'a'.repeat(64), functionName: 'start', startUtf16: 0 } };
  const place: Place = { fileId: 'old-last', fileHash: 'b'.repeat(64), view: 'function',
    symbol: { name: 'last', startUtf16: 0, step: 2 }, range: { startUtf16: 10, endUtf16: 20, startLine: 2, endLine: 3 } };
  it('round trips by relative path when every file ID changes', () => {
    const saved = spotOf(topic, place, files);
    expect(learningSpotSchema.parse(saved)).toEqual(saved);
    const reopened = files.map(file => ({ ...file, id: `new-${file.id}` }));
    const restored = restoreSpot(saved, reopened);
    expect(restored).toEqual({ topic: { ...topic, anchor: null, start: { ...topic.start, fileId: 'new-old-start' } },
      place: { ...place, fileId: 'new-old-last' }, placeMissing: false });
    if ('missingStart' in restored) throw new Error('Unexpected missing start');
    expect(spotOf(restored.topic, restored.place, reopened)).toEqual(saved);
  });
  it('distinguishes a missing start from a missing last file and a topic with no place', () => {
    expect(restoreSpot(spotOf(topic, place, files), files.slice(1))).toEqual({ missingStart: 'start.ts' });
    expect(restoreSpot(spotOf(topic, place, files), files.slice(0, 1))).toEqual({ topic: { ...topic, anchor: null }, place: null, placeMissing: true });
    expect(restoreSpot(spotOf(topic, null, files), files)).toEqual({ topic: { ...topic, anchor: null }, place: null, placeMissing: false });
  });
  it('never serializes a file ID from a different project', () => {
    expect(() => spotOf(topic, place, [])).toThrow('not in this project');
    expect(() => spotOf(topic, { ...place, fileId: 'foreign' }, files)).toThrow('not in this project');
  });
});
