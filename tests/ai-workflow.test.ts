import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LocalWorkerWorkflow, type EvidenceSnapshot, type StageRequest, type StageResponse } from '../src/core/ai/workflow';
import { GEMINI_MODEL, explanationSchema, type ExplainRequest, type Explanation, type LearningEvent } from '../src/shared/ai';
import { AppError } from '../src/shared/errors';
import { SECRET_MASK } from '../src/core/ai/secrets';

// These are injected fake adapters: no CLI, account, network, or real AI is used.
function fixture() {
  const snapshot: EvidenceSnapshot = {
    evidence: { id: randomUUID(), projectId: randomUUID(), fileId: randomUUID(), fileHash: 'a'.repeat(64),
      startUtf16: 0, endUtf16: 25, startLine: 1, endLine: 1 },
    code: 'const answer = 42;', relativePath: 'src/example.ts', revision: 1, files: [], availableFiles: [], limitations: [],
  };
  const request: ExplainRequest = { projectId: snapshot.evidence.projectId, evidenceId: snapshot.evidence.id,
    expectedFileHash: snapshot.evidence.fileHash, question: '이 값은 무엇인가요?', mode: 'local-worker', consent: true };
  const explanation: Explanation = { summary: '값을 저장합니다.', steps: [],
    claims: [{ kind: 'code', text: 'answer에 42를 저장합니다.', evidenceIds: [snapshot.evidence.id] }], terms: [], unknowns: [] };
  const events: LearningEvent[] = [];
  const assertReady = vi.fn();
  const capture = vi.fn(async () => structuredClone(snapshot));
  const revalidate = vi.fn(async (_snapshot: EvidenceSnapshot, _signal: AbortSignal) => {});
  const expand = vi.fn(async (_snapshot: EvidenceSnapshot, _ids: string[], _signal: AbortSignal) => {});
  const run = vi.fn(async ({ stage }: StageRequest): Promise<StageResponse> => ({
    reportedModel: stage === 'explaining' ? GEMINI_MODEL : 'reported-codex-model',
    value: stage === 'organizing' ? { focus: '상수 설명', questions: [], requestedFileIds: [], evidenceIds: [snapshot.evidence.id] }
      : stage === 'explaining' ? structuredClone(explanation)
        : { accepted: true, issues: [], explanation: structuredClone(explanation) },
  }));
  const workflow = new LocalWorkerWorkflow({ assertReady, capture, expand, revalidate, run, emit: event => events.push(event) });
  const finish = async (input = request) => {
    const { jobId } = workflow.start(input);
    await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress')).toBe(true));
    // Let job.finally release the slot before a follow-up starts.
    await new Promise(resolve => setTimeout(resolve, 0));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  };
  return { snapshot, request, explanation, events, assertReady, capture, expand, revalidate, run, workflow, finish };
}
function context(request: StageRequest) {
  return JSON.parse(request.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
}

describe('local worker workflow with fake adapters', () => {
  it('enforces readiness before any code capture or model execution', () => {
    const f = fixture();
    f.assertReady.mockImplementation(() => { throw new AppError('AI_UNAVAILABLE', '격리 미검증'); });
    expect(() => f.workflow.start(f.request)).toThrow('격리 미검증');
    expect(f.assertReady).toHaveBeenCalledWith('local-worker');
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it.each([{ consent: false }, { consent: undefined }, { path: '/etc/passwd' }, { code: 'untrusted source' },
    { prompt: 'bypass' }, { executable: '/bin/sh' }, { expectedFileHash: 'bad' }])('rejects renderer-supplied invalid input %j', extra => {
    const f = fixture();
    expect(() => f.workflow.start({ ...f.request, ...extra } as ExplainRequest)).toThrow();
    expect(f.assertReady).not.toHaveBeenCalled();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('uses three ordered stages with identical original context and explicit requested/reported model metadata', async () => {
    const f = fixture();
    const result = await f.finish();
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('expected completion');
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([
      ['organizing', 'codex'], ['explaining', 'antigravity'], ['reviewing', 'codex'],
    ]);
    const contexts = f.run.mock.calls.map(([input]) => context(input));
    expect(contexts).toEqual(Array(3).fill({ question: f.request.question, history: [], evidence: f.snapshot.evidence,
      relativePath: f.snapshot.relativePath, code: f.snapshot.code, files: [], availableFiles: [], limitations: [] }));
    expect(f.revalidate).toHaveBeenCalledTimes(4);
    expect(f.revalidate).toHaveBeenCalledWith(f.snapshot, expect.any(AbortSignal));
    expect(result.result.models).toEqual([
      { stage: 'organizing', provider: 'codex', requestedModel: null, reportedModel: 'reported-codex-model' },
      { stage: 'explaining', provider: 'antigravity', requestedModel: GEMINI_MODEL, reportedModel: GEMINI_MODEL },
      { stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: 'reported-codex-model' },
    ]);
    expect(f.events.filter(e => e.kind === 'progress').map(e => e.phase)).toEqual([
      'collecting', 'organizing', 'reading-related', 'explaining', 'reviewing', 'validating',
    ]);
  });

  it.each(['codex', 'antigravity'] as const)('%s single mode runs one explaining stage by that CLI with only the captured code, marked unchecked', async mode => {
    const f = fixture();
    // The real capture adds the selection's whole file; a single mode sends that and nothing more.
    f.snapshot.files = [{ evidence: { ...f.snapshot.evidence, id: randomUUID(), startUtf16: 0, endUtf16: 18 }, relativePath: 'src/example.ts', code: 'const answer = 42;' }];
    const result = await f.finish({ ...f.request, mode });
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('expected completion');
    expect(f.run.mock.calls.map(([input]) => [input.stage, input.provider])).toEqual([['explaining', mode]]);
    expect(f.expand).not.toHaveBeenCalled();
    expect(context(f.run.mock.calls[0][0]).files).toEqual(f.snapshot.files);
    expect(f.events.filter(e => e.kind === 'progress').map(e => e.phase)).toEqual(['collecting', 'explaining', 'validating']);
    expect(result.result.review).toBe('AI 대조 없음');
    expect(result.result.models.map(model => [model.stage, model.provider, model.requestedModel]))
      .toEqual([['explaining', mode, mode === 'antigravity' ? GEMINI_MODEL : null]]);
    expect(result.result.limitations).toContain('단독 방식: 관련 파일을 더 읽지 않았고, 다른 AI의 대조도 없습니다.');
  });

  it('tells only the local worker that related files can be requested', async () => {
    const worker = fixture();
    await worker.finish();
    const single = fixture();
    await single.finish({ ...single.request, mode: 'codex' });
    for (const [input] of worker.run.mock.calls) {
      expect(input.prompt).toContain('연관 파일은 availableFiles의 ID로 요청하면 앱이 읽어서 files에 제공한다.');
      expect(input.prompt).not.toContain('관련 파일을 더 요청할 수 없다');
    }
    const prompt = single.run.mock.calls[0][0].prompt;
    expect(prompt).toContain('이번 방식에서는 관련 파일을 더 요청할 수 없다.');
    expect(prompt).not.toContain('availableFiles의 ID로 요청하면');
    expect(prompt).not.toContain('availableFiles에서 다시 요청한다');
  });

  it.each(['codex', 'antigravity'] as const)('rejects unrelated evidence in %s single mode', async mode => {
    const f = fixture();
    f.run.mockImplementation(async () => ({ reportedModel: null,
      value: { ...f.explanation, claims: [{ kind: 'code', text: '틀린 근거', evidenceIds: [randomUUID()] }] } }));
    expect(await f.finish({ ...f.request, mode })).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('refuses Claude Code single before capturing any code', () => {
    const f = fixture();
    expect(() => f.workflow.start({ ...f.request, mode: 'claude-code' })).toThrow('Claude Code 단독 연결은 아직 준비 중입니다.');
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('sends Codex stages a schema without oneOf', async () => {
    // Codex passes --output-schema on as an OpenAI strict schema, which lists anyOf but not oneOf.
    // The first real local worker run (W1) failed at the reviewing stage while the claims union was a oneOf.
    const f = fixture();
    expect((await f.finish()).kind).toBe('completed');
    const codexSchemas = f.run.mock.calls.map(([input]) => input).filter(input => input.provider === 'codex').map(input => JSON.stringify(input.schema));
    expect(codexSchemas).toHaveLength(2);
    for (const schema of codexSchemas) expect(schema).not.toContain('"oneOf"');
  });

  it.each([
    { kind: 'code', text: '근거가 없는 코드 설명' },
    { kind: 'concept', text: '근거를 붙인 개념', evidenceIds: [randomUUID()] },
    { kind: 'guess', text: '모르는 종류', evidenceIds: [randomUUID()] },
  ])('rejects the malformed claim %j', claim => {
    expect(explanationSchema.safeParse({ ...fixture().explanation, claims: [claim] }).success).toBe(false);
  });

  it.each(['organizing', 'explaining', 'reviewing'] as const)('stops at malformed %s schema', async stage => {
    const f = fixture();
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementation(async input => input.stage === stage ? { value: {}, reportedModel: null } : normal(input));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.run).toHaveBeenCalledTimes(['organizing', 'explaining', 'reviewing'].indexOf(stage) + 1);
    expect(f.revalidate).toHaveBeenCalledTimes(['organizing', 'explaining', 'reviewing'].indexOf(stage) + 1);
  });

  it.each(['organizing', 'explaining', 'reviewing'] as const)('rejects unrelated evidence in %s', async stage => {
    const f = fixture();
    const normal = f.run.getMockImplementation()!;
    const wrongExplanation = { ...f.explanation, claims: [{ kind: 'code', text: '틀린 근거', evidenceIds: [randomUUID()] }] };
    f.run.mockImplementation(async input => input.stage !== stage ? normal(input) : {
      reportedModel: null, value: stage === 'organizing' ? { focus: '설명', questions: [], requestedFileIds: [], evidenceIds: [randomUUID()] }
        : stage === 'explaining' ? wrongExplanation : { accepted: true, issues: [], explanation: wrongExplanation },
    });
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.run).toHaveBeenCalledTimes(['organizing', 'explaining', 'reviewing'].indexOf(stage) + 1);
    expect(f.revalidate).toHaveBeenCalledTimes(['organizing', 'explaining', 'reviewing'].indexOf(stage) + 1);
  });

  it.each([{ accepted: false, issues: [] }, { accepted: true, issues: ['해결하지 못한 문제'] }])('does not publish rejected review %j', async review => {
    const f = fixture();
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementation(async input => input.stage === 'reviewing'
      ? { value: { ...review, explanation: f.explanation }, reportedModel: null } : normal(input));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
    expect(f.events.some(e => e.kind === 'completed')).toBe(false);
  });

  it('tells the reviewer that issues are only the problems it could not fix', async () => {
    // Any issue discards the answer, so a fix that is also listed as an issue would discard a corrected
    // explanation (a possible cause of the first real app question's rejection, 2026-10-19; not confirmed).
    const f = fixture();
    await f.finish();
    const reviewing = f.run.mock.calls.map(([input]) => input).find(input => input.stage === 'reviewing')!;
    expect(reviewing.prompt).toContain('issues에는 바로잡지 못하고 남은 문제만 적는다. 바로잡은 내용은 explanation에만 반영하고 issues에 적지 않는다.');
  });

  it.each(['organizing', 'explaining', 'reviewing'] as const)('cancels during %s without continuing or completing', async stage => {
    const f = fixture();
    const normal = f.run.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async input => { if (input.stage === stage) await blocked; return normal(input); });
    const { jobId } = f.workflow.start(f.request);
    await vi.waitFor(() => expect(f.run.mock.calls.some(([input]) => input.stage === stage)).toBe(true));
    const cancellation = f.workflow.cancel(jobId);
    expect(f.run.mock.calls.at(-1)![0].signal.aborted).toBe(true);
    release();
    await cancellation;
    expect(f.run).toHaveBeenCalledTimes(['organizing', 'explaining', 'reviewing'].indexOf(stage) + 1);
    expect(f.events.filter(e => e.kind !== 'progress')).toEqual([
      expect.objectContaining({ kind: 'failed', error: { code: 'CANCELLED', message: 'AI 작업을 취소했습니다.' } }),
    ]);
  });

  it.each(['projectId', 'id', 'fileHash'] as const)('rejects mismatched captured %s before model execution', async key => {
    const f = fixture();
    f.snapshot.evidence[key] = key === 'fileHash' ? 'b'.repeat(64) : randomUUID();
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('does not publish or save a result after final stale-code validation fails', async () => {
    const f = fixture();
    f.revalidate.mockResolvedValueOnce().mockResolvedValueOnce().mockResolvedValueOnce()
      .mockRejectedValueOnce(new AppError('CHANGED', '코드 변경'));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.events.some(e => e.kind === 'completed')).toBe(false);
  });

  it('includes history only for an explicit conversation and clears it on close', async () => {
    const f = fixture();
    const first = await f.finish();
    if (first.kind !== 'completed') throw new Error('expected completion');
    const next = { ...f.request, question: '다시 설명해 주세요', conversationId: first.result.conversationId };
    expect(await f.finish(next)).toMatchObject({ kind: 'completed', result: { conversationId: first.result.conversationId } });
    expect(context(f.run.mock.calls[3][0]).history).toEqual([{ question: f.request.question, explanation: f.explanation }]);
    await f.finish();
    expect(context(f.run.mock.calls[6][0]).history).toEqual([]);
    await f.workflow.close();
    f.run.mockClear();
    expect(await f.finish(next)).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(['project', 'scope', 'hash', 'revision', 'unknown-conversation'] as const)('isolates follow-up history when %s changes', async change => {
    const f = fixture();
    const first = await f.finish();
    if (first.kind !== 'completed') throw new Error('expected completion');
    const next = { ...f.request, conversationId: first.result.conversationId };
    if (change === 'project') next.projectId = f.snapshot.evidence.projectId = randomUUID();
    if (change === 'scope') next.evidenceId = f.snapshot.evidence.id = randomUUID();
    if (change === 'hash') next.expectedFileHash = f.snapshot.evidence.fileHash = 'b'.repeat(64);
    if (change === 'revision') f.snapshot.revision++;
    if (change === 'unknown-conversation') next.conversationId = randomUUID();
    f.run.mockClear();
    expect(await f.finish(next)).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('passes requested related code to both later stages and publishes its resolvable source reference', async () => {
    const f = fixture();
    const related = { evidence: { ...f.snapshot.evidence, id: randomUUID(), fileId: randomUUID() },
      relativePath: 'src/helper.ts', code: 'export const helper = () => 42;' };
    f.snapshot.availableFiles.push({ id: related.evidence.fileId, relativePath: related.relativePath });
    f.expand.mockImplementation(async (snapshot, ids) => {
      expect(ids).toEqual([related.evidence.fileId]);
      snapshot.files.push(structuredClone(related));
    });
    f.explanation.claims = [{ kind: 'code', text: 'helper가 값을 반환합니다.', evidenceIds: [related.evidence.id] }];
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementation(async input => input.stage === 'organizing' ? {
      reportedModel: null, value: { focus: 'helper 설명', questions: [], evidenceIds: [f.snapshot.evidence.id], requestedFileIds: [related.evidence.fileId] },
    } : normal(input));
    const first = await f.finish();
    expect(first).toMatchObject({ kind: 'completed', result: { sources: [
      { evidence: f.snapshot.evidence, relativePath: f.snapshot.relativePath },
      { evidence: related.evidence, relativePath: related.relativePath },
    ] } });
    expect(context(f.run.mock.calls[0][0]).files).toEqual([]);
    expect(context(f.run.mock.calls[1][0]).files).toEqual([related]);
    expect(context(f.run.mock.calls[2][0]).files).toEqual([related]);
    if (first.kind !== 'completed') throw new Error('expected completion');
    expect(await f.finish({ ...f.request, conversationId: first.result.conversationId })).toMatchObject({ kind: 'completed' });
    expect(context(f.run.mock.calls[3][0]).history[0].explanation.claims[0].evidenceIds).toEqual([related.evidence.id]);
  });

  it('sends masked copies of secret-looking values and keeps the originals for revalidation', async () => {
    const f = fixture();
    // Made-up values in the shape of secrets; not real credentials.
    f.snapshot.code = 'const password = "hunter22";';
    f.snapshot.files = [
      { evidence: { ...f.snapshot.evidence, id: randomUUID() }, relativePath: 'src/example.ts', code: 'const password = "hunter22";\nconst other = 1;' },
    ];
    // A related file with a secret arrives only after organizing, through expand().
    const related = { evidence: { ...f.snapshot.evidence, id: randomUUID(), fileId: randomUUID() },
      relativePath: 'src/db.ts', code: 'const url = "postgres://app:s3cr3tPass@db/x";' };
    f.snapshot.availableFiles.push({ id: related.evidence.fileId, relativePath: related.relativePath });
    f.expand.mockImplementation(async snapshot => { snapshot.files.push(structuredClone(related)); });
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementation(async input => input.stage === 'organizing' ? {
      reportedModel: null, value: { focus: '설정 설명', questions: [], evidenceIds: [f.snapshot.evidence.id], requestedFileIds: [related.evidence.fileId] },
    } : normal(input));
    const event = await f.finish();
    if (event.kind !== 'completed') throw new Error('expected completion');
    expect(f.run).toHaveBeenCalledTimes(3);
    for (const [request] of f.run.mock.calls) {
      const sent = JSON.stringify(context(request));
      expect(sent).not.toContain('hunter22');
      expect(sent).not.toContain('s3cr3tPass');
      expect(sent).toContain(SECRET_MASK);
    }
    expect(context(f.run.mock.calls[0][0]).files.map((file: { relativePath: string }) => file.relativePath)).toEqual(['src/example.ts']);
    for (const call of [1, 2]) {
      expect(context(f.run.mock.calls[call][0]).files.map((file: { code: string }) => file.code))
        .toContain(`const url = "postgres://app:${SECRET_MASK}@db/x";`);
    }
    // One note per file, shown with the answer and sent to the model as a reading limit.
    expect(event.result.limitations).toEqual([
      'src/example.ts: 비밀값처럼 보이는 1곳을 가린 뒤 보냈어요. AI는 가린 내용을 보지 못했어요. 모든 비밀값을 찾아낸다고 보장하지는 않아요.',
      'src/db.ts: 비밀값처럼 보이는 1곳을 가린 뒤 보냈어요. AI는 가린 내용을 보지 못했어요. 모든 비밀값을 찾아낸다고 보장하지는 않아요.',
    ]);
    expect(context(f.run.mock.calls[0][0]).limitations).toEqual([event.result.limitations[0]]);
    expect(context(f.run.mock.calls[2][0]).limitations).toEqual(event.result.limitations);
    // Revalidation still compares the untouched originals with the files on disk.
    for (const [snapshot] of f.revalidate.mock.calls) {
      expect(snapshot.code).toContain('hunter22');
      expect(snapshot.files.map(file => file.code).join('\n')).toContain('s3cr3tPass');
    }
  });

  it('masks a secret pasted into the question, both now and when the question is sent again as history', async () => {
    const f = fixture();
    // Made-up values in the shape of secrets; not real credentials.
    const asked = '이 키 sk-abcdefghijklmnopqrstuvwx 는 어디에 쓰나요?\npassword: hunter22';
    const masked = `이 키 ${SECRET_MASK} 는 어디에 쓰나요?\npassword: ${SECRET_MASK}`;
    const note = '질문: 비밀값처럼 보이는 2곳을 가린 뒤 보냈어요. AI는 가린 내용을 보지 못했어요. 모든 비밀값을 찾아낸다고 보장하지는 않아요.';
    const first = await f.finish({ ...f.request, question: asked });
    if (first.kind !== 'completed') throw new Error('expected completion');
    expect(f.run).toHaveBeenCalledTimes(3);
    for (const [request] of f.run.mock.calls) expect(context(request)).toMatchObject({ question: masked, limitations: [note] });
    // The answer screen on this computer shows the question as typed, with the same note.
    expect(first.result.question).toBe(asked);
    expect(first.result.limitations).toEqual([note]);

    f.run.mockClear();
    const next = await f.finish({ ...f.request, question: '다시 설명해 주세요', conversationId: first.result.conversationId });
    if (next.kind !== 'completed') throw new Error('expected completion');
    for (const [request] of f.run.mock.calls) {
      expect(context(request).history[0].question).toBe(masked);
      expect(JSON.stringify(context(request))).not.toMatch(/sk-abcdefghijklmnopqrstuvwx|hunter22/);
      // That question's note went out with its own answer.
      expect(context(request).limitations).toEqual([]);
    }
  });

  it('stops before explanation when related file access is denied', async () => {
    const f = fixture();
    f.expand.mockRejectedValue(new AppError('NOT_ALLOWED', '제외된 파일'));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'NOT_ALLOWED' } });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('stops before model stage %s when source revalidation fails', async stage => {
    const f = fixture();
    for (let index = 0; index < stage; index++) f.revalidate.mockResolvedValueOnce();
    f.revalidate.mockRejectedValueOnce(new AppError('CHANGED', '관련 파일 변경'));
    expect(await f.finish()).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
    expect(f.run).toHaveBeenCalledTimes(stage);
  });

  it('cancels while related files are read and ignores their late result', async () => {
    const f = fixture();
    let release!: () => void;
    f.expand.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const { jobId } = f.workflow.start(f.request);
    await vi.waitFor(() => expect(f.expand).toHaveBeenCalledTimes(1));
    const cancelled = f.workflow.cancel(jobId);
    expect(f.expand.mock.calls[0][2].aborted).toBe(true);
    release();
    await cancelled;
    expect(f.events.at(-1)).toMatchObject({ kind: 'failed', error: { code: 'CANCELLED' } });
    expect(f.run).toHaveBeenCalledTimes(1);
  });


  it.each([1, 2].flatMap(age => [0, 1, 2, 3].map(stage => ({ age, stage }))))(
    'revalidates related files used only $age turn(s) ago before stage/final $stage even without revision changes', async ({ age, stage }) => {
      const f = fixture();
      const related = { evidence: { ...f.snapshot.evidence, id: randomUUID(), fileId: randomUUID() },
        relativePath: 'src/previous-only.ts', code: 'export const previous = 42;' };
      f.snapshot.availableFiles.push({ id: related.evidence.fileId, relativePath: related.relativePath });
      const originalExplanation = structuredClone(f.explanation);
      f.explanation.claims = [{ kind: 'code', text: '이전 파일의 값입니다.', evidenceIds: [related.evidence.id] }];
      f.expand.mockImplementationOnce(async snapshot => { snapshot.files.push(structuredClone(related)); });
      const normal = f.run.getMockImplementation()!;
      f.run.mockImplementationOnce(async input => ({ ...(await normal(input)), value: {
        focus: '관련 파일 확인', questions: [], evidenceIds: [f.snapshot.evidence.id], requestedFileIds: [related.evidence.fileId],
      } }));
      const first = await f.finish();
      if (first.kind !== 'completed') throw new Error('expected first completion');
      f.explanation.claims = originalExplanation.claims;
      const followup = { ...f.request, conversationId: first.result.conversationId };
      if (age === 2) {
        expect(await f.finish(followup)).toMatchObject({ kind: 'completed' });
        expect(context(f.run.mock.calls[3][0]).history).toEqual([{ question: f.request.question, explanation: first.result.explanation }]);
      }
      // Neither the currently selected file nor the watcher revision changes.
      // Only the old related file fails its content check at the specified boundary.
      let oldFileChecks = 0;
      f.revalidate.mockImplementation(async snapshot => {
        if (snapshot.files.some(file => file.evidence.fileId === related.evidence.fileId) && oldFileChecks++ === stage) {
          throw new AppError('CHANGED', '이전 답변의 관련 파일 변경');
        }
      });
      f.run.mockClear();
      expect(await f.finish(followup)).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
      expect(f.run).toHaveBeenCalledTimes(stage);
      expect(oldFileChecks).toBe(stage + 1);
      await expect(f.capture.mock.results.at(-1)?.value).resolves.toMatchObject({ files: [], revision: 1 });
      for (const [input] of f.run.mock.calls) {
        const history = context(input).history;
        expect(history).toHaveLength(age);
        expect(history[0].explanation.claims[0].evidenceIds).toEqual([related.evidence.id]);
        for (const turn of history) expect(Object.keys(turn).sort()).toEqual(['explanation', 'question']);
      }
    });

});
