import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPlanCompare, planCompareResultSchema, planCompareSchema, type PlanCompareResult, type PlanCompareAnswer, type PlanCompareRequest, type PlanSelection } from '../src/shared/plan-compare';
import { planSections } from '../src/core/analysis/plan-sections';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { ProjectAiContext } from '../src/core/ai/context';
import { capturePlanCompare, checkPlanCompareBasis, planMapHash, restorePlanCompare, revalidatePlanCompare, waitForPlan, type PickedPlan } from '../src/core/ai/plan-compare';
import { LocalWorkerWorkflow, type StageRequest, type StageResponse, type WorkflowDependencies } from '../src/core/ai/workflow';
import { readStable, scanProject } from '../src/core/project/files';
import { AppError } from '../src/shared/errors';
import type { LearningEvent, LearningMode } from '../src/shared/ai';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(text = '# 장\n기획대로\n다름\n확인 못 함\n못 찾음\n설계', files = { 'main.ts': 'export const x = 1;' } as Record<string, string>) {
  const base = await mkdtemp('/private/tmp/plan-compare-');
  temporary.push(base);
  const root = path.join(base, 'project');
  await mkdir(root);
  for (const [name, code] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), code);
  }
  const filename = path.join(base, 'plan.md');
  await writeFile(filename, text);
  const document: PickedPlan = { documentId: randomUUID(), name: 'plan.md', path: filename,
    hash: (await readStable(base, 'plan.md')).hash, bytes: Buffer.byteLength(text), ...planSections(text) };
  const project = await scanProject(root, randomUUID());
  const context = new ProjectAiContext(root, project);
  const source = { projectId: project.id, root, context, map: vi.fn(() => buildProjectMap(root, project.id, project.files, [])), restoreMap: vi.fn(() => buildProjectMap(root, project.id, project.files, [])), cancelMap: vi.fn() };
  const signal = new AbortController().signal;
  const selection = { documentId: document.documentId, startLine: 1, endLine: document.lines };
  const capture = (chosen: PlanSelection = selection, cancellation = signal) => capturePlanCompare(source, document, chosen, 7, cancellation);
  const id = (name: string) => project.files.find(file => file.relativePath === name)!.id;
  return { base, root, document, project, context, source, signal, selection, capture, id };
}
const empty = (): PlanCompareAnswer => ({ items: [], unrequested: [], designMismatches: [], unknowns: [] });
const item = (file: string): PlanCompareAnswer['items'][number] => ({ title: '항목', plan: { startLine: 2, endLine: 3 },
  status: 'matches', files: [file], difference: null, missingEvidence: null, searched: null });

function workflow(f: Awaited<ReturnType<typeof fixture>>, answer: () => PlanCompareAnswer = empty, requested: string[] = [], mode: LearningMode = 'local-worker') {
  const events: LearningEvent[] = [];
  const run = vi.fn(async ({ stage }: StageRequest): Promise<StageResponse> => ({ reportedModel: null,
    value: stage === 'organizing' ? { focus: '대조', requestedFileIds: requested } : stage === 'reviewing' ? { accepted: true, issues: [], compare: answer() } : answer() }));
  const deps: WorkflowDependencies = {
    assertReady() {},
    capturePlanCompare: (_request, signal) => f.capture(f.selection, signal),
    revalidatePlanCompare: (snapshot, signal, final) => revalidatePlanCompare(f.source, snapshot, signal, final),
    capture: async () => { throw new Error('not a question test'); },
    captureOverview: async () => { throw new Error('not an overview test'); },
    captureFeatureGuide: async () => { throw new Error('not a guide test'); },
    revalidateFeatureGuide: async () => { throw new Error('not a guide test'); },
    captureFile: async () => { throw new Error('not a file test'); },
    expand: (snapshot, ids, signal) => f.context.expand(snapshot, ids, signal),
    revalidate: (snapshot, signal) => f.context.revalidate(snapshot, signal), run, emit: event => events.push(event),
  };
  const worker = new LocalWorkerWorkflow(deps);
  const request: PlanCompareRequest = { projectId: f.project.id, selection: f.selection, mode, consent: true };
  const terminal = async (jobId: string) => {
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  };
  const finish = async () => terminal(worker.startPlanCompare(request).jobId);
  return { worker, deps, run, events, request, finish, terminal };
}

describe('plan comparison references', () => {
  const file = randomUUID();
  const second = randomUUID();
  const ranges = [{ startLine: 2, endLine: 4 }, { startLine: 6, endLine: 8 }];
  const check = (answer: PlanCompareAnswer, read = [file]) => checkPlanCompare(answer, ranges, [file, second], read, [2]);
  it('accepts all four statuses, a candidate and a design mismatch with supplied references', () => {
    const answer = empty();
    answer.items = [item(file), { ...item(file), status: 'differs', difference: '조건이 다름' },
      { ...item(second), status: 'unverified', missingEvidence: '설정 파일' },
      { ...item(file), status: 'missing', files: [], searched: '전체 목록과 두 파일' }];
    answer.unrequested = [{ title: '후보', files: [second], note: '기획에서 못 찾음' }];
    answer.designMismatches = [{ plan: { startLine: 6, endLine: 8 }, edge: 2, note: '직접 연결' }];
    expect(() => check(planCompareSchema.parse(answer))).not.toThrow();
  });
  it.each([
    ['outside range', { plan: { startLine: 1, endLine: 3 } }],
    ['across ranges', { plan: { startLine: 3, endLine: 6 } }],
    ['reversed range', { plan: { startLine: 4, endLine: 2 } }],
    ['unknown file', { files: [randomUUID()] }],
    ['duplicate file', { files: [file, file] }],
    ['unread file', { files: [second] }],
    ['mixed read files', { files: [file, second] }],
    ['matches without files', { files: [] }],
    ['differs without difference', { status: 'differs' }],
    ['differs without files', { status: 'differs', files: [], difference: '다름' }],
    ['unverified without files', { status: 'unverified', files: [], missingEvidence: '설정' }],
    ['unverified without evidence', { status: 'unverified' }],
    ['missing with files', { status: 'missing', searched: '목록' }],
    ['missing without scope', { status: 'missing', files: [] }],
  ])('refuses %s', (_name, change) => {
    expect(() => check({ ...empty(), items: [{ ...item(file), ...change } as PlanCompareAnswer['items'][number]] })).toThrow(AppError);
  });
  it.each([
    { unrequested: [{ title: '후보', files: [randomUUID()], note: '설명' }] },
    { unrequested: [{ title: '후보', files: [file, file], note: '설명' }] },
    { designMismatches: [{ plan: { startLine: 2, endLine: 3 }, edge: 1, note: '연결' }] },
    { designMismatches: [{ plan: { startLine: 3, endLine: 6 }, edge: 2, note: '연결' }] },
  ])('refuses other invalid references %j', change => expect(() => check({ ...empty(), ...change })).toThrow(AppError));

});

describe('plan material and currentness', () => {
  it.each([
    ['unchanged', []],
    ['plan', ['기획 문서가 바뀌었어요. 문서를 다시 고른 뒤 대조해 주세요']],
    ['deleted plan', ['기획 문서를 다시 읽지 못했어요']],
    ['new file', ['폴더에 새 파일이 생겼거나 없어졌어요. 폴더를 다시 열어 주세요']],
    ['deleted file', ['폴더에 새 파일이 생겼거나 없어졌어요. 폴더를 다시 열어 주세요']],
    ['ignore', ['파일 목록이나 제외 규칙(.gitignore)이 바뀌었어요']],
  ])('checks %s without rebuilding the map', async (kind, reasons) => {
    const f = await fixture(undefined, { 'main.ts': 'export {};', '.gitignore': '# original' });
    const snapshot = await f.capture();
    f.source.map.mockClear();
    if (kind === 'plan') await writeFile(f.document.path, '# changed');
    if (kind === 'deleted plan') await rm(f.document.path);
    if (kind === 'new file') await writeFile(path.join(f.root, 'new.ts'), 'export {};');
    if (kind === 'deleted file') await rm(path.join(f.root, 'main.ts'));
    if (kind === 'ignore') await writeFile(path.join(f.root, '.gitignore'), '# same files, changed rule text');
    expect(await checkPlanCompareBasis(f.source, f.document.path, snapshot.basis)).toEqual(reasons);
    expect(f.source.map).not.toHaveBeenCalled();
  });
  it('propagates scope errors other than CHANGED', async () => {
    const f = await fixture();
    const snapshot = await f.capture();
    const error = new AppError('INTERNAL', 'scope failed');
    vi.spyOn(f.context, 'paths').mockImplementation(() => { throw error; });
    await expect(checkPlanCompareBasis(f.source, f.document.path, snapshot.basis)).rejects.toBe(error);
  });
  it('keeps CRLF and original Korean line positions, merges overlapping sections, and computes excluded ranges', async () => {
    const f = await fixture('머리\r\n# 첫 장\r\n본문\r\n## 하위 절\r\n내용\r\n# 다음 장\r\n끝');
    const snapshot = await f.capture({ documentId: f.document.documentId, sectionIds: ['s2', 's4'] });
    expect(snapshot.sent).toEqual([{ startLine: 2, endLine: 5 }]);
    expect(snapshot.plan).toEqual([{ startLine: 2, text: '# 첫 장\r\n본문\r\n## 하위 절\r\n내용\r\n' }]);
    expect(snapshot.excluded).toEqual([{ startLine: 1, endLine: 1 }, { startLine: 6, endLine: 7 }]);
    expect((await f.capture()).excluded).toEqual([]);
  });
  it('masks the whole document before selecting the middle of a multiline private key', async () => {
    const f = await fixture('앞\n-----BEGIN PRIVATE KEY-----\nfixture-only-body\nfixture-only-tail\n-----END PRIVATE KEY-----\n뒤');
    const snapshot = await f.capture({ documentId: f.document.documentId, startLine: 3, endLine: 4 });
    expect(snapshot.plan).toEqual([{ startLine: 3, text: '\n\n' }]);
    expect(snapshot.limitations.join()).toContain('기획 문서: 비밀값처럼 보이는 1곳');
  });
  it('bounds edges at 64 KiB and reports unresolved and limited map information', async () => {
    const f = await fixture(undefined, { 'main.ts': "import './other';\nimport './absent';", 'other.ts': 'export {};' });
    const map = await f.source.map();
    map.edges = Array.from({ length: 3000 }, () => map.edges[0]);
    map.limited = true; map.notes = ['분석 안내'];
    f.source.map.mockResolvedValue(map);
    const snapshot = await f.capture();
    expect(Buffer.byteLength(JSON.stringify(snapshot.edges.map(({ index, from, to, line }) => ({ index, from, to, line }))))).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.edges.length).toBeLessThan(map.edges.length);
    expect(snapshot.limitations).toEqual(expect.arrayContaining(['지도 크기 제한으로 연결 일부를 보내지 않았어요',
      '지도에서 잇지 못한 연결 1개는 설계 비교에서 판단하지 않았어요', '분석 안내', '지도 분석 한도로 프로젝트 일부만 확인했어요.']));
    expect(snapshot.basis.mapHash).toBe(planMapHash(map));
  });
  it('reads eight files within 80 KiB and skips the file taking the sum to 81 KiB', async () => {
    const files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}.ts`, 'x'.repeat((i < 8 ? 10 : 1) * 1024)]));
    const f = await fixture(undefined, files);
    const snapshot = await f.capture();
    await f.context.expand(snapshot, Object.keys(files).slice(0, 8).map(f.id), f.signal);
    expect(snapshot.files).toHaveLength(8);
    expect(snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.code), 0)).toBe(80 * 1024);
    const overflow = await fixture(undefined, { 'a.ts': 'a'.repeat(32 * 1024), 'b.ts': 'b'.repeat(32 * 1024),
      'c.ts': 'c'.repeat(16 * 1024), 'd.ts': 'd'.repeat(1024), 'large.ts': 'x'.repeat(32 * 1024 + 1) });
    const over = await overflow.capture();
    await overflow.context.expand(over, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'large.ts'].map(overflow.id), overflow.signal);
    expect(over.files).toHaveLength(3);
    expect(over.limitations.join()).toContain('d.ts: 비어 있거나 자료 크기 제한');
    expect(over.limitations.join()).toContain('large.ts: 비어 있거나 자료 크기 제한');
    await expect(f.context.expand(await f.capture(), Object.keys(files).map(f.id), f.signal)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    await expect(f.context.expand(await f.capture(), [f.id('f0.ts'), f.id('f0.ts')], f.signal)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    await expect(f.context.expand(await f.capture(), [randomUUID()], f.signal)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
  });
  it.each(['plan', 'new file', 'read code', 'ignore', 'nested ignore', 'unread import', 'alias'])('detects %s changes without a revision notification', async kind => {
    const f = await fixture(undefined, { 'main.ts': 'export const x = 1;', 'unread.ts': "import '@app/value';", 'other.ts': 'export {};',
      'sub/value.ts': 'export {};', '.gitignore': '# initial', 'sub/.gitignore': '# initial',
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/value': ['./main.ts'] } } }) });
    const snapshot = await f.capture();
    await f.context.expand(snapshot, [f.id('main.ts')], f.signal);
    if (kind === 'plan') await writeFile(f.document.path, 'changed');
    if (kind === 'new file') await writeFile(path.join(f.root, 'new.ts'), 'export {};');
    if (kind === 'read code') await writeFile(path.join(f.root, 'main.ts'), 'export const x = 2;');
    if (kind === 'ignore') await writeFile(path.join(f.root, '.gitignore'), '# comment changed, same paths');
    if (kind === 'nested ignore') await writeFile(path.join(f.root, 'sub/.gitignore'), '# changed');
    if (kind === 'unread import') await writeFile(path.join(f.root, 'unread.ts'), "import './other';");
    if (kind === 'alias') await writeFile(path.join(f.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@app/value': ['./other.ts'] } } }));
    await expect(revalidatePlanCompare(f.source, snapshot, f.signal, true)).rejects.toMatchObject({ code: 'CHANGED' });
  });
  it('refuses an already outdated file list on initial capture', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'added.ts'), 'export {};');
    await expect(f.capture()).rejects.toMatchObject({ code: 'CHANGED', message: '폴더에 새 파일이 생겼거나 제외 규칙이 바뀌었어요. 폴더를 다시 열어 주세요.' });
    expect(f.source.map).not.toHaveBeenCalled();
  });
  it('hashes structure independently of file IDs', async () => {
    const f = await fixture(undefined, { 'main.ts': "import './other';", 'other.ts': 'export {};' });
    const first = await f.source.map();
    const scanned = await scanProject(f.root, randomUUID());
    const next = await buildProjectMap(f.root, scanned.id, scanned.files, []);
    expect(planMapHash(first)).toBe(planMapHash(next));
  });
});

describe('plan workflow with fake AI only', () => {
  it.each(['local-worker', 'codex', 'antigravity'] as const)('clarifies connection items without structure-only instructions in %s prompts', async mode => {
    const f = await fixture();
    const w = workflow(f, empty, [], mode);
    expect(await w.finish()).toMatchObject({ kind: 'plan-compare-completed' });
    expect(w.run).toHaveBeenCalledTimes(mode === 'local-worker' ? 3 : 2);
    const connectionInstruction = '어느 파일이 어느 파일을 불러오는지에 관한 기획 문장도 items에 한 항목으로 적고, 보낸 edges 중 그 문장과 어긋나는 연결이 있으면 designMismatches에도 그 edge 번호로 적는다. ';
    for (const [request] of w.run.mock.calls) {
      expect(request.prompt).toContain(connectionInstruction);
      expect(request.prompt).not.toContain('코드를 읽지 않은 구조 비교');
      expect(request.prompt).not.toContain('unverified·missing만 쓰고');
      expect(request.prompt).not.toContain('structureOnly');
    }
  });
  it('returns masked plan text and import sites while sending exactly four edge fields to AI', async () => {
    const f = await fixture('# 기획\npassword: fixture-only-value', { 'main.ts': "import './other';", 'other.ts': 'export {};' });
    const map = await f.source.map();
    const w = workflow(f);
    const event = await w.finish();
    expect(event.kind).toBe('plan-compare-completed');
    if (event.kind !== 'plan-compare-completed') throw new Error('Missing result');
    expect(event.result.plan).toEqual([{ startLine: 1, text: '# 기획\npassword: [MASKED_SECRET]' }]);
    const { toFileId: _to, names: _names, ...site } = map.edges[0];
    expect(event.result.edges[0].site).toEqual(site);
    for (const [request] of w.run.mock.calls) {
      const material = JSON.parse(request.prompt.split('\n자료:\n')[1].split('\n과제:\n')[0]);
      expect(material.edges).toHaveLength(1);
      expect(Object.keys(material.edges[0])).toEqual(['index', 'from', 'to', 'line']);
      expect(material.plan).toEqual(event.result.plan);
      expect(request.prompt).not.toContain(site.fileHash);
      expect(request.prompt).not.toContain(site.text);
      expect(request.prompt).not.toContain('fixture-only-value');
    }
  });
  it('runs picking, writing and review, masks plan and code, and returns metadata without source text', async () => {
    const f = await fixture('# 기획\npassword: fixture-only-value', { 'main.ts': 'const password = "fixture-only-value";' });
    const w = workflow(f, () => ({ ...empty(), items: [{ ...item(f.id('main.ts')), plan: { startLine: 2, endLine: 2 } }] }), [f.id('main.ts')]);
    const result = await w.finish();
    expect(result.kind).toBe('plan-compare-completed');
    if (result.kind !== 'plan-compare-completed') return;
    expect(w.run.mock.calls.map(([request]) => [request.stage, request.provider])).toEqual([
      ['organizing', 'codex'], ['explaining', 'antigravity'], ['reviewing', 'codex']]);
    expect(result.result).toMatchObject({ structureOnly: false, review: 'AI 검토됨', document: { name: 'plan.md' } });
    expect(result.result.limitations.join()).toContain('main.ts: 비밀값처럼 보이는');
    expect(result.result.limitations.join()).toContain('기획 문서: 비밀값처럼 보이는');
    for (const [request] of w.run.mock.calls) {
      expect(request.prompt).not.toContain('fixture-only-value');
      expect(request.prompt).not.toContain(f.base);
      expect(request.prompt).toContain('[MASKED_SECRET]');
    }
    expect(JSON.stringify(result.result)).not.toContain(f.base);
    expect(Object.keys(result.result.document).sort()).toEqual(['documentId', 'name']);
    expect(result.result.read).toHaveLength(1);
    expect(f.source.map).toHaveBeenCalledTimes(2);
  });
  it.each(['local-worker', 'codex', 'antigravity'] as const)('masks token-shaped paths in the file list, edges and read files (%s)', async mode => {
    const token = `ghp_${'A'.repeat(36)}`;
    const f = await fixture(undefined, { [`${token}/store.ts`]: "import { n } from '../screen';\nexport const orders = [n];", 'screen.ts': `import { orders } from './${token}/store';\nexport const n = orders;` });
    const w = workflow(f, empty, [f.id(`${token}/store.ts`)], mode);
    const result = await w.finish();
    expect(result.kind).toBe('plan-compare-completed');
    if (result.kind !== 'plan-compare-completed') return;
    expect(result.result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'screen.ts', to: `${token}/store.ts` }),
      expect.objectContaining({ from: `${token}/store.ts`, to: 'screen.ts' })]));
    expect(w.run).toHaveBeenCalled();
    for (const [request] of w.run.mock.calls) {
      expect(request.prompt).not.toContain(token);
      expect(request.prompt).toContain('[MASKED_SECRET]/store.ts');
    }
  });
  it.each(['codex', 'antigravity'] as const)('runs %s picking and comparison with the same AI and no review', async mode => {
    const f = await fixture();
    const fileId = f.id('main.ts');
    const w = workflow(f, () => ({ ...empty(), items: [item(fileId)] }), [fileId], mode);
    const result = await w.finish();
    expect(result).toMatchObject({ kind: 'plan-compare-completed', result: {
      structureOnly: false, review: 'AI 대조 없음', read: [{ fileId, relativePath: 'main.ts' }],
    } });
    expect(w.run.mock.calls.map(([request]) => [request.stage, request.provider])).toEqual([
      ['organizing', mode], ['explaining', mode],
    ]);
    const [organizing, explaining] = w.run.mock.calls.map(([request]) => request);
    const material = (prompt: string) => JSON.parse(prompt.split('\n자료:\n')[1].split('\n과제:\n')[0]);
    expect(material(organizing.prompt).files).toEqual([]);
    expect(material(explaining.prompt).files).toEqual([{ id: fileId, path: 'main.ts', code: 'export const x = 1;' }]);
    expect(explaining.prompt).toContain('기획과 읽은 코드를 대조하라.');
    const schema = JSON.stringify(explaining.schema);
    expect(schema).toContain('"matches"'); expect(schema).toContain('"differs"');
    expect(w.events.filter(event => event.kind === 'progress').map(event => event.phase)).toEqual([
      'collecting', 'organizing', 'reading-related', 'explaining', 'validating',
    ]);
  });
  describe.each(['codex', 'antigravity'] as const)('%s code comparison guards', mode => {
    it.each(['unknown', 'duplicate', 'nine files'])('rejects %s file selections before comparison', async kind => {
      const files = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f${index}.ts`, 'export {};']));
      const f = await fixture(undefined, files);
      const ids = Object.keys(files).map(f.id);
      const requested = kind === 'unknown' ? [randomUUID()] : kind === 'duplicate' ? [ids[0], ids[0]] : ids;
      const w = workflow(f, empty, requested, mode);
      expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
      expect(w.run.mock.calls.map(([request]) => request.stage)).toEqual(['organizing']);
    });
    it.each(['matches', 'differs'] as const)('rejects %s evidence from an unread file', async status => {
      const f = await fixture(undefined, { 'main.ts': 'export {};', 'unread.ts': 'export {};' });
      const answer = { ...empty(), items: [{ ...item(f.id('unread.ts')), status, difference: '다름' }] };
      const w = workflow(f, () => answer, [f.id('main.ts')], mode);
      expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
      expect(w.run).toHaveBeenCalledTimes(2);
    });
    it('rejects plan changes after picking before comparison', async () => {
      const f = await fixture();
      const w = workflow(f, empty, [f.id('main.ts')], mode);
      const original = w.run.getMockImplementation()!;
      w.run.mockImplementation(async input => {
        const result = await original(input);
        if (input.stage === 'organizing') await writeFile(f.document.path, '# changed');
        return result;
      });
      expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
      expect(w.run.mock.calls.map(([request]) => request.stage)).toEqual(['organizing']);
    });
  });
  it.each([{ accepted: false, issues: [] }, { accepted: true, issues: ['남은 문제'] }])('discards an unresolved review %j', async verdict => {
    const f = await fixture(); const w = workflow(f);
    w.run.mockImplementation(async ({ stage }) => ({ reportedModel: null, value: stage === 'organizing' ? { focus: '확인', requestedFileIds: [] }
      : stage === 'reviewing' ? { ...verdict, compare: empty() } : empty() }));
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
  });
  it.each(['plan', 'new file', 'code'])('checks %s again between AI stages', async kind => {
    const f = await fixture(); const w = workflow(f, empty, [f.id('main.ts')]);
    const original = w.run.getMockImplementation()!;
    w.run.mockImplementation(async input => {
      const result = await original(input);
      if (input.stage !== 'explaining') return result;
      const file = kind === 'plan' ? f.document.path : path.join(f.root, kind === 'new file' ? 'new.ts' : 'main.ts');
      await writeFile(file, 'export const changed = 1;');
      return result;
    });
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(w.run.mock.calls.map(([input]) => input.stage)).toEqual(['organizing', 'explaining']);
  });
  it.each(['unread import', 'alias', 'ignore'])('discards final %s changes even without a watcher event', async kind => {
    const f = await fixture(undefined, { 'main.ts': 'export {};', 'unread.ts': "import '@app/value';", 'other.ts': 'export {};',
      '.gitignore': '# initial', 'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/value': ['./main.ts'] } } }) });
    const w = workflow(f, empty, [f.id('main.ts')]);
    const original = w.run.getMockImplementation()!;
    w.run.mockImplementation(async input => {
      const result = await original(input);
      if (input.stage !== 'reviewing') return result;
      if (kind === 'unread import') await writeFile(path.join(f.root, 'unread.ts'), "import './other';");
      if (kind === 'alias') await writeFile(path.join(f.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@app/value': ['./other.ts'] } } }));
      if (kind === 'ignore') await writeFile(path.join(f.root, '.gitignore'), '# changed without changing paths');
      return result;
    });
    expect(await w.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(w.run).toHaveBeenCalledTimes(3);
    expect(w.events.some(event => event.kind === 'plan-compare-completed')).toBe(false);
  });
  it.each([1, 2])('cancels map wait %i immediately and accepts a new AI job', async heldMap => {
    const f = await fixture(); const w = workflow(f);
    const realMap = f.source.map.getMockImplementation()!;
    let count = 0;
    f.source.map.mockImplementation(() => ++count === heldMap ? new Promise(() => {}) : realMap());
    const { jobId } = w.worker.startPlanCompare(w.request);
    await vi.waitFor(() => expect(f.source.map).toHaveBeenCalledTimes(heldMap));
    await w.worker.cancel(jobId);
    expect(f.source.cancelMap).toHaveBeenCalledOnce();
    expect(w.events.filter(event => event.kind === 'plan-compare-completed')).toEqual([]);
    expect(await w.terminal(jobId)).toMatchObject({ kind: 'failed', error: { code: 'CANCELLED' } });
    f.source.map.mockImplementation(realMap);
    expect(await w.finish()).toMatchObject({ kind: 'plan-compare-completed' });
  });
  it('cancels a stalled capture and does not let its later result start AI', async () => {
    const f = await fixture(); const snapshot = await f.capture(); const w = workflow(f);
    let release!: (value: typeof snapshot) => void;
    w.deps.capturePlanCompare = () => new Promise(resolve => { release = resolve; });
    const { jobId } = w.worker.startPlanCompare(w.request);
    await vi.waitFor(() => expect(release).toBeDefined());
    await w.worker.cancel(jobId);
    release(snapshot);
    await Promise.resolve();
    expect(w.run).not.toHaveBeenCalled();
    expect(await w.terminal(jobId)).toMatchObject({ error: { code: 'CANCELLED' } });
  });
  it('shares the active job lock, rejects paths and consent bypass, and keeps Claude Code unavailable', async () => {
    const f = await fixture(); const w = workflow(f);
    for (const change of [{ path: '/tmp/plan.md' }, { text: 'injected' }, { consent: false }]) {
      expect(() => w.worker.startPlanCompare({ ...w.request, ...change } as PlanCompareRequest)).toThrow();
    }
    expect(() => w.worker.startPlanCompare({ ...w.request, mode: 'claude-code' })).toThrow('준비 중');
    const { jobId } = w.worker.startPlanCompare(w.request);
    expect(() => w.worker.startOverview({ projectId: f.project.id, mode: 'local-worker', startFileId: null, consent: true })).toThrow('이미 AI 작업');
    await w.worker.cancel(jobId);
  });
  it('settles any cancelled wait without waiting for the underlying read to finish', async () => {
    const controller = new AbortController();
    const pending = waitForPlan(controller.signal, () => new Promise(() => {}));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it.each(['local-worker', 'codex', 'antigravity'] as const)('passes the five fixture cases and design mismatch through fake AI in %s', async mode => {
    const base = await mkdtemp('/private/tmp/plan-fixtures-'); temporary.push(base);
    await cp(path.resolve('tests/fixtures/plan-compare'), base, { recursive: true });
    const files: Record<string, string> = {};
    for (const name of ['order.ts', 'settings.ts', 'screen.ts', 'store.ts', 'extra.ts']) files[name] = await readFile(path.join(base, name), 'utf8');
    const f = await fixture(await readFile(path.join(base, 'plan.txt'), 'utf8'), files);
    const map = await f.source.map();
    const edge = map.edges.findIndex(edge => edge.fromFileId === f.id('screen.ts') && edge.toFileId === f.id('store.ts'));
    expect(edge).toBeGreaterThanOrEqual(0);
    const answer: PlanCompareAnswer = { items: [
      { ...item(f.id('order.ts')), title: '최소 수량', plan: { startLine: 2, endLine: 2 } },
      { ...item(f.id('order.ts')), title: '최대 수량', plan: { startLine: 3, endLine: 3 }, status: 'differs', difference: '5개 대신 6개' },
      { ...item(f.id('order.ts')), title: '배송비', plan: { startLine: 4, endLine: 4 }, status: 'unverified', missingEvidence: 'settings.ts는 읽지 않음' },
      { ...item(f.id('order.ts')), title: '취소', plan: { startLine: 5, endLine: 5 }, status: 'missing', files: [], searched: '파일 목록과 주문 코드' },
    ], unrequested: [{ title: '추천', files: [f.id('extra.ts')], note: '기획에서 찾지 못한 후보' }],
    designMismatches: [{ plan: { startLine: 6, endLine: 6 }, edge, note: '화면에서 저장소를 직접 불러옴' }], unknowns: [] };
    const w = workflow(f, () => answer, [f.id('order.ts'), f.id('extra.ts'), f.id('screen.ts')], mode);
    expect(await w.finish()).toMatchObject({ kind: 'plan-compare-completed', result: { compare: answer } });
  });
});

it.each([100, 400])('checks the actual review prompt size with 16,384 short lines and %i-character Korean draft fields', async length => {
  const f = await fixture('x\n'.repeat(16384), { 'a.ts': 'a'.repeat(32 * 1024), 'b.ts': 'b'.repeat(32 * 1024), 'c.ts': 'c'.repeat(16 * 1024) });
  const snapshot = await f.capture({ documentId: f.document.documentId, startLine: 1, endLine: 16384 });
  await f.context.expand(snapshot, [f.id('a.ts'), f.id('b.ts'), f.id('c.ts')], f.signal);
  expect(snapshot.plan).toEqual([{ startLine: 1, text: 'x\n'.repeat(16384) }]);
  // Fill the real wire shapes to within one entry of each material limit.
  while (true) {
    const next = { id: randomUUID(), relativePath: 'long-folder/'.repeat(10) + `${snapshot.availableFiles.length}.ts` };
    if (Buffer.byteLength(JSON.stringify([...snapshot.availableFiles, next])) > 96 * 1024) break;
    snapshot.availableFiles.push(next);
  }
  while (true) {
    const next = { index: snapshot.edges.length, from: 'long-folder/'.repeat(10) + 'a.ts', to: 'long-folder/'.repeat(10) + 'b.ts', line: 1 };
    if (Buffer.byteLength(JSON.stringify([...snapshot.edges, next].map(({ index, from, to, line }) => ({ index, from, to, line })))) > 64 * 1024) break;
    snapshot.edges.push({ ...next, site: { fromFileId: f.id('a.ts'), fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'x', specifier: null } });
  }
  const answer = { ...empty(), items: Array.from({ length: 40 }, () => ({ ...item(f.id('a.ts')), title: '가'.repeat(length),
    difference: '가'.repeat(length), missingEvidence: '가'.repeat(length), searched: '가'.repeat(length) })) };
  const w = workflow(f, () => answer);
  w.deps.capturePlanCompare = async () => snapshot;
  w.deps.revalidatePlanCompare = async () => {};
  const result = await w.finish();
  if (length === 400) {
    expect(result).toMatchObject({ kind: 'failed', error: { code: 'LIMIT' } });
    expect(w.run.mock.calls.map(([request]) => request.stage)).toEqual(['organizing', 'explaining']);
    return;
  }
  expect(result.kind).toBe('plan-compare-completed');
  const review = w.run.mock.calls.find(([request]) => request.stage === 'reviewing')![0];
  expect(Buffer.byteLength(review.prompt) + Buffer.byteLength(JSON.stringify(review.schema))).toBeLessThanOrEqual(384 * 1024);
  expect(Buffer.byteLength(review.prompt)).toBeGreaterThan(300 * 1024);
});

// Save the actual workflow output, then scan again so every file has a new session ID.
async function restorationFixture() {
  const f = await fixture(undefined, { 'main.ts': 'export const value = 1;',
    'unread.ts': "import { value } from './main';\nexport const result = value;\n", 'other.ts': 'export {};' });
  const event = await workflow(f, () => ({ ...empty(), items: [item(f.id('main.ts'))],
    unrequested: [{ title: '후보', note: '기획 밖', files: [f.id('other.ts')] }],
    designMismatches: [{ plan: { startLine: 6, endLine: 6 }, edge: 0, note: '직접 연결' }],
  }), [f.id('main.ts')]).finish();
  if (event.kind !== 'plan-compare-completed') throw new Error('Missing comparison');
  const saved = event.result;
  const reopen = async () => {
    const project = await scanProject(f.root, f.project.id);
    return { ...f.source, context: new ProjectAiContext(f.root, project),
      restoreMap: vi.fn(() => buildProjectMap(f.root, project.id, project.files, [])) };
  };
  return { ...f, saved, reopen };
}

describe('saved comparison schema and restoration', () => {
  it('accepts actual workflow output and rejects unknown fields and malformed hashes at every level', async () => {
    const { saved } = await restorationFixture();
    const parsed: PlanCompareResult = planCompareResultSchema.parse(saved);
    expect(parsed).toEqual(saved);
    const objects = [saved, saved.document, saved.sent[0], saved.plan[0], saved.files[0], saved.edges[0],
      saved.edges[0].site, saved.read[0], saved.basis, saved.models[0], saved.compare,
      saved.compare.items[0], saved.compare.items[0].plan, saved.compare.unrequested[0], saved.compare.designMismatches[0]];
    for (const object of objects) {
      Object.assign(object, { unexpected: true });
      expect(planCompareResultSchema.safeParse(saved).success).toBe(false);
      delete (object as unknown as Record<string, unknown>).unexpected;
    }
    for (const field of ['planHash', 'scopeHash', 'mapHash'] as const) {
      expect(planCompareResultSchema.safeParse({ ...saved, basis: { ...saved.basis, [field]: 'invalid' } }).success).toBe(false);
    }
    expect(planCompareResultSchema.safeParse({ ...saved, read: [{ ...saved.read[0], fileHash: 'invalid' }] }).success).toBe(false);
    expect(planCompareResultSchema.safeParse({ ...saved, edges: [{ ...saved.edges[0], site: { ...saved.edges[0].site, fileHash: 'invalid' } }] }).success).toBe(false);
  });
  it('remaps all five ID locations, including an edge source outside the truncated file list', async () => {
    const f = await restorationFixture();
    f.saved.files = f.saved.files.filter(file => file.relativePath !== 'unread.ts');
    const original = structuredClone(f.saved);
    const source = await f.reopen();
    const { result, reasons } = await restorePlanCompare(source, f.saved, f.document.path);
    expect(reasons).toEqual([]);
    for (const file of result.files) {
      expect(file.id).toBe(source.context.fileIdOf(file.relativePath));
      expect(file.id).not.toBe(f.id(file.relativePath));
    }
    expect(result.compare.items[0].files).toEqual([source.context.fileIdOf('main.ts')]);
    expect(result.compare.unrequested[0].files).toEqual([source.context.fileIdOf('other.ts')]);
    expect(result.read[0].fileId).toBe(source.context.fileIdOf('main.ts'));
    expect(result.edges[0].site.fromFileId).toBe(source.context.fileIdOf('unread.ts'));
    expect(f.saved).toEqual(original);
    // The path-based remap must also work when stale results skip rebuilding the map.
    await writeFile(f.document.path, '# changed');
    source.restoreMap.mockClear();
    expect((await restorePlanCompare(source, f.saved, f.document.path)).result.edges[0].site.fromFileId)
      .toBe(source.context.fileIdOf('unread.ts'));
    expect(source.restoreMap).not.toHaveBeenCalled();
  });
  it.each([
    ['read code', '대조한 뒤 코드가 바뀌었어요'],
    ['deleted code', '대조한 뒤 코드가 바뀌었어요'],
    ['unreadable code', '대조한 뒤 코드가 바뀌었어요'],
    ['plan', '기획 문서가 바뀌었어요. 문서를 다시 고른 뒤 대조해 주세요'],
    ['deleted plan', '기획 문서를 다시 읽지 못했어요'],
    ['new file', '파일 목록이나 제외 규칙(.gitignore)이 바뀌었어요'],
    ['ignore', '파일 목록이나 제외 규칙(.gitignore)이 바뀌었어요'],
  ])('retains %s results as stale and skips the map', async (kind, reason) => {
    const f = await restorationFixture();
    if (kind === 'read code') await writeFile(path.join(f.root, 'main.ts'), 'export const value = 2;');
    if (kind === 'deleted code') await rm(path.join(f.root, 'main.ts'));
    if (kind === 'unreadable code') await writeFile(path.join(f.root, 'main.ts'), Buffer.from('bad\0text'));
    if (kind === 'plan') await writeFile(f.document.path, '# changed');
    if (kind === 'deleted plan') await rm(f.document.path);
    if (kind === 'new file') await writeFile(path.join(f.root, 'new.ts'), 'export {};');
    if (kind === 'ignore') await writeFile(path.join(f.root, '.gitignore'), '# changed');
    const source = await f.reopen();
    const { result, reasons } = await restorePlanCompare(source, f.saved, f.document.path);
    expect(reasons).toContain(reason);
    expect(reasons.filter(value => value === reason)).toHaveLength(1);
    expect(result.jobId).toBe(f.saved.jobId);
    expect(source.restoreMap).not.toHaveBeenCalled();
    if (kind === 'deleted code') expect(result.read[0].fileId).toBe(f.saved.read[0].fileId);
  });
  it('detects changed connections in an unread file', async () => {
    const f = await restorationFixture();
    await writeFile(path.join(f.root, 'unread.ts'), "import './other';");
    const source = await f.reopen();
    const { reasons } = await restorePlanCompare(source, f.saved, f.document.path);
    expect(reasons).toEqual(['대조한 뒤 파일 사이 연결이 바뀌었어요']);
    expect(source.restoreMap).toHaveBeenCalledOnce();
  });
  it('refreshes import hashes and offsets when only unread source text changes', async () => {
    const f = await restorationFixture();
    await writeFile(path.join(f.root, 'unread.ts'), "/* prefix */ import { value } from './main';\nexport const result = value + 1;\n");
    const source = await f.reopen();
    const { result, reasons } = await restorePlanCompare(source, f.saved, f.document.path);
    const map = await source.restoreMap();
    const { toFileId: _to, names: _names, ...site } = map.edges[0];
    expect(reasons).toEqual([]);
    expect(result.edges[0].site).toEqual(site);
    expect(site.fileHash).not.toBe(f.saved.edges[0].site.fileHash);
    expect(site.startUtf16).not.toBe(f.saved.edges[0].site.startUtf16);
  });
  it.each([
    ['CHANGED', '확인하는 동안 코드가 바뀌었어요'],
    ['LIMIT', '파일 사이 연결을 다시 확인하지 못했어요'],
    ['INTERNAL', '파일 사이 연결을 다시 확인하지 못했어요'],
    ['INVALID_REQUEST', '파일 사이 연결을 다시 확인하지 못했어요'],
  ] as const)('keeps the result when the map fails with %s', async (code, reason) => {
    const f = await restorationFixture();
    const source = await f.reopen();
    source.restoreMap.mockRejectedValue(new AppError(code, 'map failed'));
    expect(await restorePlanCompare(source, f.saved, f.document.path))
      .toMatchObject({ result: { jobId: f.saved.jobId }, reasons: [reason] });
  });
  it.each(['CANCELLED', 'PROJECT_CLOSED'] as const)('propagates %s instead of showing a closed project', async code => {
    const f = await restorationFixture();
    const source = await f.reopen();
    source.restoreMap.mockRejectedValue(new AppError(code, 'closed'));
    await expect(restorePlanCompare(source, f.saved, f.document.path)).rejects.toMatchObject({ code });
  });
});
