import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { learningResultSchema, type LearningResult } from '../src/shared/ai';
import { MAX_FILE_BYTES } from '../src/core/project/files';

function answer(): LearningResult {
  const projectId = randomUUID();
  const evidence = { id: randomUUID(), projectId, fileId: randomUUID(), fileHash: 'a'.repeat(64),
    startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1 };
  return { jobId: randomUUID(), projectId, conversationId: randomUUID(), question: '질문', evidence,
    sources: [{ evidence, relativePath: 'index.ts' }], limitations: [], models: [], review: 'AI 검토됨',
    explanation: { summary: '설명', steps: [], claims: [{ kind: 'code', text: '코드', evidenceIds: [evidence.id] }], terms: [], examples: [], unknowns: [] } };
}

it('accepts six sources, masked questions and positions up to the actual readable file limit', () => {
  const result = answer();
  result.question = 'x'.repeat(16_000);
  result.evidence = { ...result.evidence, startUtf16: MAX_FILE_BYTES - 32 * 1024, endUtf16: MAX_FILE_BYTES,
    startLine: MAX_FILE_BYTES, endLine: MAX_FILE_BYTES + 1 };
  result.sources = Array.from({ length: 6 }, () => ({ evidence: result.evidence, relativePath: 'index.ts' }));
  expect(learningResultSchema.safeParse(result).success).toBe(true);
});

it.each(['result', 'evidence', 'source', 'explanation', 'model'])('rejects unknown fields in %s', field => {
  const result = answer();
  const nested: Record<string, unknown> = field === 'evidence' ? result.evidence : field === 'source' ? result.sources[0]
    : field === 'explanation' ? result.explanation : result;
  if (field === 'model') result.models = [{ stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: null, extra: true } as never];
  else nested.extra = true;
  expect(learningResultSchema.safeParse(result).success).toBe(false);
});

it.each(['question', 'path', 'summary', 'sources', 'position', 'line', 'selection', 'reversed', 'models', 'limitations'])
('rejects an excessive or reversed %s', field => {
  const result = answer();
  if (field === 'question') result.question = 'x'.repeat(16_001);
  if (field === 'path') result.sources[0].relativePath = 'x'.repeat(1025);
  if (field === 'summary') result.explanation.summary = 'x'.repeat(2001);
  if (field === 'sources') result.sources = Array(7).fill(result.sources[0]);
  if (field === 'position') result.evidence.startUtf16 = result.evidence.endUtf16 = MAX_FILE_BYTES + 1;
  if (field === 'line') result.evidence.endLine = MAX_FILE_BYTES + 2;
  if (field === 'selection') result.evidence.endUtf16 = 32 * 1024 + 1;
  if (field === 'reversed') result.evidence.startUtf16 = 11;
  if (field === 'models') result.models = Array(4).fill({ stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: null });
  if (field === 'limitations') result.limitations = Array(33).fill('범위');
  expect(learningResultSchema.safeParse(result).success).toBe(false);
});
