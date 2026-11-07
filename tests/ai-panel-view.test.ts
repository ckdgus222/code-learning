import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiPanel, sendBlockedReason } from '../src/renderer/ai-panel';
import type { ConnectionReport, LearningMode } from '../src/shared/ai';

describe('compact AI panel', () => {
  const modes: [LearningMode, string][] = [
    ['codex', 'Codex 단독'],
    ['antigravity', 'Gemini 단독'], ['claude-code', 'Claude Code(준비 중)'],
  ];

  it.each(modes)('shows readiness for %s with a visible question and folded settings', (mode, label) => {
    for (const ready of [null, false, true]) {
      const connections: ConnectionReport | null = ready === null ? null : {
        checkedAt: '2026-10-23T00:00:00.000Z', providers: [], modes: [{ mode, ready, reason: 'test' }],
      };
      const html = renderToStaticMarkup(React.createElement(AiPanel, {
        open: true, onClose() {},
        projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
        connections, checking: false, otherRunning: false, mode,
        onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
      }));
      expect(html).toContain('class="ai-line" role="group" aria-label="AI 연결"');
      expect(html).toContain(`AI · ${label} · ${ready === null ? '설치 확인 필요' : ready ? '준비됨' : '사용할 수 없음'}`);
      expect(html).not.toContain('질문하기');
      expect(html).toMatch(/<button[^>]*aria-expanded="false">설정<\/button>/);
      expect(html).toContain('<div class="ai-settings" hidden="">');
      expect(html).toContain('<div class="ai-question">');
      expect(html).not.toContain('question-target');
      expect(html).not.toContain('data-testid="question-scope"');
      expect(html).toMatch(/^<div class="ai-panel"><div class="ai-head"><h2>질문<\/h2><div class="ai-line"/);
      expect(html).toMatch(/>설정<\/button><\/div><button class="btn btn--ghost btn--icon" aria-label="질문 칸 닫기" title="질문 칸 닫기"><svg.*?<\/svg><\/button><\/div><div class="panel__body">/);
      expect(html).not.toContain('role="tab"');
      expect(html).not.toContain('AI 작업 취소');
    }
  });

  it('places one selected code range before the question without inventing a function name', () => {
    const html = renderToStaticMarkup(React.createElement(AiPanel, {
      open: true, onClose() {},
      projectId: 'project', relativePath: 'web/lib/auth.ts', stale: false, draft: null,
      evidence: { id: 'selection', projectId: 'project', fileId: 'file', fileHash: 'a'.repeat(64),
        startUtf16: 20, endUtf16: 100, startLine: 3, endLine: 12 },
      connections: null, checking: false, otherRunning: false, mode: 'codex',
      onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
    }));
    expect(html).toContain('<div class="ai-question"><div class="question-target"><span class="eyebrow">질문 대상</span><p class="question-target__code" data-testid="question-scope">web/lib/auth.ts · 3–12행</p></div><label>선택한 코드에 질문');
    expect(html.match(/data-testid="question-scope"/g)).toHaveLength(1);
    expect(html).not.toContain('질문 기준:');
    expect(html).not.toContain('login()');
  });

  it('places the blocked reason immediately after the send button and links its description', () => {
    const html = renderToStaticMarkup(React.createElement(AiPanel, {
      open: true, onClose() {},
      projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
      connections: null, checking: true, otherRunning: false, mode: 'codex',
      onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
    }));
    const actions = html.match(/<div class="ai-actions">(.*?)<\/div>/)?.[1];
    expect(actions).toBeDefined();
    expect(actions).toMatch(/^<button class="btn btn--primary"/);
    const descriptionId = actions?.match(/<button[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(descriptionId).toBeTruthy();
    expect(actions).toContain(`>질문 보내기</button><p class="hint" id="${descriptionId}" data-testid="send-blocked">로컬 AI 설치를 확인하는 중이에요.</p>`);
    expect(html.match(/data-testid="send-blocked"/g)).toHaveLength(1);
    expect(html).not.toContain('함수나 구문을 선택하면 질문할 코드 범위가 정해집니다.');
    expect(html).not.toContain('코드가 바뀌었습니다. 파일을 다시 읽고 근거를 선택해 주세요.');
  });

  it('explains the automatic subset only when a report omits Claude Code', () => {
    const automatic: ConnectionReport = { checkedAt: '2026-10-30T00:00:00.000Z', modes: [], providers: [
      { provider: 'codex', installation: 'missing', version: null, authentication: 'unchecked', isolation: 'unverified', message: 'test' },
      { provider: 'antigravity', installation: 'missing', version: null, authentication: 'unchecked', isolation: 'unverified', message: 'test' },
    ] };
    const manual: ConnectionReport = { ...automatic, providers: [...automatic.providers,
      { ...automatic.providers[0], provider: 'claude-code' }] };
    const windows: ConnectionReport = { ...automatic, providers: [automatic.providers[0]] };
    for (const connections of [null, automatic, manual, windows]) {
      const html = renderToStaticMarkup(React.createElement(AiPanel, {
        open: true, onClose() {},
        projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
        connections, checking: false, otherRunning: false, mode: 'codex',
        onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
      }));
      expect(html.includes('자동 확인은 Codex·Antigravity만 해요. Claude Code까지 보려면 ‘로컬 AI 설치 확인’을 눌러요.')).toBe(connections === automatic);
    }
  });

  it.each([undefined, 'Windows 실험 기능 경고'])('shows the optional warning outside folded settings immediately before consent: %s', warning => {
    const html = renderToStaticMarkup(React.createElement(AiPanel, {
      open: true, onClose() {},
      projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
      connections: { checkedAt: '2026-11-06T00:00:00.000Z', providers: [],
        modes: [{ mode: 'codex', ready: true, reason: 'ready', ...(warning ? { warning } : {}) }] },
      checking: false, otherRunning: false, mode: 'codex',
      onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
    }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false">설정<\/button>/);
    expect(html).toContain('<div class="ai-settings" hidden="">');
    if (!warning) {
      expect(html).not.toContain('data-testid="ai-warning"');
      return;
    }
    expect(html).toContain(`</textarea></label><p class="notice" data-testid="ai-warning">${warning}</p><label class="ai-consent">`);
    expect(html.indexOf('data-testid="ai-warning"')).toBeGreaterThan(html.indexOf('<div class="ai-question">'));
  });
});

describe('sendBlockedReason', () => {
  const sendable = {
    checked: true, checking: false, ready: true, readyReason: null, hasEvidence: true, stale: false,
    running: false, otherRunning: false, question: '이 함수는 무슨 일을 하나요?', consent: true,
  };

  it('shows only the first reason as each prerequisite is resolved', () => {
    const state = { ...sendable, checked: false, ready: false, stale: true, hasEvidence: false,
      running: true, otherRunning: true, question: ' \n\t ', consent: false };
    expect(sendBlockedReason(state)).toBe('먼저 ‘설정’에서 ‘로컬 AI 설치 확인’을 눌러 주세요.');
    state.checked = true;
    expect(sendBlockedReason(state)).toBe('지금 고른 AI 방식은 쓸 수 없어요. ‘설정’에서 다른 방식을 골라 보세요.');
    state.ready = true;
    expect(sendBlockedReason(state)).toBe('코드가 바뀌었어요. 코드 읽기에서 파일을 다시 열고(이미 열려 있으면 ‘파일 다시 읽기’) 함수나 구문을 다시 골라 주세요.');
    state.stale = false;
    expect(sendBlockedReason(state)).toBe('코드 읽기에서 함수나 구문을 골라 주세요. 고른 부분이 질문할 범위가 돼요.');
    state.hasEvidence = true;
    expect(sendBlockedReason(state)).toBeNull();
    state.running = false;
    expect(sendBlockedReason(state)).toBe('다른 AI 작업이 끝나면 보낼 수 있어요.');
    state.otherRunning = false;
    expect(sendBlockedReason(state)).toBe('질문을 적어 주세요.');
    state.question = sendable.question;
    expect(sendBlockedReason(state)).toBe('‘보낼 자료에 동의’에 체크해 주세요.');
    state.consent = true;
    expect(sendBlockedReason(state)).toBeNull();
  });

  it.each([null, '', 'Codex가 필요해요.'])('appends the readiness reason only when present: %s', readyReason => {
    expect(sendBlockedReason({ ...sendable, ready: false, readyReason })).toBe(
      '지금 고른 AI 방식은 쓸 수 없어요. ‘설정’에서 다른 방식을 골라 보세요.'
      + (readyReason ? ` (이유: ${readyReason})` : ''),
    );
  });

  it('has no reason when ready to send or already running', () => {
    expect(sendBlockedReason(sendable)).toBeNull();
    expect(sendBlockedReason({ ...sendable, running: true })).toBeNull();
  });

  const combinations = [
    { checked: false, ready: false }, { checked: true, ready: false }, { checked: true, checking: false, ready: true },
  ].flatMap(readiness => Array.from({ length: 128 }, (_, flags) => ({
    ...sendable, ...readiness, checking: Boolean(flags & 64), hasEvidence: Boolean(flags & 1), stale: Boolean(flags & 2),
    running: Boolean(flags & 4), otherRunning: Boolean(flags & 8),
    question: flags & 16 ? sendable.question : ' \n\t ', consent: Boolean(flags & 32),
  })));

  it.each(combinations)('matches the send gate including an installation check for state %#', state => {
    const disabled = state.checking || !state.ready || !state.hasEvidence || state.stale || !state.consent
      || state.running || state.otherRunning || !state.question.trim();
    if (state.checking) expect(sendBlockedReason(state)).toBe('로컬 AI 설치를 확인하는 중이에요.');
    expect(sendBlockedReason(state) === null && !state.running).toBe(!disabled);
  });
});
