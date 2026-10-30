import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, type ProjectView, type ProjectRoutes, type Result } from '../src/shared/contracts';
import type { FeatureGuideResult } from '../src/shared/ai';

// Real IPC actions and SQLite, with the Electron window, scanning and AI runtime replaced. No AI process runs.
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<Result<unknown>>>(),
  folder: '', profile: '', variant: '', closeStorage: () => {},
  contents: { mainFrame: { url: 'http://learning.test/' }, setWindowOpenHandler: () => {}, on: () => {},
    session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, on: () => {} } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.profile, whenReady: () => Promise.resolve(), on: () => {}, exit: vi.fn() },
  BrowserWindow: class { webContents = host.contents; on() {} loadURL() {} },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [host.folder] }), showErrorBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<Result<unknown>>) => host.handlers.set(channel, handler) },
  powerMonitor: { on: () => {} },
}));
vi.mock('../src/core/ai/runtime', () => ({ LocalAiRuntime: class { async close() {} } }));
vi.mock('../src/core/ai/workflow', () => ({ LocalWorkerWorkflow: class { async close() {} cancelFeatureGuide() {} } }));
vi.mock('../src/core/storage/projects', async importOriginal => {
  const { ProjectStorage } = await importOriginal<typeof import('../src/core/storage/projects')>();
  return { ProjectStorage: class extends ProjectStorage {
    constructor(filename: string) { super(filename); host.closeStorage = () => this.close(); }
  } };
});
// Keep the production material builder, hash and current-routes validation. Only scanning is replaced.
vi.mock('../src/main/project-session', async importOriginal => {
  const { ProjectSession } = await importOriginal<typeof import('../src/main/project-session')>();
  const { randomUUID } = await import('node:crypto');
  return { workersStopped: async () => {}, ProjectSession: class {
    private project?: ProjectView;
    private lastRoutes?: { result: ProjectRoutes; revision: number; observed: number };
    private observedChanges = 0;
    private closed = false;
    currentRoutes = ProjectSession.prototype['currentRoutes'];
    captureFeatureGuide = ProjectSession.prototype.captureFeatureGuide;
    constructor(readonly id: string, readonly root: string) {}
    async open() {
      this.project = { id: this.id, name: 'test', files: [
        { id: randomUUID(), relativePath: 'api.ts', size: 20 },
        { id: randomUUID(), relativePath: 'request.ts', size: 20 },
        { id: randomUUID(), relativePath: 'next.config.ts', size: 20 },
        { id: randomUUID(), relativePath: host.variant === 'screen' ? 'app/changed/page.tsx' : 'app/dogs/page.tsx', size: 20 },
      ], excluded: {}, warnings: [], overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
      return this.project;
    }
    async routes(revision: number) {
      const secret = 'ghp_' + 'x'.repeat(36);
      const site = { fileId: this.project!.files[0].id, fileHash: (host.variant === 'handler body' ? 'b' : 'a').repeat(64),
        startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 1, text: 'source never stored' };
      const result: ProjectRoutes = { projectId: this.id, routesId: randomUUID(),
        routes: host.variant === 'empty' ? [] : [{ method: 'GET', path: host.variant === 'route' ? '/changed' : '/' + secret,
          prefix: 'known', framework: 'nest', handler: { ...site, name: secret }, basis: { text: 'basis', range: site } }],
        requests: [{ ...site, fileId: this.project!.files[1].id, fileHash: (host.variant === 'request body' ? 'c' : 'a').repeat(64),
          path: host.variant === 'request' ? '/changed' : '/dogs', host: null, prefix: 'known', methods: ['GET'], args: [], inTest: false,
          inFunction: { name: secret, startUtf16: 0, endUtf16: 20, startLine: 1 } }],
        links: host.variant === 'empty' ? [] : [{ requestIndex: 0, routeIndex: 0, sure: true, reasons: [] }], prefix: null, limited: false, notes: [] };
      this.lastRoutes = { result, revision, observed: this.observedChanges };
      return result;
    }
    async close() { this.closed = true; }
  } };
});
async function invoke<T = unknown>(channel: string, input?: unknown): Promise<Result<T>> {
  return await host.handlers.get(channel)!({ sender: host.contents, senderFrame: host.contents.mainFrame }, input) as Result<T>;
}
let temporary: string;
let project: ProjectView;
let routes: ProjectRoutes;
let result: FeatureGuideResult;
async function reopen() {
  const opened = await invoke<ProjectView>(channels.open);
  if (!opened.ok) throw new Error(opened.message);
  project = opened.value;
  const found = await invoke<ProjectRoutes>(channels.routes, { projectId: project.id });
  if (!found.ok) throw new Error(found.message);
  routes = found.value;
}
const read = () => invoke(channels.savedFeatureGuide, { projectId: project.id, routesId: routes.routesId });
beforeAll(async () => {
  temporary = await mkdtemp('/private/tmp/learning-saved-guide-main-');
  host.folder = path.join(temporary, 'project'); host.profile = path.join(temporary, 'profile');
  await mkdir(host.folder);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.deleteFeatureGuide)).toBe(true));
});
beforeEach(async () => {
  host.variant = '';
  await invoke(channels.cancel); await reopen();
  result = { jobId: randomUUID(), projectId: project.id, routesId: routes.routesId, mode: 'codex', review: 'AI 대조 없음',
    guide: { summary: '요약', groups: [{ name: '묶음', about: '설명', features: [{ name: '기능', about: '설명', routes: [0] }] }], unknowns: [] },
    limitations: [], models: [] };
  await invoke(channels.deleteFeatureGuide, { projectId: project.id });
});
afterAll(async () => {
  await invoke(channels.cancel); host.closeStorage(); vi.unstubAllGlobals();
  await rm(temporary, { recursive: true, force: true });
});

it('restores the current routes ID across reopen, stores only a hash of material, and deletes', async () => {
  expect(await invoke(channels.saveFeatureGuide, { projectId: project.id, result }))
    .toMatchObject({ ok: true, value: { savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
  const oldFileId = project.files[0].id;
  await reopen();
  expect(routes.routesId).not.toBe(result.routesId); expect(project.files[0].id).not.toBe(oldFileId);
  expect(await read()).toMatchObject({ ok: true, value: { changed: false, result: { ...result, routesId: routes.routesId } } });
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    const row = db.prepare('SELECT * FROM ai_feature_guides').get();
    expect(row).toMatchObject({ material_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(row)).not.toContain('ghp_' + 'x'.repeat(36));
    expect(JSON.stringify(row)).not.toContain('source never stored');
  } finally { db.close(); }
  expect(await invoke(channels.deleteFeatureGuide, { projectId: project.id })).toEqual({ ok: true, value: null });
  expect(await read()).toEqual({ ok: true, value: null });
});

it.each(['project', 'routes', 'out of bounds', 'duplicate'])('refuses invalid %s without writing', async kind => {
  const invalid = structuredClone(result);
  if (kind === 'project') invalid.projectId = randomUUID();
  if (kind === 'routes') invalid.routesId = randomUUID();
  if (kind === 'out of bounds') invalid.guide.groups[0].features[0].routes = [1];
  if (kind === 'duplicate') invalid.guide.groups[0].features[0].routes = [0, 0];
  expect(await invoke(channels.saveFeatureGuide, { projectId: project.id, result: invalid }))
    .toMatchObject({ ok: false, code: kind === 'routes' ? 'CHANGED' : 'NOT_ALLOWED' });
  expect(await read()).toEqual({ ok: true, value: null });
});

it.each(['route', 'request', 'screen', 'handler body', 'request body', 'empty'])
('marks %s changes without applying old route numbers', async variant => {
  expect(await invoke(channels.saveFeatureGuide, { projectId: project.id, result })).toMatchObject({ ok: true });
  host.variant = variant; await reopen();
  expect(await read()).toMatchObject({ ok: true, value: { changed: true, result: { ...result, routesId: routes.routesId } } });
});

it.each(['JSON', 'schema', 'project', 'route', 'duplicate'])('keeps a corrupted %s row while returning null', async kind => {
  expect(await invoke(channels.saveFeatureGuide, { projectId: project.id, result })).toMatchObject({ ok: true });
  const invalid = structuredClone(result);
  if (kind === 'project') invalid.projectId = randomUUID();
  if (kind === 'route') invalid.guide.groups[0].features[0].routes = [1];
  if (kind === 'duplicate') invalid.guide.groups[0].features[0].routes = [0, 0];
  const stored = kind === 'JSON' ? '{broken' : JSON.stringify(kind === 'schema' ? { ...invalid, extra: true } : invalid);
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    db.prepare('UPDATE ai_feature_guides SET result = ? WHERE project_id = ?').run(stored, project.id);
    expect(await read()).toEqual({ ok: true, value: null });
    expect(db.prepare('SELECT result FROM ai_feature_guides WHERE project_id = ?').get(project.id)).toEqual({ result: stored });
  } finally { db.close(); }
});

it('checks strict requests, closed projects and stale reads before touching stored rows', async () => {
  expect(await invoke(channels.saveFeatureGuide, { projectId: project.id, result: { ...result, extra: true } }))
    .toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(await invoke(channels.savedFeatureGuide, { projectId: project.id, routesId: randomUUID() }))
    .toMatchObject({ ok: false, code: 'CHANGED' });
  expect(await invoke(channels.savedFeatureGuide, { projectId: project.id, routesId: routes.routesId, extra: true }))
    .toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  expect(await invoke(channels.deleteFeatureGuide, { projectId: project.id, extra: true }))
    .toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  await invoke(channels.cancel);
  for (const channel of [channels.savedFeatureGuide, channels.saveFeatureGuide, channels.deleteFeatureGuide]) {
    const input = channel === channels.saveFeatureGuide ? { projectId: project.id, result }
      : channel === channels.savedFeatureGuide ? { projectId: project.id, routesId: routes.routesId } : { projectId: project.id };
    expect(await invoke(channel, input)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  }
});
