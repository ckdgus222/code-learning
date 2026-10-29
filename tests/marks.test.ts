import { expect, it } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { analyzeSource } from '../src/core/analysis/syntax';
import type { LearningMark, SourceView } from '../src/shared/contracts';
import { functionCodeHash, markKeysOf, markName, markView, nextMark, sameMarkKey } from '../src/renderer/marks';

const key = { relativePath: 'sample.ts', name: 'read', occurrence: 0 };
const oldHash = 'a'.repeat(64);
const currentHash = 'b'.repeat(64);
const saved: LearningMark = { ...key, state: 'understood', note: 'remember', codeHash: oldHash, savedAt: '2026-10-29' };
const sourceOf = (text: string): SourceView => ({ projectId: 'p', fileId: 'f', hash: 'h', relativePath: key.relativePath, text,
  analysis: analyzeSource(text, key.relativePath, { projectId: 'p', fileId: 'f', fileHash: 'h' }), guide: null });

it('removes only the analyzer line suffix', () => {
  expect(markName('map에 넘긴 함수 (2행)')).toBe('map에 넘긴 함수');
  expect(markName('read')).toBe('read');
  expect(markName('read (2행) suffix')).toBe('read (2행) suffix');
});

it('uses analyzer order among equal normalized names, independently of line numbers', () => {
  const before = sourceOf('function read() {}\nitems.map(item => item);\nitems.map(item => item + 1);');
  const after = sourceOf('function read() {\n\n}\nitems.map(item => item);\nitems.map(item => item + 1);');
  expect(before.analysis.symbols[1].name).toBe('map에 넘긴 함수 (2행)');
  expect(after.analysis.symbols[1].name).toBe('map에 넘긴 함수 (4행)');
  expect([...markKeysOf(before).values()]).toEqual([
    key, { ...key, name: 'map에 넘긴 함수', occurrence: 0 }, { ...key, name: 'map에 넘긴 함수', occurrence: 1 },
  ]);
  expect([...markKeysOf(after).values()]).toEqual([...markKeysOf(before).values()]);
  const duplicates = sourceOf('function read() { return 1; } function read() { return 2; }');
  expect([...markKeysOf(duplicates).values()].map(key => key.occurrence)).toEqual([0, 1]);
});

it('compares every part of the stable function key', () => {
  expect(sameMarkKey(saved, key)).toBe(true);
  for (const other of [{ ...key, relativePath: 'other.ts' }, { ...key, name: 'other' }, { ...key, occurrence: 1 }]) {
    expect(sameMarkKey(saved, other)).toBe(false);
  }
});

it('hashes UTF-8 from only the UTF-16 function range using SHA-256', async () => {
  expect(globalThis.crypto.subtle).toBeDefined();
  const input = sourceOf('// 😀 outside\nfunction read() { return "한글 😀"; }\nfunction other() { return 1; }');
  const symbol = input.analysis.symbols[0];
  const body = 'function read() { return "한글 😀"; }';
  const expected = createHash('sha256').update(body).digest('hex');
  expect(await functionCodeHash(input, symbol)).toBe(expected);
  expect(Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex')).toBe(expected);
  const changedOther = sourceOf(input.text.replace('return 1', 'return 200'));
  expect(await functionCodeHash(changedOther, changedOther.analysis.symbols[0])).toBe(expected);
  const changedSelf = sourceOf(input.text.replace('한글', '다름'));
  expect(await functionCodeHash(changedSelf, changedSelf.analysis.symbols[0])).not.toBe(expected);
  expect(await functionCodeHash({ ...input, text: 'abc' }, { ...symbol, evidence: { ...symbol.evidence, startUtf16: 0, endUtf16: 3 } }))
    .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it.each(['understood', 'review', null] as const)('detects changed code for state %s', state => {
  expect(markView({ ...saved, state }, currentHash)).toEqual({ state, note: saved.note, changed: true });
  expect(markView({ ...saved, state }, oldHash).changed).toBe(false);
  expect(markView({ ...saved, state }, undefined).changed).toBe(false);
});

it('shows an unmarked function without marking it understood', () => {
  expect(markView(undefined, currentHash)).toEqual({ state: null, note: '', changed: false });
});

it.each(['understood', 'review', null] as const)('preserves the saved hash and state on a note edit for %s', state => {
  const next = nextMark({ ...saved, state }, { note: 'edited' }, currentHash, key);
  expect(next).toEqual({ ...key, state, note: 'edited', codeHash: oldHash });
  expect(markView({ ...next, savedAt: saved.savedAt }, currentHash).changed).toBe(true);
});

it.each(['understood', 'review', null] as const)('updates the hash and keeps the note on state %s', state => {
  expect(nextMark(saved, { state }, currentHash, key)).toEqual({ ...key, state, note: saved.note, codeHash: currentHash });
});

it.each(['understood', 'review', null] as const)('keeps state %s and the note when confirming current code', state => {
  expect(nextMark({ ...saved, state }, { confirm: true }, currentHash, key))
    .toEqual({ ...key, state, note: saved.note, codeHash: currentHash });
});

it('uses current code for a new note and leaves empty-record deletion to storage', () => {
  expect(nextMark(undefined, { note: 'new' }, currentHash, key)).toEqual({ ...key, state: null, note: 'new', codeHash: currentHash });
  expect(nextMark(undefined, { state: null }, currentHash, key)).toEqual({ ...key, state: null, note: '', codeHash: currentHash });
});
