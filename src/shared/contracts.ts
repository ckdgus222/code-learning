import { z } from 'zod';
import type { ConnectionReport, ExplainRequest, LearningEvent } from './ai';

export const idSchema = z.string().uuid();
export const sourceRequestSchema = z.object({ projectId: idSchema, fileId: idSchema }).strict();
export const evidenceRequestSchema = z.object({ projectId: idSchema, evidenceId: idSchema }).strict();
export const projectRequestSchema = z.object({ projectId: idSchema }).strict();

// Offsets refer to the unchanged decoded source: UTF-16, start inclusive/end exclusive.
export interface Evidence {
  id: string;
  projectId: string;
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
}

export interface CodeStep {
  id: string;
  title: string;
  kind: string;
  depth: number;
  evidence: Evidence;
  /** Source text the step decides on or hands back, such as an if condition or a returned value. */
  detail?: string;
  /** If statements only: the step reached when the condition is true or false, inside the same function. */
  branch?: { whenTrue: string | null; whenFalse: string | null };
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  /** Parameter list as written, or '' when the function takes none. */
  params: string;
  /** Exported where it is declared; `export { name }` lists are not followed. */
  exported: boolean;
  evidence: Evidence;
  steps: CodeStep[];
}

export interface Analysis {
  language: 'typescript' | 'javascript' | 'text';
  symbols: CodeSymbol[];
  imports: { text: string; evidence: Evidence }[];
  warnings: string[];
}

export interface ProjectFile { id: string; relativePath: string; size: number }
export interface ProjectFiles {
  id: string;
  name: string;
  files: ProjectFile[];
  excluded: Record<string, number>;
  warnings: string[];
}
/** A README's own words, shown as plain text. Whether they match the code is not checked. */
export interface ProjectIntro {
  fileId: string;
  relativePath: string;
  title: string | null;
  text: string | null;
  startLine: number | null;
  endLine: number | null;
}
/**
 * A place to start reading, chosen from code structure when the project was opened. It is not
 * an Evidence ID: the screen re-reads the file and uses it only if the hash is unchanged.
 */
export interface StartCandidate {
  fileId: string;
  relativePath: string;
  /** null when the file itself is the candidate (an entry file that exports nothing). */
  name: string | null;
  reason: 'package-main' | 'package-bin' | 'entry-name' | 'exported';
  fileHash: string;
  startUtf16: number;
  startLine: number;
}
export interface ProjectOverview {
  intro: ProjectIntro | null;
  candidates: StartCandidate[];
  /** TS/JS files actually read for candidates; `limited` when more existed than were checked. */
  checkedFiles: number;
  limited: boolean;
  notes: string[];
}
export interface ProjectView extends ProjectFiles {
  overview: ProjectOverview;
}
export interface SourceView {
  projectId: string;
  fileId: string;
  relativePath: string;
  hash: string;
  text: string;
  analysis: Analysis;
}

/**
 * One import found while drawing the project map. Like StartCandidate it is not an Evidence ID: the
 * screen re-reads the importing file and highlights the range only while its hash is unchanged.
 */
export interface MapImport {
  fromFileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
  text: string;
  specifier: string | null;
}
export interface MapFile {
  id: string;
  relativePath: string;
  /** The folder the file sits in ('' for the project root); the design view groups by it. */
  folder: string;
  start: boolean;
  /** How far this file was examined: full, partly, not readable, skipped by the map's limits, or not code. */
  checked: 'full' | 'partial' | 'failed' | 'skipped' | 'not-code';
  reason: string | null;
}
export type MapUnresolvedReason = 'not-found' | 'ambiguous' | 'outside' | 'not-static' | 'syntax' | 'unavailable' | 'unreadable';
export interface ProjectMap {
  projectId: string;
  files: MapFile[];
  /** Static imports that lead to exactly one file. An arrow means "uses", not an execution order. */
  edges: (MapImport & { toFileId: string })[];
  unresolved: (MapImport & { reason: MapUnresolvedReason; candidates: string[] })[];
  /** Non-relative specifiers: a package and a path alias cannot be told apart from the import alone. */
  external: MapImport[];
  limited: boolean;
  notes: string[];
}

export type AppErrorCode = 'CANCELLED' | 'INVALID_REQUEST' | 'PROJECT_CLOSED' | 'NOT_ALLOWED' |
  'CHANGED' | 'UNSUPPORTED' | 'LIMIT' | 'IO' | 'INTERNAL' | 'AI_UNAVAILABLE' | 'AI_AUTH' | 'AI_RESPONSE';
export type Result<T> = { ok: true; value: T } | { ok: false; code: AppErrorCode; message: string };
export type ProjectEvent = { projectId: string; kind: 'changed' | 'watch-error' };

export interface LearningApi {
  openProject(): Promise<Result<ProjectView | null>>;
  readSource(input: z.infer<typeof sourceRequestSchema>): Promise<Result<SourceView>>;
  readEvidence(input: z.infer<typeof evidenceRequestSchema>): Promise<Result<{ source: SourceView; evidence: Evidence }>>;
  cancel(): Promise<Result<null>>;
  projectMap(input: z.infer<typeof projectRequestSchema>): Promise<Result<ProjectMap>>;
  cancelProjectMap(input: z.infer<typeof projectRequestSchema>): Promise<Result<null>>;
  checkConnections(): Promise<Result<ConnectionReport>>;
  startExplanation(input: ExplainRequest): Promise<Result<{ jobId: string }>>;
  cancelExplanation(input: { jobId: string }): Promise<Result<null>>;
  onLearningEvent(listener: (event: LearningEvent) => void): () => void;
  onProjectEvent(listener: (event: ProjectEvent) => void): () => void;
}

export const channels = {
  open: 'learning:open', read: 'learning:read', evidence: 'learning:evidence',
  cancel: 'learning:cancel', event: 'learning:project-event', map: 'learning:map', cancelMap: 'learning:cancel-map',
  connections: 'learning:connections', explain: 'learning:explain',
  cancelExplanation: 'learning:cancel-explanation', learningEvent: 'learning:ai-event',
} as const;
