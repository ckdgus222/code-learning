import type { Analysis, FileGuide } from '../shared/contracts';

export type FunctionBandKind = 'server' | 'jsx' | 'hook' | 'plain';
export interface FunctionBandItem { symbolId: string; text: string; kind: FunctionBandKind }

export function functionParams(params: string): string {
  const text = params.replace(/\s+/g, ' ').trim().replace(/^\(/, '').replace(/\)$/, '').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '없음';
}

export function functionCalls(calls: string[], omitted: number): string {
  return calls.join(', ') + (omitted > 0 ? ` 외 ${omitted}개` : '');
}

export function functionBands(analysis: Analysis, guide: FileGuide | null, lineCount: number): {
  headers: { line: number; items: FunctionBandItem[] }[];
  lines: { line: number; kind: FunctionBandKind }[];
} {
  const facts = new Map(guide?.functions.map(item => [item.symbolId, item]));
  const headers = new Map<number, FunctionBandItem[]>();
  const ranges: { start: number; end: number; kind: FunctionBandKind }[] = [];
  for (const symbol of analysis.symbols) {
    const { startLine, endLine } = symbol.evidence;
    if (startLine < 1 || startLine > lineCount) continue;
    const fact = facts.get(symbol.id);
    const tags = fact?.tags ?? [];
    const kind: FunctionBandKind = tags.some(tag => tag.startsWith('서버 받는 곳 모양')) ? 'server'
      : tags.some(tag => tag.startsWith('JSX')) ? 'jsx' : tags.includes('훅 이름') ? 'hook' : 'plain';
    const labels = tags.map(tag => `${tag}${fact?.routeNote && tag.startsWith('서버 받는 곳 모양') ? ' (공통 앞 경로 제외)' : ''} (모양)`);
    const item = { symbolId: symbol.id, text: [symbol.name, ...labels, `받는 것: ${functionParams(symbol.params)}`].join(' · '), kind };
    const items = headers.get(startLine) ?? [];
    items.push(item);
    headers.set(startLine, items);
    ranges.push({ start: startLine, end: endLine, kind });
  }
  // Paint outer ranges first, so the shortest function owns each overlapping line.
  ranges.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const lines = new Map<number, FunctionBandKind>();
  for (const range of ranges) {
    for (let line = range.start; line <= Math.min(range.end, lineCount); line++) lines.set(line, range.kind);
  }
  return {
    headers: [...headers].sort(([a], [b]) => a - b).map(([line, items]) => ({ line, items })),
    lines: [...lines].sort(([a], [b]) => a - b).map(([line, kind]) => ({ line, kind })),
  };
}
