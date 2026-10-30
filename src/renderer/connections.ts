import type { ConnectionReport } from '../shared/ai';

export function inspectionBlockedReason(state: {
  overviewRunning: boolean; fileExplanationRunning: boolean; questionRunning: boolean; featureGuideRunning: boolean;
}): string | null {
  if (state.overviewRunning) return '개요를 만드는 동안에는 설치를 다시 확인할 수 없어요.';
  if (state.fileExplanationRunning || state.questionRunning || state.featureGuideRunning) return 'AI 작업이 진행 중인 동안에는 설치를 다시 확인할 수 없어요.';
  return null;
}

export function needsAutomaticInspection(connections: ConnectionReport | null, checking: boolean, blockedReason: string | null): boolean {
  if (checking || blockedReason) return false;
  if (!connections) return true;
  return connections.providers.some(item => item.provider !== 'claude-code' && item.installation === 'unusable');
}
