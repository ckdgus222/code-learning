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

const description = z.string().trim().min(1).max(2000);
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
  review: 'AI 검토됨';
  models: ModelRun[];
}
export type LearningEvent =
  | { kind: 'progress'; jobId: string; projectId: string; phase: LearningPhase }
  | { kind: 'completed'; jobId: string; projectId: string; result: LearningResult }
  | { kind: 'failed'; jobId: string; projectId: string; error: { code: import('./contracts').AppErrorCode; message: string } };
