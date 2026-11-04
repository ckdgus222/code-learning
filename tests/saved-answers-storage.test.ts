import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_SAVED_ANSWERS, ProjectStorage } from '../src/core/storage/projects';

afterEach(() => vi.useRealTimers());

it('saves, lists newest first including ties, reads, replaces and deletes within a project', () => {
  const storage = new ProjectStorage(':memory:');
  try {
    const first = storage.recordOpen('/first', 'first');
    const second = storage.recordOpen('/second', 'second');
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    const at = storage.saveAnswer(first, 'one', { question: 'one' });
    storage.saveAnswer(first, 'two', { question: 'two' });
    storage.saveAnswer(second, 'one', { question: 'other project' });
    expect(storage.answersOf(first).map(row => row.jobId)).toEqual(['two', 'one']);
    expect(storage.answerOf(first, 'one')).toEqual({ result: { question: 'one' }, savedAt: at });
    storage.saveAnswer(first, 'one', { question: 'replacement' });
    expect(storage.answersOf(first).map(row => row.jobId)).toEqual(['one', 'two']);
    storage.deleteAnswer(first, 'one');
    expect(storage.answerOf(first, 'one')).toBeNull();
    expect(storage.answersOf(first)).toHaveLength(1);
    expect(storage.answerOf(second, 'one')?.result).toEqual({ question: 'other project' });
  } finally { storage.close(); }
});

it('keeps exactly the newest 50 by time then rowid, with trimming isolated to each project', () => {
  const storage = new ProjectStorage(':memory:');
  try {
    const first = storage.recordOpen('/first', 'first');
    const second = storage.recordOpen('/second', 'second');
    storage.saveAnswer(second, 'old', {});
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    storage.saveAnswer(first, 'older', {});
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    for (let i = 0; i < 51; i++) storage.saveAnswer(first, String(i), {});
    expect(MAX_SAVED_ANSWERS).toBe(50);
    expect(storage.answersOf(first)).toHaveLength(50);
    expect(storage.answerOf(first, 'older')).toBeNull();
    expect(storage.answerOf(first, '0')).toBeNull();
    expect(storage.answersOf(first).map(row => row.jobId)).toEqual(Array.from({ length: 50 }, (_, i) => String(50 - i)));
    expect(storage.answerOf(second, 'old')).not.toBeNull();
  } finally { storage.close(); }
});

it('skips corrupt JSON without deleting it and rolls back a failed transaction', async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-answers-storage-')));
  const filename = path.join(temporary, 'learning.sqlite');
  const storage = new ProjectStorage(filename);
  const db = new DatabaseSync(filename);
  try {
    const project = storage.recordOpen('/first', 'first');
    storage.saveAnswer(project, 'valid', { question: 'valid' });
    db.prepare('INSERT INTO ai_answers VALUES (?, ?, ?, ?)').run(project, 'broken', '{broken', 'now');
    expect(storage.answerOf(project, 'broken')).toBeNull();
    expect(storage.answersOf(project).map(row => row.jobId)).toEqual(['valid']);
    expect(db.prepare('SELECT result FROM ai_answers WHERE job_id = ?').get('broken')).toEqual({ result: '{broken' });
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => storage.saveAnswer(project, 'valid', cyclic)).toThrow();
    expect(storage.answerOf(project, 'valid')?.result).toEqual({ question: 'valid' });
    storage.saveAnswer(project, 'after', {});
    expect(storage.answersOf(project)).toHaveLength(2);
    for (let index = 0; index < 48; index++) storage.saveAnswer(project, String(index), {});
    db.exec("CREATE TRIGGER refuse_trim BEFORE DELETE ON ai_answers BEGIN SELECT RAISE(ABORT, 'test trim failure'); END");
    expect(() => storage.saveAnswer(project, 'rolled-back', {})).toThrow('test trim failure');
    expect(storage.answerOf(project, 'rolled-back')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_answers').get()).toEqual({ count: 50 });
    db.exec('DROP TRIGGER refuse_trim');
  } finally { db.close(); storage.close(); await rm(temporary, { recursive: true, force: true }); }
});
