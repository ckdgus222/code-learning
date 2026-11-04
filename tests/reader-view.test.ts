import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/core/analysis/syntax';
import { symbolMeta } from '../src/renderer/reader-view';

describe('code reader function metadata', () => {
  it('shows the inclusive line range and step count', () => {
    const { symbols } = analyzeSource('// before\nfunction run(input: number) {\n  if (input < 0) return 0;\n  return input;\n}',
      'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    expect(symbolMeta(symbols[0])).toBe('2–5행 · 단계 3개');
  });

  it('omits the step count for an empty single-line function', () => {
    const { symbols } = analyzeSource('function empty() {}', 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    expect(symbolMeta(symbols[0])).toBe('1–1행');
  });
});
