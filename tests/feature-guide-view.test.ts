import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeatureGuideCard, type SavedFeatureGuide } from '../src/renderer/feature-guide';
import { GEMINI_MODEL } from '../src/shared/ai';

const props = { projectId: 'p', routesId: 'r', result: null, mode: 'codex' as const,
  locked: false, running: false, checking: false, connections: null,
  onInspect: async () => null, onEnsure: async () => null, onResult() {}, onRunning() {}, onDelete: async () => {} };
it('starts with only a preparation button and locks it while stale or another AI is running', () => {
  const html = renderToStaticMarkup(React.createElement(FeatureGuideCard, props));
  expect(html).toContain('AI로 기능 정리하기');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain('동의하고 정리하기');
  for (const changed of [{ locked: true }, { running: true }]) {
    expect(renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, ...changed }))).toMatch(/<button[^>]*disabled=""/);
  }
});
it('renders interpretation, mode, review and model metadata as escaped text with folded unknowns', () => {
  const result: SavedFeatureGuide = { savedAt: null, changed: false, jobId: 'job', projectId: 'p', routesId: 'r', mode: 'local-worker', review: 'AI 검토됨',
    guide: { summary: '요약', groups: [], unknowns: ['<script>unknown</script>'] }, limitations: ['일부만 보냄'],
    models: [{ stage: 'explaining', provider: 'antigravity', requestedModel: GEMINI_MODEL, reportedModel: null },
      { stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: 'test-model' }] };
  const html = renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, result }));
  expect(html).toContain('AI 정리 · 정확성을 보장하지 않아요');
  expect(html).toContain('로컬 워커(이전 방식)'); expect(html).toContain('AI 검토됨');
  expect(html).toContain('Gemini 3.8 Flash · High'); expect(html).toContain(GEMINI_MODEL);
  expect(html).toContain('응답 모델: 알려 주지 않음'); expect(html).toContain('응답 모델: test-model');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('일부만 보냄'); expect(html).not.toContain('<details open');
});

it('shows changed saved summaries and deletion even with generation locked, without applying model metadata', () => {
  const result: SavedFeatureGuide = { jobId: 'job', projectId: 'p', routesId: 'r', mode: 'codex', review: 'AI 대조 없음',
    guide: { summary: '저장된 요약', groups: [{ name: 'old group', about: 'old', features: [] }], unknowns: ['모르는 것'] },
    limitations: [], models: [], savedAt: '2026-10-30T00:00:00.000Z', changed: true };
  const html = renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, result, locked: true }));
  expect(html).toContain('기능 정리를 만든 뒤 서버 주소나 그 코드가 바뀌었어요');
  expect(html).toContain('저장된 요약'); expect(html).toContain('모르는 것'); expect(html).toContain('저장됨 ·');
  expect(html).not.toContain('old group'); expect(html).not.toContain('AI 대조 없음');
  expect(html).toContain('<button class="btn btn--small">지우기</button>');
  const unsaved = renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, result: { ...result, savedAt: null } }));
  expect(unsaved).not.toContain('저장됨 ·'); expect(unsaved).toContain('지우기');
  const running = renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, result, running: true }));
  expect(running).not.toContain('>지우기<');
});
