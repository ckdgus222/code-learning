import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storedLearningMarkSchema } from '../src/shared/contracts';
import { ProjectStorage } from '../src/core/storage/projects';
let temp: string;
let storage: ProjectStorage | undefined;
beforeEach(async () => { temp = await mkdtemp('/private/tmp/learning-storage-test-'); });
afterEach(async () => { storage?.close(); storage = undefined; await rm(temp, { recursive: true, force: true }); });
it('persists stable project IDs by root across reopen while separating different roots', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const first = storage.recordOpen('/projects/a', 'First');
  const second = storage.recordOpen('/projects/b', 'First');
  expect(first).not.toBe(second);
  expect(storage.recordOpen('/projects/a', 'Renamed')).toBe(first);
  storage.close();
  storage = new ProjectStorage(filename);
  expect(storage.recordOpen('/projects/a', 'Renamed')).toBe(first);
  const reader = new DatabaseSync(filename);
  try {
    expect(reader.prepare('SELECT id, root, name FROM projects ORDER BY root').all()).toEqual([
      { id: first, root: '/projects/a', name: 'Renamed' }, { id: second, root: '/projects/b', name: 'First' },
    ]);
  } finally { reader.close(); }
});
it('treats SQL-shaped root and names as data and closes its database', () => {
  storage = new ProjectStorage(path.join(temp, 'app.sqlite'));
  const root = "/tmp/a'); DROP TABLE projects; --";
  const name = "'); DELETE FROM projects; --";
  const id = storage.recordOpen(root, name);
  expect(storage.recordOpen(root, name)).toBe(id);
  expect(storage.recordOpen('/safe', 'Safe')).not.toBe(id);
  const closed = storage;
  closed.close();
  storage = undefined;
  expect(() => closed.recordOpen('/new', 'New')).toThrow();
});

it('lists the ten latest projects and looks up only known roots', () => {
  storage = new ProjectStorage(path.join(temp, 'app.sqlite'));
  const writer = new DatabaseSync(path.join(temp, 'app.sqlite'));
  const ids: string[] = [];
  try {
    for (let index = 0; index < 11; index++) {
      const id = storage.recordOpen(`/projects/${index}`, `Project ${index}`);
      ids.push(id);
      writer.prepare('UPDATE projects SET opened_at = ? WHERE id = ?').run(`2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, id);
    }
    expect(storage.recentProjects(10).map(project => project.id)).toEqual(ids.slice(1).reverse());
    expect(storage.recentProjects(10)[0]).toEqual({ id: ids[10], name: 'Project 10', root: '/projects/10', openedAt: '2026-10-11T00:00:00.000Z' });
    expect(storage.rootOf(ids[0])).toBe('/projects/0');
    expect(storage.rootOf('unknown')).toBeNull();
    storage.recordOpen('/projects/0', 'Reopened');
    expect(storage.recentProjects(10)[0].id).toBe(ids[0]);
  } finally { writer.close(); }
});

it('overwrites, persists and deletes only the chosen project location', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const first = storage.recordOpen('/a', 'A');
  const second = storage.recordOpen('/b', 'B');
  const spot = { version: 1 as const, topic: { name: 'Read', original: 'start', origin: 'start' as const,
    start: { relativePath: 'start.ts', fileHash: 'a'.repeat(64), functionName: 'start', startUtf16: 0 } }, place: null };
  expect(storage.spotOf(first)).toBeNull();
  storage.saveSpot(first, spot);
  storage.saveSpot(second, spot);
  const renamed = { ...spot, topic: { ...spot.topic, name: 'Renamed' } };
  storage.saveSpot(first, renamed);
  storage.close();
  storage = new ProjectStorage(filename);
  expect(storage.spotOf(first)).toEqual({ spot: renamed, savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  expect(storage.spotOf(second)?.spot).toEqual(spot);
  storage.saveSpot(first, null);
  expect(storage.spotOf(first)).toBeNull();
  expect(storage.spotOf(second)?.spot).toEqual(spot);
});

it('opens a legacy projects-only database and leaves malformed saved JSON untouched', () => {
  const filename = path.join(temp, 'app.sqlite');
  const writer = new DatabaseSync(filename);
  try {
    writer.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, opened_at TEXT NOT NULL)');
    writer.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run('legacy', '/old', 'Old', '2026-10-01T00:00:00.000Z');
    storage = new ProjectStorage(filename);
    expect(storage.recordOpen('/old', 'Old')).toBe('legacy');
    writer.prepare('INSERT INTO learning_spots VALUES (?, ?, ?)').run('legacy', '{broken', '2026-10-01T00:00:00.000Z');
    expect(storage.spotOf('legacy')).toBeNull();
    expect(writer.prepare('SELECT spot FROM learning_spots').get()).toEqual({ spot: '{broken' });
    storage.saveSpot('legacy', null);
    expect(storage.recentProjects(10)).toHaveLength(1);
  } finally { writer.close(); }
});

it('upserts one mark per key, separates projects and occurrences, and persists validated rows after reopening', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const first = storage.recordOpen('/a', 'A');
  const second = storage.recordOpen('/b', 'B');
  const mark = { relativePath: 'start.ts', name: 'start', occurrence: 0, state: 'understood' as const, note: '', codeHash: 'a'.repeat(64) };
  expect(storage.marksOf(first)).toEqual([]);
  storage.saveMark(first, mark);
  storage.saveMark(second, mark);
  storage.saveMark(first, { ...mark, occurrence: 1 });
  storage.saveMark(first, { ...mark, relativePath: 'other.ts' });
  storage.saveMark(first, { ...mark, name: 'other' });
  const updated = storage.saveMark(first, { ...mark, state: 'review', note: 'again' });
  expect(updated).toEqual({ ...mark, state: 'review', note: 'again', savedAt: expect.any(String) });
  expect(storedLearningMarkSchema.safeParse(updated).success).toBe(true);
  storage.close();
  storage = new ProjectStorage(filename);
  const rows = storage.marksOf(first).map(row => storedLearningMarkSchema.parse(row));
  expect(rows).toHaveLength(4);
  expect(rows.map(row => [row.relativePath, row.name, row.occurrence])).toEqual([
    ['other.ts', 'start', 0], ['start.ts', 'other', 0], ['start.ts', 'start', 0], ['start.ts', 'start', 1],
  ]);
  expect(rows[2]).toEqual(updated);
  expect(storage.marksOf(second)).toEqual([{ ...mark, savedAt: expect.any(String) }]);
  expect(storage.saveMark(first, { ...mark, state: null, note: ' \n\t' })).toBeNull();
  expect(storage.marksOf(first)).toHaveLength(3);
  expect(storage.marksOf(second)).toHaveLength(1);
  expect(storage.saveMark(first, { ...mark, state: null, note: 'note only' })).toMatchObject({ state: null, note: 'note only' });
  expect(storage.saveMark(first, { ...mark, state: 'understood', note: '   ' })).toMatchObject({ state: 'understood' });
});

it('rejects unknown states in SQLite and retains damaged rows while valid rows pass the read schema', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const id = storage.recordOpen('/a', 'A');
  const writer = new DatabaseSync(filename);
  try {
    const insert = writer.prepare('INSERT INTO learning_marks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    expect(() => insert.run(id, 'a.ts', 'f', 0, 'unknown', '', 'a'.repeat(64), 'now')).toThrow(/CHECK/);
    insert.run(id, 'a.ts', 'f', 0, 'review', '', 'a'.repeat(64), 'now');
    expect(() => insert.run(id, 'a.ts', 'f', 0, 'review', '', 'a'.repeat(64), 'now')).toThrow(/UNIQUE/);
    insert.run(id, 'a.ts', 'bad', 0, null, 'note', 'broken', 'now');
    const rows = storage.marksOf(id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => storedLearningMarkSchema.safeParse(row).success)).toEqual([
      { relativePath: 'a.ts', name: 'f', occurrence: 0, state: 'review', note: '', codeHash: 'a'.repeat(64), savedAt: 'now' },
    ]);
    expect(storage.marksOf(id)).toHaveLength(2);
  } finally { writer.close(); }
});

it('persists one file explanation per path and project, and deletes only that row', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const first = storage.recordOpen('/a', 'A');
  const second = storage.recordOpen('/b', 'B');
  expect(storage.fileExplanationOf(first, 'start.ts')).toBeNull();
  storage.saveFileExplanation(first, 'start.ts', { summary: 'old' });
  storage.saveFileExplanation(second, 'start.ts', { summary: 'other project' });
  storage.saveFileExplanation(first, 'other.ts', { summary: 'other file' });
  const savedAt = storage.saveFileExplanation(first, 'start.ts', { summary: 'new' });
  expect(new Date(savedAt).toISOString()).toBe(savedAt);
  storage.close();
  storage = new ProjectStorage(filename);
  expect(storage.fileExplanationOf(first, 'start.ts')).toEqual({ result: { summary: 'new' }, savedAt });
  const reader = new DatabaseSync(filename);
  try {
    expect(reader.prepare('SELECT COUNT(*) AS count FROM ai_file_explanations').get()).toEqual({ count: 3 });
  } finally { reader.close(); }
  storage.deleteFileExplanation(first, 'start.ts');
  storage.deleteFileExplanation(first, 'start.ts');
  expect(storage.fileExplanationOf(first, 'start.ts')).toBeNull();
  expect(storage.fileExplanationOf(second, 'start.ts')?.result).toEqual({ summary: 'other project' });
  expect(storage.fileExplanationOf(first, 'other.ts')?.result).toEqual({ summary: 'other file' });
});

it('retains malformed file explanation JSON until an explicit replacement or deletion', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const projectId = storage.recordOpen('/a', 'A');
  const writer = new DatabaseSync(filename);
  try {
    writer.prepare('INSERT INTO ai_file_explanations VALUES (?, ?, ?, ?)').run(projectId, 'a.ts', '{broken', 'now');
    expect(storage.fileExplanationOf(projectId, 'a.ts')).toBeNull();
    expect(writer.prepare('SELECT result FROM ai_file_explanations').get()).toEqual({ result: '{broken' });
    storage.saveFileExplanation(projectId, 'a.ts', { summary: 'recovered' });
    expect(storage.fileExplanationOf(projectId, 'a.ts')?.result).toEqual({ summary: 'recovered' });
  } finally { writer.close(); }
});


it('replaces one overview per project, persists it across reopening and deletes only that project', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const first = storage.recordOpen('/a', 'A');
  const second = storage.recordOpen('/b', 'B');
  expect(storage.overviewOf(first)).toBeNull();
  storage.saveOverview(first, { summary: 'old' });
  storage.saveOverview(second, { summary: 'other' });
  const savedAt = storage.saveOverview(first, { summary: 'new' });
  expect(new Date(savedAt).toISOString()).toBe(savedAt);
  storage.close();
  storage = new ProjectStorage(filename);
  expect(storage.overviewOf(first)).toEqual({ result: { summary: 'new' }, savedAt });
  storage.deleteOverview(first);
  storage.deleteOverview(first);
  expect(storage.overviewOf(first)).toBeNull();
  expect(storage.overviewOf(second)?.result).toEqual({ summary: 'other' });
});

it('retains malformed overview JSON until replacement or explicit deletion', () => {
  const filename = path.join(temp, 'app.sqlite');
  storage = new ProjectStorage(filename);
  const projectId = storage.recordOpen('/a', 'A');
  const writer = new DatabaseSync(filename);
  try {
    writer.prepare('INSERT INTO ai_overviews VALUES (?, ?, ?)').run(projectId, '{broken', 'now');
    expect(storage.overviewOf(projectId)).toBeNull();
    expect(writer.prepare('SELECT result FROM ai_overviews').get()).toEqual({ result: '{broken' });
    storage.saveOverview(projectId, { summary: 'recovered' });
    expect(storage.overviewOf(projectId)?.result).toEqual({ summary: 'recovered' });
    expect(writer.prepare('SELECT COUNT(*) AS count FROM ai_overviews').get()).toEqual({ count: 1 });
  } finally { writer.close(); }
});
