import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, type ProjectView, type Result } from '../src/shared/contracts';
import type { OverviewResult } from '../src/shared/ai';

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
  const { readAllowed } = await import('../src/core/project/files');
  return { workersStopped: async () => {}, ProjectSession: class {
    files = [{ id: randomUUID(), relativePath: 'saved.ts', size: 20 }, { id: randomUUID(), relativePath: 'other.ts', size: 20 }];
    constructor(readonly id: string, readonly root: string) {}
    async open() { return { id: this.id, name: 'test', files: this.files }; }
    relativePathOf(fileId: string) {
      const file = this.files.find(file => file.id === fileId);
      if (!file) throw new AppError('NOT_ALLOWED', 'unregistered file');
      return file.relativePath;
    }
    async read(fileId: string) {
      const relativePath = this.relativePathOf(fileId);
      const source = await readAllowed(this.root, relativePath);
      return { ...source, projectId: this.id, fileId, relativePath };
    }
    async evidence() { throw new AppError('NOT_ALLOWED', 'unregistered evidence'); }
    async close() {}
  } };
});
async function invoke<T = unknown>(channel: string, input?: unknown): Promise<Result<T>> {
  return await host.handlers.get(channel)!({ sender: host.contents, senderFrame: host.contents.mainFrame }, input) as Result<T>;
}
const code = 'export function saved() { return 1; }\n';
let temporary: string;
let project: ProjectView;
let result: OverviewResult;
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-saved-overview-main-')));
  host.folder = path.join(temporary, 'project'); host.profile = path.join(temporary, 'profile');
  await mkdir(host.folder);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.deleteOverview)).toBe(true));
});
beforeEach(async () => {
  await invoke(channels.cancel);
  const opened = await invoke<ProjectView>(channels.open);
  if (!opened.ok) throw new Error(opened.message);
  project = opened.value;
  await writeFile(path.join(host.folder, 'saved.ts'), code);
  const evidence = { id: randomUUID(), projectId: project.id, fileId: project.files[0].id,
    fileHash: createHash('sha256').update(code).digest('hex'), startUtf16: 0, endUtf16: code.length, startLine: 1, endLine: 1 };
  result = { jobId: randomUUID(), projectId: project.id, sources: [{ evidence, relativePath: 'saved.ts' }],
    overview: { intro: { text: '소개', evidenceIds: [evidence.id] },
      features: [{ name: '기능', summary: '기능 설명', evidenceIds: [evidence.id], start: { evidenceId: evidence.id, functionName: 'saved' } }],
      roles: [{ name: '역할', summary: '역할 설명', evidenceIds: [evidence.id], functions: [{ name: 'saved', evidenceId: evidence.id }] }], unknowns: [] },
    limitations: [], review: 'AI 검토됨', models: [] };
  await invoke(channels.deleteOverview, { projectId: project.id });
});
afterAll(async () => {
  await invoke(channels.cancel);
  host.closeStorage(); vi.unstubAllGlobals();
  await rm(temporary, { recursive: true, force: true });
});


it('restores current file IDs and registers evidence after reopening, then deletes the overview (legacy result without mode)', async () => {
  result.models = [{ stage: 'organizing', provider: 'codex', requestedModel: null, reportedModel: null },
    { stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: null }];
  expect(result).not.toHaveProperty('mode');
  const saved = await invoke(channels.saveOverview, { projectId: project.id, result });
  expect(saved).toMatchObject({ ok: true, value: { savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
  const reopened = await invoke<ProjectView>(channels.open);
  if (!reopened.ok) throw new Error(reopened.message);
  const fileId = reopened.value.files[0].id;
  expect(fileId).not.toBe(result.sources[0].evidence.fileId);
  const restored = await invoke<{ result: OverviewResult; changed: boolean }>(channels.savedOverview, { projectId: project.id });
  expect(restored).toMatchObject({ ok: true, value: { changed: false,
    result: { ...result, sources: [{ ...result.sources[0], evidence: { ...result.sources[0].evidence, fileId } }] } } });
  expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: result.sources[0].evidence.id }))
    .toMatchObject({ ok: true, value: { source: { text: code, fileId }, evidence: { ...result.sources[0].evidence, fileId } } });
  // A registered range still rechecks the file on every read.
  await writeFile(path.join(host.folder, 'saved.ts'), code.replace('1', '2'));
  expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: result.sources[0].evidence.id }))
    .toMatchObject({ ok: false, code: 'CHANGED' });
  expect(await invoke(channels.deleteOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
  expect(await invoke(channels.savedOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
});

it.each(['project', 'source project', 'file', 'path', 'intro', 'feature', 'start', 'role', 'function', 'duplicate'] as const)
('refuses a mismatched %s before writing', async field => {
  const invalid = structuredClone(result);
  const unknown = randomUUID();
  if (field === 'project') invalid.projectId = unknown;
  if (field === 'source project') invalid.sources[0].evidence.projectId = unknown;
  if (field === 'file') invalid.sources[0].evidence.fileId = unknown;
  if (field === 'path') invalid.sources[0].relativePath = 'other.ts';
  if (field === 'intro') invalid.overview.intro!.evidenceIds = [unknown];
  if (field === 'feature') invalid.overview.features[0].evidenceIds = [unknown];
  if (field === 'start') invalid.overview.features[0].start.evidenceId = unknown;
  if (field === 'role') invalid.overview.roles[0].evidenceIds = [unknown];
  if (field === 'function') invalid.overview.roles[0].functions[0].evidenceId = unknown;
  if (field === 'duplicate') invalid.sources.push({ relativePath: 'other.ts', evidence: { ...invalid.sources[0].evidence, fileId: project.files[1].id } });
  expect(await invoke(channels.saveOverview, { projectId: project.id, result: invalid })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await invoke(channels.savedOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
});

it.each(['broken JSON', 'schema', 'reference', 'duplicate', 'project', 'source project'])
('preserves a stored row with invalid %s while returning null', async kind => {
  const invalid = structuredClone(result);
  if (kind === 'reference') invalid.overview.features[0].start.evidenceId = randomUUID();
  if (kind === 'duplicate') invalid.sources.push(invalid.sources[0]);
  if (kind === 'project') invalid.projectId = randomUUID();
  if (kind === 'source project') invalid.sources[0].evidence.projectId = randomUUID();
  const stored = kind === 'broken JSON' ? '{broken' : JSON.stringify(kind === 'schema' ? { ...invalid, extra: true } : invalid);
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    db.prepare('INSERT INTO ai_overviews VALUES (?, ?, ?)').run(project.id, stored, 'now');
    expect(await invoke(channels.savedOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
    expect(db.prepare('SELECT result FROM ai_overviews WHERE project_id = ?').get(project.id)).toEqual({ result: stored });
  } finally { db.close(); }
});

it.each(['hash', 'missing', 'binary', 'range', 'lines', 'empty range', 'too large', 'ignored'])
('returns a changed overview for %s without registering evidence, and allows deletion', async kind => {
  if (kind === 'range') result.sources[0].evidence.endUtf16 += 1;
  if (kind === 'lines') result.sources[0].evidence.endLine = 2;
  if (kind === 'empty range') result.sources[0].evidence.endUtf16 = 0;
  expect(await invoke(channels.saveOverview, { projectId: project.id, result })).toMatchObject({ ok: true });
  await invoke(channels.open);
  if (kind === 'hash') await writeFile(path.join(host.folder, 'saved.ts'), code.replace('1', '2'));
  if (kind === 'missing') await rm(path.join(host.folder, 'saved.ts'));
  if (kind === 'binary') await writeFile(path.join(host.folder, 'saved.ts'), Buffer.from([0xff, 0xfe, 0x80]));
  if (kind === 'too large') await writeFile(path.join(host.folder, 'saved.ts'), 'x'.repeat(1024 * 1024 + 1));
  if (kind === 'ignored') await writeFile(path.join(host.folder, '.gitignore'), 'saved.ts\n');
  try {
    expect(await invoke(channels.savedOverview, { projectId: project.id })).toMatchObject({ ok: true, value: { changed: true, result: { jobId: result.jobId } } });
    expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: result.sources[0].evidence.id }))
      .toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    expect(await invoke(channels.deleteOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
    expect(await invoke(channels.savedOverview, { projectId: project.id })).toEqual({ ok: true, value: null });
  } finally { await rm(path.join(host.folder, '.gitignore'), { force: true }); }
});

it('checks the schema and current project for every overview IPC', async () => {
  expect(await invoke(channels.saveOverview, { projectId: project.id, result: { ...result, extra: true } }))
    .toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  for (const channel of [channels.savedOverview, channels.deleteOverview]) {
    expect(await invoke(channel, { projectId: project.id, path: '/tmp' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  }
  await invoke(channels.cancel);
  for (const channel of [channels.savedOverview, channels.deleteOverview, channels.saveOverview]) {
    const input = channel === channels.saveOverview ? { projectId: project.id, result } : { projectId: project.id };
    expect(await invoke(channel, input)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  }
});
