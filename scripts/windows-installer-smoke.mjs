import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { checkPlainLaunch, createInspectableCopy } from './fuse-check.mjs';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, 'test-results');
const passed = [];
const errors = [];
const registryKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\code_learning`;
let app;
let installStarted = false;
let updater;
let executable;
let startMenu;
let desktopShortcut;
let diagnostics;
let iconDiagnostics;
let testCopy;
let testProfile;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function powershell(script, env = process.env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${script}`],
  { timeout: 30_000, env });
}

function registered() {
  const result = spawnSync('reg.exe', ['query', registryKey], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, `Registry query failed: ${result.stderr}`);
  return result.status === 0;
}

function startMenuShortcuts() {
  if (!existsSync(startMenu)) return [];
  return readdirSync(startMenu, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === 'Code Learning.lnk')
    .map(entry => path.join(entry.parentPath, entry.name));
}

// What is left when removal fails: the files, any Code Learning process still running, and the end of Squirrel's logs.
function uninstallDiagnostics() {
  const installRoot = path.dirname(updater);
  const tail = file => { try { return readFileSync(file, 'utf8').slice(-4000); } catch (error) { return String(error); } };
  const logs = [installRoot, path.join(process.env.LOCALAPPDATA, 'SquirrelTemp')].flatMap(folder => existsSync(folder)
    ? readdirSync(folder).filter(name => name.endsWith('.log')).map(name => ({ file: path.join(folder, name), tail: tail(path.join(folder, name)) }))
    : []);
  let processes;
  try {
    processes = powershell("@(Get-CimInstance Win32_Process -Filter \"Name='Code Learning.exe'\" | Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress");
  } catch (error) { processes = String(error); }
  return { files: existsSync(installRoot) ? readdirSync(installRoot, { recursive: true }) : [], processes, logs };
}

async function until(check) {
  const deadline = Date.now() + 120_000;
  while (true) {
    try { check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(500);
  }
}

async function closeApp() {
  let timer;
  if (app) {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 10_000); }),
    ]);
    clearTimeout(timer);
    app = undefined;
  }
  // Also catches a process left behind by a failed Playwright launch or installer.
  const result = spawnSync('taskkill.exe', ['/IM', 'Code Learning.exe', '/F', '/T'],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 128, `Could not stop Code Learning: ${result.stderr || result.stdout}`);
}

try {
  assert.equal(process.platform, 'win32', `Windows installer tests require Windows; got ${process.platform}`);
  assert.ok(process.env.LOCALAPPDATA && process.env.APPDATA, 'LOCALAPPDATA and APPDATA are required');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const setup = path.join(root, 'out/make/squirrel.windows/x64/Code-Learning-win-x64-Setup.exe');
  const installRoot = path.join(process.env.LOCALAPPDATA, 'code_learning');
  updater = path.join(installRoot, 'Update.exe');
  executable = path.join(installRoot, `app-${version}`, 'Code Learning.exe');
  startMenu = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs');
  const desktop = powershell("[Environment]::GetFolderPath('DesktopDirectory')");
  assert.ok(desktop, 'Windows did not return a desktop directory');
  desktopShortcut = path.join(desktop, 'Code Learning.lnk');
  const database = path.join(process.env.APPDATA, 'Code Learning/learning.sqlite');

  assert.ok(existsSync(setup), `Installer not found: ${setup}`);
  // Use a clean Windows runner so stale data cannot hide a failed install or be removed by cleanup.
  assert.ok(!existsSync(installRoot), 'A clean runner without an existing code_learning installation is required');
  assert.ok(!existsSync(database), 'A clean runner without an existing learning.sqlite is required');
  assert.equal(registered(), false, 'An existing uninstall registration was found');
  assert.deepEqual(startMenuShortcuts(), [], 'An existing Start Menu shortcut was found');
  assert.ok(!existsSync(desktopShortcut), 'An existing desktop shortcut was found');

  installStarted = true;
  run(setup, ['--silent']);
  passed.push('Silent installer exited with code 0');
  await until(() => {
    assert.ok(existsSync(updater), 'Installed Update.exe is missing');
    assert.ok(existsSync(executable), 'Installed Code Learning.exe is missing');
    assert.ok(startMenuShortcuts().length > 0, 'Start Menu shortcut is missing');
    assert.ok(existsSync(desktopShortcut), 'Desktop shortcut is missing');
    assert.equal(registered(), true, 'Uninstall registration is missing');
  });
  passed.push('Installed executables, Start Menu and desktop shortcuts, and uninstall registration exist');
  iconDiagnostics = { displayIcon: null, file: null, size: null, hash: null };
  const displayIcon = JSON.parse(powershell(
    "(Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER' + $env:CODE_LEARNING_REGISTRY_KEY.Substring(4)) -Name DisplayIcon).DisplayIcon | ConvertTo-Json -Compress",
    { ...process.env, CODE_LEARNING_REGISTRY_KEY: registryKey }));
  iconDiagnostics.displayIcon = displayIcon;
  assert.equal(typeof displayIcon, 'string', 'DisplayIcon must be a file path');
  // Strip an optional resource index, then quotes around paths containing spaces.
  const iconFile = displayIcon.trim().replace(/,\s*-?\d+\s*$/, '').trim().replace(/^"(.*)"$/, '$1');
  iconDiagnostics.file = iconFile;
  assert.ok(iconFile && existsSync(iconFile), `DisplayIcon file is missing: ${displayIcon}`);
  const installedIcon = await readFile(iconFile);
  iconDiagnostics.size = installedIcon.length;
  iconDiagnostics.hash = createHash('sha256').update(installedIcon).digest('hex');
  const expectedIconHash = createHash('sha256').update(await readFile(path.join(root, 'assets/icon/icon.ico'))).digest('hex');
  assert.equal(iconDiagnostics.hash, expectedIconHash, 'DisplayIcon differs from assets/icon/icon.ico');
  passed.push('Uninstall DisplayIcon matches assets/icon/icon.ico');
  assert.ok(!existsSync(database), 'Installation started the app and created learning.sqlite');
  passed.push('Installation did not create learning.sqlite');

  testCopy = await createInspectableCopy(executable);
  await checkPlainLaunch(executable, path.dirname(database));
  passed.push('Installed release fuses match and plain first launch creates learning.sqlite');
  testProfile = await mkdtemp(path.join(os.tmpdir(), 'code-learning-installer-profile-'));
  app = await electron.launch({ executablePath: testCopy.executablePath,
    args: [`--user-data-dir=${testProfile}`], chromiumSandbox: true, timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Code Learning', exact: true }).waitFor({ timeout: 30_000 });
  await until(() => assert.ok(existsSync(database), 'First launch did not create learning.sqlite'));
  await closeApp();
  await testCopy.cleanup(); testCopy = undefined;
  passed.push('Temporary copy shows Code Learning and the entire installed app is unchanged');

  const shortcuts = startMenuShortcuts();
  assert.ok(shortcuts.length > 0, 'Start Menu shortcut disappeared after first launch');
  for (const shortcut of shortcuts) {
    const target = JSON.parse(powershell(
      '$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CODE_LEARNING_SHORTCUT); ' +
      '@{ TargetPath = $shortcut.TargetPath; Arguments = $shortcut.Arguments } | ConvertTo-Json -Compress',
      { ...process.env, CODE_LEARNING_SHORTCUT: shortcut }));
    // Squirrel 2 points shortcuts at its launcher stub beside Update.exe, which starts the newest app-<version>.
    const launcher = path.join(path.dirname(updater), 'Code Learning.exe');
    assert.equal(path.resolve(target.TargetPath).toLowerCase(), path.resolve(launcher).toLowerCase(), 'Shortcut must target the installed launcher');
    assert.equal(target.Arguments, '', 'Shortcut must not pass arguments');
  }
  passed.push('Start Menu shortcuts start the installed launcher');
} catch (error) {
  console.error(error);
  if (iconDiagnostics) console.error(JSON.stringify(iconDiagnostics, null, 2));
  errors.push(String(error));
} finally {
  // Attempt removal even after an earlier check fails, and report cleanup failures as test failures.
  if (installStarted) {
    try { await closeApp(); }
    catch (error) { console.error(error); errors.push(String(error)); }
    // Check the installed app before the uninstaller intentionally removes it.
    try { if (testCopy) await testCopy.cleanup(); }
    catch (error) { console.error(error); errors.push(String(error)); }
    try { if (testProfile) await rm(testProfile, { recursive: true, force: true }); }
    catch (error) { console.error(error); errors.push(String(error)); }
    try {
      assert.ok(existsSync(updater), 'Cannot uninstall: Update.exe is missing');
      run(updater, ['--uninstall']);
      passed.push('Uninstaller exited with code 0');
      await until(() => {
        assert.deepEqual(startMenuShortcuts(), [], 'Start Menu shortcut remains after uninstall');
        assert.ok(!existsSync(desktopShortcut), 'Desktop shortcut remains after uninstall');
        assert.equal(registered(), false, 'Uninstall registration remains after uninstall');
        assert.ok(!existsSync(executable), 'Code Learning.exe remains after uninstall');
      });
      passed.push('Uninstall removed both shortcuts, registration, and the installed app');
    } catch (error) {
      console.error(error);
      errors.push(String(error));
      diagnostics = uninstallDiagnostics();
      console.error(JSON.stringify(diagnostics, null, 2));
    }
  }
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'windows-installer.json'), JSON.stringify({ passed, errors, diagnostics, iconDiagnostics }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}
