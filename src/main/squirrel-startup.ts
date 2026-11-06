import { app } from 'electron';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

/** Squirrel.Windows runs the app with one of these while installing, updating or removing it; the app only manages its shortcuts then. */
export function squirrelUpdateArgs(platform: NodeJS.Platform, argv: readonly string[], execPath: string): string[] | 'quit' | null {
  if (platform !== 'win32') return null;
  const executable = path.win32.basename(execPath);
  switch (argv[1]) {
    case '--squirrel-install':
    case '--squirrel-updated':
      return [`--createShortcut=${executable}`];
    case '--squirrel-uninstall':
      return [`--removeShortcut=${executable}`];
    case '--squirrel-obsolete':
      return 'quit';
    default:
      return null;
  }
}

export function handleSquirrelEvent(env: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  execPath: string;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  quit: () => void;
} = { platform: process.platform, argv: process.argv, execPath: process.execPath, spawn, quit: () => app.quit() }): boolean {
  const args = squirrelUpdateArgs(env.platform, env.argv, env.execPath);
  if (args === null) return false;
  if (args === 'quit') {
    env.quit();
    return true;
  }

  let finished = false;
  const quit = () => {
    if (finished) return;
    finished = true;
    env.quit();
  };
  const updater = path.win32.resolve(path.win32.dirname(env.execPath), '..', 'Update.exe');
  try {
    const child = env.spawn(updater, args, { detached: true, windowsHide: true });
    child.once('close', quit);
    child.once('error', quit);
  } catch {
    quit();
  }
  return true;
}
