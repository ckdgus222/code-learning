import { mkdtemp, realpath, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, MAP_EXPORT_MAX, type ProjectEvent, type Result } from '../src/shared/contracts';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<Result<unknown>>>(),
  appEvents: new Map<string, (event: { preventDefault(): void }) => void>(),
  folder: '', profile: '', projectId: '', closeStorage: () => {}, emit: (_event: ProjectEvent) => {},
  afterWrite: null as (() => Promise<void>) | null,
  open: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  save: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>(),
  expose: vi.fn(), invoke: vi.fn(),
  clipboard: vi.fn(), quit: vi.fn(), map: vi.fn(async () => ({})),
  contents: { send: vi.fn(), mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler() {}, on() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } },
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: host.expose }, ipcRenderer: { invoke: host.invoke },
  safeStorage: { isEncryptionAvailable: () => false }, clipboard: { writeText: host.clipboard },
  app: { getPath: () => host.profile, whenReady: () => Promise.resolve(),
    on: (name: string, callback: (event: { preventDefault(): void }) => void) => host.appEvents.set(name, callback), exit: vi.fn(), quit: host.quit },
  BrowserWindow: class { isDestroyed() { return false; } webContents = host.contents; on() {} loadURL() {} },
  dialog: { showOpenDialog: host.open, showSaveDialog: host.save, showErrorBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<Result<unknown>>) => host.handlers.set(channel, handler) },
  powerMonitor: { on() {} }, nativeTheme: { themeSource: 'system' },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class { async close() {} } }));
vi.mock('../src/core/storage/projects', async importOriginal => {
  const { ProjectStorage } = await importOriginal<typeof import('../src/core/storage/projects')>();
  return { ProjectStorage: class extends ProjectStorage {
    constructor(filename: string) { super(filename); host.closeStorage = () => this.close(); }
  } };
});
vi.mock('../src/main/project-session', () => ({
  MAP_TIMEOUT_MS: 120_000, workersStopped: async () => {},
  ProjectSession: class {
    constructor(readonly id: string, readonly root: string, _worker: string, emit: (event: ProjectEvent) => void) { host.projectId = id; host.emit = emit; }
    async open() { return { id: this.id, name: path.basename(this.root), files: [], excluded: {}, warnings: [] }; }
    map = host.map;
    async close() {}
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!String(args[0]).includes('.map-export-')) return handle;
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => { await write(...input); await host.afterWrite?.(); };
    return handle;
  } };
});

async function invoke(channel: string, input?: unknown) {
  return host.handlers.get(channel)!({ sender: host.contents, senderFrame: host.contents.mainFrame }, input);
}
function request(to: 'file' | 'clipboard' = 'file') { return { projectId: host.projectId, text: '# 지도\n', to }; }
function emit(kind: ProjectEvent['kind']) { host.emit({ projectId: host.projectId, kind }); }
function holdDialog() {
  let release!: (value: { canceled: boolean; filePath?: string }) => void;
  host.save.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  return (value: { canceled: boolean; filePath?: string }) => release(value);
}
function holdWrite() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  host.afterWrite = vi.fn(() => wait);
  return release;
}
let temporary: string, output: string;
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-map-main-')));
  host.folder = path.join(temporary, process.platform === 'win32' ? 'project' : 'project<>:"|?*\u0001');
  host.profile = path.join(temporary, 'profile'); output = path.join(temporary, 'exports');
  await mkdir(host.folder); await mkdir(output);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window'); vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
});
beforeEach(async () => {
  vi.resetModules(); host.handlers.clear(); host.appEvents.clear(); host.afterWrite = null;
  host.open.mockReset().mockResolvedValue({ canceled: false, filePaths: [host.folder] });
  host.save.mockReset().mockResolvedValue({ canceled: false, filePath: path.join(output, 'map.md') });
  host.clipboard.mockReset(); host.quit.mockReset(); host.contents.send.mockClear(); host.map.mockClear();
  await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.exportMap)).toBe(true));
  expect(await invoke(channels.open)).toMatchObject({ ok: true });
});
afterEach(async () => {
  if (!host.quit.mock.calls.length) { await invoke(channels.cancel); host.closeStorage(); }
  for (const name of await readdir(output)) await rm(path.join(output, name), { recursive: true, force: true });
});
afterAll(async () => { vi.unstubAllGlobals(); await rm(temporary, { recursive: true, force: true }); });

it.each([{ extra: true }, { text: '' }, { text: 'x'.repeat(MAP_EXPORT_MAX + 1) }, { to: 'elsewhere' }, { projectId: 'invalid' }])('rejects malformed export input %# without side effects', async change => {
  expect(await invoke(channels.exportMap, { ...request(), ...change })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(host.save).not.toHaveBeenCalled(); expect(host.clipboard).not.toHaveBeenCalled();
});

it('rejects foreign senders, foreign IDs and closed projects before any effect', async () => {
  expect(await host.handlers.get(channels.exportMap)!({ sender: {}, senderFrame: host.contents.mainFrame }, request())).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await invoke(channels.exportMap, { ...request(), projectId: randomUUID() })).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  const input = request(); await invoke(channels.cancel);
  expect(await invoke(channels.exportMap, input)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  expect(host.save).not.toHaveBeenCalled(); expect(host.clipboard).not.toHaveBeenCalled();
});

it('copies exact text including the size boundary and never opens a dialog', async () => {
  const input = { ...request('clipboard'), text: 'x'.repeat(MAP_EXPORT_MAX) };
  expect(await invoke(channels.exportMap, input)).toEqual({ ok: true, value: { done: true, name: null } });
  expect(host.clipboard).toHaveBeenCalledExactlyOnceWith(input.text); expect(host.save).not.toHaveBeenCalled();
});

it('uses a sanitized filename-only default and returns only the saved basename', async () => {
  const result = await invoke(channels.exportMap, request());
  expect(host.save).toHaveBeenCalledExactlyOnceWith(expect.anything(), { title: '프로젝트 지도 저장',
    defaultPath: process.platform === 'win32' ? 'project-map.md' : 'project________-map.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
  expect(result).toEqual({ ok: true, value: { done: true, name: 'map.md' } });
  expect(JSON.stringify(result)).not.toContain(output);
  expect(await readFile(path.join(output, 'map.md'), 'utf8')).toBe(request().text);
  expect(await readdir(output)).toEqual(['map.md']);
});

it('cancels the save window without writing even if a path is returned', async () => {
  host.save.mockResolvedValueOnce({ canceled: true, filePath: path.join(output, 'map.md') });
  expect(await invoke(channels.exportMap, request())).toEqual({ ok: true, value: { done: false, name: null } });
  expect(await readdir(output)).toEqual([]);
});

it.each(['success', 'cancel', 'failure', 'dialog-error'])('blocks overlapping saves and unlocks after %s', async outcome => {
  const release = holdDialog(); const pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
  expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  release({ canceled: outcome === 'cancel', filePath: path.join(outcome === 'failure' ? host.folder : output, 'first.md') });
  expect(await pending).toMatchObject({ ok: outcome !== 'failure' });
  if (outcome === 'dialog-error') {
    host.save.mockRejectedValueOnce(new Error('native error'));
    expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: false, code: 'INTERNAL' });
  }
  expect(await invoke(channels.exportMap, request())).toEqual({ ok: true, value: { done: true, name: 'map.md' } });
});

it.each(['close', 'open', 'recent'] as const)('cancels a pending save on %s and lets folder opening proceed', async change => {
  const id = host.projectId, release = holdDialog(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
  if (change === 'close') expect(await invoke(channels.cancel)).toMatchObject({ ok: true });
  if (change === 'open') expect(await invoke(channels.open)).toMatchObject({ ok: true });
  if (change === 'recent') expect(await invoke(channels.openRecent, { projectId: id })).toMatchObject({ ok: true });
  release({ canceled: false, filePath: path.join(output, 'map.md') });
  expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
  expect(await readdir(output)).toEqual([]);
});

it('rejects project destinations with a safe message', async () => {
  host.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(host.folder, 'map.md') });
  expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: false, code: 'UNSUPPORTED',
    message: '열어 둔 프로젝트 폴더 안에는 저장하지 않아요. 프로젝트 밖의 위치를 골라 주세요.' });
  expect(await readdir(host.folder)).toEqual([]); expect(await readdir(output)).toEqual([]);
});

it('answers a project change before judging the chosen path', async () => {
  const release = holdDialog(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
  expect(await invoke(channels.cancel)).toMatchObject({ ok: true });
  release({ canceled: false, filePath: path.join(output, 'map.txt') });
  expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
});
it.each(['changed', 'watch-error'] as const)('stops when %s arrives during the dialog', async kind => {
  const release = holdDialog(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
  emit(kind); release({ canceled: false, filePath: path.join(output, 'map.md') });
  const result = await pending;
  expect(result).toMatchObject({ ok: false, code: 'CHANGED' }); expect(await readdir(output)).toEqual([]);
  // A failed watch is said as such: reopening the folder is what helps, not drawing the map again.
  expect((result as { message: string }).message.includes('파일 변경을 감지하지 못하는 상태예요.')).toBe(kind === 'watch-error');
  if (kind === 'changed') expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: true });
});

it.each(['close', 'changed', 'watch-error'] as const)('stops and removes a real temporary file when %s occurs during writing', async change => {
  const release = holdWrite(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.afterWrite).toHaveBeenCalledOnce());
  expect((await readdir(output)).some(name => name.startsWith('.map-export-'))).toBe(true);
  if (change === 'close') await invoke(channels.cancel);
  if (change !== 'close') emit(change);
  release();
  expect(await pending).toMatchObject({ ok: false, code: change === 'close' ? 'CANCELLED' : 'CHANGED' });
  expect(await readdir(output)).toEqual([]);
  if (change === 'changed') expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: true });
});

it('remembers watcher failure through a successful rebuild and resets it only for a new session', async () => {
  emit('watch-error');
  expect(host.contents.send).toHaveBeenCalledWith(channels.event, { projectId: host.projectId, kind: 'watch-error' });
  expect(await invoke(channels.map, { projectId: host.projectId })).toMatchObject({ ok: true });
  for (const to of ['file', 'clipboard'] as const) expect(await invoke(channels.exportMap, request(to))).toMatchObject({ ok: false, code: 'CHANGED',
    message: '파일 변경을 감지하지 못하는 상태예요. 폴더를 다시 연 뒤 내보내 주세요.' });
  expect(host.save).not.toHaveBeenCalled(); expect(host.clipboard).not.toHaveBeenCalled();
  expect(await invoke(channels.open)).toMatchObject({ ok: true });
  expect(await invoke(channels.exportMap, request('clipboard'))).toMatchObject({ ok: true });
  expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: true });
});

it.each(['folder', 'plan'] as const)('rejects file export while the %s picker is open', async picker => {
  let release!: (value: { canceled: boolean; filePaths: string[] }) => void;
  host.open.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = invoke(picker === 'folder' ? channels.open : channels.pickPlanDocument);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(host.save).not.toHaveBeenCalled();
  release({ canceled: true, filePaths: [] }); await pending;
  expect(await invoke(channels.exportMap, request())).toMatchObject({ ok: true });
});

it('holds quitting until the active write is stopped and its temporary file is removed', async () => {
  const release = holdWrite(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.afterWrite).toHaveBeenCalledOnce());
  const event = { preventDefault: vi.fn() };
  host.appEvents.get('before-quit')!(event); host.appEvents.get('before-quit')!(event);
  // Long enough for everything else quitting waits for to end: only the held write keeps the app open.
  await new Promise(resolve => setTimeout(resolve, 100)); expect(host.quit).not.toHaveBeenCalled();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  release(); expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
  await vi.waitFor(() => expect(host.quit).toHaveBeenCalledOnce());
  expect(await readdir(output)).toEqual([]);
});

it('does not wait for an unanswered save dialog on quit, and never writes its late selection', async () => {
  const release = holdDialog(), pending = invoke(channels.exportMap, request());
  await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
  host.appEvents.get('before-quit')!({ preventDefault() {} });
  await vi.waitFor(() => expect(host.quit).toHaveBeenCalledOnce());
  release({ canceled: false, filePath: path.join(output, 'map.md') });
  expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' }); expect(await readdir(output)).toEqual([]);
});

it('preload forwards only the export request and returns the main result without side effects at load', async () => {
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  await import('../src/preload/preload');
  const api = host.expose.mock.calls.at(-1)![1] as import('../src/shared/contracts').LearningApi;
  expect(host.invoke).not.toHaveBeenCalled();
  const result = { ok: true, value: { done: true, name: 'map.md' } };
  host.invoke.mockResolvedValueOnce(result);
  const input = request();
  expect(await api.exportMap(input)).toBe(result);
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith(channels.exportMap, input);
});
