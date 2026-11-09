import path from 'node:path';
import os from 'node:os';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from '../../shared/errors';
import type { Launch } from './runtime';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const unavailable = (detail: string) => new AppError('AI_UNAVAILABLE', `AI 프로그램을 안전한 울타리 안에서 실행할 수 없어 실행하지 않았습니다. ${detail}`);

/** A path as an SBPL string. JSON escaping also covers the quotes and backslashes SBPL needs. */
function sbplPath(value: string) {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw unavailable('경로 형식을 확인할 수 없습니다.');
  return JSON.stringify(value);
}
const subpaths = (paths: string[]) => paths.map(item => `(subpath ${sbplPath(item)})`).join(' ');

export interface FenceOptions {
  /** The user's real home folder. */
  home: string;
  /** This CLI's app-only home, where its own login and settings live. */
  appHome: string;
  /** The temporary folder of this run. */
  runDirectory: string;
  /** The CLI's own program files. */
  readable: string[];
}

/**
 * The macOS sandbox an AI CLI runs in: the second wall after the tool limits. Even a tool the
 * limits miss cannot read home or temporary files outside its allowed paths, write outside its
 * own folders, or reach other programs through local sockets, signals, app launching, Apple Events,
 * clipboard access or the blocked system commands. Each CLI gets only its own home, so neither
 * can read the other's login.
 * Later rules override earlier ones. Metadata (stat) stays readable for path resolution; file
 * contents and folder listings do not. The internet stays open for the model API, with the
 * mDNSResponder socket allowed for DNS. Codex needs the keychain service, so it stays reachable;
 * only the security command is blocked, not keychain access through other programs.
 */
export function fenceProfile({ home, appHome, runDirectory, readable }: FenceOptions): string {
  const own = [appHome, runDirectory];
  return `(version 1)
(allow default)
(deny file-read-data ${subpaths([...new Set([home, '/Users', '/Volumes', '/private/tmp', '/private/var/folders'])])})
(allow file-read-data ${subpaths([...own, ...readable])})
(deny file-write*)
(allow file-write* ${subpaths(own)} (literal "/dev/null"))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(deny network-outbound (remote ip "localhost:*"))
(deny signal)
(allow signal (target same-sandbox))
(deny lsopen)
(deny appleevent-send)
(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at") (literal "/usr/bin/batch") (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.pasteboard.1"))
`;
}

/**
 * What a CLI needs to read of itself: its executable and, for a Node script, the npm package that
 * holds it (Codex keeps its native binary in a package inside it). Only a folder inside
 * node_modules counts as that package, so a stray package.json in the home folder never reopens
 * the whole home.
 */
export async function launchReadPaths(launch: Launch): Promise<string[]> {
  const script = launch.prefix[0];
  if (!script) return [launch.executable];
  let folder = path.dirname(script);
  while (!(await access(path.join(folder, 'package.json')).then(() => true, () => false))) {
    if (path.dirname(folder) === folder) throw unavailable('프로그램 패키지 위치를 찾지 못했습니다.');
    folder = path.dirname(folder);
  }
  if (!folder.split(path.sep).slice(0, -1).includes('node_modules')) throw unavailable('프로그램 패키지 위치가 예상한 설치 형태가 아닙니다.');
  return [launch.executable, folder];
}

/** The launch that starts `launch` inside the fence. Without the fence, the CLI is not started at all. */
export async function fencedLaunch(launch: Launch, { appHome, runDirectory }: { appHome: string; runDirectory: string }): Promise<Launch> {
  if (process.platform !== 'darwin') throw unavailable('macOS에서만 실행할 수 있습니다.');
  try { await access(SANDBOX_EXEC, constants.X_OK); } catch { throw unavailable('macOS 울타리 기능(sandbox-exec)을 찾지 못했습니다.'); }
  // Rules match real paths: /var is /private/var, and a home can sit behind a link.
  const [home, ownHome, run] = await Promise.all([os.homedir(), appHome, runDirectory].map(item => realpath(item)));
  const profile = fenceProfile({ home, appHome: ownHome, runDirectory: run, readable: await launchReadPaths(launch) });
  return { executable: SANDBOX_EXEC, prefix: ['-p', profile, launch.executable, ...launch.prefix] };
}
