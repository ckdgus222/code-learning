import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_EXEC, fenceProfile, fencedLaunch, launchReadPaths } from '../src/core/ai/fence';
import { runProcess } from '../src/core/ai/process';

// Real files in a temporary folder laid out like a home folder, and the real macOS sandbox.
// Nothing here starts an AI CLI or sends internet traffic; socket probes stay local.
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

// fencedLaunch only builds the launch; without the fence it refuses, so the caller never starts the CLI.
it.runIf(process.platform !== 'darwin')('refuses a fenced launch outside macOS', async () => {
  await expect(fencedLaunch({ executable: process.execPath, prefix: [] }, { appHome: codexHome, runDirectory: run }))
    .rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: 'AI 프로그램을 안전한 울타리 안에서 실행할 수 없어 실행하지 않았습니다. macOS에서만 실행할 수 있습니다.' });
});

describe('AI CLI fence profile', () => {
  it('opens only its own app home, the run folder and the program files again', () => {
    const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: ['/Volumes/Tools/agy'] });
    expect(profile).toContain(`(deny file-read-data (subpath ${JSON.stringify(home)}) (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))`);
    expect(profile).toContain(`(allow file-read-data (subpath ${JSON.stringify(codexHome)}) (subpath ${JSON.stringify(run)}) (subpath "/Volumes/Tools/agy"))`);
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(codexHome)}) (subpath ${JSON.stringify(run)}) (literal "/dev/null"))`);
    expect(profile).not.toContain(agyHome);
    // A re-allow only works after the deny it overrides.
    expect(profile.indexOf('(allow file-read-data')).toBeGreaterThan(profile.indexOf('(deny file-read-data'));
  });
  it('closes access to other programs while keeping DNS and its own child signals open', () => {
    const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: [] });
    const rules = [
      '(deny network-outbound (remote unix-socket))',
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
      '(deny network-outbound (remote ip4 "localhost:*"))',
      '(deny network-outbound (remote ip6 "*:*"))',
      '(deny signal)',
      '(allow signal (target same-sandbox))',
      '(deny lsopen)',
      '(deny appleevent-send)',
      '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at") (literal "/usr/bin/batch") (literal "/usr/bin/security"))',
      '(deny mach-lookup (global-name "com.apple.pasteboard.1"))',
    ];
    const lines = profile.trim().split('\n');
    let previous = lines.findIndex(line => line.startsWith('(allow file-write*'));
    for (const rule of rules) {
      expect(lines).toContain(rule);
      expect(lines.indexOf(rule)).toBeGreaterThan(previous);
      previous = lines.indexOf(rule);
    }
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
        runRead: attempt(() => fs.readFileSync(run + '/tmp.txt')),
        program: attempt(() => fs.readFileSync(packageRoot + '/package.json')),
        homeWrite: attempt(() => fs.writeFileSync(home + '/planted.txt', 'x')),
        outsideWrite: attempt(() => fs.writeFileSync(outside, 'x')),
      }));
    `;
    const output = await runProcess({ executable: SANDBOX_EXEC,
      args: ['-p', profile, node, '-e', script, home, codexHome, agyHome, run, packageRoot, os.homedir(), path.join(root, 'outside.txt')],
      cwd: run, env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: run }, signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(output.exitCode, output.stderr).toBe(0);
    const result = JSON.parse(output.stdout);
    const denied = expect.stringMatching(/^(EPERM|EACCES)$/);
    expect(result).toEqual({ secret: denied, homeListing: denied, realHomeListing: denied, otherHome: denied,
      ownHome: 'allowed', ownHomeWrite: 'allowed', runWrite: 'allowed', runRead: 'allowed', program: 'allowed', homeWrite: denied, outsideWrite: denied });
  });

  it('blocks outside sockets, signals, system commands and temporary files', async () => {
    const folders: string[] = [];
    const unixServer = createServer(socket => socket.destroy());
    const tcpServer = createServer(socket => socket.destroy());
    let outsideSleep: ChildProcess | undefined;
    try {
      const socketFolder = await mkdtemp('/private/tmp/clf-');
      folders.push(socketFolder);
      const tempFolder = await mkdtemp('/private/tmp/clf-');
      folders.push(tempFolder);
      const userTempFolder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ai-fence-outside-')));
      folders.push(userTempFolder);
      expect(userTempFolder.startsWith('/private/var/folders/')).toBe(true);
      const tempFile = path.join(tempFolder, 'fixture.txt');
      const userTempFile = path.join(userTempFolder, 'fixture.txt');
      await writeFile(tempFile, 'NOT_A_REAL_SECRET');
      await writeFile(userTempFile, 'NOT_A_REAL_SECRET');
      const socketPath = path.join(socketFolder, 'socket');
      unixServer.listen(socketPath);
      await once(unixServer, 'listening');
      tcpServer.listen(0, '127.0.0.1');
      await once(tcpServer, 'listening');
      const address = tcpServer.address();
      if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
      outsideSleep = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      await once(outsideSleep, 'spawn');
      const node = await realpath(process.execPath);
      const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: [node] });
      const script = `
        const fs = require('node:fs');
        const net = require('node:net');
        const { spawn, spawnSync } = require('node:child_process');
        const { once } = require('node:events');
        const [socketPath, port, outsidePid, tempFile, userTempFile] = process.argv.slice(1);
        const attempt = action => { try { action(); return 'allowed'; } catch (error) { return error.code; } };
        const connect = options => new Promise(resolve => {
          const socket = net.createConnection(options);
          const finish = result => { socket.destroy(); resolve(result); };
          socket.once('connect', () => finish('allowed'));
          socket.once('error', error => finish(error.code));
          socket.setTimeout(2000, () => finish('timeout'));
        });
        async function probe() {
          const result = {
            unixSocket: await connect({ path: socketPath }),
            dnsSocket: await connect({ path: '/private/var/run/mDNSResponder' }),
            localhost: await connect({ host: '127.0.0.1', port: Number(port) }),
            // The same loopback address in IPv6-mapped form must not slip past the localhost rule.
            localhostMapped: await connect({ host: '::ffff:127.0.0.1', port: Number(port), family: 6 }),
            // Nothing listens on ::1 here: an allowed connection would end in ECONNREFUSED instead.
            ipv6Loopback: await connect({ host: '::1', port: Number(port), family: 6 }),
            outsideSignal: attempt(() => process.kill(Number(outsidePid), 'SIGCONT')),
            security: spawnSync('/usr/bin/security', ['help'], { stdio: 'ignore' }).error?.code ?? 'allowed',
            launchctl: spawnSync('/bin/launchctl', ['version'], { stdio: 'ignore' }).error?.code ?? 'allowed',
            tempRead: attempt(() => fs.readFileSync(tempFile)),
            userTempRead: attempt(() => fs.readFileSync(userTempFile)),
          };
          const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
          await once(child, 'spawn');
          const exited = once(child, 'exit');
          result.ownSignal = attempt(() => process.kill(child.pid, 'SIGTERM'));
          const [, signal] = await exited;
          result.childExitSignal = signal;
          console.log(JSON.stringify(result));
        }
        probe().catch(() => { process.exitCode = 1; });
      `;
      const output = await runProcess({ executable: SANDBOX_EXEC,
        args: ['-p', profile, node, '-e', script, socketPath, String(address.port), String(outsideSleep.pid), tempFile, userTempFile],
        cwd: run, env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: run }, signal: new AbortController().signal, timeoutMs: 10_000 });
      expect(output.exitCode, output.stderr).toBe(0);
      const denied = expect.stringMatching(/^(EPERM|EACCES)$/);
      expect(JSON.parse(output.stdout)).toEqual({ unixSocket: denied, dnsSocket: 'allowed', localhost: denied, localhostMapped: denied, ipv6Loopback: denied,
        outsideSignal: 'EPERM', security: 'EPERM', launchctl: 'EPERM', tempRead: denied, userTempRead: denied,
        ownSignal: 'allowed', childExitSignal: 'SIGTERM' });
    } finally {
      if (outsideSleep?.pid && outsideSleep.exitCode === null && outsideSleep.signalCode === null) {
        const exited = once(outsideSleep, 'exit');
        outsideSleep.kill('SIGKILL');
        await exited;
      }
      await Promise.all([unixServer, tcpServer].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true })));
    }
  }, 20_000);

  it('blocks clipboard reading when the pasteboard service is available', async context => {
    const node = await realpath(process.execPath);
    const profile = fenceProfile({ home, appHome: codexHome, runDirectory: run, readable: [node] });
    const controlProfile = profile.replace('(deny mach-lookup (global-name "com.apple.pasteboard.1"))\n', '');
    // Never capture clipboard contents, even in the control run.
    const script = `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('/usr/bin/pbpaste', [], { stdio: 'ignore', timeout: 5000 });
      console.log(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code ?? null }));
    `;
    const options = { executable: SANDBOX_EXEC, cwd: run, env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: run },
      signal: new AbortController().signal, timeoutMs: 6000 };
    const controlOutput = await runProcess({ ...options, args: ['-p', controlProfile, node, '-e', script] });
    expect(controlOutput.exitCode, controlOutput.stderr).toBe(0);
    const control = JSON.parse(controlOutput.stdout);
    expect(control.error).toBeNull();
    expect(control.signal).toBeNull();
    if (control.status !== 0) {
      console.warn('SKIP clipboard assertion: pbpaste control failed; pasteboard service is unavailable.');
      context.skip();
      return;
    }
    const blockedOutput = await runProcess({ ...options, args: ['-p', profile, node, '-e', script] });
    expect(blockedOutput.exitCode, blockedOutput.stderr).toBe(0);
    const blocked = JSON.parse(blockedOutput.stdout);
    expect(blocked.error).toBeNull();
    expect(blocked.signal).toBeNull();
    expect(blocked.status).not.toBeNull();
    expect(blocked.status).not.toBe(0);
  }, 15_000);
});
