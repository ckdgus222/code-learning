import React, { useMemo } from 'react';
import type { MapSymbol } from '../shared/contracts';
import type { MapEntry } from './project-map';
import { searchSymbols, SYMBOL_HIT_LIMIT, symbolsIncomplete } from './symbol-search';

export function SymbolResults({ query, entry, stale, mapping, locked, onBuild, onShow }: {
  query: string;
  entry: MapEntry | null;
  stale: boolean;
  mapping: boolean;
  locked: boolean;
  onBuild(): void;
  onShow(symbol: MapSymbol): void;
}): React.ReactNode {
  const map = entry?.map;
  const { hits, total } = useMemo(() => map ? searchSymbols(map, query) : { hits: [], total: 0 }, [map, query]);
  if (!query.trim()) return null;
  return <section className="symbol-results" aria-label="함수·클래스 검색 결과">
    {mapping && <p role="status" className="hint">함수·클래스 이름을 모으는 중…</p>}
    {!map && !mapping && <>
      <p className="hint">함수·클래스 이름은 지도를 만들 때 함께 모아요.</p>
      <button type="button" className="btn btn--small" disabled={locked} onClick={onBuild}>이름 모으기</button>
    </>}
    {map && <>
      <h3 className="eyebrow">함수·클래스 · {total}개</h3>
      {hits.length > 0 ? <ul>{hits.map(({ symbol, relativePath }) => <li key={`${symbol.fileId}:${symbol.startUtf16}:${symbol.kind}`}>
        <button type="button" className="files__item" disabled={locked} title={symbol.name} onClick={() => onShow(symbol)}>{symbol.name}</button>
        <span className="symbol-results__place">{symbol.kind === 'function' ? '함수' : '클래스'} · {relativePath}:{symbol.startLine}</span>
      </li>)}</ul> : <p className="hint">일치하는 함수·클래스가 없어요.</p>}
      {total > SYMBOL_HIT_LIMIT && <p className="hint">처음 {SYMBOL_HIT_LIMIT}개만 보여요. 나머지 {total - SYMBOL_HIT_LIMIT}개는 검색어를 더 적어 주세요.</p>}
      <p className="hint">지도가 읽은 TS/JS·Python 파일에서 찾아요.{symbolsIncomplete(map) && ' 끝까지 읽지 못한 파일이나 빠진 이름이 있어요.'}</p>
      {stale && <p className="hint">지도를 만든 뒤 파일이 바뀌었어요. 이름과 위치가 지금과 다를 수 있어요.</p>}
    </>}
  </section>;
}
