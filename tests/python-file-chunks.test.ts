import { describe, expect, it } from 'vitest';
import { splitFileChunks, splitPythonFileChunks } from '../src/core/analysis/file-chunks';
import { analyzeSource } from '../src/core/analysis/syntax';
const id = 'python-file';
const hash = 'a'.repeat(64);
const split = (text: string) => splitPythonFileChunks(text, 'sample.py', id, hash);

describe('Python static file chunks', () => {
  it('groups adjacent future, plain and from imports without swallowing later statements', () => {
    const text = 'from __future__ import annotations\nimport os\nfrom .helper import run\nx = 1\n';
    const chunks = split(text).chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks[0].kind).toBe('imports');
    expect(text.slice(chunks[0].range.startUtf16, chunks[0].range.endUtf16)).toBe(text.split('\n').slice(0, 3).join('\n'));
    expect(chunks[1].kind).toBe('variable');
  });
  it('ends import groups at blank lines or comments', () => {
    const chunks = split('import os\n\nimport sys\n# comment\nimport math\n').chunks;
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => chunk.kind === 'imports')).toBe(true);
  });
  it('keeps decorators in exact function and direct method evidence', () => {
    const text = '@deco\ndef top():\n    pass\n@deco\nclass C:\n    field = 1\n    @deco\n    async def method(self):\n        pass\n';
    const chunks = split(text).chunks;
    const symbols = analyzeSource(text, 'sample.py', { projectId: 'p', fileId: id, fileHash: hash }).symbols;
    expect(chunks.filter(chunk => chunk.kind === 'class')).toHaveLength(1);
    const header = chunks.find(chunk => chunk.kind === 'class')!;
    expect(text.slice(header.range.startUtf16, header.range.endUtf16)).toBe('@deco\nclass C:');
    expect(chunks.some(chunk => chunk.kind === 'variable' && text.slice(chunk.range.startUtf16, chunk.range.endUtf16) === 'field = 1')).toBe(true);
    for (const symbol of symbols) {
      const chunk = chunks.find(chunk => chunk.functionRange?.startUtf16 === symbol.evidence.startUtf16 && chunk.functionRange?.endUtf16 === symbol.evidence.endUtf16);
      expect(chunk, symbol.name).toBeDefined();
      expect(text.slice(chunk!.range.startUtf16, chunk!.range.endUtf16)).toContain('@deco');
    }
  });
  it('keeps nested functions, lambdas and conditional definitions inside their enclosing chunk', () => {
    const text = 'def outer():\n    def inner():\n        pass\n    callback = lambda: 1\n    class Nested:\n        pass\nif flag:\n    def conditional():\n        pass\n';
    const chunks = split(text).chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks.filter(chunk => chunk.functionRange)).toHaveLength(1);
    expect(text.slice(chunks[0].range.startUtf16, chunks[0].range.endUtf16)).toContain('class Nested');
    expect(text.slice(chunks[1].range.startUtf16, chunks[1].range.endUtf16)).toContain('def conditional');
  });
  it('retains good neighboring statements while reporting malformed items', () => {
    const text = 'first = 1\n)\nlast = 2\n';
    const result = split(text);
    expect(result.limitations.length).toBeGreaterThan(0);
    const pieces = result.chunks.map(chunk => text.slice(chunk.range.startUtf16, chunk.range.endUtf16));
    expect(pieces).toEqual(expect.arrayContaining(['first = 1', 'last = 2']));
    expect(pieces.some(piece => piece.includes(')'))).toBe(false);
  });
  it('caps chunks at eighty and reports the remaining items', () => {
    const result = split(Array.from({ length: 85 }, (_, index) => `value${index} = ${index}`).join('\n'));
    expect(result.chunks).toHaveLength(80);
    expect(result.limitations.length).toBeGreaterThan(0);
  });
  it('uses exact UTF-16 and line ranges after astral Unicode', () => {
    const text = '# 😀\nname = "한글"\ndef run():\n    return name\n';
    const result = split(text);
    for (const chunk of result.chunks) {
      expect(chunk.range).toMatchObject({ fileId: id, fileHash: hash });
      expect(chunk.range.startLine).toBe(text.slice(0, chunk.range.startUtf16).split('\n').length);
    }
    expect(text.slice(result.chunks[0].range.startUtf16, result.chunks[0].range.endUtf16)).toBe('name = "한글"');
  });
  it('uses the same Python chunk ranges through the AI entry point', () => {
    const text = 'x = 1\n@deco\ndef run():\n    return x\n';
    const withoutIds = (result: ReturnType<typeof split>) => result.chunks.map(({ id: _id, ...chunk }) => chunk);
    expect(withoutIds(splitFileChunks(text, 'sample.py', id, hash))).toEqual(withoutIds(split(text)));
  });
  it('honors cancellation during static Python chunk traversal', () => {
    expect(() => splitPythonFileChunks('x = 1\n', 'sample.py', id, hash, undefined, () => true))
      .toThrow(expect.objectContaining({ code: 'CANCELLED' }));
  });
});
