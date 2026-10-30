import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { featureGuideResultSchema, saveFeatureGuideSchema } from '../src/shared/ai';

const projectId = randomUUID();
const model = { stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: 'test-model' };
const feature = { name: '기능', about: '설명', routes: [0] };
const group = { name: '묶음', about: '설명', features: [feature] };
const result = { jobId: randomUUID(), projectId, routesId: randomUUID(), mode: 'codex', review: 'AI 대조 없음',
  guide: { summary: '요약', groups: [group], unknowns: [] }, limitations: [], models: [model] };
it('accepts feature guides within the workflow limits', () => {
  expect(featureGuideResultSchema.parse(result)).toEqual(result);
  expect(saveFeatureGuideSchema.parse({ projectId, result })).toEqual({ projectId, result });
  expect(featureGuideResultSchema.safeParse({ ...result, limitations: Array(4).fill('a'.repeat(2000)),
    models: Array(2).fill({ ...model, reportedModel: 'a'.repeat(120) }) }).success).toBe(true);
});
it.each([
  { extra: true }, { guide: { ...result.guide, extra: true } },
  { guide: { ...result.guide, groups: [{ ...group, extra: true }] } },
  { guide: { ...result.guide, groups: [{ ...group, features: [{ ...feature, extra: true }] }] } },
  { guide: { ...result.guide, summary: 'a'.repeat(601) } },
  { guide: { ...result.guide, groups: Array(21).fill(group) } },
  { guide: { ...result.guide, groups: [{ ...group, name: 'a'.repeat(41) }] } },
  { guide: { ...result.guide, unknowns: Array(11).fill('unknown') } },
  { guide: { ...result.guide, groups: [{ ...group, features: Array(41).fill(feature) }] } },
  { guide: { ...result.guide, groups: [{ ...group, features: [{ ...feature, routes: Array(21).fill(0) }] }] } },
  { limitations: Array(5).fill('limit') }, { limitations: ['a'.repeat(2001)] },
  { models: Array(3).fill(model) }, { models: [{ ...model, extra: true }] },
  { models: [{ ...model, reportedModel: 'a'.repeat(121) }] }, { routesId: 'invalid' },
])('rejects unknown or excessive fields %#', invalid => {
  expect(featureGuideResultSchema.safeParse({ ...result, ...invalid }).success).toBe(false);
});
it('rejects a renderer-supplied material hash', () => {
  expect(saveFeatureGuideSchema.safeParse({ projectId, result, materialHash: 'a'.repeat(64) }).success).toBe(false);
});
