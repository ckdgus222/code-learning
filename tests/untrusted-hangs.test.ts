import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-hangs-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Run the actual TypeScript modules with Node's type transform. A parent-enforced SIGKILL timeout
// ensures that removing a guard fails the test instead of hanging the Vitest worker indefinitely.
async function isolated(code: string, timeout = 2000) {
  const source = pathToFileURL(path.resolve('src') + path.sep).href;
  const script = `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(${JSON.stringify(source)})) {
        return next(specifier + '.ts', context);
      }
      return next(specifier, context);
    } });
    const { scanProject, pathPolicy, assertAllowed } = await import(${JSON.stringify(source + 'core/project/files.ts')});
    const root = ${JSON.stringify(root)};
    ${code}
    console.log('finished');
  `;
  const result = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script],
    { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  expect(result.stdout.trim()).toBe('finished');
}

it.each([
  ['30 adjacent globstars', `a/${'**/'.repeat(30)}b`],
  ['25 slash classes', '*[a/]'.repeat(25) + 'b'],
  ['long literal', 'a'.repeat(65534) + '*'],
  ['long alternating stars', '*a'.repeat(32767) + 'bb'],
])('rejects %s before compiling or matching can hang', async (_name, rule) => {
  await writeFile(path.join(root, '.gitignore'), rule);
  const deep = path.join(root, 'a', ...Array(18).fill('a'));
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, 'a.ts'), '');
  await isolated(`
    await assert.rejects(scanProject(root, 'hangs'), {
      code: 'NOT_ALLOWED', message: '.gitignore에 너무 복잡하거나 긴 규칙이 있어 이 범위를 열지 않습니다.'
    });
  `);
});

it('rejects thousands of unpinned-star rules before a long file name can stall the scan', async () => {
  await writeFile(path.join(root, '.gitignore'), Array(5000).fill('*[a/]*[a/]*b').join('\n'));
  await writeFile(path.join(root, 'a'.repeat(252) + '.ts'), '');
  await isolated(`
    await assert.rejects(scanProject(root, 'hangs'), {
      code: 'NOT_ALLOWED', message: '.gitignore에 너무 복잡하거나 긴 규칙이 있어 이 범위를 열지 않습니다.'
    });
  `);
});

it('rejects trailing unpinned stars before a long history path can stall the path check', async () => {
  await writeFile(path.join(root, '.gitignore'), Array(200).fill('!*[a/]*a*').join('\n'));
  await isolated(`
    assert.equal(await pathPolicy(root)('a'.repeat(1016) + '/main.ts'), '복잡한 .gitignore 규칙');
  `);
});

it.each(['*[a/]*[a/]b', 'x/**/x/**/b'])('bounds huge and deep historical paths before matching %s', async rule => {
  await writeFile(path.join(root, '.gitignore'), rule);
  await isolated(`
    const policy = pathPolicy(root);
    for (const relative of ['a'.repeat(262144) + '.ts', 'a'.repeat(65536), Array(240).fill('x').join('/') + '/a.ts']) {
      assert.equal(await policy(relative), '경로 길이·깊이 제한');
      await assert.rejects(assertAllowed(root, relative), { code: 'NOT_ALLOWED', message: /경로 길이·깊이 제한/ });
    }
  `);
});

it.each(['<', '[', '# <'])('reads a 256 KiB README starting with %j within one second', async prefix => {
  await writeFile(path.join(root, 'README.md'), prefix + prefix.at(-1)!.repeat(256 * 1024 - prefix.length));
  await isolated(`
    const { buildOverview } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/core/analysis/overview.ts')).href)});
    const overview = await buildOverview(root, await scanProject(root, 'hangs'));
    assert.ok(overview.intro);
    assert.ok((overview.intro.text ?? overview.intro.title).length <= 401);
  `, 1000);
});
