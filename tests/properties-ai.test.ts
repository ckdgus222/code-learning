import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAiContext } from '../src/core/ai/context';
import { LearningWorkflow, type ContextSnapshot, type EvidenceSnapshot, type StageRequest, type StageResponse, type WorkflowDependencies } from '../src/core/ai/workflow';
import { capturePlanCompare, revalidatePlanCompare, type PickedPlan } from '../src/core/ai/plan-compare';
import { planSections } from '../src/core/analysis/plan-sections';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { readAllowed, readStable, scanProject } from '../src/core/project/files';
import { SECRET_MASK } from '../src/core/ai/secrets';
import type { LearningEvent } from '../src/shared/ai';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config = 'password firstHidden secondHidden\r\npass\\u0077ord=unicodeHidden\napi_key=continuedHidden\\\r\n nextHidden\nnormal=keep\n';
const hidden = ['firstHidden', 'secondHidden', 'unicodeHidden', 'continuedHidden', 'nextHidden'];
const newlines = (text: string) => text.match(/\r\n|\r|\n/g) ?? [];
async function fixture(code = config) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'properties-ai-')));
  roots.push(base);
  const root = path.join(base, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'application.properties'), code);
  const project = await scanProject(root, randomUUID());
  const file = project.files.find(file => file.relativePath === 'application.properties')!;
  expect(file).toBeDefined();
  const context = new ProjectAiContext(root, project);
  const signal = new AbortController().signal;
  const snapshot = await context.captureOverview(file.id, 1, signal);
  expect(snapshot.files[0].code).toBe(code);
  const question: EvidenceSnapshot = { ...snapshot, evidence: snapshot.files[0].evidence, code, relativePath: file.relativePath };
  const planText = '# 설정\n애플리케이션 설정을 파일에서 읽는다.\n';
  const planPath = path.join(base, 'plan.md');
  await writeFile(planPath, planText);
  const document: PickedPlan = { documentId: randomUUID(), name: 'plan.md', path: planPath,
    hash: (await readStable(base, 'plan.md')).hash, bytes: Buffer.byteLength(planText), ...planSections(planText) };
  const selection = { documentId: document.documentId, startLine: 1, endLine: document.lines };
  const source = { projectId: project.id, root, context, map: () => buildProjectMap(root, project.id, project.files, []),
    restoreMap: () => buildProjectMap(root, project.id, project.files, []), cancelMap() {} };
  return { root, project, file, context, signal, snapshot, question, code, document, selection, source };
}
function worker(f: Awaited<ReturnType<typeof fixture>>, kind: 'overview' | 'plan' | 'question') {
  const events: LearningEvent[] = [];
  const run = vi.fn(async (input: StageRequest): Promise<StageResponse> => {
    const overview = { intro: null, features: [], roles: [], unknowns: [] };
    const compare = { items: [], unrequested: [], designMismatches: [], unknowns: [] };
    const explanation = { summary: '설정 파일을 설명합니다.', steps: [], claims: [{ kind: 'code', text: '설정 항목이 적혀 있습니다.', evidenceIds: [f.question.evidence.id] }], terms: [], examples: [], unknowns: [] };
    return { reportedModel: 'fake-test-model', value: input.stage === 'organizing' ? { focus: '설정 확인', requestedFileIds: kind === 'plan' ? [f.file.id] : [] }
      : kind === 'plan' ? compare : kind === 'overview' ? overview : explanation };
  });
  const revalidate = vi.fn(async (snapshot: ContextSnapshot, signal: AbortSignal) => f.context.revalidate(snapshot, signal));
  const deps: WorkflowDependencies = {
    assertReady() {}, run, emit: event => events.push(event),
    capture: async () => f.question,
    captureOverview: async () => f.snapshot,
    capturePlanCompare: (_request, signal) => capturePlanCompare(f.source, f.document, f.selection, 1, signal),
    revalidatePlanCompare: (snapshot, signal, final) => revalidatePlanCompare(f.source, snapshot, signal, final),
    captureFeatureGuide: async () => { throw new Error('not a feature-guide test'); },
    revalidateFeatureGuide: async () => { throw new Error('not a feature-guide test'); },
    captureFile: async () => { throw new Error('not a file explanation test'); },
    expand: (snapshot, ids, signal) => f.context.expand(snapshot, ids, signal), revalidate,
  };
  const workflow = new LearningWorkflow(deps);
  async function finish() {
    const request = { projectId: f.project.id, mode: 'codex' as const, consent: true as const };
    const { jobId } = kind === 'overview' ? workflow.startOverview({ ...request, startFileId: f.file.id })
      : kind === 'plan' ? workflow.startPlanCompare({ ...request, selection: f.selection })
      : workflow.start({ ...request, evidenceId: f.question.evidence.id, expectedFileHash: f.question.evidence.fileHash, question: '이 파일은 어떤 설정인가요?' });
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  }
  return { run, finish, revalidate };
}
function material(input: StageRequest) {
  return JSON.parse(input.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
}
function assertMasked(run: ReturnType<typeof worker>['run'], original: string, secrets = hidden) {
  const sentCodes: string[] = [];
  for (const [input] of run.mock.calls) {
    for (const secret of secrets) expect(input.prompt).not.toContain(secret);
    const data = material(input);
    const codes = [...(typeof data.code === 'string' ? [data.code] : []), ...(data.files ?? []).map((file: { code: string }) => file.code)];
    for (const code of codes) {
      expect(code).toContain(SECRET_MASK);
      expect(newlines(code)).toEqual(newlines(original));
      expect(code).toContain('normal=keep');
      sentCodes.push(code);
    }
  }
  expect(sentCodes.length).toBeGreaterThan(0);
}

describe('properties AI transmission using only fake model stages', () => {
  it.each([
    ['whitespace values', 'password firstHidden secondHidden\nnormal=keep\n', ['firstHidden', 'secondHidden']],
    ['escaped key', 'pass\\u0077ord=unicodeHidden\nnormal=keep\n', ['unicodeHidden']],
    ['continued value', 'api_key=continuedHidden\\\r\n nextHidden\nnormal=keep\n', ['continuedHidden', 'nextHidden']],
  ] as const)('masks overview code with %s', async (_, source, secrets) => {
    const f = await fixture(source);
    const w = worker(f, 'overview');
    const result = await w.finish();
    expect(result.kind).toBe('overview-completed');
    assertMasked(w.run, source, [...secrets]);
    expect(f.snapshot.files[0].code).toBe(source);
    expect(w.revalidate).toHaveBeenCalled();
  });
  it('masks plan comparison files after the organizing stage selects the real property file', async () => {
    const f = await fixture();
    const w = worker(f, 'plan');
    const result = await w.finish();
    expect(result.kind).toBe('plan-compare-completed');
    assertMasked(w.run, config);
    expect(w.run.mock.calls.map(([input]) => input.stage)).toEqual(['organizing', 'explaining']);
    expect(JSON.stringify(result)).toContain('application.properties: 비밀값처럼 보이는 3곳');
    expect((await readAllowed(f.root, f.file.relativePath)).text).toBe(config);
  });
  it('masks a full-file question once per file while retaining original revalidation data', async () => {
    const f = await fixture();
    const w = worker(f, 'question');
    const result = await w.finish();
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'completed' });
    assertMasked(w.run, config);
    expect(JSON.stringify(result).match(/application\.properties: 비밀값처럼 보이는 3곳/g)).toHaveLength(1);
    expect(f.question.code).toBe(config);
    expect(f.question.files[0].code).toBe(config);
    await f.context.revalidate(f.question, f.signal);
  });
  it.each(['partial-range', 'different-code', 'missing-whole-file'] as const)('blocks a question with %s before any model request', async shape => {
    const f = await fixture();
    if (shape === 'partial-range') {
      f.question.evidence = { ...f.question.evidence, startUtf16: config.indexOf('firstHidden') };
      f.question.code = config.slice(f.question.evidence.startUtf16);
    } else if (shape === 'different-code') f.question.code = 'password=replacement\n';
    else f.question.files = [];
    const w = worker(f, 'question');
    // Changed selected code is rejected by disk revalidation before the properties selection guard.
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: shape === 'different-code' ? 'CHANGED' : 'NOT_ALLOWED' } });
    expect(w.run).not.toHaveBeenCalled();
  });
  it.each(['overview', 'plan'] as const)('blocks malformed Unicode before sending property contents in %s', async kind => {
    const secret = 'NEVER_SEND_MALFORMED_SECRET';
    const f = await fixture('name=' + secret + '\\u00G0\n');
    const w = worker(f, kind);
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'NOT_ALLOWED' } });
    expect(w.run.mock.calls.length).toBe(kind === 'plan' ? 1 : 0);
    for (const [input] of w.run.mock.calls) expect(input.prompt).not.toContain(secret);
  });
  it.each(['overview', 'plan'] as const)('blocks an escaped PEM marker before sending its body in %s', async kind => {
    const secret = 'NEVER_SEND_ENCODED_PEM_BODY';
    const f = await fixture('-----BEGIN\\u0020PRIVATE KEY-----\n' + secret + '\n-----END PRIVATE KEY-----\n');
    const w = worker(f, kind);
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'NOT_ALLOWED' } });
    expect(w.run.mock.calls.length).toBe(kind === 'plan' ? 1 : 0);
    for (const [input] of w.run.mock.calls) expect(input.prompt).not.toContain(secret);
  });
  it('detects changed source hashes after a successful read without replacing originals with masked text', async () => {
    const f = await fixture();
    await f.context.revalidate(f.snapshot, f.signal);
    await writeFile(path.join(f.root, f.file.relativePath), config + 'normal.changed=true\n');
    await expect(f.context.revalidate(f.snapshot, f.signal)).rejects.toMatchObject({ code: 'CHANGED' });
    expect(f.snapshot.files[0].code).toBe(config);
  });
});
