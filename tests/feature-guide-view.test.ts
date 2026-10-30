import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeatureGuideCard } from '../src/renderer/feature-guide';
import { GEMINI_MODEL, type FeatureGuideResult } from '../src/shared/ai';

const props = { projectId: 'p', routesId: 'r', result: null, mode: 'local-worker' as const,
  locked: false, running: false, checking: false, connections: null,
  onInspect: async () => null, onEnsure: async () => null, onResult() {}, onRunning() {} };
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
  const result: FeatureGuideResult = { jobId: 'job', projectId: 'p', routesId: 'r', mode: 'local-worker', review: 'AI 검토됨',
    guide: { summary: '요약', groups: [], unknowns: ['<script>unknown</script>'] }, limitations: ['일부만 보냄'],
    models: [{ stage: 'explaining', provider: 'antigravity', requestedModel: GEMINI_MODEL, reportedModel: null },
      { stage: 'reviewing', provider: 'codex', requestedModel: null, reportedModel: 'test-model' }] };
  const html = renderToStaticMarkup(React.createElement(FeatureGuideCard, { ...props, result }));
  expect(html).toContain('AI 정리 · 정확성을 보장하지 않아요');
  expect(html).toContain('Gemini 정리 → Codex 대조'); expect(html).toContain('AI 검토됨');
  expect(html).toContain('Gemini 3.8 Flash · High'); expect(html).toContain(GEMINI_MODEL);
  expect(html).toContain('응답 모델: 알려 주지 않음'); expect(html).toContain('응답 모델: test-model');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('일부만 보냄'); expect(html).not.toContain('<details open');
});
