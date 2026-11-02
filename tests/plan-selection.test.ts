import { expect, it } from 'vitest';
import { planSections } from '../src/core/analysis/plan-sections';
import { CODE_SEND_LIMIT, PLAN_SEND_LIMIT, planSelection, selectionBytes, type PlanDocument, type PlanSelection } from '../src/shared/plan-compare';

function document(text: string): PlanDocument {
  return { documentId: 'document', name: 'plan.md', bytes: Buffer.byteLength(text), ...planSections(text) };
}

it('accepts exactly 48 KiB and rejects one more byte in both selection modes', () => {
  expect(PLAN_SEND_LIMIT + CODE_SEND_LIMIT).toBe(128 * 1024);
  for (const extra of [0, 1]) {
    const doc = document('# title\n' + 'a'.repeat(PLAN_SEND_LIMIT - 8 + extra));
    for (const selection of [
      { documentId: doc.documentId, sectionIds: ['s1'] },
      { documentId: doc.documentId, startLine: 1, endLine: 2 },
    ]) {
      expect(selectionBytes(doc, selection)).toBe(PLAN_SEND_LIMIT + extra);
      if (extra) expect(() => planSelection(doc, selection)).toThrow('48 KiB');
      else expect(planSelection(doc, selection)).toBe(PLAN_SEND_LIMIT);
    }
  }
});

it.each([
  { documentId: 'someone-else', sectionIds: ['s1'] },
  { documentId: 'document', sectionIds: ['missing'] },
  { documentId: 'document', startLine: 0, endLine: 1 },
  { documentId: 'document', startLine: 1, endLine: 4 },
  { documentId: 'document', startLine: 2, endLine: 1 },
  { documentId: 'document', startLine: 1.5, endLine: 2 },
  { documentId: 'document', startLine: NaN, endLine: 2 },
  { documentId: 'document', startLine: 1, endLine: Infinity },
  { documentId: 'document', sectionIds: ['s1'], startLine: 1, endLine: 2 },
  { documentId: 'document', sectionIds: ['s1'], path: '/arbitrary' },
  { documentId: 'document', sectionIds: 's1' },
  null,
])('rejects foreign IDs, out-of-document lines and malformed selections %#', input => {
  const doc = document('# 장\n본문\n');
  expect(() => selectionBytes(doc, input as PlanSelection)).toThrow();
  expect(() => planSelection(doc, input as PlanSelection)).toThrow();
});

it('counts overlapping parents and children, duplicate IDs and adjacent sections only once', () => {
  const doc = document('소개\n# 큰 장\n본문\n## 작은 절\n내용\n# 다음 장\n마지막');
  const selection = { documentId: doc.documentId, sectionIds: ['s4', 's2', 's4', 's6'] };
  expect(selectionBytes(doc, selection)).toBe(doc.bytes - Buffer.byteLength('소개\n'));
  expect(planSelection(doc, selection)).toBe(doc.bytes - Buffer.byteLength('소개\n'));
  expect(selectionBytes(doc, { documentId: doc.documentId, sectionIds: [] })).toBe(0);
  expect(() => planSelection(doc, { documentId: doc.documentId, sectionIds: [] })).toThrow('골라');
});

it.each([0, 1])('matches actual sliced Korean CRLF text at the byte limit plus %i', extra => {
  const text = '# 앞\r\n' + '가'.repeat(16383) + 'a\r\n' + 'b'.repeat(extra) + '\n# 뒤';
  const doc = document(text);
  const sourceLines = text.match(/[^\n]*\n|[^\n]+$/g)!;
  const selected = { documentId: doc.documentId, startLine: 2, endLine: 2 };
  expect(planSelection(doc, selected)).toBe(PLAN_SEND_LIMIT);
  for (let startLine = 1; startLine <= sourceLines.length; startLine++) {
    for (let endLine = startLine; endLine <= sourceLines.length; endLine++) {
      const bytes = Buffer.byteLength(sourceLines.slice(startLine - 1, endLine).join(''), 'utf8');
      expect(selectionBytes(doc, { documentId: doc.documentId, startLine, endLine })).toBe(bytes);
    }
  }
  const overflow = { ...selected, endLine: 3 };
  expect(selectionBytes(doc, overflow)).toBe(PLAN_SEND_LIMIT + 1 + extra);
  expect(() => planSelection(doc, overflow)).toThrow('48 KiB');
});

it('can select the parent body by lines when a parent exceeds the limit but its child is small', () => {
  const text = '# 부모\n' + '가'.repeat(8000) + '\r\n' + '나'.repeat(9000) + '\r\n## 자식\n작음';
  const doc = document(text);
  expect(() => planSelection(doc, { documentId: doc.documentId, sectionIds: ['s1'] })).toThrow('48 KiB');
  expect(planSelection(doc, { documentId: doc.documentId, startLine: 2, endLine: 2 })).toBe(24002);
  expect(planSelection(doc, { documentId: doc.documentId, sectionIds: ['s4'] })).toBe(Buffer.byteLength('## 자식\n작음'));
});
