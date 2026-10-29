import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { LearningSpot, RecentProject } from '../../shared/contracts';

export class ProjectStorage {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, opened_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS learning_spots (project_id TEXT PRIMARY KEY REFERENCES projects(id), spot TEXT NOT NULL, saved_at TEXT NOT NULL)');
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
  close() { this.db.close(); }
}
