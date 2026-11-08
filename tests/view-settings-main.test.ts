import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { channels, type Result } from '../src/shared/contracts';

const host = vi.hoisted(() => ({
  fetch: vi.fn(), openExternal: vi.fn(), globalFetch: vi.fn(),
  profile: '', start: null as (() => Promise<void>) | null,
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<Result<unknown>>>(),
  theme: { themeSource: 'system' }, created: null as { options: unknown; screen: string } | null,
  contents: { mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler() {}, on() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.profile, getVersion: () => '1.0.0', whenReady: () => ({ then: (start: () => Promise<void>) => {
    host.start = start;
    return Promise.resolve();
  } }), on() {}, exit: vi.fn() },
  nativeTheme: host.theme,
  net: { fetch: host.fetch }, shell: { openExternal: host.openExternal },
  BrowserWindow: class {
    constructor(options: unknown) { host.created = { options, screen: host.theme.themeSource }; }
    webContents = host.contents;
    on() {} loadURL() {}
  },
  ipcMain: { handle: (name: string, handler: (event: unknown, input?: unknown) => Promise<Result<unknown>>) => host.handlers.set(name, handler) },
  dialog: { showErrorBox: vi.fn() }, powerMonitor: { on() {} },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class {} }));
vi.mock('../src/core/ai/workflow', () => ({ LearningWorkflow: class {} }));
vi.mock('../src/core/storage/projects', () => ({ ProjectStorage: class {} }));

beforeAll(async () => {
  host.profile = await mkdtemp(path.join(os.tmpdir(), 'view-settings-main-'));
  await writeFile(path.join(host.profile, 'view-settings.json'), JSON.stringify({ screen: 'dark', codeColors: 'contrast' }));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('fetch', host.globalFetch);
  await import('../src/main/main');
  await host.start!();
  expect(host.created).not.toBeNull();
  expect(host.fetch).not.toHaveBeenCalled();
  expect(host.globalFetch).not.toHaveBeenCalled();
  expect(host.openExternal).not.toHaveBeenCalled();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(host.profile, { recursive: true, force: true });
});
const sender = () => ({ sender: host.contents, senderFrame: host.contents.mainFrame });

it('loads the screen mode before creating the window and passes code colours to preload', () => {
  expect(host.created).toEqual({ options: expect.objectContaining({ webPreferences: expect.objectContaining({
    additionalArguments: ['--code-colors=contrast'], sandbox: true, contextIsolation: true,
  }) }), screen: 'dark' });
});

it('returns and updates settings through the validated IPC handlers', async () => {
  const get = host.handlers.get(channels.getViewSettings)!;
  const set = host.handlers.get(channels.setViewSettings)!;
  expect(await get(sender())).toEqual({ ok: true, value: { screen: 'dark', codeColors: 'contrast' } });
  expect(await set(sender(), { screen: 'wrong', codeColors: 'default' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(host.theme.themeSource).toBe('dark');
  expect(await get(sender(), {})).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  const value = { screen: 'light', codeColors: 'default' };
  expect(await set(sender(), value)).toEqual({ ok: true, value });
  expect(host.theme.themeSource).toBe('light');
  expect(await get(sender())).toEqual({ ok: true, value });
});

it.each([channels.getViewSettings, channels.setViewSettings, channels.checkForUpdate, channels.openReleasePage])('rejects untrusted callers of %s', async channel => {
  const action = host.handlers.get(channel)!;
  expect(await action({ sender: {}, senderFrame: host.contents.mainFrame })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await action({ sender: host.contents, senderFrame: { url: 'http://learning.test/' } })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
});

it.each([channels.checkForUpdate, channels.openReleasePage])('rejects arguments to %s before any external action', async channel => {
  const action = host.handlers.get(channel)!;
  host.fetch.mockClear();
  host.openExternal.mockClear();
  for (const input of [{}, null, 'https://untrusted.example/', 1]) {
    expect(await action(sender(), input)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  }
  expect(host.fetch).not.toHaveBeenCalled();
  expect(host.openExternal).not.toHaveBeenCalled();
});

it('requests a release only through IPC and opens only the fixed release page', async () => {
  const { LATEST_RELEASE_API, RELEASES_PAGE } = await import('../src/main/update-check');
  host.fetch.mockResolvedValueOnce(Response.json({ tag_name: 'v9.9.9', html_url: 'https://untrusted.example/' }));
  expect(await host.handlers.get(channels.checkForUpdate)!(sender())).toEqual({
    ok: true, value: { current: '1.0.0', latest: '9.9.9', status: 'newer' },
  });
  expect(host.fetch).toHaveBeenCalledExactlyOnceWith(LATEST_RELEASE_API, expect.objectContaining({ credentials: 'omit' }));
  expect(host.openExternal).not.toHaveBeenCalled();
  expect(await host.handlers.get(channels.openReleasePage)!(sender())).toEqual({ ok: true, value: null });
  expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(RELEASES_PAGE);
  expect(RELEASES_PAGE).toBe('https://github.com/ckdgus222/code-learning/releases/latest');
  expect(host.globalFetch).not.toHaveBeenCalled();
});
