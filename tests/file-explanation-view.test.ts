import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitFileChunks } from '../src/core/analysis/file-chunks';
import { FileExplanationCard, rememberFileExplanation, type FileExplanationEntry } from '../src/renderer/file-explanation';
import type { SourceView } from '../src/shared/contracts';

function entry(count = 80): FileExplanationEntry {
  const text = Array.from({ length: count }, (_, i) => `const value${i} = ${i};`).join('\n');
  const fileId = randomUUID();
  const hash = 'a'.repeat(64);
  const { chunks } = splitFileChunks(text, 'file.ts', fileId, hash);
  return { revision: 1, savedAt: null, result: { jobId: randomUUID(), projectId: randomUUID(), relativePath: 'file.ts', mode: 'codex',
    range: { fileId, fileHash: hash, startUtf16: 0, endUtf16: text.length, startLine: 1, endLine: count },
    chunks, explanation: { summary: '상수를 선언하는 파일입니다.', chunks: chunks.slice(1).map(chunk => ({ chunkId: chunk.id, summary: `${chunk.name} 설명` })), unknowns: [] },
    limitations: [], models: [{ provider: 'codex', stage: 'explaining', requestedModel: null, reportedModel: 'test-model' }], review: 'AI 대조 없음' } };
}

describe('file explanation result retention and display', () => {
  it('keeps all 80 ranges while 20 different file results are held and evicts the first on the 21st', () => {
    const first = entry();
    const last = first.result.chunks.at(-1)!.range;
    let entries = rememberFileExplanation([], first);
    for (let i = 0; i < 19; i++) entries = rememberFileExplanation(entries, entry());
    expect(entries).toHaveLength(20);
    expect(entries[0]).toBe(first);
    expect(entries[0].result.chunks).toHaveLength(80);
    expect(entries[0].result.chunks.at(-1)!.range).toEqual(last);
    entries = rememberFileExplanation(entries, entry());
    expect(entries).toHaveLength(20);
    expect(entries.some(item => item.result.range.fileId === first.result.range.fileId)).toBe(false);
    expect(entries.flatMap(item => item.result.chunks).some(chunk => chunk.range === last)).toBe(false);
  });

  it('replaces a regenerated file and makes it the most recent, keeping the result and ranges together', () => {
    const first = entry();
    const second = entry();
    const next = { ...first, result: { ...first.result, range: { ...first.result.range, fileHash: 'b'.repeat(64) }, chunks: [] } };
    const saved = rememberFileExplanation([first, second], next);
    expect(saved).toEqual([second, next]);
    expect(saved.some(item => item.result.range.fileHash === first.result.range.fileHash && item.result.range.fileId === first.result.range.fileId)).toBe(false);
  });

  it('shows six chunks, missing summaries, unknowns, mode/model and a stale disabled range', () => {
    const saved = entry();
    const source: SourceView = { projectId: saved.result.projectId, fileId: saved.result.range.fileId, hash: saved.result.range.fileHash,
      relativePath: 'file.ts', text: 'const value = 1;', guide: null, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
    const html = renderToStaticMarkup(React.createElement(FileExplanationCard, { source, entry: saved, state: null,
      stale: true, mode: 'codex', locked: false, running: false, checking: false, connections: null,
      onInspect() {}, onEnsure() {}, onStart() {}, onCancel() {}, onDelete() {}, onShow() {} }));
    expect(html).toContain('설명 없음');
    expect(html.match(/>코드 보기<\/button>/g)).toHaveLength(6);
    expect(html).toContain('더 보기');
    expect(html).not.toContain('const value6');
    expect(html).toContain('확인하지 못한 것');
    expect(html).toContain('AI 해석이며 정확성을 보장하지 않아요');
    expect(html).toContain('Codex 단독');
    expect(html).toContain('test-model');
    expect(html).toContain('다시 확인 필요');
    expect(html).toMatch(/disabled="">파일 전체 근거/);
    expect(html.match(/disabled="">코드 보기/g)).toHaveLength(6);
  });
});

it.each([null, '2026-10-30T00:00:00.000Z'])('offers deletion with a saved date only when stored: %s', savedAt => {
  const saved = { ...entry(1), savedAt };
  const source: SourceView = { projectId: saved.result.projectId, fileId: saved.result.range.fileId, hash: saved.result.range.fileHash,
    relativePath: 'file.ts', text: 'const value = 1;', guide: null, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
  const props = { source, entry: saved, state: null, stale: false, mode: 'codex' as const, locked: false,
    running: false, checking: false, connections: null,
    onInspect() {}, onEnsure() {}, onStart() {}, onCancel() {}, onDelete() {}, onShow() {} };
  const html = renderToStaticMarkup(React.createElement(FileExplanationCard, props));
  expect(html).toContain('>지우기</button>');
  expect(html.includes('저장됨 ·')).toBe(savedAt !== null);
  if (savedAt) expect(html).toContain(new Date(savedAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }));
  for (const blocked of [{ locked: true }, { running: true }]) {
    expect(renderToStaticMarkup(React.createElement(FileExplanationCard, { ...props, ...blocked }))).toMatch(/disabled="">지우기/);
  }
  expect(renderToStaticMarkup(React.createElement(FileExplanationCard, { ...props, state: {
    status: 'running', fileId: source.fileId, revision: 1, phase: null, mode: 'codex',
  } }))).not.toContain('>지우기</button>');
});
