import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
