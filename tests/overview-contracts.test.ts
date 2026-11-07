import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { learningModeSchema, overviewRequestSchema, overviewResultSchema, saveOverviewSchema } from '../src/shared/ai';

const projectId = randomUUID();
const evidence = { id: randomUUID(), projectId, fileId: randomUUID(), fileHash: 'a'.repeat(64),
  startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 1 };
const source = { evidence, relativePath: 'start.ts' };
const model = { stage: 'organizing', provider: 'codex', requestedModel: null, reportedModel: 'test-model' };
const result = { jobId: randomUUID(), projectId, sources: [source], limitations: [], review: 'AI 검토됨', models: [model],
  overview: { intro: { text: '소개', evidenceIds: [evidence.id] }, features: [], roles: [], unknowns: [] } };

it.each(learningModeSchema.options)('accepts the common overview mode %s', mode => {
  const request = { projectId, startFileId: null, mode, consent: true };
  expect(overviewRequestSchema.parse(request)).toEqual(request);
});

it('rejects an unknown overview mode', () => {
  expect(overviewRequestSchema.safeParse({ projectId, startFileId: null, mode: 'unknown', consent: true }).success).toBe(false);
});

it('saves a single-AI result with 56 notices and rejects 57', () => {
  const single = { ...result, review: 'AI 대조 없음', limitations: Array(55).fill('a'.repeat(2000)).concat('단독 방식: 다른 AI의 대조가 없습니다.') };
  expect(saveOverviewSchema.parse({ projectId, result: single }).result).toEqual(single);
  expect(saveOverviewSchema.safeParse({ projectId, result: { ...single, limitations: [...single.limitations, 'extra'] } }).success).toBe(false);
});

it('accepts overview results and the workflow limits', () => {
  expect(overviewResultSchema.parse(result)).toEqual(result);
  expect(saveOverviewSchema.parse({ projectId, result })).toEqual({ projectId, result });
  expect(overviewResultSchema.safeParse({ ...result, sources: Array(5).fill(source),
    limitations: Array(55).fill('a'.repeat(2000)), models: Array(3).fill({ ...model, reportedModel: 'a'.repeat(120) }) }).success).toBe(true);
  expect(overviewResultSchema.safeParse({ ...result, sources: [], review: '개요 작성 안 함',
    overview: { intro: null, features: [], roles: [], unknowns: [] } }).success).toBe(true);
});

it.each([
  { extra: true }, { sources: [{ ...source, extra: true }] },
  { sources: [{ ...source, evidence: { ...evidence, extra: true } }] },
  { overview: { ...result.overview, extra: true } },
  { overview: { ...result.overview, intro: { ...result.overview.intro, extra: true } } },
  { models: [{ ...model, extra: true }] }, { review: 'unknown' },
  { sources: Array(6).fill(source) }, { limitations: Array(57).fill('limit') },
  { limitations: ['a'.repeat(2001)] }, { models: Array(4).fill(model) },
  { models: [{ ...model, reportedModel: 'a'.repeat(121) }] },
  { sources: [{ ...source, relativePath: 'a'.repeat(1025) }] },
  { sources: [{ ...source, evidence: { ...evidence, fileHash: 'bad' } }] },
  { sources: [{ ...source, evidence: { ...evidence, endUtf16: 32769 } }] },
  { sources: [{ ...source, evidence: { ...evidence, startUtf16: 21 } }] },
  { sources: [{ ...source, evidence: { ...evidence, startLine: 2 } }] },
  { overview: { ...result.overview, intro: { ...result.overview.intro, text: 'a'.repeat(2001) } } },
])('rejects unknown, invalid or excessive overview fields %#', invalid => {
  expect(overviewResultSchema.safeParse({ ...result, ...invalid }).success).toBe(false);
});

it('rejects unrecognized save request fields', () => {
  expect(saveOverviewSchema.safeParse({ projectId, result, path: '/tmp' }).success).toBe(false);
});
