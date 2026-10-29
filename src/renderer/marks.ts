import type { CodeSymbol, LearningMark, MarkKey, SourceView } from '../shared/contracts';

export function markName(name: string): string { return name.replace(/ \(\d+행\)$/, ''); }

/** Every function's key by its ID, counted in one pass over the file's functions. */
export function markKeysOf(source: SourceView): Map<string, MarkKey> {
  const seen = new Map<string, number>();
  return new Map(source.analysis.symbols.map(item => {
    const name = markName(item.name);
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return [item.id, { relativePath: source.relativePath, name, occurrence }];
  }));
}


export function sameMarkKey(left: MarkKey, right: MarkKey): boolean {
  return left.relativePath === right.relativePath && left.name === right.name && left.occurrence === right.occurrence;
}

export async function functionCodeHash(source: SourceView, symbol: CodeSymbol): Promise<string> {
  const text = source.text.slice(symbol.evidence.startUtf16, symbol.evidence.endUtf16);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function markView(mark: LearningMark | undefined, currentHash: string | undefined): {
  state: LearningMark['state']; changed: boolean; note: string;
} {
  return { state: mark?.state ?? null, note: mark?.note ?? '',
    changed: !!mark && currentHash !== undefined && mark.codeHash !== currentHash };
}

export type MarkChange = { state: LearningMark['state'] } | { note: string } | { confirm: true };

export function nextMark(previous: LearningMark | undefined, change: MarkChange, currentHash: string, key: MarkKey): Omit<LearningMark, 'savedAt'> {
  return { ...key, state: 'state' in change ? change.state : previous?.state ?? null,
    note: 'note' in change ? change.note : previous?.note ?? '',
    codeHash: 'note' in change ? previous?.codeHash ?? currentHash : currentHash };
}
