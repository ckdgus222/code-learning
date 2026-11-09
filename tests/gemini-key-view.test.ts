import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { AiPanel } from '../src/renderer/ai-panel';
import type { GeminiKeyStatus } from '../src/shared/contracts';
import { GEMINI_KEY_WARNING } from '../src/core/ai/runtime';
import { PROVIDER_DATA_NOTICE } from '../src/shared/ai';

function render(status: GeminiKeyStatus, busy = false) {
  return renderToStaticMarkup(React.createElement(AiPanel, {
    open: true, onClose() {}, projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
    connections: { checkedAt: 'test', providers: [], modes: [{ mode: 'antigravity', ready: true, reason: 'ready', warning: GEMINI_KEY_WARNING }] },
    checking: false, otherRunning: false, mode: 'antigravity', keyBusy: busy, geminiKeyStatus: status,
    onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
  }));
}
afterEach(() => vi.unstubAllGlobals());
it.each([
  [{ saved: false, readable: false, canEncrypt: true }, '없음'],
  [{ saved: true, readable: true, canEncrypt: true }, '저장됨'],
  [{ saved: true, readable: false, canEncrypt: true }, '저장된 키를 읽지 못했어요. 다시 넣어 주세요.'],
  [{ saved: false, readable: false, canEncrypt: false }, '이 컴퓨터에서 키를 안전하게 저장할 수 없어요'],
] as const)('shows key status alone: %j', (status, message) => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  const html = render(status);
  expect(html).toContain(`<p role="status">${message}</p>`);
  const input = html.match(/<input[^>]*type="password"[^>]*>/)?.[0];
  expect(input).toContain('autoComplete="off"');
  expect(input).toContain('spellCheck="false"');
  expect(input?.includes('disabled=""')).toBe(false);
  expect(html).toContain(PROVIDER_DATA_NOTICE);
  expect(html.indexOf(GEMINI_KEY_WARNING)).toBeLessThan(html.indexOf('class="ai-consent"'));
});
it('hides key settings on Windows', () => {
  vi.stubGlobal('navigator', { userAgent: 'Windows NT' });
  expect(render({ saved: true, readable: true, canEncrypt: true })).not.toContain('<legend>Gemini API 키</legend>');
});
it('disables saving, clearing, checking and sending while a shared key operation is pending', () => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  const html = render({ saved: true, readable: true, canEncrypt: true }, true);
  for (const label of ['저장', '지우기', '로컬 AI 설치 확인', '질문 보내기']) {
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  }
});
