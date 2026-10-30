import { describe, expect, it } from 'vitest';
import type { ConnectionReport, ProviderConnection } from '../src/shared/ai';
import { checkConnectionsSchema } from '../src/shared/ai';
import { inspectionBlockedReason, needsAutomaticInspection } from '../src/renderer/connections';

const idle = { overviewRunning: false, fileExplanationRunning: false, questionRunning: false, featureGuideRunning: false };
const report = (installation: ProviderConnection['installation'], provider: ProviderConnection['provider'] = 'codex'): ConnectionReport => ({
  checkedAt: '2026-10-30T00:00:00.000Z', modes: [],
  providers: [{ provider, installation, version: null, authentication: 'unchecked', isolation: 'unverified', message: 'test' }],
});

describe('automatic installation inspection', () => {
  it('starts without a result, including after a failed IPC, but never while checking', () => {
    expect(needsAutomaticInspection(null, false, null)).toBe(true);
    expect(needsAutomaticInspection(null, true, null)).toBe(false);
    expect(needsAutomaticInspection(null, false, null)).toBe(true);
    expect(needsAutomaticInspection(report('unusable'), true, null)).toBe(false);
  });

  it.each(Object.keys(idle) as (keyof typeof idle)[])('skips %s and can check when that job ends', key => {
    const blocked = inspectionBlockedReason({ ...idle, [key]: true });
    expect(blocked).not.toBeNull();
    expect(needsAutomaticInspection(null, false, blocked)).toBe(false);
    expect(needsAutomaticInspection(report('unusable'), false, blocked)).toBe(false);
    expect(needsAutomaticInspection(null, false, inspectionBlockedReason(idle))).toBe(true);
  });

  it('retries only unusable automatic providers, not missing programs or Claude Code', () => {
    expect(needsAutomaticInspection(report('found'), false, null)).toBe(false);
    expect(needsAutomaticInspection(report('missing'), false, null)).toBe(false);
    expect(needsAutomaticInspection(report('unusable', 'claude-code'), false, null)).toBe(false);
    for (const provider of ['codex', 'antigravity'] as const) {
      expect(needsAutomaticInspection(report('unusable', provider), false, null)).toBe(true);
    }
  });
});

describe('installation inspection input', () => {
  it('accepts only the manual default and explicit automatic inspection', () => {
    expect(checkConnectionsSchema.parse(undefined)).toBeUndefined();
    expect(checkConnectionsSchema.parse({ automatic: true })).toEqual({ automatic: true });
  });
  it.each([null, {}, { automatic: false }, { automatic: true, extra: true }, { extra: true }, true])('rejects %j', input => {
    expect(checkConnectionsSchema.safeParse(input).success).toBe(false);
  });
});
