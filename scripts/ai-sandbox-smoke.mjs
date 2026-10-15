// Local fixture only: no login, model, real project, or network access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin') throw new Error('This check requires macOS sandbox-exec. No unprotected fallback.');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-ai-sandbox-')));
const project = path.join(directory, 'project');
const outside = path.join(directory, 'outside');
const scratch = path.join(directory, 'scratch');
const artifacts = path.resolve(import.meta.dirname, '../test-results');
// JSON string escaping also handles quotes/backslashes in these literal SBPL paths.
const quote = value => JSON.stringify(value);
try {
  await Promise.all([mkdir(project), mkdir(outside), mkdir(scratch), mkdir(artifacts, { recursive: true })]);
  const file = path.join(project, 'main.ts');
  await writeFile(file, 'export const answer = 42;\n');
  await writeFile(path.join(outside, 'private.txt'), 'NOT_A_REAL_SECRET');
  await symlink(path.join(outside, 'private.txt'), path.join(project, 'linked.txt'));
  const before = await stat(file);
  const profile = path.join(directory, 'readonly.sb');
  await writeFile(profile, `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${quote(scratch)}))
(deny file-read-data (subpath ${quote(outside)}))
(deny network*)
`);
  const probe = path.join(directory, 'probe.cjs');
  await writeFile(probe, `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [project, scratch] = process.argv.slice(2);
const file = path.join(project, 'main.ts');
const checks = [];
function denied(name, operation) {
  try { operation(); throw new Error(name + ': unexpectedly permitted'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    checks.push(name);
  }
}
if (fs.readFileSync(file, 'utf8') !== 'export const answer = 42;\\n') throw new Error('read failed');
checks.push('project read permitted');
denied('overwrite denied', () => fs.writeFileSync(file, 'changed'));
denied('creation denied', () => fs.writeFileSync(path.join(project, 'new.ts'), 'new'));
denied('deletion denied', () => fs.unlinkSync(file));
denied('rename denied', () => fs.renameSync(file, path.join(project, 'moved.ts')));
denied('chmod denied', () => fs.chmodSync(file, 0o777));
denied('outside read through symlink denied', () => fs.readFileSync(path.join(project, 'linked.txt')));
denied('outside write through symlink denied', () => fs.writeFileSync(path.join(project, 'linked.txt'), 'changed'));
const child = spawnSync('/bin/sh', ['-c', 'printf changed > "$1"', 'readonly-probe', file], { encoding: 'utf8' });
if (child.error || child.status === 0 || !/not permitted|denied/i.test(child.stderr)) throw new Error('child write not denied');
checks.push('child process write denied');
fs.writeFileSync(path.join(scratch, 'allowed.txt'), 'scratch only');
checks.push('scratch write permitted');
process.stdout.write(JSON.stringify(checks));
`);
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, probe, project, scratch], {
    cwd: scratch, env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch }, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.length, 10);
  assert.equal(await readFile(file, 'utf8'), 'export const answer = 42;\n');
  assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'NOT_A_REAL_SECRET');
  assert.deepEqual((await readdir(project)).sort(), ['linked.txt', 'main.ts']);
  const after = await stat(file);
  assert.deepEqual([after.mtimeMs, after.ctimeMs, after.ino, after.mode], [before.mtimeMs, before.ctimeMs, before.ino, before.mode]);
  checks.push('fixture contents, metadata and file list unchanged');
  await writeFile(path.join(artifacts, 'ai-sandbox-smoke.json'), JSON.stringify({ passed: true, fixtureOnly: true,
    realAiRequests: 0, platform: process.platform, osRelease: os.release(), checks }, null, 2));
  console.log(`PASS ${checks.length} macOS read-only fixture checks (no AI/login/network)`);
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'ai-sandbox-smoke.json'), JSON.stringify({ passed: false, fixtureOnly: true, error: String(error) }, null, 2));
  throw error;
} finally { await rm(directory, { recursive: true, force: true }); }
