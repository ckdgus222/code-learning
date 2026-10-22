import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { featureGuideMaterial, MAX_FEATURE_GUIDE_BYTES, type FeatureGuideSnapshot } from '../src/core/ai/feature-guide';
import { LocalWorkerWorkflow, type StageRequest, type StageResponse } from '../src/core/ai/workflow';
import { SECRET_MASK } from '../src/core/ai/secrets';
import { GEMINI_MODEL, featureGuideSchema, type FeatureGuide, type FeatureGuideRequest, type LearningEvent } from '../src/shared/ai';
import type { ProjectRoutes, ProjectView } from '../src/shared/contracts';
import { AppError } from '../src/shared/errors';
import { featureGroups } from '../src/renderer/feature-flow';

function fixture(count = 3) {
  const project: ProjectView = { id: randomUUID(), name: '반려견', files: [
    { id: 'api', relativePath: 'api/dogs.controller.ts', size: 1 },
    { id: 'web', relativePath: 'web/dogs.ts', size: 1 },
    { id: 'config', relativePath: 'web/next.config.ts', size: 1 },
    { id: 'screen', relativePath: 'web/app/dogs/page.tsx', size: 1 },
  ], excluded: {}, warnings: [], overview: { intro: { text: 'NEVER_SEND_README', fileId: 'readme', title: null, relativePath: 'README.md', startLine: 1, endLine: 1 },
    candidates: [], checkedFiles: 0, limited: false, notes: [] } };
  const site = { fileId: 'api', fileHash: 'h', startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1, text: 'NEVER_SEND_CODE' };
  const routes: ProjectRoutes = { projectId: project.id, routesId: randomUUID(), routes: Array.from({ length: count }, (_, index) => ({
    method: 'GET', path: `/dogs/${index}`, prefix: 'known', framework: 'nest', handler: { ...site, name: `Dogs.get${index}` }, basis: { text: 'NEVER_SEND_CODE', range: site },
  })), requests: [{ ...site, fileId: 'web', path: '/dogs/1', host: null, prefix: 'known', methods: ['GET'], args: [{ text: 'NEVER_SEND_CODE', spread: false }], inTest: false,
    inFunction: { name: 'getDog', startUtf16: 0, endUtf16: 10, startLine: 1 } }],
    links: [{ requestIndex: 0, routeIndex: 1, sure: true, reasons: ['NEVER_SEND_REASON'] }], prefix: null, limited: false, notes: ['NEVER_SEND_NOTE'] };
  return { project, routes };
}
const answer = (): FeatureGuide => ({ summary: '반려견을 살펴보는 프로젝트예요.', groups: [{ name: '반려견', about: '반려견 기능',
  features: [{ name: '반려견 조회', about: '반려견을 찾아요.', routes: [0, 1] }] }], unknowns: [] });
function workflowFixture(count = 3) {
  const f = fixture(count);
  const built = featureGuideMaterial(f.project, f.routes);
  const snapshot: FeatureGuideSnapshot = { projectId: f.project.id, routesId: f.routes.routesId, revision: 1, ...built };
  const request: FeatureGuideRequest = { projectId: f.project.id, routesId: f.routes.routesId, mode: 'local-worker', consent: true };
  const events: LearningEvent[] = [];
  const captureFeatureGuide = vi.fn(async () => snapshot);
  const revalidate = vi.fn(async () => {});
  const assertReady = vi.fn();
  const run = vi.fn(async (input: StageRequest): Promise<StageResponse> => ({ reportedModel: input.provider === 'antigravity' ? GEMINI_MODEL : 'test-codex',
    value: input.stage === 'explaining' ? answer() : { accepted: true, issues: [], guide: answer() } }));
  const workflow = new LocalWorkerWorkflow({ assertReady, captureFeatureGuide, revalidateFeatureGuide: revalidate, revalidate: vi.fn(async () => {}), run, emit: event => events.push(event),
    capture: async () => { throw new Error('not a question'); }, captureOverview: async () => { throw new Error('not an overview'); },
    captureFile: async () => { throw new Error('not a file explanation'); }, expand: async () => { throw new Error('no source reads'); } });
  async function finish(input = request) {
    const { jobId } = workflow.startFeatureGuide(input);
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  }
  return { ...f, snapshot, request, events, captureFeatureGuide, revalidate, assertReady, run, workflow, finish };
}

describe('feature guide material', () => {
  it('includes only explicit metadata, Next screens and numbered links without source or README', () => {
    const f = fixture();
    const { material } = featureGuideMaterial(f.project, f.routes);
    expect(Object.keys(material)).toEqual(['projectName', 'routes', 'requests', 'screens']);
    expect(material.routes[0]).toEqual({ index: 0, method: 'GET', path: '/dogs/0', handler: 'Dogs.get0', file: 'api/dogs.controller.ts' });
    expect(material.requests[0]).toEqual({ index: 0, path: '/dogs/1', methods: ['GET'], inFunction: 'getDog', file: 'web/dogs.ts', links: [{ routeIndex: 1, sure: true }] });
    expect(material.screens).toEqual([{ file: 'web/app/dogs/page.tsx', path: '/dogs' }]);
    expect(JSON.stringify(material)).not.toContain('NEVER_SEND');
  });
  it('masks names and paths before capping lengths and bounds the entire JSON to 32 KiB', () => {
    const f = fixture(500);
    const secret = 'ghp_' + 'x'.repeat(36);
    f.project.name = secret + '한'.repeat(400);
    f.project.files[0].relativePath = secret + '/한'.repeat(400);
    f.routes.routes.forEach(route => { route.path = '/' + secret + '가'.repeat(400); route.handler.name = secret + '나'.repeat(400); });
    const { material, limitations } = featureGuideMaterial(f.project, f.routes);
    const serialized = JSON.stringify(material);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_FEATURE_GUIDE_BYTES);
    expect(serialized).not.toContain(secret); expect(serialized).toContain(SECRET_MASK);
    expect(material.projectName.length).toBeLessThanOrEqual(200);
    expect(material.routes.every(route => route.handler.length <= 200 && route.file.length <= 300 && route.path!.length <= 300)).toBe(true);
    expect(material.routes.length).toBeLessThan(500); expect(material.routes.length).toBeGreaterThan(0);
    expect(material.routes.map(route => route.index)).toEqual(Array.from({ length: material.routes.length }, (_, i) => i));
    expect(limitations.join(' ')).toContain('일부만 보냄'); expect(limitations.join(' ')).toContain('비밀값');
  });
  it('keeps unmentioned routes at the end and chooses most sure links then index', () => {
    const f = fixture(4);
    const guide = answer(); guide.groups[0].features[0].routes = [2, 0, 1];
    const groups = featureGroups(f.project, f.routes, guide);
    expect(groups[0].features[0].routes).toEqual([1, 0, 2]);
    expect(groups[1]).toMatchObject({ name: '정리되지 않은 기능', features: [{ routes: [3], ai: false }] });
    expect(featureGroups(f.project, f.routes)[0].name).toBe('dogs');
    expect(featureGroups(f.project, f.routes, { ...guide, groups: [] })[0].features).toHaveLength(4);
  });
});

describe('feature guide workflow', () => {
  it('runs Gemini then Codex with identical metadata and validates before each stage and display', async () => {
    const f = workflowFixture();
    expect(await f.finish()).toMatchObject({ kind: 'feature-guide-completed', result: { routesId: f.request.routesId, mode: 'local-worker', review: 'AI 검토됨',
      models: [{ requestedModel: GEMINI_MODEL, reportedModel: GEMINI_MODEL }, { reportedModel: 'test-codex' }] } });
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([['explaining', 'antigravity'], ['reviewing', 'codex']]);
    const sent = f.run.mock.calls.map(([input]) => JSON.parse(input.prompt.split('자료:\n')[1].split('\n과제:\n')[0]));
    expect(sent[0]).toEqual(sent[1]); expect(JSON.stringify(sent)).not.toContain('NEVER_SEND');
    expect(f.revalidate).toHaveBeenCalledTimes(3);
  });
  it.each(['codex', 'antigravity'] as const)('%s runs once without review', async mode => {
    const f = workflowFixture();
    expect(await f.finish({ ...f.request, mode })).toMatchObject({ kind: 'feature-guide-completed', result: { mode, review: 'AI 대조 없음' } });
    expect(f.run.mock.calls.map(([input]) => input.provider)).toEqual([mode]);
  });
  it.each([{ consent: false }, { consent: undefined }, { routes: [] }, { prompt: 'override' }, { routesId: 'invalid' }])('rejects invalid request %j before capture or execution', extra => {
    const f = workflowFixture();
    expect(() => f.workflow.startFeatureGuide({ ...f.request, ...extra } as FeatureGuideRequest)).toThrow();
    expect(f.captureFeatureGuide).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['draft', 'review'] as const)('rejects invalid %s route references including numbers cut from the payload', async stage => {
    for (const invalid of [[-1], [0.5], [9999], [0, 0], [], [499], [1]]) {
      const f = workflowFixture(500);
      const normal = f.run.getMockImplementation()!;
      f.run.mockImplementation(async input => {
        if ((input.stage === 'reviewing') !== (stage === 'review')) return normal(input);
        const guide = answer();
        guide.groups[0].features[0].routes = invalid;
        // [1] is duplicated across features rather than within the same feature.
        if (invalid.length === 1 && invalid[0] === 1) guide.groups[0].features.push({ name: '다른 기능', about: '중복', routes: [1] });
        return { reportedModel: null, value: stage === 'draft' ? guide : { accepted: true, issues: [], guide } };
      });
      expect(f.snapshot.material.routes.some(route => route.index === 499)).toBe(false);
      expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
      expect(f.run).toHaveBeenCalledTimes(stage === 'draft' ? 1 : 2);
    }
  });
  it.each([0, 1, 2])('rejects a change at validation %s without sending the next stage or displaying a result', async index => {
    const f = workflowFixture();
    f.revalidate.mockImplementation(async () => { if (f.revalidate.mock.calls.length === index + 1) throw new AppError('CHANGED', 'changed'); });
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).toHaveBeenCalledTimes(index);
  });
  it('rejects a different captured routes ID and unresolved review issues', async () => {
    const changed = workflowFixture(); changed.snapshot.routesId = randomUUID();
    expect(await changed.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } }); expect(changed.run).not.toHaveBeenCalled();
    const rejected = workflowFixture(); rejected.run.mockResolvedValueOnce({ value: answer(), reportedModel: null })
      .mockResolvedValueOnce({ value: { accepted: true, issues: ['모순'], guide: answer() }, reportedModel: null });
    expect(await rejected.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
  });
  it.each(['cancel', 'new-routes', 'close'] as const)('discards late success after %s and prevents overlapping AI jobs', async reason => {
    const f = workflowFixture();
    let release!: (response: StageResponse) => void;
    f.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { jobId } = f.workflow.startFeatureGuide(f.request);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    expect(() => f.workflow.startOverview({ projectId: f.project.id, startFileId: null, mode: 'local-worker', consent: true })).toThrow('이미 AI 작업');
    const cancelled = reason === 'cancel' ? f.workflow.cancel(jobId) : reason === 'close' ? f.workflow.close() : f.workflow.cancelFeatureGuide(f.project.id);
    expect(f.run.mock.calls[0][0].signal.aborted).toBe(true);
    release({ value: answer(), reportedModel: null }); await cancelled;
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ kind: 'failed', error: { code: 'CANCELLED' } }));
    expect(f.events.some(event => event.kind === 'feature-guide-completed')).toBe(false);
    expect((await f.finish()).kind).toBe('feature-guide-completed');
  });
  it('enforces field and collection bounds with strict nested objects', () => {
    expect(featureGuideSchema.safeParse(answer()).success).toBe(true);
    for (const change of [{ summary: 'x'.repeat(601) }, { groups: Array(21).fill(answer().groups[0]) }, { unknowns: Array(11).fill('모름') }, { source: 'no' }]) {
      expect(featureGuideSchema.safeParse({ ...answer(), ...change }).success).toBe(false);
    }
    for (const change of [{ name: 'x'.repeat(41) }, { about: 'x'.repeat(201) }, { features: Array(41).fill(answer().groups[0].features[0]) }]) {
      expect(featureGuideSchema.safeParse({ ...answer(), groups: [{ ...answer().groups[0], ...change }] }).success).toBe(false);
    }
    for (const change of [{ name: 'x'.repeat(61) }, { about: 'x'.repeat(201) }, { routes: Array(21).fill(0) }, { extra: true }]) {
      const guide = answer(); Object.assign(guide.groups[0].features[0], change);
      expect(featureGuideSchema.safeParse(guide).success).toBe(false);
    }
  });
});

describe('names sent to the AI', () => {
  it('replaces computed names, whose expression is code, after the real analyzer', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const { scanProject } = await import('../src/core/project/files');
    const { findProjectRoutes } = await import('../src/core/analysis/routes');
    const root = await mkdtemp('/private/tmp/learning-guide-names-');
    try {
      await writeFile(path.join(root, 'controller.ts'), "@Controller('dogs') export class DogsController { @Get('x') ['a' + 'CODE_IN_NAME_ROUTE']() {} @Get('y') plain() {} }");
      await writeFile(path.join(root, 'client.ts'), "export const api = { ['k' + 'CODE_IN_NAME_REQUEST']() { return fetch('/dogs/x'); }, load() { return fetch('/dogs/y'); } };");
      const project = await scanProject(root, randomUUID());
      const routes = await findProjectRoutes(root, project.id, project.files);
      const view = { ...project, overview: { intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
      const sent = JSON.stringify(featureGuideMaterial(view, routes).material);
      expect(sent).not.toContain('CODE_IN_NAME');
      expect(sent).toContain('이름 미확인');
      expect(sent).toContain('DogsController.plain');
      expect(sent).toContain('load');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
