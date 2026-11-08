import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, type ProjectView, type Result } from '../src/shared/contracts';
import type { FileExplanationResult } from '../src/shared/ai';

// Real IPC actions and SQLite, with the Electron window, scanning and AI runtime replaced. No AI process runs.
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<Result<unknown>>>(),
  folder: '', profile: '', closeStorage: () => {},
  contents: { mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler: () => {}, on: () => {},
    session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, on: () => {} } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.profile, whenReady: () => Promise.resolve(), on: () => {}, exit: vi.fn() },
  BrowserWindow: class { webContents = host.contents; on() {} loadURL() {} },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [host.folder] }), showErrorBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<Result<unknown>>) => host.handlers.set(channel, handler) },
  powerMonitor: { on: () => {} },
  nativeTheme: { themeSource: 'system' },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class { async close() {} } }));
vi.mock('../src/core/ai/workflow', () => ({ LearningWorkflow: class { async close() {} } }));
vi.mock('../src/core/storage/projects', async importOriginal => {
  const { ProjectStorage } = await importOriginal<typeof import('../src/core/storage/projects')>();
  return { ProjectStorage: class extends ProjectStorage {
    constructor(filename: string) { super(filename); host.closeStorage = () => this.close(); }
  } };
});
vi.mock('../src/main/project-session', async () => {
  const { randomUUID } = await import('node:crypto');
  const { AppError } = await import('../src/shared/errors');
  return { workersStopped: async () => {}, ProjectSession: class {
    files = [{ id: randomUUID(), relativePath: 'saved.ts', size: 20 }, { id: randomUUID(), relativePath: 'other.ts', size: 20 }];
    constructor(readonly id: string) {}
    async open() { return { id: this.id, name: 'test', files: this.files }; }
    relativePathOf(fileId: string) {
      const file = this.files.find(file => file.id === fileId);
      if (!file) throw new AppError('NOT_ALLOWED', 'unregistered file');
      return file.relativePath;
    }
    async close() {}
  } };
});
async function invoke<T = unknown>(channel: string, input?: unknown): Promise<Result<T>> {
  return await host.handlers.get(channel)!({ sender: host.contents, senderFrame: host.contents.mainFrame }, input) as Result<T>;
}
let temporary: string;
let project: ProjectView;
let result: FileExplanationResult;
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-saved-explanation-main-')));
  host.folder = path.join(temporary, 'project'); host.profile = path.join(temporary, 'profile');
  await mkdir(host.folder);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.deleteFileExplanation)).toBe(true));
});
beforeEach(async () => {
  await invoke(channels.cancel);
  const opened = await invoke<ProjectView>(channels.open);
  if (!opened.ok) throw new Error(opened.message);
  project = opened.value;
  const range = { fileId: project.files[0].id, fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 1 };
  const chunkId = randomUUID();
  result = { jobId: randomUUID(), projectId: project.id, relativePath: 'saved.ts', range,
    chunks: [{ id: chunkId, kind: 'function', name: 'saved', range, functionRange: null }],
    explanation: { summary: '파일 설명', chunks: [{ chunkId, summary: '함수 설명' }], unknowns: [] },
    limitations: [], mode: 'codex', review: 'AI 대조 없음', models: [] };
  await invoke(channels.deleteFileExplanation, { projectId: project.id, fileId: range.fileId });
});
afterAll(async () => {
  await invoke(channels.cancel);
  host.closeStorage(); vi.unstubAllGlobals();
  await rm(temporary, { recursive: true, force: true });
});

it.each(['codex', 'local-worker'] as const)('saves an accepted result, rebinds all ranges after reopen, preserves hashes and deletes by current ID (%s)', async mode => {
  result.mode = mode;
  result.review = mode === 'local-worker' ? 'AI 검토됨' : 'AI 대조 없음';
  result.models = [{ stage: mode === 'local-worker' ? 'reviewing' : 'explaining', provider: 'codex', requestedModel: null, reportedModel: null }];
  const saved = await invoke<{ savedAt: string }>(channels.saveFileExplanation, { projectId: project.id, result });
  expect(saved).toMatchObject({ ok: true, value: { savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
  const reopened = await invoke<ProjectView>(channels.open);
  if (!reopened.ok) throw new Error(reopened.message);
  expect(reopened.value.id).toBe(project.id);
  const fileId = reopened.value.files[0].id;
  expect(fileId).not.toBe(result.range.fileId);
  const input = { projectId: project.id, fileId };
  expect(await invoke(channels.savedFileExplanation, input)).toEqual({ ok: true, value: {
    result: { ...result, range: { ...result.range, fileId }, chunks: result.chunks.map(chunk => ({ ...chunk, range: { ...chunk.range, fileId } })) },
    savedAt: saved.ok ? saved.value.savedAt : null,
  } });
  expect(await invoke(channels.deleteFileExplanation, input)).toEqual({ ok: true, value: null });
  expect(await invoke(channels.savedFileExplanation, input)).toEqual({ ok: true, value: null });
});

it('masks secrets in chunk names before they are stored', async () => {
  const token = 'ghp_' + 'x'.repeat(36);
  const named = { ...result, chunks: [{ ...result.chunks[0], name: `['${token}']` }] };
  expect(await invoke(channels.saveFileExplanation, { projectId: project.id, result: named })).toMatchObject({ ok: true });
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    const rows = db.prepare('SELECT result FROM ai_file_explanations WHERE project_id = ?').all(project.id) as { result: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].result).not.toContain(token);
    expect(rows[0].result).toContain('[MASKED_SECRET]');
  } finally { db.close(); }
});

it.each(['project', 'file', 'path', 'chunk'] as const)('refuses a mismatched %s before writing', async field => {
  const unknown = randomUUID();
  const invalid = field === 'project' ? { ...result, projectId: unknown }
    : field === 'file' ? { ...result, range: { ...result.range, fileId: unknown } }
      : field === 'path' ? { ...result, relativePath: 'other.ts' }
        : { ...result, chunks: [{ ...result.chunks[0], range: { ...result.range, fileId: project.files[1].id } }] };
  expect(await invoke(channels.saveFileExplanation, { projectId: project.id, result: invalid })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await invoke(channels.savedFileExplanation, { projectId: project.id, fileId: result.range.fileId })).toEqual({ ok: true, value: null });
});

it('checks the schema, current project and registered file on every IPC', async () => {
  expect(await invoke(channels.saveFileExplanation, { projectId: project.id, result: { ...result, extra: true } })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  for (const channel of [channels.savedFileExplanation, channels.deleteFileExplanation]) {
    expect(await invoke(channel, { projectId: project.id, fileId: randomUUID() })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    expect(await invoke(channel, { projectId: project.id, fileId: result.range.fileId, path: '/tmp' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  }
  await invoke(channels.cancel);
  for (const channel of [channels.savedFileExplanation, channels.deleteFileExplanation, channels.saveFileExplanation]) {
    const input = channel === channels.saveFileExplanation ? { projectId: project.id, result } : { projectId: project.id, fileId: result.range.fileId };
    expect(await invoke(channel, input)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  }
});

it.each(['broken JSON', 'old schema', 'wrong path'])('leaves a saved %s row untouched while returning no result', async kind => {
  const stored = kind === 'broken JSON' ? '{broken' : JSON.stringify(kind === 'old schema' ? { ...result, extra: true } : { ...result, relativePath: 'other.ts' });
  const writer = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    writer.prepare('INSERT INTO ai_file_explanations VALUES (?, ?, ?, ?)').run(project.id, 'saved.ts', stored, 'now');
    expect(await invoke(channels.savedFileExplanation, { projectId: project.id, fileId: result.range.fileId })).toEqual({ ok: true, value: null });
    expect(writer.prepare('SELECT result FROM ai_file_explanations WHERE project_id = ? AND relative_path = ?').get(project.id, 'saved.ts')).toEqual({ result: stored });
  } finally { writer.close(); }
});
