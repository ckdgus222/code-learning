import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAiContext, MAX_CONTEXT_FILE_BYTES } from '../src/core/ai/context';
import { LocalWorkerWorkflow, type StageRequest, type StageResponse } from '../src/core/ai/workflow';
import { scanProject, readAllowed } from '../src/core/project/files';
import { SECRET_MASK } from '../src/core/ai/secrets';
import { GEMINI_MODEL, fileExplanationSchema, type FileExplanation, type FileExplanationRequest, type LearningEvent } from '../src/shared/ai';
import { AppError } from '../src/shared/errors';

// Fake runners only. No installed AI program, account or network is used.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(text = 'export function run() { return 1; }\n', relativePath = 'app.ts') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-file-explanation-')));
  roots.push(root);
  await writeFile(path.join(root, relativePath), text);
  await writeFile(path.join(root, 'other.ts'), 'const NEVER_SEND_OTHER_FILE = 2;');
  const project = await scanProject(root, randomUUID());
  const file = project.files.find(file => file.relativePath === relativePath)!;
  const { hash } = await readAllowed(root, relativePath);
  const context = new ProjectAiContext(root, project);
  const request: FileExplanationRequest = { projectId: project.id, fileId: file.id, expectedFileHash: hash, mode: 'local-worker', consent: true };
  const events: LearningEvent[] = [];
  const assertReady = vi.fn();
  const captureFile = vi.fn((request: FileExplanationRequest, signal: AbortSignal) => context.captureFile(request, 1, signal));
  const revalidate = vi.fn((...args: Parameters<ProjectAiContext['revalidate']>) => context.revalidate(...args));
  const expand = vi.fn();
  const run = vi.fn(async (input: StageRequest): Promise<StageResponse> => {
    const sent = material(input);
    const explanation: FileExplanation = { summary: '이 파일은 값을 돌려줍니다.',
      chunks: sent.chunks.map(chunk => ({ chunkId: chunk.id, summary: `${chunk.name} 설명` })), unknowns: [] };
    return { reportedModel: input.provider === 'antigravity' ? GEMINI_MODEL : 'test-codex',
      value: input.stage === 'explaining' ? explanation : { accepted: true, issues: [], explanation } };
  });
  const workflow = new LocalWorkerWorkflow({ captureFeatureGuide: async () => { throw new Error('not a feature guide test'); }, revalidateFeatureGuide: async () => { throw new Error('not a feature guide test'); }, assertReady, captureFile, revalidate, expand, run, emit: event => events.push(event),
    capture: async () => { throw new Error('not a question'); },
    captureOverview: async () => { throw new Error('not an overview'); } });
  const finish = async (input = request) => {
    const { jobId } = workflow.startFileExplanation(input);
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  };
  return { root, project, file, text, request, context, workflow, events, assertReady, captureFile, revalidate, expand, run, finish };
}
function material(request: StageRequest): { relativePath: string; code: string; chunks: { id: string; kind: string; name: string; startLine: number; endLine: number }[] } {
  return JSON.parse(request.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
}

describe('file explanation material', () => {
  it('reads exactly the approved file, without the file list or evidence registration', async () => {
    const f = await fixture();
    const snapshot = await f.context.captureFile(f.request, 7, new AbortController().signal);
    expect(snapshot).toMatchObject({ projectId: f.project.id, revision: 7, availableFiles: [], limitations: [] });
    expect(snapshot.files.map(file => [file.relativePath, file.code])).toEqual([['app.ts', f.text]]);
    expect(snapshot.chunks).toHaveLength(1);
    expect(snapshot.chunks[0].range).toMatchObject({ fileId: f.file.id, fileHash: f.request.expectedFileHash });
    expect(f.context.lookup(snapshot.files[0].evidence.id)).toBeUndefined();
  });

  it('refuses files above 32 KiB, including multibyte text, and accepts the exact byte limit', async () => {
    const exact = await fixture('//' + 'x'.repeat(MAX_CONTEXT_FILE_BYTES - 2));
    expect((await exact.finish()).kind).toBe('file-explanation-completed');
    const over = await fixture('//' + '한'.repeat(Math.ceil(MAX_CONTEXT_FILE_BYTES / 3)));
    expect(await over.finish()).toMatchObject({ kind: 'failed', error: { code: 'LIMIT' } });
    expect(over.run).not.toHaveBeenCalled();
  });

  it('rejects a non-code file and a changed hash, and accepts an empty code file', async () => {
    const doc = await fixture('# hello', 'README.md');
    expect(await doc.finish()).toMatchObject({ kind: 'failed', error: { code: 'UNSUPPORTED' } });
    const changed = await fixture();
    expect(await changed.finish({ ...changed.request, expectedFileHash: '0'.repeat(64) })).toMatchObject({ kind: 'failed', error: { code: 'CHANGED', message: '파일이 바뀌어 다시 만들어 주세요' } });
    const empty = await fixture('');
    expect(await empty.finish()).toMatchObject({ kind: 'file-explanation-completed', result: { chunks: [], range: { startUtf16: 0, endUtf16: 0 } } });
  });

  it('rechecks file membership, project identity, ignore rules and cancellation before sending', async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    await expect(f.context.captureFile({ ...f.request, fileId: randomUUID() }, 1, signal)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(f.context.captureFile({ ...f.request, projectId: randomUUID() }, 1, signal)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    const controller = new AbortController(); controller.abort();
    await expect(f.context.captureFile(f.request, 1, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await writeFile(path.join(f.root, '.gitignore'), 'app.ts\n');
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'NOT_ALLOWED' } });
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe('file explanation workflow', () => {
  it.each(['codex', 'antigravity'] as const)('%s runs exactly one explaining stage', async mode => {
    const f = await fixture();
    const result = await f.finish({ ...f.request, mode });
    expect(result).toMatchObject({ kind: 'file-explanation-completed', result: { mode, review: 'AI 대조 없음' } });
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([['explaining', mode]]);
    expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.expand).not.toHaveBeenCalled();
  });

  it('runs Gemini explanation then Codex review with the same single masked file and no other file data', async () => {
    const f = await fixture('const password = "test-only-secret-value";\nexport function run() { return password; }');
    const result = await f.finish();
    expect(result).toMatchObject({ kind: 'file-explanation-completed', result: { review: 'AI 검토됨', mode: 'local-worker',
      models: [{ provider: 'antigravity', requestedModel: GEMINI_MODEL, reportedModel: GEMINI_MODEL },
        { provider: 'codex', reportedModel: 'test-codex' }] } });
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([['explaining', 'antigravity'], ['reviewing', 'codex']]);
    const sent = f.run.mock.calls.map(([input]) => material(input));
    expect(sent[0]).toEqual(sent[1]);
    expect(Object.keys(sent[0]).sort()).toEqual(['chunks', 'code', 'relativePath']);
    expect(sent[0].code).toContain(SECRET_MASK);
    for (const [input] of f.run.mock.calls) {
      expect(input.prompt).not.toContain('test-only-secret-value');
      expect(input.prompt).not.toContain('NEVER_SEND_OTHER_FILE');
      expect(input.prompt).not.toContain('other.ts');
    }
    expect(f.revalidate).toHaveBeenCalledTimes(3);
    expect(f.expand).not.toHaveBeenCalled();
    if (result.kind !== 'file-explanation-completed') throw new Error('expected completion');
    expect(result.result.limitations.join(' ')).toContain('비밀값');
    expect(result.result.range).toMatchObject({ fileId: f.file.id, fileHash: f.request.expectedFileHash, startUtf16: 0, endUtf16: f.text.length });
  });

  it.each(['before-stage', 'between-stages', 'before-display'] as const)('discards a file changed %s', async when => {
    const f = await fixture();
    const normal = f.run.getMockImplementation()!;
    if (when === 'before-stage') f.captureFile.mockImplementationOnce(async (request, signal) => {
      const snapshot = await f.context.captureFile(request, 1, signal);
      await writeFile(path.join(f.root, 'app.ts'), 'const changed = 1;');
      return snapshot;
    });
    else f.run.mockImplementation(async input => {
      const result = await normal(input);
      if (input.stage === (when === 'between-stages' ? 'explaining' : 'reviewing')) await writeFile(path.join(f.root, 'app.ts'), 'const changed = 1;');
      return result;
    });
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED', message: '파일이 바뀌어 다시 만들어 주세요' } });
    expect(f.run).toHaveBeenCalledTimes(when === 'before-stage' ? 0 : when === 'between-stages' ? 1 : 2);
    expect(f.events.some(event => event.kind === 'file-explanation-completed')).toBe(false);
  });

  it.each(['unknown', 'duplicate', 'review-unknown', 'review-duplicate', 'format', 'review-rejected'] as const)('rejects %s responses', async kind => {
    const f = await fixture();
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementation(async input => {
      const response = await normal(input);
      const reviewing = input.stage === 'reviewing';
      if (reviewing !== kind.startsWith('review-')) return response;
      const answer = reviewing ? (response.value as { explanation: FileExplanation }).explanation : response.value as FileExplanation;
      if (kind.endsWith('unknown')) answer.chunks[0].chunkId = randomUUID();
      else if (kind.endsWith('duplicate')) answer.chunks.push(answer.chunks[0]);
      else if (kind === 'format') return { ...response, value: { ...answer, invented: true } };
      else if (kind === 'review-rejected') return { ...response, value: { accepted: false, issues: ['근거 부족'], explanation: answer } };
      return response;
    });
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.events.some(event => event.kind === 'file-explanation-completed')).toBe(false);
  });

  it('accepts omitted explanations and keeps all original chunks for the screen', async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ reportedModel: null, value: { summary: '파일 설명', chunks: [], unknowns: [] } });
    const result = await f.finish({ ...f.request, mode: 'codex' });
    expect(result).toMatchObject({ kind: 'file-explanation-completed', result: { explanation: { chunks: [] }, chunks: [{ name: 'run' }] } });
  });

  it('cancels a running stage, emits no result and allows another job after cancellation', async () => {
    const f = await fixture();
    f.run.mockImplementationOnce(input => new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })));
    const { jobId } = f.workflow.startFileExplanation(f.request);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await f.workflow.cancel(jobId);
    expect(f.events.at(-1)).toMatchObject({ kind: 'failed', error: { code: 'CANCELLED', message: 'AI 작업을 취소했습니다.' } });
    expect(f.events.some(event => event.kind === 'file-explanation-completed')).toBe(false);
    expect((await f.finish()).kind).toBe('file-explanation-completed');
  });

  it('shares the active job slot with questions and overviews in both directions', async () => {
    const f = await fixture();
    const question = { projectId: f.project.id, evidenceId: randomUUID(), expectedFileHash: f.request.expectedFileHash, question: '설명', mode: 'codex' as const, consent: true as const };
    const overview = { projectId: f.project.id, startFileId: null, mode: 'local-worker' as const, consent: true as const };
    const fileJob = f.workflow.startFileExplanation(f.request);
    expect(() => f.workflow.start(question)).toThrow('이미 AI 작업');
    expect(() => f.workflow.startOverview(overview)).toThrow('이미 AI 작업');
    expect(() => f.workflow.startFileExplanation(f.request)).toThrow('이미 AI 작업');
    await f.workflow.cancel(fileJob.jobId);
    const questionJob = f.workflow.start(question);
    expect(() => f.workflow.startFileExplanation(f.request)).toThrow('이미 AI 작업');
    await f.workflow.cancel(questionJob.jobId);
    const overviewJob = f.workflow.startOverview(overview);
    expect(() => f.workflow.startFileExplanation(f.request)).toThrow('이미 AI 작업');
    await f.workflow.cancel(overviewJob.jobId);
  });

  it('checks installation before reading code and keeps Claude Code locked', async () => {
    const f = await fixture();
    f.assertReady.mockImplementationOnce(() => { throw new AppError('AI_UNAVAILABLE', '먼저 설치 상태를 확인해 주세요.'); });
    expect(() => f.workflow.startFileExplanation(f.request)).toThrow('설치 상태');
    expect(() => f.workflow.startFileExplanation({ ...f.request, mode: 'claude-code' })).toThrow('준비 중');
    expect(f.captureFile).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([{ consent: false }, { consent: undefined }, { fileId: '../file.ts' }, { code: 'source' }, { prompt: 'instructions' }, { path: '/tmp/a' }])('rejects invalid input %j', async extra => {
    const f = await fixture();
    expect(() => f.workflow.startFileExplanation({ ...f.request, ...extra } as FileExplanationRequest)).toThrow();
    expect(f.captureFile).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('uses strict nested response objects and enforces 80 chunks and 16 unknowns', () => {
    const answer = { summary: '파일', chunks: [], unknowns: [] };
    expect(fileExplanationSchema.safeParse(answer).success).toBe(true);
    expect(fileExplanationSchema.safeParse({ ...answer, chunks: [{ chunkId: randomUUID(), summary: '설명', startLine: 1 }] }).success).toBe(false);
    expect(fileExplanationSchema.safeParse({ ...answer, chunks: Array.from({ length: 81 }, () => ({ chunkId: randomUUID(), summary: '설명' })) }).success).toBe(false);
    expect(fileExplanationSchema.safeParse({ ...answer, unknowns: Array(17).fill('모름') }).success).toBe(false);
  });
});
