import { z } from 'zod';
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

const selectionSchema = z.union([
  z.object({ documentId: z.string(), sectionIds: z.array(z.string()) }).strict(),
  z.object({ documentId: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
]);
export type PlanSelection = z.infer<typeof selectionSchema>;

/** Count each selected source line once, including its original LF or CRLF. */
export function selectionBytes(document: PlanDocument, input: PlanSelection): number {
  const parsed = selectionSchema.safeParse(input);
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
