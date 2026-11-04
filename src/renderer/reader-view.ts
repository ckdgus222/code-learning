import type { CodeSymbol } from '../shared/contracts';

export function symbolMeta(symbol: CodeSymbol): string {
  const range = `${symbol.evidence.startLine}–${symbol.evidence.endLine}행`;
  return symbol.steps.length ? `${range} · 단계 ${symbol.steps.length}개` : range;
}
