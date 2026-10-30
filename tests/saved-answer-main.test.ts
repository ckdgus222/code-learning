import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { channels, type ProjectView, type Result } from '../src/shared/contracts';
import type { LearningResult } from '../src/shared/ai';

// Real IPC actions and SQLite, with the Electron window, scanning and AI runtime replaced. No AI process runs.
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<Result<unknown>>>(),
  folder: '', profile: '', closeStorage: () => {},
  context: null as import('../src/core/ai/context').ProjectAiContext | null,
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
vi.mock('../src/core/ai/workflow', () => ({ LocalWorkerWorkflow: class { async close() {} } }));
vi.mock('../src/core/ai/context', async importOriginal => {
  const { ProjectAiContext } = await importOriginal<typeof import('../src/core/ai/context')>();
  return { ProjectAiContext: class extends ProjectAiContext {
    constructor(...args: ConstructorParameters<typeof ProjectAiContext>) { super(...args); host.context = this; }
  } };
});
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
let result: LearningResult;
beforeAll(async () => {
  temporary = await mkdtemp('/private/tmp/learning-saved-answer-main-');
  host.folder = path.join(temporary, 'project'); host.profile = path.join(temporary, 'profile');
  await mkdir(host.folder);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://learning.test/');
  await import('../src/main/main');
  await vi.waitFor(() => expect(host.handlers.has(channels.deleteAnswer)).toBe(true));
});
beforeEach(async () => {
  await invoke(channels.cancel);
  const opened = await invoke<ProjectView>(channels.open);
  if (!opened.ok) throw new Error(opened.message);
  project = opened.value;
  await writeFile(path.join(host.folder, 'saved.ts'), code);
  const evidence = { id: randomUUID(), projectId: project.id, fileId: project.files[0].id,
    fileHash: createHash('sha256').update(code).digest('hex'), startUtf16: 0, endUtf16: code.length, startLine: 1, endLine: 1 };
  result = { jobId: randomUUID(), conversationId: randomUUID(), projectId: project.id, question: '무슨 일을 하나요?',
    evidence, sources: [{ evidence, relativePath: 'saved.ts' }],
    explanation: { summary: '요약', steps: [], claims: [{ kind: 'code', text: '설명', evidenceIds: [evidence.id] }], terms: [], examples: [], unknowns: [] },
    limitations: [], review: 'AI 검토됨', models: [] };
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try { db.exec('DELETE FROM ai_answers'); } finally { db.close(); }
  await writeFile(path.join(host.folder, 'other.ts'), code);

});
afterAll(async () => {
  await invoke(channels.cancel);
  host.closeStorage(); vi.unstubAllGlobals();
  await rm(temporary, { recursive: true, force: true });
});



const save = () => invoke(channels.saveAnswer, { projectId: project.id, result });
const list = () => invoke(channels.savedAnswers, { projectId: project.id });
const read = () => invoke(channels.savedAnswer, { projectId: project.id, jobId: result.jobId });
const openEvidence = () => invoke(channels.openSavedEvidence, { projectId: project.id, jobId: result.jobId, evidenceId: result.evidence.id });

it('restores new file IDs without registering evidence and reads code directly, then deletes', async () => {
  expect(await save()).toMatchObject({ ok: true, value: { savedAt: expect.any(String) } });
  expect(await list()).toMatchObject({ ok: true, value: [{ jobId: result.jobId, question: result.question, savedAt: expect.any(String) }] });
  const opened = await invoke<ProjectView>(channels.open);
  if (!opened.ok) throw new Error(opened.message);
  const fileId = opened.value.files[0].id;
  expect(fileId).not.toBe(result.evidence.fileId);
  expect(await read()).toMatchObject({ ok: true, value: { changed: false, result: { evidence: { fileId } } } });
  expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: result.evidence.id })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await openEvidence()).toMatchObject({ ok: true, value: { source: { text: code, fileId }, evidence: { fileId } } });
  expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: result.evidence.id })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await invoke(channels.deleteAnswer, { projectId: project.id, jobId: result.jobId })).toEqual({ ok: true, value: null });
  expect(await read()).toEqual({ ok: true, value: null });
  expect(await list()).toEqual({ ok: true, value: [] });
});

it.each(['project', 'source project', 'file', 'path', 'claim', 'step', 'example', 'duplicate', 'selection', 'no references'])
('refuses invalid %s without writing', async kind => {
  const unknown = randomUUID();
  if (kind === 'project') result.projectId = unknown;
  if (kind === 'source project') result.sources.push({ relativePath: 'other.ts', evidence: { ...result.evidence, id: randomUUID(), projectId: unknown, fileId: project.files[1].id } });
  if (kind === 'file') result.sources[0].evidence.fileId = unknown;
  if (kind === 'path') result.sources[0].relativePath = 'other.ts';
  if (kind === 'claim') result.explanation.claims = [{ kind: 'code', text: '설명', evidenceIds: [unknown] }];
  if (kind === 'step') result.explanation.steps = [{ title: '단계', input: '입력', action: '처리', output: '출력', alternatives: [], evidenceIds: [unknown] }];
  if (kind === 'example') result.explanation.examples = [{ given: '입력', result: '출력', evidenceIds: [unknown] }];
  if (kind === 'duplicate') result.sources.push(result.sources[0]);
  if (kind === 'selection') result.evidence = { ...result.evidence, startUtf16: 1 };
  if (kind === 'no references') result.explanation.claims = [{ kind: 'concept', text: '개념' }];
  expect(await save()).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  expect(await list()).toEqual({ ok: true, value: [] });
});

it.each(['JSON', 'schema', 'project', 'reference', 'duplicate', 'selection', 'job'])
('keeps a corrupt %s row but omits it from reads and lists', async kind => {
  const invalid = structuredClone(result);
  if (kind === 'project') invalid.projectId = randomUUID();
  if (kind === 'reference') invalid.explanation.claims = [{ kind: 'code', text: '설명', evidenceIds: [randomUUID()] }];
  if (kind === 'duplicate') invalid.sources.push(invalid.sources[0]);
  if (kind === 'selection') invalid.evidence = { ...invalid.evidence, endUtf16: 1 };
  if (kind === 'job') invalid.jobId = randomUUID();
  const stored = kind === 'JSON' ? '{broken' : JSON.stringify(kind === 'schema' ? { ...invalid, extra: true } : invalid);
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    db.prepare('INSERT INTO ai_answers VALUES (?, ?, ?, ?)').run(project.id, result.jobId, stored, 'now');
    expect(await list()).toEqual({ ok: true, value: [] });
    expect(await read()).toEqual({ ok: true, value: null });
    expect(await openEvidence()).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    expect(db.prepare('SELECT result FROM ai_answers WHERE job_id = ?').get(result.jobId)).toEqual({ result: stored });
  } finally { db.close(); }
});

it('masks fake secrets on disk and restores a question expanded beyond the input limit', async () => {
  const fake = 'ghp_' + 'x'.repeat(36);
  result.question = fake + '\n' + 'TOKEN=a\n'.repeat(240);
  expect(result.question.length).toBeLessThanOrEqual(2000);
  expect(await save()).toMatchObject({ ok: true });
  const db = new DatabaseSync(path.join(host.profile, 'learning.sqlite'));
  try {
    const row = db.prepare('SELECT result FROM ai_answers WHERE job_id = ?').get(result.jobId) as { result: string };
    expect(row.result).not.toContain(fake);
    expect(row.result).not.toContain('TOKEN=a');
    const masked = JSON.parse(row.result).question;
    expect(masked.length).toBeGreaterThan(2000);
    expect(await list()).toMatchObject({ ok: true, value: [{ question: masked }] });
    expect(await read()).toMatchObject({ ok: true, value: { result: { question: masked }, changed: false } });
  } finally { db.close(); }
});

it('accepts six sources and a selection after 32 KiB', async () => {
  const large = '// padding\n'.repeat(4000) + code;
  await writeFile(path.join(host.folder, 'saved.ts'), large);
  result.evidence = { ...result.evidence, fileHash: createHash('sha256').update(large).digest('hex'),
    startUtf16: large.length - code.length, endUtf16: large.length, startLine: 4001, endLine: 4001 };
  result.sources = Array.from({ length: 6 }, (_, index) => ({ relativePath: 'saved.ts', evidence: { ...result.evidence, id: index ? randomUUID() : result.evidence.id } }));
  expect(await save()).toMatchObject({ ok: true });
  expect(await read()).toMatchObject({ ok: true, value: { changed: false, result: { sources: result.sources } } });
  expect(await openEvidence()).toMatchObject({ ok: true, value: { source: { text: large }, evidence: result.evidence } });
});

it.each(['related', 'selected', 'missing', 'range', 'lines'])('blocks all evidence when %s changes', async kind => {
  result.sources.push({ relativePath: 'other.ts', evidence: { ...result.evidence, id: randomUUID(), fileId: project.files[1].id } });
  if (kind === 'range') { result.evidence.endUtf16++; result.sources[0].evidence = result.evidence; }
  if (kind === 'lines') { result.evidence.endLine++; result.sources[0].evidence = result.evidence; }
  expect(await save()).toMatchObject({ ok: true });
  if (kind === 'related') await writeFile(path.join(host.folder, 'other.ts'), code.replace('1', '2'));
  if (kind === 'selected') await writeFile(path.join(host.folder, 'saved.ts'), code.replace('1', '2'));
  if (kind === 'missing') await rm(path.join(host.folder, 'other.ts'));
  expect(await openEvidence()).toMatchObject({ ok: false, code: 'CHANGED' });
  expect(await read()).toMatchObject({ ok: true, value: { changed: true } });
});

it('does not evict current answer or overview evidence after more than 64 distinct saved evidence reads', async () => {
  const currentAnswer = { ...result.evidence, id: randomUUID() };
  host.context!.keep(currentAnswer);
  const overview = { jobId: randomUUID(), projectId: project.id, sources: [{ ...result.sources[0], evidence: { ...result.evidence, id: randomUUID() } }],
    overview: { intro: null, features: [], roles: [], unknowns: [] }, limitations: [], review: 'AI 검토됨', models: [] };
  expect(await invoke(channels.saveOverview, { projectId: project.id, result: overview })).toMatchObject({ ok: true });
  expect(await invoke(channels.savedOverview, { projectId: project.id })).toMatchObject({ ok: true });
  for (let index = 0; index < 70; index++) {
    result.jobId = randomUUID(); result.evidence = { ...result.evidence, id: randomUUID() };
    result.sources = [{ relativePath: 'saved.ts', evidence: result.evidence }];
    result.explanation.claims = [{ kind: 'code', text: '설명', evidenceIds: [result.evidence.id] }];
    expect(await save()).toMatchObject({ ok: true });
    expect(await read()).toMatchObject({ ok: true });
    expect(await openEvidence()).toMatchObject({ ok: true });
    expect(host.context!.lookup(result.evidence.id)).toBeUndefined();
  }
  for (const evidence of [currentAnswer, overview.sources[0].evidence]) {
    expect(await invoke(channels.evidence, { projectId: project.id, evidenceId: evidence.id })).toMatchObject({ ok: true });
  }
});

it('validates strict IPC requests, evidence ownership and closed projects', async () => {
  expect(await save()).toMatchObject({ ok: true });
  expect(await invoke(channels.openSavedEvidence, { projectId: project.id, jobId: result.jobId, evidenceId: randomUUID() }))
    .toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  const requests = [
    [channels.savedAnswers, { projectId: project.id }], [channels.saveAnswer, { projectId: project.id, result }],
    [channels.savedAnswer, { projectId: project.id, jobId: result.jobId }],
    [channels.deleteAnswer, { projectId: project.id, jobId: result.jobId }],
    [channels.openSavedEvidence, { projectId: project.id, jobId: result.jobId, evidenceId: result.evidence.id }],
  ] as const;
  for (const [channel, input] of requests) expect(await invoke(channel, { ...input, extra: true })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  await invoke(channels.cancel);
  for (const [channel, input] of requests) expect(await invoke(channel, input)).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
});

it.each(['answer', 'evidence'])('discards a pending %s read when the same folder is reopened', async kind => {
  expect(await save()).toMatchObject({ ok: true });
  const context = host.context!;
  const check = context.checkSources.bind(context);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const checking = vi.spyOn(context, 'checkSources').mockImplementation(async sources => {
    const result = await check(sources);
    await held;
    return result;
  });
  const pending = kind === 'answer' ? read() : openEvidence();
  await vi.waitFor(() => expect(checking).toHaveBeenCalledOnce());
  const reopened = await invoke<ProjectView>(channels.open);
  expect(reopened).toMatchObject({ ok: true, value: { id: project.id } });
  release();
  expect(await pending).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
  checking.mockRestore();
  expect(await read()).toMatchObject({ ok: true, value: { changed: false } });
});
