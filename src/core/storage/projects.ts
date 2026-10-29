import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { LearningMark, LearningSpot, RecentProject } from '../../shared/contracts';

export class ProjectStorage {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, opened_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS learning_spots (project_id TEXT PRIMARY KEY REFERENCES projects(id), spot TEXT NOT NULL, saved_at TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS learning_marks (
      project_id TEXT NOT NULL REFERENCES projects(id), relative_path TEXT NOT NULL, name TEXT NOT NULL,
      occurrence INTEGER NOT NULL, state TEXT CHECK (state IN ('understood', 'review')), note TEXT NOT NULL,
      code_hash TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY (project_id, relative_path, name, occurrence))`);
  }
  recordOpen(root: string, name: string): string {
    const existing = this.db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET name=excluded.name, opened_at=excluded.opened_at')
      .run(id, root, name, new Date().toISOString());
    return id;
  }
  recentProjects(limit: number): RecentProject[] {
    return this.db.prepare('SELECT id, name, root, opened_at AS openedAt FROM projects ORDER BY opened_at DESC, rowid DESC LIMIT ?')
      .all(limit) as unknown as RecentProject[];
  }
  rootOf(id: string): string | null {
    const row = this.db.prepare('SELECT root FROM projects WHERE id = ?').get(id) as { root: string } | undefined;
    return row?.root ?? null;
  }
  saveSpot(projectId: string, spot: LearningSpot | null) {
    if (spot === null) {
      this.db.prepare('DELETE FROM learning_spots WHERE project_id = ?').run(projectId);
      return;
    }
    this.db.prepare('INSERT INTO learning_spots VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET spot=excluded.spot, saved_at=excluded.saved_at')
      .run(projectId, JSON.stringify(spot), new Date().toISOString());
  }
  spotOf(projectId: string): { spot: unknown; savedAt: string } | null {
    const row = this.db.prepare('SELECT spot, saved_at AS savedAt FROM learning_spots WHERE project_id = ?')
      .get(projectId) as { spot: string; savedAt: string } | undefined;
    if (!row) return null;
    try { return { spot: JSON.parse(row.spot), savedAt: row.savedAt }; }
    catch { return null; }
  }
  marksOf(projectId: string): unknown[] {
    return this.db.prepare(`SELECT relative_path AS relativePath, name, occurrence, state, note,
      code_hash AS codeHash, saved_at AS savedAt FROM learning_marks WHERE project_id = ?
      ORDER BY relative_path, name, occurrence`).all(projectId);
  }
  saveMark(projectId: string, mark: Omit<LearningMark, 'savedAt'>): LearningMark | null {
    if (mark.state === null && mark.note.trim() === '') {
      this.db.prepare('DELETE FROM learning_marks WHERE project_id = ? AND relative_path = ? AND name = ? AND occurrence = ?')
        .run(projectId, mark.relativePath, mark.name, mark.occurrence);
      return null;
    }
    const savedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO learning_marks VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, relative_path, name, occurrence) DO UPDATE SET
      state=excluded.state, note=excluded.note, code_hash=excluded.code_hash, saved_at=excluded.saved_at`)
      .run(projectId, mark.relativePath, mark.name, mark.occurrence, mark.state, mark.note, mark.codeHash, savedAt);
    return { ...mark, savedAt };
  }
  close() { this.db.close(); }
}
