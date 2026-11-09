import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire, pathToFuseFile } from '@electron/fuses';

export async function checkFuses(executablePath) {
  const wire = await getCurrentFuseWire(executablePath);
  assert.equal(wire.version, FuseVersion.V1, 'Expected fuse wire V1');
  const expected = {
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE,
  };
  for (const [option, state] of Object.entries(expected)) {
    assert.equal(wire[option], state, `Unexpected fuse: ${FuseV1Options[option]}`);
  }
}

// Include every file (Frameworks and signatures too), directory, mode and link target without following links.
export async function hashApp(appDirectory) {
  const hash = createHash('sha256');
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    const file = path.join(appDirectory, relative);
    const stat = await lstat(file);
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(['link', await readlink(file)]));
      continue;
    }
    if (stat.isDirectory()) {
      const names = (await readdir(file)).sort().reverse();
      pending.push(...names.map(name => path.join(relative, name)));
      continue;
    }
    assert.ok(stat.isFile(), `Unsupported app entry: ${file}`);
    const fileHash = createHash('sha256');
    for await (const chunk of createReadStream(file)) fileHash.update(chunk);
    hash.update(fileHash.digest());
  }
  return hash.digest('hex');
}

function assertInside(directory, file) {
  const relative = path.relative(directory, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Path escapes temporary app copy: ${file}`);
}

export async function createInspectableCopy(executablePath, platform = process.platform) {
  assert.ok(platform === 'darwin' || platform === 'win32', `Unsupported platform: ${platform}`);
  const source = path.resolve(executablePath);
  const appDirectory = platform === 'darwin' ? path.resolve(source, '../../..') : path.dirname(source);
  const originalHash = await hashApp(appDirectory);
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'code-learning-fuses-')));
  const copy = path.join(temp, path.basename(appDirectory));
  const copiedExecutable = path.join(copy, path.relative(appDirectory, source));
  const cleanup = async () => {
    try {
      assert.equal(await hashApp(appDirectory), originalHash, 'Distributed app changed during smoke test');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  };
  try {
    await checkFuses(source);
    if (platform === 'darwin') execFileSync('codesign', ['--verify', '--deep', '--strict', appDirectory]);
    // Default fs.cp rewrites relative links into absolute links back to the source bundle.
    await cp(appDirectory, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    const copiedRoot = await realpath(copy);
    assertInside(temp, copiedRoot);
    const entries = await readdir(copy, { recursive: true });
    // Signing traverses the bundle too, so reject every escaping link before any mutation.
    for (const entry of entries) assertInside(copiedRoot, await realpath(path.join(copy, entry)));
    const fuseFile = await realpath(pathToFuseFile(copiedExecutable));
    assertInside(copiedRoot, fuseFile);
    const before = await getCurrentFuseWire(copiedExecutable);
    await flipFuses(fuseFile, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });
    assert.deepEqual(await getCurrentFuseWire(copiedExecutable), {
      ...before, [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.ENABLE,
    }, 'Only the inspect fuse may change in the test copy');
    if (platform === 'darwin') {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy]);
      execFileSync('codesign', ['--verify', '--deep', '--strict', copy]);
    }
    return { executablePath: copiedExecutable, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Launch the unchanged release without Playwright's --inspect, using a fresh profile.
export async function checkPlainLaunch(executablePath, profile, timeout = 15_000) {
  const database = path.join(profile, 'learning.sqlite');
  assert.ok(!existsSync(database), 'Plain launch requires a profile without learning.sqlite');
  await mkdir(profile, { recursive: true });
  const child = spawn(executablePath, [`--user-data-dir=${profile}`], {
    detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true,
  });
  let launchError;
  child.once('error', error => { launchError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const started = Date.now();
  try {
    while (Date.now() - started < timeout) {
      await delay(200);
      if (launchError) throw launchError;
      assert.ok(child.exitCode === null && child.signalCode === null, 'Distributed app exited during startup');
      if (existsSync(database) && Date.now() - started >= 2_000) return;
    }
    throw new Error('Distributed app did not create learning.sqlite before the startup deadline');
  } finally {
    if (child.pid) stopProcessTree(child.pid);
    await closed;
  }
}

function stopProcessTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      if (error.status !== 128) throw error; // Already exited.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // Already exited, including all children.
  }
}
