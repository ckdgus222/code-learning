import { z } from 'zod';
import { idSchema, type MapImport } from './contracts';
import { learningModeSchema, resultModeSchema, modelRunSchema, type ResultMode, type ModelRun } from './ai';
import { AppError } from './errors';

export const PLAN_SEND_LIMIT = 48 * 1024;
export const CODE_SEND_LIMIT = 80 * 1024;

export interface PlanSection {
  id: string;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  bytes: number;
  parentId: string | null;
}

export interface PlanDocument {
  documentId: string;
  name: string;
  bytes: number;
  lines: number;
  lineBytes: number[];
  sections: PlanSection[];
}

export const planSelectionSchema = z.union([
  z.object({ documentId: z.string(), sectionIds: z.array(z.string()) }).strict(),
  z.object({ documentId: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
]);
export type PlanSelection = z.infer<typeof planSelectionSchema>;

/** Count each selected source line once, including its original LF or CRLF. */
export function selectionBytes(document: PlanDocument, input: PlanSelection): number {
  const parsed = planSelectionSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', '기획 범위를 다시 골라 주세요.');
  const selection = parsed.data;
  if (selection.documentId !== document.documentId) throw new AppError('INVALID_REQUEST', '현재 고른 기획 문서가 아닙니다.');
  if ('startLine' in selection) {
    if (selection.startLine > selection.endLine || selection.endLine > document.lines) {
      throw new AppError('INVALID_REQUEST', '문서 안의 시작 줄과 끝 줄을 순서대로 골라 주세요.');
    }
    return document.lineBytes.slice(selection.startLine - 1, selection.endLine).reduce((sum, bytes) => sum + bytes, 0);
  }
  const byId = new Map(document.sections.map(section => [section.id, section]));
  const ranges = selection.sectionIds.map(id => {
    const section = byId.get(id);
    if (!section) throw new AppError('INVALID_REQUEST', '이 문서에 없는 장·절입니다.');
    return section;
  }).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  let bytes = 0;
  let lastLine = 0;
  for (const range of ranges) {
    const start = Math.max(lastLine + 1, range.startLine);
    if (start > range.endLine) continue;
    bytes += document.lineBytes.slice(start - 1, range.endLine).reduce((sum, size) => sum + size, 0);
    lastLine = range.endLine;
  }
  return bytes;
}

/** Main and renderer use the same byte count; the main keeps the trusted document. */
export function planSelection(document: PlanDocument, selection: PlanSelection): number {
  const bytes = selectionBytes(document, selection);
  if ('sectionIds' in selection && selection.sectionIds.length === 0) throw new AppError('INVALID_REQUEST', '대조할 장·절을 골라 주세요.');
  if (bytes > PLAN_SEND_LIMIT) throw new AppError('LIMIT', '고른 범위가 48 KiB를 넘어요. 범위를 줄여 주세요.');
  return bytes;
}

export const planCompareRequestSchema = z.object({
  projectId: idSchema, selection: planSelectionSchema, mode: learningModeSchema, consent: z.literal(true),
}).strict();
export type PlanCompareRequest = z.infer<typeof planCompareRequestSchema>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const planCompareCheckSchema = z.object({
  projectId: idSchema, documentId: z.string(), planHash: sha256, scopeHash: sha256,
}).strict();
export type PlanCompareCheck = z.infer<typeof planCompareCheckSchema>;
const planLines = z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict();
export type PlanRange = z.infer<typeof planLines>;
const text = z.string().trim().min(1).max(400);
const item = z.object({
  title: text, plan: planLines, status: z.enum(['matches', 'differs', 'unverified', 'missing']),
  files: z.array(idSchema).max(6), difference: text.nullable(), missingEvidence: text.nullable(), searched: text.nullable(),
}).strict();
export const planCompareSchema = z.object({
  items: z.array(item).max(40),
  unrequested: z.array(z.object({ title: text, files: z.array(idSchema).min(1).max(6), note: text }).strict()).max(20),
  designMismatches: z.array(z.object({ plan: planLines, edge: z.number().int().min(0), note: text }).strict()).max(20),
  unknowns: z.array(text).max(10),
}).strict();
export const planCompareReviewSchema = z.object({ accepted: z.boolean(), issues: z.array(text).max(16), compare: planCompareSchema }).strict();
export const planCompareOrganizationSchema = z.object({ focus: text, requestedFileIds: z.array(idSchema).max(8) }).strict();
export type PlanCompareAnswer = z.infer<typeof planCompareSchema>;
export interface PlanCompareResult {
  jobId: string; projectId: string; mode: ResultMode; review: 'AI 검토됨' | 'AI 대조 없음'; models: ModelRun[];
  structureOnly: boolean; // Keep true for previously saved structure comparisons; new results are always false.
  document: Pick<PlanDocument, 'documentId' | 'name'>;
  sent: PlanRange[]; excluded: PlanRange[];
  plan: { startLine: number; text: string }[];
  files: { id: string; relativePath: string }[];
  edges: { index: number; from: string; to: string; line: number; site: MapImport }[];
  read: { fileId: string; relativePath: string; fileHash: string }[];
  compare: PlanCompareAnswer;
  basis: { planHash: string; scopeHash: string; mapHash: string };
  limitations: string[];
}

export const savePlanCompareSchema = z.object({ projectId: idSchema, jobId: idSchema }).strict();
export type SavePlanCompare = z.infer<typeof savePlanCompareSchema>;
const mapImportSchema = z.object({
  fromFileId: idSchema, fileHash: sha256,
  startUtf16: z.number().int().min(0), endUtf16: z.number().int().min(0),
  startLine: z.number().int().min(1), endLine: z.number().int().min(1),
  text: z.string(), specifier: z.string().nullable(),
}).strict();
export const planCompareResultSchema = z.object({
  jobId: idSchema, projectId: idSchema, mode: resultModeSchema,
  review: z.enum(['AI 검토됨', 'AI 대조 없음']), models: z.array(modelRunSchema),
  structureOnly: z.boolean(), // Accept previously saved structure comparisons (true); new results are always false.
  document: z.object({ documentId: z.string(), name: z.string() }).strict(),
  sent: z.array(planLines), excluded: z.array(planLines),
  plan: z.array(z.object({ startLine: z.number().int().min(1), text: z.string() }).strict()),
  files: z.array(z.object({ id: idSchema, relativePath: z.string() }).strict()),
  edges: z.array(z.object({ index: z.number().int().min(0), from: z.string(), to: z.string(),
    line: z.number().int().min(1), site: mapImportSchema }).strict()),
  read: z.array(z.object({ fileId: idSchema, relativePath: z.string(), fileHash: sha256 }).strict()),
  compare: planCompareSchema,
  basis: z.object({ planHash: sha256, scopeHash: sha256, mapHash: sha256 }).strict(),
  limitations: z.array(z.string()),
}).strict();

export function planPartFor(plan: PlanCompareResult['plan'], range: PlanRange) {
  return plan.find(part => part.startLine <= range.startLine
    && part.startLine + part.text.split('\n').length > range.endLine);
}

/** Every cited plan range must fit wholly within one range actually sent. */
export function checkPlanCompare(compare: PlanCompareAnswer, sent: PlanRange[], files: string[], read: string[], edges: number[]): void {
  const invalid = () => { throw new AppError('AI_RESPONSE', '대조 결과에 이번 자료로 확인할 수 없는 근거가 있어 표시하지 않았어요.'); };
  const rangeAllowed = (range: PlanRange) => range.startLine <= range.endLine && sent.some(part =>
    range.startLine >= part.startLine && range.endLine <= part.endLine);
  const filesAllowed = (ids: string[]) => new Set(ids).size === ids.length && ids.every(id => files.includes(id));
  for (const item of compare.items) {
    if (!rangeAllowed(item.plan) || !filesAllowed(item.files)) invalid();
    if ((item.status === 'matches' || item.status === 'differs') && (!item.files.length || item.files.some(id => !read.includes(id)))) invalid();
    if (item.status === 'differs' && !item.difference?.trim()) invalid();
    if (item.status === 'unverified' && (!item.files.length || !item.missingEvidence?.trim())) invalid();
    if (item.status === 'missing' && (item.files.length || !item.searched?.trim())) invalid();
  }
  if (compare.unrequested.some(item => !item.files.length || !filesAllowed(item.files))) invalid();
  if (compare.designMismatches.some(item => !rangeAllowed(item.plan) || !edges.includes(item.edge))) invalid();
}
