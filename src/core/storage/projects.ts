import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class ProjectStorage {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, opened_at TEXT NOT NULL)');
  }
  recordOpen(root: string, name: string): string {
    const existing = this.db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET name=excluded.name, opened_at=excluded.opened_at')
      .run(id, root, name, new Date().toISOString());
    return id;
  }
  close() { this.db.close(); }
}
