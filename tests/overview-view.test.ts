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
    project, state, stale: false, locked, checking, readiness: null, revealAnchor: null, topicName: null,
    onInspect() {}, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {},
  }));
  expect(html.includes('저장됨 ·')).toBe(savedAt !== null);
  if (savedAt) expect(html).toContain('10월 30일');
  expect(html).toMatch(/<button[^>]*>지우기<\/button>/);
  expect(/<button[^>]*disabled=""[^>]*>지우기<\/button>/.test(html)).toBe(locked || checking);
});
