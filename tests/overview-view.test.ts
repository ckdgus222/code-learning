import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { OverviewAi, type OverviewState } from '../src/renderer/overview';
import type { ProjectView } from '../src/shared/contracts';
import type { OverviewResult } from '../src/shared/ai';

const project: ProjectView = { id: 'project', name: 'test', files: [], excluded: {}, warnings: [],
  overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
const result: OverviewResult = { jobId: 'job', projectId: project.id, sources: [], limitations: [], models: [], review: '개요 작성 안 함',
  overview: { intro: null, features: [], roles: [], unknowns: [] } };

it.each([
  { savedAt: '2026-10-30T00:00:00.000Z', locked: false, checking: false },
  { savedAt: null, locked: false, checking: false },
  { savedAt: '2026-10-30T00:00:00.000Z', locked: true, checking: false },
  { savedAt: null, locked: false, checking: true },
])('shows saved dates only after acknowledgement and locks deletion during conflicting work %#', ({ savedAt, locked, checking }) => {
  const state: OverviewState = { status: 'done', result, revision: 0, savedAt, changed: false };
  const html = renderToStaticMarkup(React.createElement(OverviewAi, {
    project, mode: 'codex', state, stale: false, locked, checking, readiness: null, revealAnchor: null, topicName: null,
    onInspect() {}, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {},
  }));
  expect(html.includes('저장됨 ·')).toBe(savedAt !== null);
  if (savedAt) expect(html).toContain('10월 30일');
  expect(html).toMatch(/<button[^>]*>지우기<\/button>/);
  expect(/<button[^>]*disabled=""[^>]*>지우기<\/button>/.test(html)).toBe(locked || checking);
});

it.each([
  ['codex', 'Codex', 'Codex', 'Codex'],
  ['antigravity', 'Gemini(Antigravity)', 'Gemini(Antigravity)', 'Gemini(Antigravity)'],
  ['claude-code', 'Claude Code', 'Claude Code', 'Claude Code'],
] as const)('shows the recipients, disclosure and progress for %s', (mode, recipient, picker, writer) => {
  const render = (state: OverviewState | null) => renderToStaticMarkup(React.createElement(OverviewAi, {
    project, mode, state, stale: false, locked: false, checking: false, readiness: { ready: true, reason: 'test' },
    revealAnchor: null, topicName: null,
    onInspect() {}, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {},
  }));
  const html = render(null);
  expect(html).toContain(`${picker}가 고른 관련 파일(최대 4개)을 ${recipient}에 보내는 데 동의합니다.`);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>개요 만들기<\/button>/);
  expect(html).toContain(`고른 AI(${recipient})가 시작 파일 하나와 스스로 고른 파일 최대 4개만 읽고 써요. 다른 AI의 대조는 없어요.`);
  expect(html).not.toContain('로컬 워커(Codex');
  expect(render({ status: 'running', phase: 'organizing', revision: 0 })).toContain(`${picker}가 읽을 파일을 고르는 중`);
  expect(render({ status: 'running', phase: 'explaining', revision: 0 })).toContain(`${writer}가 개요를 쓰는 중`);
});

it.each(['AI 검토됨', 'AI 대조 없음', '개요 작성 안 함'] as const)('displays the saved review status %s', review => {
  const html = renderToStaticMarkup(React.createElement(OverviewAi, {
    project, mode: 'codex', state: { status: 'done', result: { ...result, review }, revision: 0, savedAt: null, changed: false },
    stale: false, locked: false, checking: false, readiness: null, revealAnchor: null, topicName: null,
    onInspect() {}, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {},
  }));
  expect(html).toContain(review === '개요 작성 안 함' ? '읽은 자료가 없어 개요를 쓰지 않았어요.' : `${review} · 개요의 정확성을 보장하지 않습니다.`);
});

it('labels the legacy overview without a mode field from its saved reviewing stage', () => {
  const legacy: OverviewResult = { ...result, review: 'AI 검토됨',
    models: [{ stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: null }] };
  expect(legacy).not.toHaveProperty('mode');
  const html = renderToStaticMarkup(React.createElement(OverviewAi, {
    project, mode: 'codex', state: { status: 'done', result: legacy, revision: 0, savedAt: null, changed: false },
    stale: false, locked: false, checking: false, readiness: null, revealAnchor: null, topicName: null,
    onInspect() {}, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {},
  }));
  expect(html).toContain('로컬 워커(이전 방식)');
  expect(html).toContain('AI 검토됨');
});
