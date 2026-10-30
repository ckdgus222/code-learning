import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { LearningMark, LearningSpot, RecentProject } from '../../shared/contracts';

export const MAX_SAVED_ANSWERS = 50;

export class ProjectStorage {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, opened_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS learning_spots (project_id TEXT PRIMARY KEY REFERENCES projects(id), spot TEXT NOT NULL, saved_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS ai_feature_guides (project_id TEXT PRIMARY KEY REFERENCES projects(id), result TEXT NOT NULL, material_hash TEXT NOT NULL, saved_at TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ai_answers (
      project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL,
      result TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY (project_id, job_id))`);
    this.db.exec('CREATE TABLE IF NOT EXISTS ai_overviews (project_id TEXT PRIMARY KEY REFERENCES projects(id), result TEXT NOT NULL, saved_at TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ai_file_explanations (
      project_id TEXT NOT NULL REFERENCES projects(id), relative_path TEXT NOT NULL,
      result TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY (project_id, relative_path))`);
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
  saveAnswer(projectId: string, jobId: string, result: unknown): string {
    const savedAt = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO ai_answers VALUES (?, ?, ?, ?)').run(projectId, jobId, JSON.stringify(result), savedAt);
      this.db.prepare(`DELETE FROM ai_answers WHERE project_id = ? AND rowid NOT IN (
        SELECT rowid FROM ai_answers WHERE project_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT ?)`)
        .run(projectId, projectId, MAX_SAVED_ANSWERS);
      this.db.exec('COMMIT');
      return savedAt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  answersOf(projectId: string): { jobId: string; result: unknown; savedAt: string }[] {
    const rows = this.db.prepare('SELECT job_id AS jobId, result, saved_at AS savedAt FROM ai_answers WHERE project_id = ? ORDER BY saved_at DESC, rowid DESC')
      .all(projectId) as { jobId: string; result: string; savedAt: string }[];
    return rows.flatMap(row => {
      try { return [{ ...row, result: JSON.parse(row.result) }]; }
      catch { return []; }
    });
  }
  answerOf(projectId: string, jobId: string): { result: unknown; savedAt: string } | null {
    const row = this.db.prepare('SELECT result, saved_at AS savedAt FROM ai_answers WHERE project_id = ? AND job_id = ?')
      .get(projectId, jobId) as { result: string; savedAt: string } | undefined;
    if (!row) return null;
    try { return { result: JSON.parse(row.result), savedAt: row.savedAt }; }
    catch { return null; }
  }
  deleteAnswer(projectId: string, jobId: string): void {
    this.db.prepare('DELETE FROM ai_answers WHERE project_id = ? AND job_id = ?').run(projectId, jobId);
  }
  saveOverview(projectId: string, result: unknown): string {
    const savedAt = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO ai_overviews VALUES (?, ?, ?)').run(projectId, JSON.stringify(result), savedAt);
    return savedAt;
  }
  overviewOf(projectId: string): { result: unknown; savedAt: string } | null {
    const row = this.db.prepare('SELECT result, saved_at AS savedAt FROM ai_overviews WHERE project_id = ?')
      .get(projectId) as { result: string; savedAt: string } | undefined;
    if (!row) return null;
    try { return { result: JSON.parse(row.result), savedAt: row.savedAt }; }
    catch { return null; }
  }
  deleteOverview(projectId: string): void {
    this.db.prepare('DELETE FROM ai_overviews WHERE project_id = ?').run(projectId);
  }
  saveFeatureGuide(projectId: string, result: unknown, materialHash: string): string {
    const savedAt = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO ai_feature_guides VALUES (?, ?, ?, ?)')
      .run(projectId, JSON.stringify(result), materialHash, savedAt);
    return savedAt;
  }
  featureGuideOf(projectId: string): { result: unknown; materialHash: string; savedAt: string } | null {
    const row = this.db.prepare('SELECT result, material_hash AS materialHash, saved_at AS savedAt FROM ai_feature_guides WHERE project_id = ?')
      .get(projectId) as { result: string; materialHash: string; savedAt: string } | undefined;
    if (!row) return null;
    try { return { result: JSON.parse(row.result), materialHash: row.materialHash, savedAt: row.savedAt }; }
    catch { return null; }
  }
  deleteFeatureGuide(projectId: string): void {
    this.db.prepare('DELETE FROM ai_feature_guides WHERE project_id = ?').run(projectId);
  }
  saveFileExplanation(projectId: string, relativePath: string, result: unknown): string {
    const savedAt = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO ai_file_explanations VALUES (?, ?, ?, ?)')
      .run(projectId, relativePath, JSON.stringify(result), savedAt);
    return savedAt;
  }
  fileExplanationOf(projectId: string, relativePath: string): { result: unknown; savedAt: string } | null {
    const row = this.db.prepare('SELECT result, saved_at AS savedAt FROM ai_file_explanations WHERE project_id = ? AND relative_path = ?')
      .get(projectId, relativePath) as { result: string; savedAt: string } | undefined;
    if (!row) return null;
    try { return { result: JSON.parse(row.result), savedAt: row.savedAt }; }
    catch { return null; }
  }
  deleteFileExplanation(projectId: string, relativePath: string): void {
    this.db.prepare('DELETE FROM ai_file_explanations WHERE project_id = ? AND relative_path = ?').run(projectId, relativePath);
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
