import { z } from 'zod';
import { idSchema, type Evidence } from './contracts';

export const GEMINI_MODEL = 'gemini-3.8-flash-high';
export const learningModeSchema = z.enum(['local-worker', 'codex', 'claude-code', 'antigravity']);
export type LearningMode = z.infer<typeof learningModeSchema>;
export type ProviderId = Exclude<LearningMode, 'local-worker'>;
export const explainRequestSchema = z.object({
  projectId: idSchema, evidenceId: idSchema,
  expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/),
  question: z.string().trim().min(1).max(2000),
  mode: learningModeSchema,
  consent: z.literal(true),
  conversationId: idSchema.optional(),
}).strict();
export const cancelExplanationSchema = z.object({ jobId: idSchema }).strict();
export type ExplainRequest = z.infer<typeof explainRequestSchema>;

export const fileExplanationRequestSchema = z.object({
  projectId: idSchema, fileId: idSchema,
  expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: learningModeSchema, consent: z.literal(true),
}).strict();
export type FileExplanationRequest = z.infer<typeof fileExplanationRequestSchema>;

export const featureGuideRequestSchema = z.object({
  projectId: idSchema, routesId: idSchema, mode: learningModeSchema, consent: z.literal(true),
}).strict();
export type FeatureGuideRequest = z.infer<typeof featureGuideRequestSchema>;
export const featureGuideSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  groups: z.array(z.object({
    name: z.string().trim().min(1).max(40), about: z.string().trim().min(1).max(200),
    features: z.array(z.object({
      name: z.string().trim().min(1).max(60), about: z.string().trim().min(1).max(200),
      routes: z.array(z.number().int().min(0)).min(1).max(20),
    }).strict()).max(40),
  }).strict()).max(20),
  unknowns: z.array(z.string().trim().min(1).max(2000)).max(10),
}).strict();
export type FeatureGuide = z.infer<typeof featureGuideSchema>;
export const featureGuideReviewSchema = z.object({
  accepted: z.boolean(), issues: z.array(z.string().trim().min(1).max(2000)).max(16), guide: featureGuideSchema,
}).strict();
export interface FeatureGuideResult {
  jobId: string; projectId: string; routesId: string; guide: FeatureGuide; limitations: string[];
  mode: LearningMode; review: 'AI 검토됨' | 'AI 대조 없음'; models: ModelRun[];
}

const description = z.string().trim().min(1).max(2000);
export const fileExplanationSchema = z.object({
  summary: description,
  chunks: z.array(z.object({ chunkId: idSchema, summary: description }).strict()).max(80),
  unknowns: z.array(description).max(16),
}).strict();
export type FileExplanation = z.infer<typeof fileExplanationSchema>;
export const fileExplanationReviewSchema = z.object({
  accepted: z.boolean(), issues: z.array(description).max(16), explanation: fileExplanationSchema,
}).strict();
/** Stored with the explanation, independent of the AI and analysis workers' evidence caches. */
export type FileExplanationRange = Pick<Evidence, 'fileId' | 'fileHash' | 'startUtf16' | 'endUtf16' | 'startLine' | 'endLine'>;
export interface FileChunk {
  id: string;
  kind: 'imports' | 'class' | 'function' | 'field' | 'variable' | 'statement';
  name: string;
  range: FileExplanationRange;
  functionRange: { startUtf16: number; endUtf16: number } | null;
}
export interface FileExplanationResult {
  jobId: string;
  projectId: string;
  relativePath: string;
  range: FileExplanationRange;
  chunks: FileChunk[];
  explanation: FileExplanation;
  limitations: string[];
  mode: LearningMode;
  review: 'AI 검토됨' | 'AI 대조 없음';
  models: ModelRun[];
}
const references = z.array(idSchema).min(1).max(16);
export const explanationSchema = z.object({
  summary: description,
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    input: description, action: description, output: description,
    alternatives: z.array(description).max(8), evidenceIds: references,
  }).strict()).max(32),
  // A plain union becomes anyOf in JSON Schema. Codex sends the schema to OpenAI's strict structured
  // output, whose supported keywords include anyOf but not the oneOf a discriminated union becomes.
  claims: z.array(z.union([
    z.object({ kind: z.literal('code'), text: description, evidenceIds: references }).strict(),
    z.object({ kind: z.literal('concept'), text: description }).strict(),
  ])).min(1).max(64),
  terms: z.array(z.object({ term: z.string().trim().min(1).max(160), meaning: description }).strict()).max(32),
  examples: z.array(z.object({
    given: z.string().trim().min(1).max(300), result: description, evidenceIds: references,
  }).strict()).max(3),
  unknowns: z.array(description).max(32),
}).strict();
export type Explanation = z.infer<typeof explanationSchema>;
export const organizationSchema = z.object({
  focus: description, questions: z.array(description).max(8), evidenceIds: references,
  requestedFileIds: z.array(idSchema).max(4),
}).strict();
export const reviewSchema = z.object({
  accepted: z.boolean(), issues: z.array(description).max(16), explanation: explanationSchema,
}).strict();

/**
 * Plan G1: an overview of the whole folder, asked by the local worker only (user decision 2026-10-20). It starts from
 * at most one file the user chose, or none, and reads at most four more that Codex picks from the list.
 */
export const overviewRequestSchema = z.object({
  projectId: idSchema, startFileId: idSchema.nullable(), mode: z.literal('local-worker'), consent: z.literal(true),
}).strict();
export type OverviewRequest = z.infer<typeof overviewRequestSchema>;
const itemName = z.string().trim().min(1).max(80);
const functionName = z.string().trim().min(1).max(120);
// Like CodeBoarding's key entities, a function is named, never placed: the app finds it in the file (no line numbers).
export const overviewSchema = z.object({
  intro: z.object({ text: description, evidenceIds: references }).strict().nullable(),
  features: z.array(z.object({
    name: itemName, summary: description, evidenceIds: references,
    start: z.object({ evidenceId: idSchema, functionName: functionName.nullable() }).strict(),
  }).strict()).max(8),
  roles: z.array(z.object({
    name: itemName, summary: description, evidenceIds: references,
    functions: z.array(z.object({ name: functionName, evidenceId: idSchema }).strict()).max(5),
  }).strict()).max(8),
  unknowns: z.array(description).max(16),
}).strict();
export type ProjectOverviewAnswer = z.infer<typeof overviewSchema>;
export type OverviewFeature = ProjectOverviewAnswer['features'][number];
export type OverviewRole = ProjectOverviewAnswer['roles'][number];
export const overviewOrganizationSchema = z.object({ focus: description, requestedFileIds: z.array(idSchema).max(4) }).strict();
export const overviewReviewSchema = z.object({
  accepted: z.boolean(), issues: z.array(description).max(16), overview: overviewSchema,
}).strict();

export interface ProviderConnection {
  provider: ProviderId;
  installation: 'found' | 'missing' | 'unusable';
  version: string | null;
  authentication: 'unchecked';
  isolation: 'unverified';
  message: string;
}
export interface ConnectionReport {
  checkedAt: string;
  providers: ProviderConnection[];
  modes: { mode: LearningMode; ready: boolean; reason: string }[];
}
export type LearningPhase = 'collecting' | 'organizing' | 'reading-related' | 'explaining' | 'reviewing' | 'validating';
export interface ModelRun {
  stage: 'organizing' | 'explaining' | 'reviewing';
  provider: 'codex' | 'antigravity';
  requestedModel: string | null;
  reportedModel: string | null;
}
export interface LearningResult {
  jobId: string;
  conversationId: string;
  projectId: string;
  question: string;
  evidence: Evidence;
  sources: { evidence: Evidence; relativePath: string }[];
  limitations: string[];
  explanation: Explanation;
  /** A single mode has no second AI checking the explanation against the code. */
  review: 'AI 검토됨' | 'AI 대조 없음';
  models: ModelRun[];
}
export interface OverviewResult {
  jobId: string;
  projectId: string;
  overview: ProjectOverviewAnswer;
  /** The files actually read for it; a name only seen in the file list was not read. */
  sources: { evidence: Evidence; relativePath: string }[];
  limitations: string[];
  /** With nothing read no overview is written, so nothing was checked either. */
  review: 'AI 검토됨' | '개요 작성 안 함';
  models: ModelRun[];
}
export type LearningEvent =
  | { kind: 'progress'; jobId: string; projectId: string; phase: LearningPhase }
  | { kind: 'completed'; jobId: string; projectId: string; result: LearningResult }
  | { kind: 'overview-completed'; jobId: string; projectId: string; result: OverviewResult }
  | { kind: 'file-explanation-completed'; jobId: string; projectId: string; result: FileExplanationResult }
  | { kind: 'feature-guide-completed'; jobId: string; projectId: string; result: FeatureGuideResult }
  | { kind: 'failed'; jobId: string; projectId: string; error: { code: import('./contracts').AppErrorCode; message: string } };
