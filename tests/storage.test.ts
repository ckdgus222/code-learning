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
