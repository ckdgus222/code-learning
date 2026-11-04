import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AnswerView, AiPanel } from '../src/renderer/ai-panel';
import { savedDate } from '../src/renderer/overview';
import type { LearningResult } from '../src/shared/ai';

const evidence = { id: 'selection', projectId: 'project', fileId: 'file', fileHash: 'a'.repeat(64),
  startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 2 };
const answer: LearningResult = {
  jobId: 'job', conversationId: 'chat', projectId: 'project', question: '저장 질문', evidence,
  sources: [{ evidence, relativePath: 'index.ts' }, { evidence: { ...evidence, id: 'related' }, relativePath: 'other.ts' }],
  limitations: ['읽기 제한'], review: 'AI 검토됨', models: [{ stage: 'explaining', provider: 'codex', requestedModel: null, reportedModel: 'test' }],
  explanation: { summary: '쉬운 설명',
    steps: [{ title: '계산', input: '수', action: '더하기', output: '결과', alternatives: ['다른 경우'], evidenceIds: ['selection'] }],
    claims: [{ kind: 'code', text: '코드 설명', evidenceIds: ['selection'] }, { kind: 'concept', text: '개념 설명' }],
    terms: [{ term: '입력', meaning: '받는 값' }], examples: [{ given: '1', result: '2', evidenceIds: ['related'] }], unknowns: ['미확인'] },
};

it.each([false, true])('renders the same answer layers and disables every evidence button only when stale=%s', stale => {
  const html = renderToStaticMarkup(React.createElement(AnswerView, { answer, stale, onEvidence() {} }));
  for (const text of ['저장 질문', '쉬운 설명', '낱말 풀이', '예시로 따라가기', '자세히 보기', '계산', '코드 설명', '개념 설명', '읽기 제한', '미확인', '응답 모델 test']) {
    expect(html).toContain(text);
  }
  const buttons = html.match(/<button[^>]*>/g)!;
  expect(buttons).toHaveLength(5);
  expect(buttons.every(button => button.includes('disabled=""') === stale)).toBe(true);
  expect(html).not.toContain('학습 주제');
});

it('retains the live answer topic without adding a topic to saved answers', () => {
  const html = renderToStaticMarkup(React.createElement(AnswerView, { answer, topic: '주문', stale: false, onEvidence() {} }));
  expect(html).toContain('학습 주제: 주문');
});

it('starts history folded and explains storage and conversation boundaries', () => {
  const html = renderToStaticMarkup(React.createElement(AiPanel, {
    open: true, onClose() {},
    projectId: 'project', openedAt: 1, evidence: null, relativePath: '', stale: false, draft: null,
    connections: null, checking: false, otherRunning: false, mode: 'local-worker',
    onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {}, onSavedEvidence() {},
  }));
  expect(html).toContain('<details class="saved-answers"><summary>지난 질문과 답 · 0개</summary>');
  expect(html).toContain('지난 답의 대화는 이어지지 않아요.');
  expect(html).toContain('질문과 답은 최근 50개까지 이 Mac에 저장해요. 이어 묻기는 앱을 켜 둔 동안만 돼요.');
});

it('preserves the month and day display used by earlier saved results', () => {
  expect(savedDate('2026-10-30T12:00:00.000Z')).toBe('10월 30일');
});
