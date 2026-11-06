import { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { handleSquirrelEvent, squirrelUpdateArgs } from '../src/main/squirrel-startup';

vi.mock('electron', () => ({ app: { quit: vi.fn() } }));

const execPath = String.raw`C:\Users\Test User\AppData\Local\code_learning\app-0.1.0\Code Learning.exe`;
const updater = String.raw`C:\Users\Test User\AppData\Local\code_learning\Update.exe`;

describe('Squirrel update arguments', () => {
  it.each([
    ['--squirrel-install', ['--createShortcut=Code Learning.exe']],
    ['--squirrel-updated', ['--createShortcut=Code Learning.exe']],
    ['--squirrel-uninstall', ['--removeShortcut=Code Learning.exe']],
    ['--squirrel-obsolete', 'quit'],
    ['--squirrel-firstrun', null],
    ['.vite/build/main.cjs', null],
    ['--squirrel-install-extra', null],
    ['--unknown', null],
  ] as const)('handles %s exactly, keeping spaces in one argument', (argument, expected) => {
    expect(squirrelUpdateArgs('win32', [execPath, argument], execPath)).toEqual(expected);
  });

  it('ignores missing arguments and flags after the entry file', () => {
    expect(squirrelUpdateArgs('win32', [], execPath)).toBeNull();
    expect(squirrelUpdateArgs('win32', [execPath], execPath)).toBeNull();
    expect(squirrelUpdateArgs('win32', [execPath, '.vite/build/main.cjs', '--squirrel-install'], execPath)).toBeNull();
  });

  it.each(['darwin', 'linux'] as const)('ignores all Squirrel events on %s', platform => {
    for (const event of ['install', 'updated', 'uninstall', 'obsolete']) {
      expect(squirrelUpdateArgs(platform, [execPath, `--squirrel-${event}`], execPath)).toBeNull();
    }
  });
});

describe('Squirrel startup handling', () => {
  it.each([
    ['--squirrel-install', '--createShortcut=Code Learning.exe'],
    ['--squirrel-updated', '--createShortcut=Code Learning.exe'],
    ['--squirrel-uninstall', '--removeShortcut=Code Learning.exe'],
  ])('runs the parent Update.exe for %s and waits for it to close', (argument, expected) => {
    const child = new ChildProcess();
    const spawn = vi.fn(() => child);
    const quit = vi.fn();
    expect(handleSquirrelEvent({ platform: 'win32', argv: [execPath, argument], execPath, spawn, quit })).toBe(true);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(updater, [expected], { detached: true, windowsHide: true });
    expect(quit).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it.each(['error-first', 'close-first'] as const)('quits only once when both events arrive (%s)', order => {
    const child = new ChildProcess();
    const quit = vi.fn();
    expect(handleSquirrelEvent({ platform: 'win32', argv: [execPath, '--squirrel-install'], execPath,
      spawn: vi.fn(() => child), quit })).toBe(true);
    const events = order === 'error-first' ? ['error', 'close'] : ['close', 'error'];
    child.emit(events[0], new Error('Update.exe failed'));
    expect(quit).toHaveBeenCalledTimes(1);
    child.emit(events[1], new Error('Update.exe failed'));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('quits when spawning Update.exe throws', () => {
    const quit = vi.fn();
    const spawn = vi.fn(() => { throw new Error('Cannot start Update.exe'); });
    expect(handleSquirrelEvent({ platform: 'win32', argv: [execPath, '--squirrel-install'], execPath, spawn, quit })).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('quits immediately without spawning for an obsolete version', () => {
    const spawn = vi.fn(() => new ChildProcess());
    const quit = vi.fn();
    expect(handleSquirrelEvent({ platform: 'win32', argv: [execPath, '--squirrel-obsolete'], execPath, spawn, quit })).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['win32', undefined],
    ['win32', '--squirrel-firstrun'],
    ['win32', '.vite/build/main.cjs'],
    ['darwin', '--squirrel-install'],
    ['linux', '--squirrel-install'],
  ] as const)('does nothing for normal startup on %s with %s', (platform, argument) => {
    const spawn = vi.fn(() => new ChildProcess());
    const quit = vi.fn();
    const argv = argument === undefined ? [execPath] : [execPath, argument];
    expect(handleSquirrelEvent({ platform, argv, execPath, spawn, quit })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
