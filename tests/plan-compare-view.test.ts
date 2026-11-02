import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlanCompare } from '../src/renderer/plan-compare';
import type { PlanCompareFreshness, usePlanCompare } from '../src/renderer/use-plan-compare';
import { planSections } from '../src/core/analysis/plan-sections';
import { PlanCompareResultView } from '../src/renderer/plan-compare-result';
import type { PlanCompareResult, PlanSelection } from '../src/shared/plan-compare';

function render(text: string | null, selection: PlanSelection | null = null, saved: { result: PlanCompareResult; savedAt: string | null } | null = null) {
  const state: ReturnType<typeof usePlanCompare> = {
    document: text === null ? null : { documentId: 'doc', name: 'plan.md', bytes: Buffer.byteLength(text), ...planSections(text) },
    freshness: { status: 'fresh', reasons: [] }, async recheck() {}, running: false, phase: null, result: saved?.result ?? null, savedAt: saved?.savedAt ?? null, async remove() {}, consent: false, setConsent() {}, async start() {}, cancel() {},
    selection: selection ?? (text === null ? null : { documentId: 'doc', startLine: 1, endLine: text.split('\n').length }), setSelection() {}, picking: false, error: '', async pick() {}, forget() {},
  };
  return renderToStaticMarkup(React.createElement(PlanCompare, { state, locked: false, mode: 'local-worker', checking: false, readiness: null, onInspect() {}, onFile() {}, onImport() {} }));
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

function comparison(): PlanCompareResult {
  const range = { startLine: 3, endLine: 10 };
  return {
    jobId: 'job', projectId: 'project', document: { documentId: 'doc', name: 'plan.md' }, mode: 'local-worker',
    structureOnly: false, review: 'AI 검토됨', models: [
      { stage: 'organizing', provider: 'codex', requestedModel: 'requested', reportedModel: 'reported' },
      { stage: 'explaining', provider: 'antigravity', requestedModel: null, reportedModel: null },
      { stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: null },
    ],
    plan: [{ startLine: 3, text: Array.from({ length: 8 }, (_, i) => `기획본문${i + 3}`).join('\n') }, { startLine: 15, text: '[MASKED_SECRET]\n' }],
    sent: [range, { startLine: 15, endLine: 15 }], excluded: [{ startLine: 1, endLine: 2 }, { startLine: 11, endLine: 14 }],
    files: [{ id: 'read', relativePath: 'src/read.ts' }, { id: 'listed', relativePath: 'src/listed.ts' }],
    read: [{ fileId: 'read', relativePath: 'src/read.ts', fileHash: 'a'.repeat(64) }],
    edges: [{ index: 0, from: 'src/read.ts', to: 'src/listed.ts', line: 4,
      site: { fromFileId: 'read', fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 10, startLine: 4, endLine: 4, text: "import './listed'", specifier: './listed' } }],
    compare: {
      items: [
        { title: '같음', status: 'matches', plan: { startLine: 15, endLine: 15 }, files: ['read'], difference: null, missingEvidence: null, searched: null },
        { title: '차이', status: 'differs', plan: range, files: ['read'], difference: '다른 동작', missingEvidence: '추가 근거', searched: '읽은 범위' },
        { title: '미확인', status: 'unverified', plan: range, files: ['listed'], difference: null, missingEvidence: '실행 확인', searched: null },
        { title: '없음 항목', status: 'missing', plan: range, files: [], difference: null, missingEvidence: null, searched: '전체 목록' },
      ],
      unrequested: [{ title: '후보', note: '범위에서 못 찾음', files: ['listed'] }],
      designMismatches: [{ plan: range, edge: 0, note: '직접 연결됨' }], unknowns: ['실행 결과는 모름'],
    },
    basis: { planHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), mapHash: 'c'.repeat(64) },
    limitations: ['지도에서 잇지 못한 연결 1개', '큰 파일 생략'],
  };
}
function renderResult(result = comparison(), freshness: PlanCompareFreshness = { status: 'fresh', reasons: [] }, locked = false) {
  return renderToStaticMarkup(React.createElement(PlanCompareResultView, {
    result, freshness, locked, recheck() {}, onFile() {}, onImport() {},
  }));
}

it('groups results in review order and opens populated groups except matches', () => {
  const html = renderResult();
  const groups = [...html.matchAll(/<details( open="")?><summary>([^<]+)<\/summary>/g)].slice(0, 6);
  expect(groups.map(match => match[2])).toEqual([
    '있지만 기획과 다름 (1)', '기획에 있는데 못 찾음 (1)', '찾았지만 확인 못 함 (1)',
    '시키지 않은 작업 후보 (1)', '설계와 다른 연결 (1)', '기획대로 있음 (1)',
  ]);
  expect(groups.map(match => !!match[1])).toEqual([true, true, true, true, true, false]);
  expect(html).toContain('대조 결과 · 기획대로 1 · 다름 1 · 확인 못 함 1 · 못 찾음 1');
  expect(html).toContain('AI 대조 · 정확성을 보장하지 않아요 · 로컬 워커');
  expect(html).toContain('파일 고르기 · 요청 모델: requested · 응답 모델: reported');
  expect(html).toContain('대조 · 요청 모델: 실행기 기본값 · 응답 모델: 알려 주지 않음');
  expect(html).toContain('검토 · 요청 모델:');
});

it('shows masked excerpts at original lines, at most six lines, and all non-null evidence fields', () => {
  const html = renderResult();
  expect(html).toContain('기획 3–10줄');
  expect(html).toContain('기획 15줄');
  expect(html).toContain('[MASKED_SECRET]</blockquote>');
  expect(html).toContain('기획본문3\n기획본문4\n기획본문5\n기획본문6\n기획본문7\n기획본문8</blockquote>');
  expect(html).not.toContain('기획본문9');
  expect(html).toContain('… 외 2줄은 기획 문서에서 보세요');
  for (const field of ['다른 점: 다른 동작', '부족한 근거: 추가 근거', '조사한 범위: 읽은 범위', '조사한 범위: 전체 목록']) expect(html).toContain(field);
  expect(html).toContain('기획에서 찾아본 범위: 3–10줄, 15줄');
  expect(html).toContain('src/read.ts → src/listed.ts · 4행');
  expect(html).toContain('지도에서 잇지 못한 연결은 판단하지 않았어요');
});

it('shows read paths, listed-only counts and labels, excluded ranges and limitations', () => {
  const html = renderResult();
  expect(html).toContain('코드까지 읽은 파일 1개');
  expect(html).toContain('<li>src/read.ts</li>');
  expect(html).toContain('<summary>목록만 본 파일 1개</summary><ul><li>src/listed.ts</li>');
  expect(html).toMatch(/>src\/listed.ts<\/button><span class="hint"> 목록만 봄/);
  expect(html).not.toMatch(/>src\/read.ts<\/button><span class="hint"> 목록만 봄/);
  expect(html).toContain('빠진 파일과 이유는 아래 한계를 보세요');
  expect(html).toContain('대조하지 않은 기획 범위: 1–2줄, 11–14줄');
  expect(html).toContain('<h4>AI가 판단하지 못한 점</h4>');
  expect(html).toContain('<h4>한계</h4>');
});

it('keeps empty groups visible and explains structure-only judgments without empty optional sections', () => {
  const result = comparison();
  result.structureOnly = true; result.mode = 'codex'; result.read = [];
  result.compare = { items: [], unrequested: [], designMismatches: [], unknowns: [] };
  result.limitations = []; result.excluded = [];
  const html = renderResult(result);
  expect([...html.matchAll(/<summary>[^<]+ \(0\)<\/summary>/g)]).toHaveLength(6);
  expect([...html.matchAll(/<p>없음<\/p>/g)]).toHaveLength(6);
  expect([...html.matchAll(/코드를 읽지 않은 구조 비교라 판정하지 않았어요/g)]).toHaveLength(2);
  expect(html).toContain('코드는 읽지 않았어요(구조 비교)');
  expect(html).toContain('목록만 본 파일 2개');
  expect(html).toContain('대조하지 않은 기획 범위: 없음');
  expect(html).not.toContain('빠진 파일과 이유');
  expect(html).not.toContain('AI가 판단하지 못한 점');
  expect(html).not.toContain('<h4>한계</h4>');
  expect(html).not.toContain('지도에서 잇지 못한 연결은 판단하지 않았어요');
});

it.each(['checking', 'stale', 'error'] as const)('locks every evidence button while %s and retains result content', status => {
  const html = renderResult(comparison(), { status, reasons: ['시험 이유'] });
  const buttons = [...html.matchAll(/<button([^>]*)>/g)];
  expect(buttons).toHaveLength(5);
  expect(buttons.every(match => match[1].includes('disabled=""'))).toBe(true);
  expect(html).toContain('기획본문3');
  if (status === 'checking') expect(html).toContain('role="status">지금 파일과 맞는지 확인 중');
  if (status === 'stale') expect(html).toContain('role="alert" class="notice notice--warn">다시 확인 필요: 시험 이유');
  if (status === 'error') expect(html).toContain('role="alert">지금 파일과 맞는지 확인하지 못했어요: 시험 이유');
});

it('locks fresh evidence during other work and otherwise enables every button', () => {
  expect(renderResult()).not.toContain('disabled=""');
  expect([...renderResult(comparison(), { status: 'fresh', reasons: [] }, true).matchAll(/<button([^>]*)>/g)]
    .every(match => match[1].includes('disabled=""'))).toBe(true);
});


it('shows a restored result, saved date and delete action without selecting a document', () => {
  const html = render(null, null, { result: comparison(), savedAt: '2026-11-02T03:00:00.000Z' });
  expect(html).toContain('기획 문서 고르기');
  expect(html).toContain('저장됨 · 11월 2일');
  expect(html).toMatch(/<button class="btn btn--small">지우기<\/button>/);
  expect(html).toContain('대조 결과 · 기획대로 1');
  expect(render(null, null, { result: comparison(), savedAt: null })).toContain('저장 전');
});
