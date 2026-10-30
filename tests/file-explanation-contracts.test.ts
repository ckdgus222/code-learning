import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileExplanationResultSchema, saveFileExplanationSchema } from '../src/shared/ai';

const range = { fileId: randomUUID(), fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 20, startLine: 1, endLine: 1 };
const chunk = { id: randomUUID(), kind: 'function', name: 'run', range, functionRange: { startUtf16: 0, endUtf16: 20 } };
const model = { stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: 'test-model' };
const result = { jobId: randomUUID(), projectId: randomUUID(), relativePath: 'src/run.ts', range, chunks: [chunk],
  explanation: { summary: '파일 설명', chunks: [{ chunkId: chunk.id, summary: '함수 설명' }], unknowns: [] },
  limitations: [], mode: 'codex', review: 'AI 대조 없음', models: [model] };

describe('saved file explanation boundary', () => {
  it('accepts the result without changing its shape and the existing generation limits', () => {
    expect(fileExplanationResultSchema.parse(result)).toEqual(result);
    expect(saveFileExplanationSchema.parse({ projectId: result.projectId, result })).toEqual({ projectId: result.projectId, result });
    expect(fileExplanationResultSchema.safeParse({ ...result, range: { ...range, endUtf16: 32768, endLine: 32769 },
      chunks: Array.from({ length: 80 }, () => ({ ...chunk, name: 'a'.repeat(32768) })),
      explanation: { summary: 'a'.repeat(2000), chunks: Array.from({ length: 80 }, () => ({ chunkId: chunk.id, summary: 'a'.repeat(2000) })),
        unknowns: Array(16).fill('a'.repeat(2000)) }, limitations: Array(3).fill('a'.repeat(2000)),
      models: Array(2).fill({ ...model, reportedModel: 'a'.repeat(120) }) }).success).toBe(true);
  });

  it('rejects unknown fields throughout the stored result and request', () => {
    const invalid = [
      { ...result, extra: true }, { ...result, range: { ...range, extra: true } },
      { ...result, chunks: [{ ...chunk, extra: true }] },
      { ...result, chunks: [{ ...chunk, range: { ...range, extra: true } }] },
      { ...result, chunks: [{ ...chunk, functionRange: { ...chunk.functionRange, extra: true } }] },
      { ...result, explanation: { ...result.explanation, extra: true } },
      { ...result, explanation: { ...result.explanation, chunks: [{ chunkId: chunk.id, summary: '설명', extra: true }] } },
      { ...result, models: [{ ...model, extra: true }] },
    ];
    for (const value of invalid) expect(fileExplanationResultSchema.safeParse(value).success).toBe(false);
    expect(saveFileExplanationSchema.safeParse({ projectId: result.projectId, result, path: '/tmp' }).success).toBe(false);
    expect(saveFileExplanationSchema.safeParse({ projectId: 'bad', result }).success).toBe(false);
  });

  it.each([
    { mode: 'other' }, { review: 'checked' }, { jobId: 'bad' }, { projectId: 'bad' }, { relativePath: 'a'.repeat(1025) },
    { range: { ...range, fileHash: 'bad' } }, { range: { ...range, startUtf16: -1 } },
    { range: { ...range, startUtf16: 21 } }, { range: { ...range, endUtf16: 32769 } },
    { range: { ...range, startLine: 0 } }, { range: { ...range, startLine: 2 } },
    { chunks: Array(81).fill(chunk) }, { chunks: [{ ...chunk, name: 'a'.repeat(32769) }] },
    { chunks: [{ ...chunk, functionRange: { startUtf16: 2, endUtf16: 1 } }] },
    { explanation: { ...result.explanation, summary: 'a'.repeat(2001) } },
    { explanation: { ...result.explanation, unknowns: Array(17).fill('unknown') } },
    { limitations: Array(4).fill('limit') }, { limitations: ['a'.repeat(2001)] },
    { models: Array(3).fill(model) }, { models: [{ ...model, reportedModel: 'a'.repeat(121) }] },
  ])('rejects invalid or excessive values %#', invalid => {
    expect(fileExplanationResultSchema.safeParse({ ...result, ...invalid }).success).toBe(false);
  });
});
