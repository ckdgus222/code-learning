import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, MAX_FILE_BYTES, type Result } from '../src/shared/contracts';
import type { LearningEvent } from '../src/shared/ai';
import type { PlanDocument } from '../src/shared/plan-compare';
import { readStable } from '../src/core/project/files';
import { AppError } from '../src/shared/errors';

// Real IPC validation and file reading. Only temporary files and a test profile are used; no AI runs.
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<Result<unknown>>>(),
  folder: '', profile: '', projectId: '', closeStorage: () => {}, events: [] as LearningEvent[],
  run: vi.fn(async () => ({ value: { items: [], unrequested: [], designMismatches: [], unknowns: [] }, reportedModel: null })),
  picker: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  contents: { send: (_channel: string, event: LearningEvent) => host.events.push(event), mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler() {}, on() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.profile, whenReady: () => Promise.resolve(), on() {}, exit: vi.fn() },
  BrowserWindow: class { isDestroyed() { return false; } webContents = host.contents; on() {} loadURL() {} },
  dialog: { showOpenDialog: host.picker, showErrorBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<Result<unknown>>) => host.handlers.set(channel, handler) },
  powerMonitor: { on() {} },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class { assertReady() {} run = host.run; async close() {} } }));
vi.mock('../src/core/storage/projects', async importOriginal => {
  const { ProjectStorage } = await importOriginal<typeof import('../src/core/storage/projects')>();
  return { ProjectStorage: class extends ProjectStorage {
    constructor(filename: string) { super(filename); host.closeStorage = () => this.close(); }
  } };
});
vi.mock('../src/core/project/files', async importOriginal => {
  const files = await importOriginal<typeof import('../src/core/project/files')>();
  return { ...files, readStable: vi.fn(files.readStable) };
});
vi.mock('../src/main/project-session', () => ({
  workersStopped: async () => {},
  ProjectSession: class {
    constructor(readonly id: string, readonly root: string) { host.projectId = id; }
    async open() { return { id: this.id, name: 'test', files: [], excluded: {}, warnings: [] }; }
    async map() { return { projectId: this.id, files: [], edges: [], unresolved: [], external: [], limited: false, notes: [] }; }
    cancelMap() {}
    async close() {}
  },
}));

async function invoke<T = unknown>(channel: string, input?: unknown): Promise<Result<T>> {
  return await host.handlers.get(channel)!({ sender: host.contents, senderFrame: host.contents.mainFrame }, input) as Result<T>;
}
let temporary: string;
let main: typeof import('../src/main/main');
beforeAll(async () => {
  temporary = await mkdtemp('/private/tmp/learning-plan-main-');
  host.folder = path.join(temporary, 'project'); host.profile = path.join(temporary, 'profile');
  await mkdir(host.folder);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  main = await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.pickPlanDocument)).toBe(true));
});
beforeEach(async () => {
  await invoke(channels.cancel);
  host.picker.mockReset().mockResolvedValue({ canceled: false, filePaths: [host.folder] });
  expect(await invoke(channels.open)).toMatchObject({ ok: true });
  host.picker.mockClear();
  host.events.length = 0; host.run.mockClear();
  vi.mocked(readStable).mockClear();
});
afterAll(async () => {
  await invoke(channels.cancel);
  host.closeStorage(); vi.unstubAllGlobals();
  await rm(temporary, { recursive: true, force: true });
});

it.each(['md', 'markdown', 'txt', 'MD'])('reads only the chosen .%s file outside the project and returns masked metadata', async extension => {
  const file = path.join(temporary, `plan-${extension === 'MD' ? 'upper' : extension}.${extension}`);
  const text = '# password: example-only-value\r\n본문은 화면으로 보내지 않음';
  await writeFile(file, text);
  host.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  const result = await invoke<PlanDocument>(channels.pickPlanDocument);
  expect(host.picker).toHaveBeenCalledWith(expect.anything(), { properties: ['openFile'], title: '대조할 기획 문서 선택',
    filters: [{ name: '기획 문서', extensions: ['md', 'markdown', 'txt'] }] });
  expect(readStable).toHaveBeenCalledExactlyOnceWith(temporary, path.basename(file), MAX_FILE_BYTES);
  expect(result).toMatchObject({ ok: true, value: { name: path.basename(file), bytes: Buffer.byteLength(text), lines: 2,
    sections: [{ title: 'password: [MASKED_SECRET]' }] } });
  if (!result.ok) throw new Error('Document read failed');
  expect(Object.keys(result.value).sort()).toEqual(['bytes', 'documentId', 'lineBytes', 'lines', 'name', 'sections']);
  expect(JSON.stringify(result)).not.toContain(temporary);
  expect(JSON.stringify(result)).not.toContain('본문은');
  expect(JSON.stringify(result)).not.toContain('example-only-value');
  expect(main.planDocument).toEqual({ ...result.value, path: file, text, hash: createHash('sha256').update(text).digest('hex') });
  const next = await invoke<PlanDocument>(channels.pickPlanDocument);
  if (!next.ok) throw new Error('Second document read failed');
  expect(next.value.documentId).not.toBe(result.value.documentId);
  expect(main.planDocument?.documentId).toBe(next.value.documentId);
});

it('keeps the captured text on cancellation or read failure, replaces it on success and clears it on project changes', async () => {
  const file = path.join(temporary, 'snapshot.md');
  await writeFile(file, '# captured');
  host.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true });
  const captured = main.planDocument;
  await writeFile(file, '# changed after selection');
  expect(main.planDocument?.text).toBe('# captured');
  host.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await invoke(channels.pickPlanDocument)).toEqual({ ok: true, value: null });
  expect(main.planDocument).toBe(captured);
  vi.mocked(readStable).mockRejectedValueOnce(new AppError('UNSUPPORTED', 'not text'));
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false });
  expect(main.planDocument).toBe(captured);
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true });
  expect(main.planDocument?.text).toBe('# changed after selection');
  expect(main.planDocument?.documentId).not.toBe(captured?.documentId);
  host.picker.mockResolvedValueOnce({ canceled: false, filePaths: [host.folder] });
  expect(await invoke(channels.open)).toMatchObject({ ok: true });
  expect(main.planDocument).toBeNull();
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true });
  expect(main.planDocument).not.toBeNull();
  await invoke(channels.cancel);
  expect(main.planDocument).toBeNull();
});

it('returns null on cancellation without reading any file', async () => {
  host.picker.mockResolvedValue({ canceled: true, filePaths: [path.join(temporary, 'not-selected.md')] });
  expect(await invoke(channels.pickPlanDocument)).toEqual({ ok: true, value: null });
  expect(readStable).not.toHaveBeenCalled();
});

it('rejects renderer paths, foreign senders and closed projects before opening the picker', async () => {
  expect(await invoke(channels.pickPlanDocument, { path: path.join(temporary, 'plan.md') })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  const handler = host.handlers.get(channels.pickPlanDocument)!;
  expect(await handler({ sender: {}, senderFrame: host.contents.mainFrame }, undefined)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await handler({ sender: host.contents, senderFrame: { url: 'http://learning.test/' } }, undefined)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  await invoke(channels.cancel);
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  expect(host.picker).not.toHaveBeenCalled();
  expect(readStable).not.toHaveBeenCalled();
});

it('rejects unsupported extensions and multiple files even if the dialog filter is bypassed', async () => {
  host.picker.mockResolvedValue({ canceled: false, filePaths: [path.join(temporary, 'plan.js')] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  host.picker.mockResolvedValue({ canceled: false, filePaths: ['one.md', 'two.md'] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(readStable).not.toHaveBeenCalled();
});

it('accepts the 256 KiB read boundary, rejects overflow, invalid UTF-8, NUL and symbolic links', async () => {
  const file = path.join(temporary, 'boundary.md');
  host.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  await writeFile(file, 'a'.repeat(MAX_FILE_BYTES));
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true, value: { bytes: MAX_FILE_BYTES } });
  for (const size of [MAX_FILE_BYTES + 1, 300 * 1024]) {
    await writeFile(file, 'a'.repeat(size));
    expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'LIMIT', message: '문서가 256 KiB를 넘어 고를 수 없어요.' });
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('text\0data')]) {
    await writeFile(file, bytes);
    expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  }
  const link = path.join(temporary, 'link.md');
  await symlink(file, link);
  host.picker.mockResolvedValue({ canceled: false, filePaths: [link] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
});

it('preserves safe read errors and does not expose filesystem paths from native errors', async () => {
  host.picker.mockResolvedValue({ canceled: false, filePaths: [path.join(temporary, 'missing.md')] });
  const message = '읽는 동안 파일이 바뀌었습니다. 다시 열어 주세요.';
  vi.mocked(readStable).mockRejectedValueOnce(new AppError('CHANGED', message));
  expect(await invoke(channels.pickPlanDocument)).toEqual({ ok: false, code: 'CHANGED', message });
  const missing = await invoke(channels.pickPlanDocument);
  expect(missing).toMatchObject({ ok: false, code: 'INTERNAL' });
  expect(JSON.stringify(missing)).not.toContain(temporary);
});

it('rejects overlapping pickers and discards a dialog result after the project closes', async () => {
  let release!: (value: { canceled: boolean; filePaths: string[] }) => void;
  host.picker.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = invoke(channels.pickPlanDocument);
  await vi.waitFor(() => expect(host.picker).toHaveBeenCalledOnce());
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  await invoke(channels.cancel);
  release({ canceled: false, filePaths: [path.join(temporary, 'plan.md')] });
  expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
  expect(readStable).not.toHaveBeenCalled();
  expect(main.planDocument).toBeNull();
});

it('discards a file read that finishes after the project changes', async () => {
  let release!: (value: { text: string; hash: string }) => void;
  host.picker.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(temporary, 'plan.md')] });
  vi.mocked(readStable).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = invoke(channels.pickPlanDocument);
  await vi.waitFor(() => expect(readStable).toHaveBeenCalledOnce());
  host.picker.mockResolvedValue({ canceled: false, filePaths: [host.folder] });
  expect(await invoke(channels.open)).toMatchObject({ ok: true });
  release({ text: '# old', hash: 'old' });
  expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
  expect(main.planDocument).toBeNull();
});


it('rejects a foreign document, oversized selection and renderer source material before starting AI', async () => {
  const file = path.join(temporary, 'compare.md');
  await writeFile(file, 'a'.repeat(48 * 1024 + 1));
  host.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true });
  const request = { projectId: host.projectId, selection: { documentId: main.planDocument!.documentId, startLine: 1, endLine: 1 }, mode: 'codex', consent: true };
  expect(await invoke(channels.planCompare, { ...request, selection: { ...request.selection, documentId: randomUUID() } }))
    .toMatchObject({ ok: false, code: 'INVALID_REQUEST', message: '기획 문서를 다시 골라 주세요' });
  expect(await invoke(channels.planCompare, request)).toMatchObject({ ok: false, code: 'LIMIT' });
  for (const extra of [{ path: file }, { text: 'injected' }, { consent: false }]) {
    expect(await invoke(channels.planCompare, { ...request, ...extra })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  }
  expect(host.run).not.toHaveBeenCalled();
});

it('rereads a chosen document in main and rejects a changed hash before any AI stage', async () => {
  const file = path.join(temporary, 'compare-changed.md');
  await writeFile(file, '# original');
  host.picker.mockResolvedValue({ canceled: false, filePaths: [file] });
  expect(await invoke(channels.pickPlanDocument)).toMatchObject({ ok: true });
  await writeFile(file, '# changed');
  const result = await invoke<{ jobId: string }>(channels.planCompare, { projectId: host.projectId,
    selection: { documentId: main.planDocument!.documentId, startLine: 1, endLine: 1 }, mode: 'codex', consent: true });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await vi.waitFor(() => expect(host.events.find(event => event.jobId === result.value.jobId && event.kind === 'failed'))
    .toMatchObject({ error: { code: 'CHANGED', message: '기획 문서가 바뀌었어요. 다시 골라 주세요.' } }));
  expect(host.run).not.toHaveBeenCalled();
});
