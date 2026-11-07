import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { explainRequestSchema, fileExplanationRequestSchema, featureGuideRequestSchema, overviewRequestSchema,
  learningModeSchema, resultModeSchema } from '../src/shared/ai';
import { planCompareRequestSchema } from '../src/shared/plan-compare';

const projectId = randomUUID();
const fileId = randomUUID();
const expectedFileHash = 'a'.repeat(64);

it.each([
  ['question', explainRequestSchema, { projectId, evidenceId: fileId, expectedFileHash, question: '설명해 주세요' }],
  ['file explanation', fileExplanationRequestSchema, { projectId, fileId, expectedFileHash }],
  ['feature guide', featureGuideRequestSchema, { projectId, routesId: fileId }],
  ['plan comparison', planCompareRequestSchema, { projectId, selection: { documentId: 'plan', startLine: 1, endLine: 2 } }],
  ['overview', overviewRequestSchema, { projectId, startFileId: null }],
] as const)('accepts single providers and rejects local-worker requests for %s', (_name, schema, input) => {
  for (const mode of ['codex', 'antigravity', 'claude-code']) {
    expect(schema.safeParse({ ...input, mode, consent: true }).success).toBe(true);
  }
  expect(schema.safeParse({ ...input, mode: 'local-worker', consent: true }).success).toBe(false);
});

it('keeps the old mode only in the stored-result contract', () => {
  expect(learningModeSchema.options).toEqual(['codex', 'claude-code', 'antigravity']);
  expect(resultModeSchema.parse('local-worker')).toBe('local-worker');
});
