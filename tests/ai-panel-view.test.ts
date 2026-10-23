import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiPanel } from '../src/renderer/ai-panel';
import type { ConnectionReport, LearningMode } from '../src/shared/ai';

describe('compact AI panel', () => {
  const modes: [LearningMode, string][] = [
    ['local-worker', '로컬 워커'], ['codex', 'Codex 단독'],
    ['antigravity', 'Gemini 단독'], ['claude-code', 'Claude Code(준비 중)'],
  ];

  it.each(modes)('shows readiness for %s while settings and questions start folded', (mode, label) => {
    for (const ready of [null, false, true]) {
      const connections: ConnectionReport | null = ready === null ? null : {
        checkedAt: '2026-10-23T00:00:00.000Z', providers: [], modes: [{ mode, ready, reason: 'test' }],
      };
      const html = renderToStaticMarkup(React.createElement(AiPanel, {
        projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
        connections, checking: false, otherRunning: false, mode,
        onMode() {}, onRunning() {}, async onInspect() { return null; }, onEvidence() {},
      }));
      expect(html).toContain('class="ai-line" role="group" aria-label="AI 연결"');
      expect(html).toContain(`AI · ${label} · ${ready === null ? '설치 확인 필요' : ready ? '준비됨' : '사용할 수 없음'}`);
      expect(html).toMatch(/<button[^>]*aria-expanded="false">질문하기<\/button>/);
      expect(html).toMatch(/<button[^>]*aria-expanded="false">설정<\/button>/);
      expect(html).toContain('<div class="ai-settings" hidden="">');
      expect(html).toContain('<div class="ai-question" hidden="">');
      expect(html).not.toContain('role="tab"');
      expect(html).not.toContain('AI 작업 취소');
    }
  });
});
