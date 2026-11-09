import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { channels, type Result } from '../src/shared/contracts';

const host = vi.hoisted(() => ({
  profile: '', start: null as (() => Promise<void>) | null, refresh: vi.fn(async () => {}),
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<Result<unknown>>>(),
  contents: { mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler() {}, on() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.profile, getVersion: () => '1.0.0', whenReady: () => ({ then: (start: () => Promise<void>) => {
    host.start = start;
    return Promise.resolve();
  } }), on() {}, exit: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true,
    encryptString: (key: string) => Buffer.from(key.split('').reverse().join('')),
    decryptString: (bytes: Buffer) => bytes.toString().split('').reverse().join('') },
  nativeTheme: { themeSource: 'system' }, net: { fetch: vi.fn() }, shell: { openExternal: vi.fn() },
  BrowserWindow: class { webContents = host.contents; on() {} loadURL() {} },
  ipcMain: { handle: (name: string, handler: (event: unknown, input?: unknown) => Promise<Result<unknown>>) => host.handlers.set(name, handler) },
  dialog: { showErrorBox: vi.fn() }, powerMonitor: { on() {} },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class { refreshGeminiKey = host.refresh; } }));
vi.mock('../src/core/ai/workflow', () => ({ LearningWorkflow: class {} }));
vi.mock('../src/core/storage/projects', () => ({ ProjectStorage: class {} }));
beforeAll(async () => {
  host.profile = await mkdtemp(path.join(os.tmpdir(), 'gemini-key-main-'));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  await import('../src/main/main');
  await host.start!();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(host.profile, { recursive: true, force: true });
});
const sender = () => ({ sender: host.contents, senderFrame: host.contents.mainFrame });
it('returns only status booleans and refreshes runtime readiness after save and clear', async () => {
  const key = 'fake-gemini-key-for-tests-only';
  const status = (saved: boolean) => ({ ok: true, value: { saved, readable: saved, canEncrypt: true } });
  expect(await host.handlers.get(channels.geminiKeyStatus)!(sender())).toEqual(status(false));
  const saved = await host.handlers.get(channels.saveGeminiKey)!(sender(), { key });
  expect(saved).toEqual(status(true));
  expect(JSON.stringify(saved)).not.toContain(key);
  expect(host.refresh).toHaveBeenCalledTimes(1);
  expect(await host.handlers.get(channels.geminiKeyStatus)!(sender())).toEqual(status(true));
  expect(await host.handlers.get(channels.clearGeminiKey)!(sender())).toEqual(status(false));
  expect(host.refresh).toHaveBeenCalledTimes(2);
});
it.each([channels.geminiKeyStatus, channels.saveGeminiKey, channels.clearGeminiKey])('rejects extra fields and untrusted callers for %s', async channel => {
  const action = host.handlers.get(channel)!;
  expect(await action(sender(), { key: 'fake-gemini-key-for-tests-only', extra: true })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(await action({ sender: {}, senderFrame: host.contents.mainFrame })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await action({ sender: host.contents, senderFrame: {} })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
});
