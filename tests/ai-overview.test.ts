import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAiContext, MAX_CONTEXT_FILE_BYTES } from '../src/core/ai/context';
import { LocalWorkerWorkflow, type ContextSnapshot, type StageRequest, type StageResponse } from '../src/core/ai/workflow';
import { scanProject } from '../src/core/project/files';
import { SECRET_MASK } from '../src/core/ai/secrets';
import { GEMINI_MODEL, type LearningEvent, type OverviewRequest, type ProjectOverviewAnswer } from '../src/shared/ai';
import { AppError } from '../src/shared/errors';

// Plan G1: the project overview. Fake model stages only: no CLI, account, network or real AI.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-overview-')));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  const scanned = await scanProject(root, randomUUID());
  const id = (name: string) => scanned.files.find(file => file.relativePath === name)!.id;
  return { root, project: scanned, context: new ProjectAiContext(root, scanned), id };
}
const files = {
  'README.md': '# 주문 앱\n\n주문을 받고 재고를 확인합니다.\n',
  'order.ts': 'import { stock } from \'./stock\';\nexport function placeOrder(count: number) {\n  return count <= stock() ? \'ok\' : \'too many\';\n}\n',
  'stock.ts': 'export function stock() { return 3; }\nexport const $reserve = () => 1;\n',
};

describe('overview material read by the app', () => {
  it('lists the files and reads only the start file the user chose, or none', async () => {
    const f = await project(files);
    const signal = new AbortController().signal;
    const none = await f.context.captureOverview(null, 4, signal);
    expect(none).toMatchObject({ projectId: f.project.id, revision: 4, files: [] });
    expect(none.availableFiles.map(file => file.relativePath).sort()).toEqual(['README.md', 'order.ts', 'stock.ts']);
    const started = await f.context.captureOverview(f.id('README.md'), 4, signal);
    expect(started.files.map(file => [file.relativePath, file.code])).toEqual([['README.md', files['README.md']]]);
    expect(f.context.lookup(started.files[0].evidence.id)).toEqual(started.files[0].evidence);
    await f.context.revalidate(started, signal);
    await writeFile(path.join(f.root, 'README.md'), '# 바뀐 소개\n');
    await expect(f.context.revalidate(started, signal)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('checks the start file against the whole project list, not the list cut for sending', async () => {
    // Enough long names that the list sent stops before the last file, which is still a project file.
    const many = Object.fromEntries(Array.from({ length: 900 }, (_, index) => [`f${String(index).padStart(3, '0')}-${'x'.repeat(100)}.ts`, 'export {};\n']));
    const f = await project({ ...many, 'zz-last.ts': 'export const last = 1;\n' });
    const snapshot = await f.context.captureOverview(f.id('zz-last.ts'), 1, new AbortController().signal);
    expect(snapshot.availableFiles.some(file => file.relativePath === 'zz-last.ts')).toBe(false);
    expect(snapshot.limitations).toContain('파일 목록 크기 제한으로 일부 파일은 이번 질문의 탐색 목록에 없습니다.');
    expect(snapshot.files.map(file => file.relativePath)).toEqual(['zz-last.ts']);
  });

  it('refuses a start file outside the project or refused when read, and leaves out one too big with a reason', async () => {
    const f = await project({ ...files, 'big.ts': `// ${'a'.repeat(MAX_CONTEXT_FILE_BYTES)}\n` });
    const signal = new AbortController().signal;
    await expect(f.context.captureOverview(randomUUID(), 1, signal)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    const big = await f.context.captureOverview(f.id('big.ts'), 1, signal);
    expect(big.files).toEqual([]);
    expect(big.limitations).toContain('big.ts: 비어 있거나 자료 크기 제한을 넘어 전체 파일을 포함하지 않았습니다.');
    // Replaced by a link after the folder was opened: the read rules refuse it as for any question.
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-overview-outside-')));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.ts'), 'export const secret = 1;\n');
    await unlink(path.join(f.root, 'stock.ts'));
    await symlink(path.join(outside, 'secret.ts'), path.join(f.root, 'stock.ts'));
    await expect(f.context.captureOverview(f.id('stock.ts'), 1, signal)).rejects.toBeInstanceOf(AppError);
  });

  it('keeps evidence the screen checked so a question can still use it after another file is read', async () => {
    const f = await project(files);
    const evidence = { id: randomUUID(), projectId: f.project.id, fileId: f.id('order.ts'), fileHash: 'a'.repeat(64),
      startUtf16: 0, endUtf16: 5, startLine: 1, endLine: 1 };
    expect(f.context.lookup(evidence.id)).toBeUndefined();
    f.context.keep(evidence);
    expect(f.context.lookup(evidence.id)).toEqual(evidence);
  });
});

function fake(snapshot: ContextSnapshot, answer: (snapshot: ContextSnapshot) => ProjectOverviewAnswer, requested: string[] = []) {
  const events: LearningEvent[] = [];
  const revalidate = vi.fn(async (_snapshot: ContextSnapshot, _signal: AbortSignal) => {});
  const expand = vi.fn(async (_snapshot: ContextSnapshot, _ids: string[], _signal: AbortSignal) => {});
  const run = vi.fn(async ({ stage }: StageRequest): Promise<StageResponse> => ({
    reportedModel: stage === 'explaining' ? GEMINI_MODEL : null,
    value: stage === 'organizing' ? { focus: '기능 확인', requestedFileIds: requested }
      : stage === 'explaining' ? answer(snapshot) : { accepted: true, issues: [], overview: answer(snapshot) },
  }));
  const assertReady = vi.fn();
  const capture = vi.fn(async () => { throw new Error('not a question test'); });
  const captureOverview = vi.fn(async () => snapshot);
  const workflow = new LocalWorkerWorkflow({ captureFeatureGuide: async () => { throw new Error('not a feature guide test'); }, revalidateFeatureGuide: async () => { throw new Error('not a feature guide test'); }, assertReady, capture, captureOverview, captureFile: async () => { throw new Error('not a file explanation test'); }, expand, revalidate, run, emit: event => events.push(event) });
  const request: OverviewRequest = { projectId: snapshot.projectId, startFileId: null, mode: 'local-worker', consent: true };
  const finish = async (input = request) => {
    const { jobId } = workflow.startOverview(input);
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  };
  return { events, revalidate, expand, run, assertReady, captureOverview, workflow, request, finish };
}
const material = (code: Record<string, string>): ContextSnapshot => {
  const projectId = randomUUID();
  return { projectId, revision: 1, availableFiles: [], limitations: [],
    files: Object.entries(code).map(([relativePath, text]) => ({ relativePath, code: text, evidence: { id: randomUUID(), projectId,
      fileId: randomUUID(), fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: text.length, startLine: 1, endLine: 1 } })) };
};
const idOf = (snapshot: ContextSnapshot, relativePath: string) => snapshot.files.find(file => file.relativePath === relativePath)!.evidence.id;
const written = (snapshot: ContextSnapshot): ProjectOverviewAnswer => ({
  intro: { text: '주문을 받는 앱이에요.', evidenceIds: [idOf(snapshot, 'README.md')] },
  features: [{ name: '주문하기', summary: '수량을 재고와 비교해요.', evidenceIds: [idOf(snapshot, 'order.ts')],
    start: { evidenceId: idOf(snapshot, 'order.ts'), functionName: 'placeOrder' } }],
  roles: [{ name: '재고', summary: '남은 수를 알려 줘요.', evidenceIds: [idOf(snapshot, 'stock.ts')],
    functions: [{ name: 'stock', evidenceId: idOf(snapshot, 'stock.ts') }, { name: '$reserve', evidenceId: idOf(snapshot, 'stock.ts') }] }],
  unknowns: ['결제는 확인하지 못했어요.'],
});

describe('overview workflow with fake stages', () => {
  it('runs Codex picking, Gemini writing and Codex checking, rechecking the files before each stage', async () => {
    const snapshot = material(files);
    const f = fake(snapshot, written);
    const result = await f.finish();
    if (result.kind !== 'overview-completed') throw new Error(`expected an overview, got ${result.kind}`);
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([
      ['organizing', 'codex'], ['explaining', 'antigravity'], ['reviewing', 'codex']]);
    expect(f.events.filter(event => event.kind === 'progress').map(event => event.phase)).toEqual([
      'collecting', 'organizing', 'reading-related', 'explaining', 'reviewing', 'validating']);
    // Before each of the three stages and once more before the result.
    expect(f.revalidate).toHaveBeenCalledTimes(4);
    expect(f.assertReady).toHaveBeenCalledWith('local-worker');
    expect(result.result).toMatchObject({ review: 'AI 검토됨', overview: written(snapshot) });
    expect(result.result.sources.map(source => source.relativePath)).toEqual(['README.md', 'order.ts', 'stock.ts']);
    const sent = JSON.parse(f.run.mock.calls[0][0].prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
    expect(sent.purpose).toBe('프로젝트 개요');
    expect(f.run.mock.calls[1][0].prompt).toContain('코드에 없는 기능·구성은 만들지 않고');
    for (const [input] of f.run.mock.calls.filter(([input]) => input.provider === 'codex')) expect(JSON.stringify(input.schema)).not.toContain('"oneOf"');
  });

  it('writes nothing and claims no check when no file was read', async () => {
    const f = fake(material({}), () => { throw new Error('must not be asked'); });
    const result = await f.finish();
    if (result.kind !== 'overview-completed') throw new Error(`expected an overview, got ${result.kind}`);
    expect(f.run.mock.calls.map(([input]) => input.stage)).toEqual(['organizing']);
    expect(result.result.review).toBe('개요 작성 안 함');
    expect(result.result.overview).toEqual({ intro: null, features: [], roles: [], unknowns: [] });
    expect(result.result.limitations).toContain('개요를 만들 코드·문서를 하나도 읽지 못해 개요를 쓰지 않았어요. 다른 시작 파일을 골라 다시 만들어 주세요.');
  });

  it('stops before the next model when a file changes between stages', async () => {
    const f = fake(material(files), written);
    f.revalidate.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new AppError('CHANGED', '바뀜'); });
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run.mock.calls.map(([input]) => input.stage)).toEqual(['organizing']);
  });

  it.each([
    ['intro', (answer: ProjectOverviewAnswer) => ({ ...answer, intro: { text: '소개', evidenceIds: [randomUUID()] } })],
    ['feature start', (answer: ProjectOverviewAnswer) => ({ ...answer, features: [{ ...answer.features[0], start: { evidenceId: randomUUID(), functionName: null } }] })],
    ['role function', (answer: ProjectOverviewAnswer) => ({ ...answer, roles: [{ ...answer.roles[0], functions: [{ name: 'stock', evidenceId: randomUUID() }] }] })],
  ])('refuses evidence not given this time in the %s', async (_where, change) => {
    const f = fake(material(files), snapshot => change(written(snapshot)));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.run.mock.calls.map(([input]) => input.stage)).toEqual(['organizing', 'explaining']);
  });

  it.each([{ accepted: false, issues: [] }, { accepted: true, issues: ['남은 문제'] }])('shows nothing when the check leaves a problem %j', async verdict => {
    const snapshot = material(files);
    const f = fake(snapshot, written);
    f.run.mockImplementation(async ({ stage }) => ({ reportedModel: null, value: stage === 'organizing' ? { focus: 'x', requestedFileIds: [] }
      : stage === 'explaining' ? written(snapshot) : { ...verdict, overview: written(snapshot) } }));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
  });

  it('drops function names not written as a whole name in the file they were given for, and says so', async () => {
    const snapshot = material(files);
    const f = fake(snapshot, current => {
      const answer = written(current);
      answer.features.push({ ...answer.features[0], name: '부분 이름', start: { evidenceId: idOf(current, 'order.ts'), functionName: 'Order' } });
      answer.roles[0].functions.push({ name: 'placeOrder', evidenceId: idOf(current, 'stock.ts') }, { name: 'stock()', evidenceId: idOf(current, 'stock.ts') });
      return answer;
    });
    const result = await f.finish();
    if (result.kind !== 'overview-completed') throw new Error(`expected an overview, got ${result.kind}`);
    expect(result.result.overview.features.map(feature => feature.start.functionName)).toEqual(['placeOrder', null]);
    expect(result.result.overview.roles[0].functions.map(item => item.name)).toEqual(['stock', '$reserve']);
    expect(result.result.limitations).toEqual(expect.arrayContaining([
      '앱 확인: AI가 적은 함수 이름 ‘Order’은 order.ts에서 찾지 못해 뺐어요.',
      '앱 확인: AI가 적은 함수 이름 ‘placeOrder’은 stock.ts에서 찾지 못해 뺐어요.',
      '앱 확인: AI가 적은 함수 이름 ‘stock()’은 stock.ts에서 찾지 못해 뺐어요.']));
  });

  it('sends masked copies of secret-looking values', async () => {
    const snapshot = material({ 'config.ts': 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\n' });
    const f = fake(snapshot, () => ({ intro: null, features: [], roles: [], unknowns: [] }));
    const result = await f.finish();
    for (const [input] of f.run.mock.calls) {
      expect(input.prompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
      expect(input.prompt).toContain(SECRET_MASK);
    }
    if (result.kind !== 'overview-completed') throw new Error(`expected an overview, got ${result.kind}`);
    expect(result.result.limitations.some(item => item.startsWith('config.ts: 비밀값처럼 보이는'))).toBe(true);
  });

  it.each([{ mode: 'codex' }, { consent: false }, { startFileId: '../outside.ts' }, { path: '/etc/passwd' }, { prompt: 'bypass' }])(
    'refuses renderer input %j before anything runs', extra => {
      const f = fake(material(files), written);
      expect(() => f.workflow.startOverview({ ...f.request, ...extra } as OverviewRequest)).toThrow();
      expect(f.assertReady).not.toHaveBeenCalled();
      expect(f.captureOverview).not.toHaveBeenCalled();
    });

  it('shares the one active AI job with questions and can be cancelled', async () => {
    const f = fake(material(files), written);
    let release = () => {};
    f.run.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      release = () => reject(new AppError('CANCELLED', '취소'));
      signal.addEventListener('abort', () => release());
    }));
    const { jobId } = f.workflow.startOverview(f.request);
    expect(() => f.workflow.startOverview(f.request)).toThrow('이미 AI 작업이 진행 중입니다.');
    expect(() => f.workflow.start({ projectId: f.request.projectId, evidenceId: randomUUID(), expectedFileHash: 'a'.repeat(64),
      question: '질문', mode: 'local-worker', consent: true })).toThrow('이미 AI 작업이 진행 중입니다.');
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    await f.workflow.cancel(jobId);
    expect(f.events.find(event => event.jobId === jobId && event.kind === 'failed')).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(f.events.some(event => event.kind === 'overview-completed')).toBe(false);
  });
});

describe('overview with the real app reads and fake stages', () => {
  it('reads the files Codex picks, once, and keeps only names written in them', async () => {
    const f = await project(files);
    const events: LearningEvent[] = [];
    const run = async (request: StageRequest): Promise<StageResponse> => {
      const sent = JSON.parse(request.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
      if (request.stage === 'organizing') {
        return { reportedModel: null, value: { focus: '주문', requestedFileIds: sent.availableFiles
          .filter((file: { relativePath: string }) => file.relativePath !== 'README.md').map((file: { id: string }) => file.id) } };
      }
      const id = (name: string) => sent.files.find((file: { relativePath: string }) => file.relativePath === name).evidence.id;
      const answer: ProjectOverviewAnswer = { intro: { text: '주문 앱', evidenceIds: [id('README.md')] },
        features: [{ name: '주문하기', summary: '재고 비교', evidenceIds: [id('order.ts')], start: { evidenceId: id('order.ts'), functionName: 'placeOrder' } }],
        roles: [{ name: '재고', summary: '남은 수', evidenceIds: [id('stock.ts')], functions: [{ name: 'missing', evidenceId: id('stock.ts') }] }], unknowns: [] };
      return { reportedModel: null, value: request.stage === 'explaining' ? answer : { accepted: true, issues: [], overview: answer } };
    };
    const workflow = new LocalWorkerWorkflow({ captureFeatureGuide: async () => { throw new Error('not a feature guide test'); }, revalidateFeatureGuide: async () => { throw new Error('not a feature guide test'); }, assertReady: () => {}, run, emit: event => events.push(event),
      capture: async () => { throw new Error('not a question test'); },
      captureOverview: (request, signal) => f.context.captureOverview(request.startFileId, 1, signal),
      captureFile: (request, signal) => f.context.captureFile(request, 1, signal),
      expand: (snapshot, ids, signal) => f.context.expand(snapshot, ids, signal),
      revalidate: (snapshot, signal) => f.context.revalidate(snapshot, signal) });
    const { jobId } = workflow.startOverview({ projectId: f.project.id, startFileId: f.id('README.md'), mode: 'local-worker', consent: true });
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    const result = events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
    if (result.kind !== 'overview-completed') throw new Error(`expected an overview, got ${JSON.stringify(result)}`);
    expect(result.result.sources.map(source => source.relativePath)).toEqual(['README.md', 'order.ts', 'stock.ts']);
    for (const source of result.result.sources) expect(f.context.lookup(source.evidence.id)).toEqual(source.evidence);
    expect(result.result.overview.features[0].start.functionName).toBe('placeOrder');
    expect(result.result.overview.roles[0].functions).toEqual([]);
    expect(result.result.limitations).toContain('관련 파일 탐색은 한 번, 최대 4개입니다. 제공되지 않은 파일의 동작은 확인하지 않았습니다.');
  });
});

it('keeps question-only writing rules out of this task', async () => {
  const f = fake(material(files), written);
  expect((await f.finish()).kind).toBe('overview-completed');
  expect(f.run.mock.calls.length).toBeGreaterThan(0);
  for (const [input] of f.run.mock.calls) {
    expect(input.prompt).not.toContain('설명 글은 12살도 읽을 수 있게');
    expect(input.prompt).not.toContain('summary는 3~5개의 짧은 문장');
    expect(input.prompt).not.toContain('terms에 term은 코드에 적힌 이름');
    expect(input.prompt).not.toContain('자세한 조건·순서·실패하는 경우는 steps에 적는다.');
    expect(input.prompt).not.toContain('examples에는');
    expect(input.prompt).not.toContain('given에는');
    expect(input.prompt).not.toContain('result에는');
    expect(input.prompt).not.toContain('examples도 같은 코드와 대조한다.');
  }
});
