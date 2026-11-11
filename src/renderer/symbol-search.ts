import type { CodeSymbol, MapSymbol, ProjectMap, SourceView } from '../shared/contracts';
import { matchFunction } from './map-layout';

export const SYMBOL_HIT_LIMIT = 50;
export interface SymbolHit { symbol: MapSymbol; relativePath: string }

/** The symbols whose name holds the query, best matches first; `total` counts all of them. */
export function searchSymbols(map: ProjectMap, query: string): { hits: SymbolHit[]; total: number } {
  const term = query.trim().toLowerCase();
  if (!term) return { hits: [], total: 0 };
  const paths = new Map(map.files.map(file => [file.id, file.relativePath]));
  const matches: (SymbolHit & { rank: number })[] = [];
  for (const symbol of map.symbols) {
    const relativePath = paths.get(symbol.fileId);
    const name = symbol.name.toLowerCase();
    if (relativePath === undefined || !name.includes(term)) continue;
    const last = name.slice(name.lastIndexOf('.') + 1);
    const rank = name === term || last === term ? 0 : name.startsWith(term) || last.startsWith(term) ? 1 : 2;
    matches.push({ symbol, relativePath, rank });
  }
  matches.sort((a, b) => a.rank - b.rank || a.symbol.name.length - b.symbol.name.length
    || a.relativePath.localeCompare(b.relativePath) || a.symbol.startUtf16 - b.symbol.startUtf16);
  return { hits: matches.slice(0, SYMBOL_HIT_LIMIT).map(({ symbol, relativePath }) => ({ symbol, relativePath })), total: matches.length };
}

/** True when names may be missing from the list: files not read to the end, or the list cut at its limit. */
export function symbolsIncomplete(map: ProjectMap): boolean {
  return map.limited || map.symbolsCut || map.files.some(file => ['partial', 'failed', 'skipped'].includes(file.checked));
}

export type SymbolJump =
  | { status: 'dropped' }
  | { status: 'changed' }
  | { status: 'function'; symbol: CodeSymbol }
  | { status: 'range' };

/** Reads the symbol's file and decides what may be marked, without marking anything itself. */
export async function findSymbol(item: MapSymbol, read: (fileId: string) => Promise<SourceView | null | undefined>,
  revision: () => number): Promise<SymbolJump> {
  const before = revision();
  const source = await read(item.fileId);
  if (!source || revision() !== before) return { status: 'dropped' };
  if (source.fileId !== item.fileId || source.hash !== item.fileHash) return { status: 'changed' };
  if (item.kind !== 'function') return { status: 'range' };
  const found = matchFunction(source, item);
  if (found.status === 'found') return { status: 'function', symbol: found.symbol };
  return { status: 'range' };
}
