import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlanCompare } from '../src/renderer/plan-compare';
import type { usePlanCompare } from '../src/renderer/use-plan-compare';
import { planSections } from '../src/core/analysis/plan-sections';
import type { PlanSelection } from '../src/shared/plan-compare';

function render(text: string | null, selection: PlanSelection | null = null) {
  const state: ReturnType<typeof usePlanCompare> = {
    document: text === null ? null : { documentId: 'doc', name: 'plan.md', bytes: Buffer.byteLength(text), ...planSections(text) },
    running: false, phase: null, result: null, consent: false, setConsent() {}, async start() {}, cancel() {},
    selection: selection ?? (text === null ? null : { documentId: 'doc', startLine: 1, endLine: text.split('\n').length }), setSelection() {}, picking: false, error: '', async pick() {}, forget() {},
  };
  return renderToStaticMarkup(React.createElement(PlanCompare, { state, locked: false, mode: 'local-worker', checking: false, readiness: null, onInspect() {} }));
}

it('shows the picker and a whole-document message for small documents with a disabled comparison action until consent', () => {
  expect(render(null)).toContain('기획 문서 고르기');
  const html = render('# 작은 문서');
  expect(html).toContain('문서 전체를 보내요.');
  expect(html).toContain('다른 문서 고르기');
  expect(html).toContain('보낼 자료에 동의');
  expect(html).toMatch(/<button[^>]+disabled=""[^>]*>대조하기<\/button>/);
});

it('shows sections with inherited checks, their union size and the uncovered parent body', () => {
  const text = '# 큰 장\n' + 'a'.repeat(50000) + '\n## 작은 절\n작음\n# 다음 장\n끝';
  const html = render(text, { documentId: 'doc', sectionIds: ['s1'] });
  expect(html).toMatch(/type="checkbox" disabled="" checked=""/);
  expect(html).toContain('고른 범위가 48 KiB를 넘어요.');
  expect(html).toContain('대조하지 않을 범위: 다음 장');
  const child = render(text, { documentId: 'doc', sectionIds: ['s3'] });
  expect(child).toContain('큰 장 (선택한 하위 절 제외)');
  expect(child).not.toContain('고른 범위가 48 KiB를 넘어요.');
});

it('offers only lines without headings and shows both excluded ranges and invalid input', () => {
  const text = '가\r\n' + '나'.repeat(17000) + '\r\n끝';
  const html = render(text, { documentId: 'doc', startLine: 2, endLine: 2 });
  expect(html).toContain('줄 범위로 고르기');
  expect(html).not.toContain('장·절로 고르기');
  expect(html).toContain('51,002 바이트 / 48 KiB');
  expect(html).toContain('대조하지 않을 범위: 1–1줄, 3–3줄');
  expect(html).toContain('고른 범위가 48 KiB를 넘어요.');
  const invalid = render(text, { documentId: 'doc', startLine: 3, endLine: 1 });
  expect(invalid).toContain('시작 줄과 끝 줄을 순서대로');
  expect(invalid).not.toContain('고른 합계:');
});
