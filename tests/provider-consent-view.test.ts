import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ProjectView, SourceView } from '../src/shared/contracts';
import { PROVIDER_DATA_NOTICE } from '../src/shared/ai';

// Open the preparation form with consent checked; all other state keeps its real initial value.
const hooks = vi.hoisted(() => ({ index: 0, enabled: [] as number[] }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [hooks.enabled.includes(hooks.index++) ? true : initial, () => {}],
}));
import { FeatureGuideCard } from '../src/renderer/feature-guide';
import { FileExplanationCard } from '../src/renderer/file-explanation';
import { OverviewAi } from '../src/renderer/overview';

it.each(['file', 'feature', 'overview'] as const)('keeps the provider notice in %s consent and disables starting during the shared check', kind => {
  const project: ProjectView = { id: 'project', name: 'test', files: [], excluded: {}, warnings: [],
    overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
  const source: SourceView = { projectId: 'project', fileId: 'file', relativePath: 'file.ts', hash: 'a'.repeat(64),
    text: 'const a = 1;', guide: null, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
  for (const checking of [false, true]) {
    hooks.index = 0;
    hooks.enabled = kind === 'file' ? [0, 1] : kind === 'feature' ? [1, 2] : [1];
    const shared = { mode: 'codex' as const, locked: false, running: false, checking,
      connections: { checkedAt: 'test', providers: [], modes: [{ mode: 'codex' as const, ready: true, reason: 'test' }] },
      onInspect: async () => null, onEnsure: async () => null };
    const element = kind === 'file' ? React.createElement(FileExplanationCard, { ...shared, source,
      entry: null, state: null, stale: false, onStart() {}, onCancel() {}, onDelete() {}, onShow() {} })
      : kind === 'feature' ? React.createElement(FeatureGuideCard, { ...shared, projectId: 'project', routesId: 'routes',
        result: null, onResult() {}, onRunning() {}, async onDelete() {} })
      : React.createElement(OverviewAi, { ...shared, project, state: null, stale: false, readiness: { ready: true, reason: 'test' },
        revealAnchor: null, topicName: null, onStart() {}, onCancel() {}, onDelete() {}, onEvidence() {}, onFollow() {}, onFunction() {} });
    const html = renderToStaticMarkup(element);
    const consent = html.match(/<details class="consent-details">.*?<\/details>/)?.[0];
    expect(consent).toContain(PROVIDER_DATA_NOTICE);
    const label = kind === 'file' ? '동의하고 파일 설명 만들기' : kind === 'feature' ? '동의하고 정리하기' : '개요 만들기';
    const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
    expect(button).toBeDefined();
    expect(button?.includes('disabled=""')).toBe(checking);
  }
});
