import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_EXEC, fenceProfile, launchReadPaths } from '../src/core/ai/fence';
import { runProcess } from '../src/core/ai/process';

// Real files in a temporary folder laid out like a home folder, and the real macOS sandbox.
// Nothing here starts an AI CLI or touches the network.
let root: string;
let home: string;
let codexHome: string;
let agyHome: string;
let run: string;
let packageRoot: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ai-fence-')));
  home = path.join(root, 'home');
  codexHome = path.join(home, 'Library/Application Support/Code Learning/codex-home');
  agyHome = path.join(home, 'Library/Application Support/Code Learning/agy-home');
  run = path.join(root, 'run');
  packageRoot = path.join(home, '.npm-global/lib/node_modules/@scope/cli');
  for (const folder of [codexHome, agyHome, run, path.join(packageRoot, 'bin'), path.join(home, '.ssh')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(home, '.ssh', 'id_fixture'), 'NOT_A_REAL_KEY');
  await writeFile(path.join(codexHome, 'login.json'), '{}');
  await writeFile(path.join(agyHome, 'login.json'), '{}');
  await writeFile(path.join(packageRoot, 'package.json'), '{}');
  await writeFile(path.join(packageRoot, 'bin', 'cli.js'), '');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('AI CLI fence profile', () => {
  it('opens only its own app home, the run folder and the program files again', () => {
    const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: ['/Volumes/Tools/agy'] });
    expect(profile).toContain(`(deny file-read-data (subpath ${JSON.stringify(home)}) (subpath "/Users") (subpath "/Volumes"))`);
    expect(profile).toContain(`(allow file-read-data (subpath ${JSON.stringify(codexHome)}) (subpath ${JSON.stringify(run)}) (subpath "/Volumes/Tools/agy"))`);
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(codexHome)}) (subpath ${JSON.stringify(run)}) (literal "/dev/null"))`);
    expect(profile).not.toContain(agyHome);
    // A re-allow only works after the deny it overrides.
    expect(profile.indexOf('(allow file-read-data')).toBeGreaterThan(profile.indexOf('(deny file-read-data'));
  });
  it('quotes paths and refuses a relative path or one with a line break', () => {
    expect(fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: ['/opt/a "b"\\c'] })).toContain('(subpath "/opt/a \\"b\\"\\\\c")');
    expect(() => fenceProfile({ home, appHome: 'relative', runDirectory: run, readable: [] })).toThrow();
    expect(() => fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: ['/opt/a\n(allow default)'] })).toThrow();
  });
});

describe('AI CLI program files', () => {
  it('reads a native executable as the file alone, and a Node script as its npm package', async () => {
    expect(await launchReadPaths({ executable: '/opt/agy', prefix: [] })).toEqual(['/opt/agy']);
    expect(await launchReadPaths({ executable: '/opt/node', prefix: [path.join(packageRoot, 'bin', 'cli.js')] })).toEqual(['/opt/node', packageRoot]);
  });
  it('never reopens a folder outside node_modules, such as a home with a stray package.json', async () => {
    const script = path.join(home, '.local/bin/cli.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, '');
    await expect(launchReadPaths({ executable: '/opt/node', prefix: [script] })).rejects.toThrow(/울타리/);
    await writeFile(path.join(home, 'package.json'), '{}');
    await expect(launchReadPaths({ executable: '/opt/node', prefix: [script] })).rejects.toThrow(/울타리/);
  });
});

describe.runIf(process.platform === 'darwin')('AI CLI fence under the real macOS sandbox', () => {
  it("blocks the user's files and the other CLI's home, and allows its own home, the run folder and its program", async () => {
    const node = await realpath(process.execPath);
    const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: [node, packageRoot] });
    const script = `
      const fs = require('node:fs');
      const attempt = action => { try { action(); return 'allowed'; } catch (error) { return error.code; } };
      const [home, codexHome, agyHome, run, packageRoot, realHome, outside] = process.argv.slice(1);
      console.log(JSON.stringify({
        secret: attempt(() => fs.readFileSync(home + '/.ssh/id_fixture')),
        homeListing: attempt(() => fs.readdirSync(home)),
        realHomeListing: attempt(() => fs.readdirSync(realHome)),
        otherHome: attempt(() => fs.readFileSync(agyHome + '/login.json')),
        ownHome: attempt(() => fs.readFileSync(codexHome + '/login.json')),
        ownHomeWrite: attempt(() => fs.writeFileSync(codexHome + '/state.json', '{}')),
        runWrite: attempt(() => fs.writeFileSync(run + '/tmp.txt', 'x')),
        program: attempt(() => fs.readFileSync(packageRoot + '/package.json')),
        homeWrite: attempt(() => fs.writeFileSync(home + '/planted.txt', 'x')),
        outsideWrite: attempt(() => fs.writeFileSync(outside, 'x')),
      }));
    `;
    const output = await runProcess({ executable: SANDBOX_EXEC,
      args: ['-p', profile, node, '-e', script, home, codexHome, agyHome, run, packageRoot, os.homedir(), path.join(root, 'outside.txt')],
      cwd: run, env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: run }, signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(output.exitCode).toBe(0);
    const result = JSON.parse(output.stdout);
    const denied = expect.stringMatching(/^(EPERM|EACCES)$/);
    expect(result).toEqual({ secret: denied, homeListing: denied, realHomeListing: denied, otherHome: denied,
      ownHome: 'allowed', ownHomeWrite: 'allowed', runWrite: 'allowed', program: 'allowed', homeWrite: denied, outsideWrite: denied });
  });
});
