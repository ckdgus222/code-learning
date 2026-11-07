import { z } from 'zod';
import { MAX_FILE_BYTES, idSchema, type Evidence } from './contracts';

export const GEMINI_MODEL = 'gemini-3.8-flash-high';
export const learningModeSchema = z.enum(['local-worker', 'codex', 'claude-code', 'antigravity']);
export type LearningMode = z.infer<typeof learningModeSchema>;
export type ProviderId = Exclude<LearningMode, 'local-worker'>;
export const checkConnectionsSchema = z.object({ automatic: z.literal(true) }).strict().optional();
export type CheckConnectionsRequest = z.infer<typeof checkConnectionsSchema>;
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
// File explanations read at most 32 KiB; offsets, lines and analyzer names fit within that source.
const fileOffset = z.number().int().min(0).max(32 * 1024);
const fileRangeSchema = z.object({
  fileId: idSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  startUtf16: fileOffset, endUtf16: fileOffset,
  startLine: z.number().int().min(1).max(32 * 1024 + 1), endLine: z.number().int().min(1).max(32 * 1024 + 1),
}).strict().refine(range => range.startUtf16 <= range.endUtf16 && range.startLine <= range.endLine);
export const modelRunSchema = z.object({
  stage: z.enum(['organizing', 'explaining', 'reviewing']), provider: z.enum(['codex', 'antigravity']),
  requestedModel: z.string().min(1).max(120).nullable(), reportedModel: z.string().min(1).max(120).nullable(),
}).strict();
export const featureGuideResultSchema = z.object({
  jobId: idSchema, projectId: idSchema, routesId: idSchema, guide: featureGuideSchema,
  // Metadata-only notice, byte limit, analysis limit and masked-value notice; two workflow stages.
  limitations: z.array(description).max(4), mode: learningModeSchema, review: z.enum(['AI 검토됨', 'AI 대조 없음']),
  models: z.array(modelRunSchema).max(2),
}).strict();
export type FeatureGuideResult = z.infer<typeof featureGuideResultSchema>;
export const saveFeatureGuideSchema = z.object({ projectId: idSchema, result: featureGuideResultSchema }).strict();
export const fileExplanationResultSchema = z.object({
  jobId: idSchema, projectId: idSchema, relativePath: z.string().min(1).max(1024),
  range: fileRangeSchema,
  chunks: z.array(z.object({
    id: idSchema, kind: z.enum(['imports', 'class', 'function', 'field', 'variable', 'statement']),
    name: z.string().min(1).max(32 * 1024), range: fileRangeSchema,
    functionRange: z.object({ startUtf16: fileOffset, endUtf16: fileOffset }).strict()
      .refine(range => range.startUtf16 <= range.endUtf16).nullable(),
  }).strict()).max(80),
  explanation: fileExplanationSchema,
  // Two chunking warnings and one masked-source notice; at most two workflow stages.
  limitations: z.array(description).max(3), mode: learningModeSchema, review: z.enum(['AI 검토됨', 'AI 대조 없음']),
  models: z.array(modelRunSchema).max(2),
}).strict();
export type FileExplanationResult = z.infer<typeof fileExplanationResultSchema>;
export type FileChunk = FileExplanationResult['chunks'][number];
export const saveFileExplanationSchema = z.object({ projectId: idSchema, result: fileExplanationResultSchema }).strict();
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
 * An overview starts from at most one file the user chose, or none, and reads at most four more
 * that the AI picks from the list.
 */
export const overviewRequestSchema = z.object({
  projectId: idSchema, startFileId: idSchema.nullable(), mode: learningModeSchema, consent: z.literal(true),
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
  modes: { mode: LearningMode; ready: boolean; reason: string; warning?: string }[];
}
export type LearningPhase = 'collecting' | 'organizing' | 'reading-related' | 'explaining' | 'reviewing' | 'validating';
export interface ModelRun {
  stage: 'organizing' | 'explaining' | 'reviewing';
  provider: 'codex' | 'antigravity';
  requestedModel: string | null;
  reportedModel: string | null;
}
// Positions can reach the end of a readable file; each selected slice is still at most 32 KiB.
const answerEvidenceSchema = z.object({
  id: idSchema, projectId: idSchema, fileId: idSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  startUtf16: z.number().int().min(0).max(MAX_FILE_BYTES), endUtf16: z.number().int().min(0).max(MAX_FILE_BYTES),
  startLine: z.number().int().min(1).max(MAX_FILE_BYTES + 1), endLine: z.number().int().min(1).max(MAX_FILE_BYTES + 1),
}).strict().refine(range => range.startUtf16 <= range.endUtf16 && range.startLine <= range.endLine &&
  range.endUtf16 - range.startUtf16 <= 32 * 1024);
export const learningResultSchema = z.object({
  jobId: idSchema, conversationId: idSchema, projectId: idSchema,
  // Masking short configuration values may expand a 2,000-character input.
  question: z.string().min(1).max(16_000), evidence: answerEvidenceSchema,
  sources: z.array(z.object({ evidence: answerEvidenceSchema, relativePath: z.string().min(1).max(1024) }).strict()).min(1).max(6),
  limitations: z.array(description).max(32), explanation: explanationSchema,
  review: z.enum(['AI 검토됨', 'AI 대조 없음']), models: z.array(modelRunSchema).max(3),
}).strict();
export type LearningResult = z.infer<typeof learningResultSchema>;
export const saveAnswerSchema = z.object({ projectId: idSchema, result: learningResultSchema }).strict();
export const savedAnswerRequestSchema = z.object({ projectId: idSchema, jobId: idSchema }).strict();
export const openSavedEvidenceSchema = savedAnswerRequestSchema.extend({ evidenceId: idSchema }).strict();
export function explanationReferencesMatch(explanation: Explanation, allowed: Set<string>): boolean {
  const ids = [...explanation.steps.flatMap(step => step.evidenceIds),
    ...explanation.claims.flatMap(claim => claim.kind === 'code' ? claim.evidenceIds : []),
    ...explanation.examples.flatMap(example => example.evidenceIds)];
  return ids.length > 0 && ids.every(id => allowed.has(id));
}
export const overviewResultSchema = z.object({
  jobId: idSchema, projectId: idSchema, overview: overviewSchema,
  // One start file and at most four related files, each limited to 32 KiB.
  sources: z.array(z.object({
    evidence: fileRangeSchema.safeExtend({ id: idSchema, projectId: idSchema }),
    relativePath: z.string().min(1).max(1024),
  }).strict()).max(5),
  // List + exploration notices, five skipped/masked files, eight starts, 8 × 5 role names and a single-mode notice.
  limitations: z.array(description).max(56), review: z.enum(['AI 검토됨', 'AI 대조 없음', '개요 작성 안 함']),
  models: z.array(modelRunSchema).max(3),
}).strict();
export type OverviewResult = z.infer<typeof overviewResultSchema>;
export const saveOverviewSchema = z.object({ projectId: idSchema, result: overviewResultSchema }).strict();
export type LearningEvent =
  | { kind: 'plan-compare-completed'; jobId: string; projectId: string; result: import('./plan-compare').PlanCompareResult }
  | { kind: 'progress'; jobId: string; projectId: string; phase: LearningPhase }
  | { kind: 'completed'; jobId: string; projectId: string; result: LearningResult }
  | { kind: 'overview-completed'; jobId: string; projectId: string; result: OverviewResult }
  | { kind: 'file-explanation-completed'; jobId: string; projectId: string; result: FileExplanationResult }
  | { kind: 'feature-guide-completed'; jobId: string; projectId: string; result: FeatureGuideResult }
  | { kind: 'failed'; jobId: string; projectId: string; error: { code: import('./contracts').AppErrorCode; message: string } };
