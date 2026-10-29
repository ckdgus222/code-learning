import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiPanel } from '../src/renderer/ai-panel';
import { OverviewAi } from '../src/renderer/overview';
import type { LearningMode } from '../src/shared/ai';
import type { ProjectView } from '../src/shared/contracts';

function checkDisclosure(html: string, expectedText: string, ready: boolean) {
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  expect(checkbox).toBeDefined();
  expect(checkbox).not.toContain('checked=');
  expect(checkbox?.includes('disabled=')).toBe(!ready);
  const descriptionId = checkbox?.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(descriptionId).toBeTruthy();
  expect(html).toContain('/>보낼 자료에 동의</label><details class="consent-details"><summary>무엇을 보내나요?</summary>');
  expect(html).toContain(`<p id="${descriptionId}">${expectedText}</p></details>`);
}

describe('folded AI consent disclosures', () => {
  const recipients: [LearningMode, string][] = [
    ['local-worker', 'Codex와 Gemini'], ['codex', 'Codex'],
    ['antigravity', 'Gemini(Antigravity)'], ['claude-code', 'Claude Code'],
  ];
  it.each(recipients)('keeps the full question disclosure and recipient for %s', (mode, recipient) => {
    for (const ready of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(AiPanel, {
        projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
        connections: { checkedAt: '2026-10-21T00:00:00.000Z', providers: [], modes: [{ mode, ready, reason: 'test' }] },
        checking: false, otherRunning: false, mode,
        onMode() {}, onRunning() {}, async onInspect() { return null; }, onEvidence() {},
      }));
      checkDisclosure(html, `선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·${mode === 'local-worker' ? '관련 파일(추가 최대 4개)·' : ''}질문·최근 답변을 ${recipient}에 보내는 데 동의합니다.${mode !== 'local-worker' ? ' 다른 파일은 더 읽지 않습니다.' : ''} 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.`, ready);
      expect(html).toMatch(/<button[^>]*disabled="">질문 보내기<\/button>/);
    }
  });

  it.each([false, true])('keeps the full overview disclosure and requires consent when ready=%s', ready => {
    const project: ProjectView = { id: 'project', name: 'test', files: [], excluded: {}, warnings: [],
      overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
    const html = renderToStaticMarkup(React.createElement(OverviewAi, {
      project, state: null, stale: false, locked: false, readiness: { ready, reason: 'test' }, checking: false,
      revealAnchor: null, topicName: null,
      onInspect() {}, onStart() {}, onCancel() {}, onEvidence() {}, onFollow() {}, onFunction() {},
    }));
    checkDisclosure(html, '프로젝트 파일 목록, 고른 시작 파일, Codex가 고른 관련 파일(최대 4개)을 Codex와 Gemini에 보내는 데 동의합니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.', ready);
    expect(html).toMatch(/<button[^>]*disabled="">개요 만들기<\/button>/);
  });
});
