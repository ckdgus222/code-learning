import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageRequest, StageResponse } from '../src/core/ai/workflow';
import { GEMINI_MODEL } from '../src/shared/ai';
import { AppError } from '../src/shared/errors';
import { recordPlanCompareStage, type PlanCompareStageRecord } from './live/plan-compare-records';

afterEach(() => vi.restoreAllMocks());
const compare = { items: [], unrequested: [], designMismatches: [], unknowns: [] };
const request = (overrides: Partial<StageRequest> = {}): StageRequest => ({
  stage: 'reviewing', provider: 'codex', prompt: 'PRIVATE_PROMPT', schema: { private: 'PRIVATE_SCHEMA' },
  signal: new AbortController().signal, ...overrides,
});

describe('non-secret plan comparison live diagnostics', () => {
  it.each([
    { accepted: false, issues: [] },
    { accepted: false, issues: ['남은 판정 오류'] },
    { accepted: true, issues: ['남은 판정 오류'] },
    { accepted: true, issues: [] },
  ])('records the review verdict without accepting or changing the response: %j', async verdict => {
    const records: PlanCompareStageRecord[] = [];
    const response: StageResponse = { reportedModel: null, value: { ...verdict, compare } };
    const input = request();
    const run = vi.fn(async () => response);
    expect(await recordPlanCompareStage(input, run, records)).toBe(response);
    expect(run).toHaveBeenCalledExactlyOnceWith(input);
    expect(records).toEqual([expect.objectContaining({ stage: 'reviewing', provider: 'codex', outcome: 'returned',
      review: { status: 'valid', ...verdict } })]);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_SCHEMA|compare/);
  });

  it('masks secret shapes and preserves control characters only as JSON escapes', async () => {
    const records: PlanCompareStageRecord[] = [];
    const token = `ghp_${'A'.repeat(36)}`;
    const issue = `근거 오류 ${token}\npassword = "fixture-hidden"\n\u001b[31m검토 실패`;
    const response = { reportedModel: null, value: { accepted: false, issues: [issue],
      compare: { ...compare, unknowns: ['PRIVATE_DRAFT'] } } };
    await recordPlanCompareStage(request(), async () => response, records);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain('[MASKED_SECRET]');
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('fixture-hidden');
    expect(serialized).not.toContain('PRIVATE_DRAFT');
    expect(serialized).not.toContain('\n');
    expect(serialized).not.toContain('\u001b');
    expect(serialized).toContain('\\n');
    expect(serialized).toContain('\\u001b');
    expect(response.value.issues).toEqual([issue]);
  });

  it.each([
    { accepted: false, issues: ['PRIVATE_INVALID'], compare: null },
    { accepted: 'PRIVATE_INVALID', issues: [], compare },
    { accepted: false, issues: Array(17).fill('PRIVATE_INVALID'), compare },
    { accepted: false, issues: ['PRIVATE_INVALID'.repeat(40)], compare },
  ])('withholds invalid or unbounded review output', async value => {
    const records: PlanCompareStageRecord[] = [];
    await recordPlanCompareStage(request(), async () => ({ reportedModel: null, value }), records);
    expect(records[0].review).toEqual({ status: 'schema-invalid' });
    expect(JSON.stringify(records)).not.toContain('PRIVATE_INVALID');
  });

  it('records the fixed Gemini request, timeout and elapsed time without its draft', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(350);
    const records: PlanCompareStageRecord[] = [];
    await recordPlanCompareStage(request({ stage: 'explaining', provider: 'antigravity', timeoutMs: 240_000 }),
      async () => ({ reportedModel: GEMINI_MODEL, value: { draft: 'PRIVATE_DRAFT' } }), records);
    expect(records).toEqual([{ stage: 'explaining', provider: 'antigravity', requestedModel: GEMINI_MODEL,
      reportedModel: GEMINI_MODEL, timeoutMs: 240_000, elapsedMs: 250, outcome: 'returned' }]);
  });

  it.each([new Error('PRIVATE_NATIVE_ERROR'), new AppError('LIMIT', 'PRIVATE_ERROR_MESSAGE')])(
    'keeps timing when the runtime fails and rethrows without recording error text', async error => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(90);
      const records: PlanCompareStageRecord[] = [];
      await expect(recordPlanCompareStage(request(), async () => { throw error; }, records)).rejects.toBe(error);
      expect(records).toEqual([{ stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: null,
        timeoutMs: 120_000, elapsedMs: 80, outcome: 'failed' }]);
      expect(JSON.stringify(records)).not.toContain('PRIVATE_');
    });
});
