import { describe, expect, it } from 'vitest';
import { changedLineCounts, codeLines } from '../src/renderer/changed-line-counts';

it.each([
  ['', []], ['x', ['x']], ['a\n', ['a\n']], ['a\nb', ['a\n', 'b']],
  ['\n\n', ['\n', '\n']], ['a\r\n', ['a\r\n']],
])('keeps line endings without an empty trailing fragment: %j', (text, lines) => {
  expect(codeLines(text as string)).toEqual(lines);
});

describe('shortest changed line counts', () => {
  it.each([
    ['', '', 0, 0], ['a\nb\n', 'a\nb\n', 0, 0], ['a\n', 'b\n', 1, 1],
    ['a\n\nb\n', 'c\n\nd\n', 2, 2], ['a\n', 'a\nb\nc\n', 2, 0],
    ['a\nb\nc\n', 'a\n', 0, 2], ['', 'x', 1, 0], ['a\n', 'a', 1, 1],
    ['a\r\n', 'a\n', 1, 1], ['d\na\nd\n', 'a\nc\nd\nc\n', 2, 1],
  ])('counts %j → %j as +%i −%i', (before, after, added, removed) => {
    expect(changedLineCounts(before, after)).toEqual({ added, removed });
  });

  it('accepts the exact edit limit and rejects one less, including zero', () => {
    expect(changedLineCounts('a\n', 'b\n', 2)).toEqual({ added: 1, removed: 1 });
    expect(changedLineCounts('a\n', 'b\n', 1)).toBeNull();
    expect(changedLineCounts('', 'a\nb\n', 1)).toBeNull();
    expect(changedLineCounts('a\nb\n', '', 1)).toBeNull();
    expect(changedLineCounts('a\n', 'a\n', 0)).toEqual({ added: 0, removed: 0 });
    expect(changedLineCounts('a\n', 'b\n', 0)).toBeNull();
  });

  it('matches an independent LCS calculation for 800 seeded small pairs', () => {
    let seed = 591;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % max; };
    const lines = () => Array.from({ length: random(9) }, () => ['a\n', 'b\n', 'c\n', '\n'][random(4)]);
    for (let sample = 0; sample < 800; sample++) {
      const before = lines(), after = lines();
      const lcs = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
      for (let i = 1; i <= before.length; i++) for (let j = 1; j <= after.length; j++) {
        lcs[i][j] = before[i - 1] === after[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
      const common = lcs[before.length][after.length];
      const expected = { added: after.length - common, removed: before.length - common };
      expect(changedLineCounts(before.join(''), after.join(''))).toEqual(expected);
      const distance = expected.added + expected.removed;
      expect(changedLineCounts(before.join(''), after.join(''), distance)).toEqual(expected);
      if (distance > 0) expect(changedLineCounts(before.join(''), after.join(''), distance - 1)).toBeNull();
    }
  });

  it('counts 29 replacements across 20,000 lines within 200 ms', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`);
    const after = before.map((line, i) => i % 700 === 0 ? `changed ${i}\n` : line);
    const oldText = before.join(''), newText = after.join('');
    const start = performance.now();
    expect(changedLineCounts(oldText, newText)).toEqual({ added: 29, removed: 29 });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('counts dozens of changes in two 256 KiB documents within 200 ms', () => {
    const before = Array.from({ length: 4096 }, (_, i) => `${String(i).padStart(63, 'a')}\n`);
    const after = before.map((line, i) => i % 100 === 0 ? `b${line.slice(1)}` : line);
    const oldText = before.join(''), newText = after.join('');
    expect(Buffer.byteLength(oldText)).toBe(256 * 1024);
    expect(Buffer.byteLength(newText)).toBe(256 * 1024);
    const start = performance.now();
    expect(changedLineCounts(oldText, newText)).toEqual({ added: 41, removed: 41 });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('stops at the edit budget for completely different 20,000-line documents within 200 ms', () => {
    const before = 'a\n'.repeat(20_000), after = 'b\n'.repeat(20_000);
    const start = performance.now();
    expect(changedLineCounts(before, after)).toBeNull();
    expect(performance.now() - start).toBeLessThan(200);
  });
});
