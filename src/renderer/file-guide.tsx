import React, { useLayoutEffect, useRef, useState } from 'react';
import { STRUCTURE_NOTE, type Analysis, type CallSite, type CodeSymbol, type FileGuide, type GuideRange, type MapImport, type ProjectRoutes } from '../shared/contracts';
import { routeLabel, stopText, storeText } from '../core/analysis/flow-story';
import type { aiFunctionSummaries, functionDoes, Importer, importersOf } from './guide-facts';
import type { CallsState } from './calls';
import type { FileUse } from './screen-groups';
import { ComplexityTags } from './complexity';
import { functionParams } from './code-bands';

const kinds = { imports: '가져오기', class: '클래스', function: '메서드/함수', field: '필드', variable: '값', statement: '문장' };
const importStatuses = { project: '', ambiguous: '어느 파일인지 하나로 정하지 못함', 'not-found': '프로젝트에서 찾지 못함',
  outside: '프로젝트 폴더 밖 · 확인 못 함', 'not-static': '실행할 때 정하는 가져오기 · 확인 못 함',
  unreadable: '가져올 경로를 읽지 못함', syntax: '구문 오류로 확인 못 함' };
// Function cards shown before '더 보기'.
const FIRST_FUNCTIONS = 8;
// Rows of a 'where it is used' list before '외 n개'.
const FIRST_ROWS = 12;

export function FileGuideCard({ guide, analysis, busy, stale, uses, onUse, onShow, onSelect, onOpenFile, focus = null,
  importers, onBuildMap, onCancelMap, onShowImport, does, doesState, ai, callers, onFindCallers, onCancelCallers, onShowCallSite, pathOf }: {
  guide: FileGuide; analysis: Analysis; busy: boolean; stale: boolean;
  uses: { state: 'none' | 'stale' | 'running' | 'ready'; uses: FileUse[]; changed: boolean; routes: ProjectRoutes | null };
  onUse(use: FileUse): void;
  /** A header click in the code; a new object each click, so the same function can be brought back into view. */
  focus?: { symbolId: string } | null;
  onShow(range: GuideRange): void; onSelect(symbolId: string): void; onOpenFile(fileId: string): void;
  importers: { state: 'none' | 'running' | 'ready'; stale: boolean; result: ReturnType<typeof importersOf> | null };
  onBuildMap(): void; onCancelMap(): void; onShowImport(item: MapImport): void;
  does: ReturnType<typeof functionDoes>;
  ai: ReturnType<typeof aiFunctionSummaries>;
  doesState: { routes: 'none' | 'stale' | 'ready'; flows: boolean };
  callers: { symbolId: string; state: CallsState; stale: boolean } | null;
  onFindCallers(symbol: CodeSymbol): void; onCancelCallers(): void; onShowCallSite(site: CallSite): void; pathOf(fileId: string): string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const card = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (!focus || !card.current) return;
    const index = analysis.symbols.findIndex(symbol => symbol.id === focus.symbolId);
    if (index < 0) return;
    card.current.open = true;
    if (index >= FIRST_FUNCTIONS) setExpanded(true);
    // After the expanded list is drawn.
    const frame = requestAnimationFrame(() => {
      card.current?.querySelector(`[data-symbol-id="${CSS.escape(focus.symbolId)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const locked = busy || stale;
  const basis = guide.role.basis;
  const facts = new Map(guide.functions.map(item => [item.symbolId, item]));
  const otherChunks = guide.chunks.filter(item => !item.chunk.functionRange);
  const notes = [
    ...does.notes.routes.map(note => `서버 주소 찾기: ${note}`),
    ...does.notes.flows.map(note => `기능 흐름: ${note}`),
  ];
  const importerRow = ({ fromFileId, relativePath, item }: Importer) => <li key={`${fromFileId}:${item.startUtf16}`}>
    <button className="btn btn--small" disabled={locked} onClick={() => onShowImport(item)}>{relativePath.split('/').at(-1)} 열기</button>{' '}
    {relativePath} · {item.startLine}행
  </li>;
  return <details ref={card} open className="card file-guide" aria-label="이 파일은">
    <summary>이 파일은</summary>
    <p><span className="badge">{guide.role.label}</span> <span className="badge">코드 모양으로 추정</span></p>
    <p>{guide.role.about}</p>
    <section aria-label="이 파일이 나오는 기능">
      {uses.state === 'none' && <p className="hint">기능 흐름을 아직 만들지 않았어요. 한눈에 보기에서 기능 목록을 찾으면 여기 보여요.</p>}
      {uses.state === 'stale' && <p className="hint">코드가 바뀌어 기능 흐름을 다시 만들어야 해요. 한눈에 보기에서 주소를 다시 찾아 주세요.</p>}
      {uses.state === 'running' && <p className="hint">기능 흐름을 만드는 중이에요.</p>}
      {uses.state === 'ready' && <>
        {uses.uses.length > 0 && <>
          <h4>이 파일이 나오는 기능 {uses.uses.length}개</h4>
          <ul className="map-list">{uses.uses.slice(0, FIRST_ROWS).map(use => <li key={JSON.stringify([use.routeIndex, use.screen, use.step])}>
            {use.screen !== null && <>화면 {use.screen} · </>}
            {uses.routes && routeLabel(uses.routes.routes[use.routeIndex])} · {use.step + 1}단계 {use.label}{' '}
            {use.other && <span className="tag">다른 경로</span>}{' '}
            {use.inferred && <span className="tag tag--unknown" title={use.reasons.join(' · ')}>추정 연결</span>}{' '}
            <button className="btn btn--small" disabled={locked} onClick={() => onUse(use)}>이 단계로</button>
          </li>)}</ul>
          {uses.uses.length > FIRST_ROWS && <p className="hint">외 {uses.uses.length - FIRST_ROWS}개</p>}
        </>}
        {uses.changed && <p className="hint">파일이 바뀌어 기능 단계를 다시 찾아야 해요.</p>}
        {!uses.uses.length && !uses.changed && <p className="hint">이 파일이 들어간 기능을 찾지 못했어요.</p>}
      </>}
    </section>
    <section aria-label="이 파일을 가져다 쓰는 파일">
      {importers.state === 'none' && <>
        <p>프로젝트 지도를 만들면 이 파일을 가져다 쓰는 파일도 보여요.</p>
        <button className="btn btn--small" disabled={busy} onClick={onBuildMap}>지도 만들어 찾기</button>
      </>}
      {importers.state === 'running' && <>
        <p>프로젝트 지도를 만드는 중이에요.</p>
        <button className="btn btn--small" onClick={onCancelMap}>취소</button>
      </>}
      {importers.state === 'ready' && importers.result && <>
        {importers.stale && <>
          <p>지도를 만든 뒤 프로젝트가 바뀌었어요. 아래 목록은 그 전 코드 기준이에요.</p>
          <button className="btn btn--small" disabled={busy} onClick={onBuildMap}>다시 찾기</button>
        </>}
        <h4>이 파일을 가져다 쓰는 파일 {importers.result.files.length}개</h4>
        {!importers.result.files.length && <p>이 파일을 가져다 쓰는 파일을 찾지 못했어요.</p>}
        <ul className="map-list">{importers.result.files.slice(0, FIRST_ROWS).map(importerRow)}</ul>
        {importers.result.files.length > FIRST_ROWS && <p className="hint">외 {importers.result.files.length - FIRST_ROWS}개</p>}
        {importers.result.ambiguous.length > 0 && <>
          <p>여럿 중 하나로 정하지 못한 가져오기 {importers.result.ambiguous.length}개:</p>
          <ul className="map-list">{importers.result.ambiguous.slice(0, FIRST_ROWS).map(importerRow)}</ul>
          {importers.result.ambiguous.length > FIRST_ROWS && <p className="hint">외 {importers.result.ambiguous.length - FIRST_ROWS}개</p>}
        </>}
        {(importers.result.unread.length > 0 || importers.result.limitedMap) && <details>
          <summary className="hint">{importers.result.unread.length > 0
            ? `끝까지 못 본 파일 ${importers.result.unread.length}개` : '지도 읽기 한도에 닿음'}</summary>
          <p>이 파일을 가져다 쓰는 파일이 더 있을 수 있어요.</p>
          <ul className="map-list">{importers.result.unread.slice(0, FIRST_ROWS).map(file => <li key={file.relativePath}>
            {file.relativePath} · {file.reason}
          </li>)}</ul>
          {importers.result.unread.length > FIRST_ROWS && <p className="hint">외 {importers.result.unread.length - FIRST_ROWS}개</p>}
          {importers.result.limitedMap && <p className="hint">지도 읽기 한도에 닿아 읽지 않은 파일도 있어요.</p>}
        </details>}
      </>}
      <p className="hint">경로 별칭(@/…)이나 실행할 때 정하는 가져오기는 따라가지 않아서 더 있을 수 있어요.</p>
    </section>
    {basis.range && <button className="btn btn--chip" disabled={locked} onClick={() => onShow(basis.range!)}>
      근거: {basis.text} ({basis.range.startLine}행)
    </button>}
    <p className="hint">코드 모양으로 짐작했어요. 자세한 문장 설명은 아래 AI 설명에서 만들 수 있어요.</p>
    {guide.notes.map(note => <p key={note} className="hint">{note}</p>)}
    {guide.limitations.map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    <h4>가져다 쓰는 파일 {guide.imports.length + guide.importsOmitted}개</h4>
    <ul className="file-guide__imports">{guide.imports.map((item, index) => <li key={index}>
      {item.target && <button className="btn btn--small" disabled={locked} title={item.target.relativePath}
        onClick={() => onOpenFile(item.target!.fileId)}>{item.target.relativePath.split('/').at(-1)} 열기</button>}
      <p className="hint">{item.specifier ?? '경로 확인 못 함'} · {item.line}행{item.status !== 'project' && ` · ${importStatuses[item.status]}`}</p>
    </li>)}</ul>
    {guide.importsOmitted > 0 && <p className="hint">외 {guide.importsOmitted}개</p>}
    {!!guide.external.length && <p className="hint">외부 패키지 또는 경로 별칭 · 확인 못 함: {guide.external.join(', ')}{guide.externalOmitted > 0 && ` 외 ${guide.externalOmitted}개`}</p>}
    {!!guide.exports.length && <p>내보내는 것: {guide.exports.join(', ')}{guide.exportsOmitted > 0 && ` 외 ${guide.exportsOmitted}개`}</p>}
    {analysis.warnings.filter(message => message !== STRUCTURE_NOTE).map(message => <p key={message} className="notice notice--warn">{message}</p>)}
    {doesState.routes === 'none' && <p className="hint">서버 주소를 찾으면 함수가 보내는 요청도 여기 보여요.</p>}
    {doesState.routes === 'stale' && <p className="hint">프로젝트가 바뀌어 서버 주소를 다시 찾아야 해요.</p>}
    {doesState.routes === 'ready' && !doesState.flows && <p className="hint">기능 흐름을 만들면 요청 뒤 할 일도 여기 보여요.</p>}
    {does.changed && <p className="hint">파일이 바뀌어 보내는 요청과 요청 뒤 할 일을 다시 찾아야 해요.</p>}
    {notes.length > 0 && <details>
      <summary className="hint">일부만 확인했어요 · 이유 {notes.length}개</summary>
      <p>보내는 요청과 요청 뒤 할 일이 더 있을 수 있어요.</p>
      <ul className="map-list">{notes.slice(0, FIRST_ROWS).map(note => <li key={note}>{note}</li>)}</ul>
      {notes.length > FIRST_ROWS && <p className="hint">외 {notes.length - FIRST_ROWS}개</p>}
    </details>}
    {analysis.language !== 'text' && ai.state === 'none' && <p className="hint">아래 ‘AI로 이 파일 설명 만들기’를 쓰면, AI가 요약한 함수 카드에 AI 해석을 보여 줘요.</p>}
    {analysis.language !== 'text' && ai.state === 'stale' && <p className="hint">파일이 바뀌어 AI 요약을 숨겼어요. 다시 만들어 주세요.</p>}
    <h4>이 파일의 함수 {analysis.symbols.length}개</h4>
    <p className="hint">종류 표시는 코드 모양으로 판단했어요. 실제로 요청이 이어지는지는 흐름 따라가기에서 확인해요.</p>
    <ol className="file-guide__functions">{(expanded ? analysis.symbols : analysis.symbols.slice(0, FIRST_FUNCTIONS)).map(symbol => {
      const fact = facts.get(symbol.id);
      const actions = does.bySymbol.get(symbol.id);
      const aiSummary = ai.bySymbol.get(symbol.id);
      const hasActions = !!(actions?.requests.length || actions?.after.length || actions?.afterPartly || fact?.stops.length || fact?.stores.length);
      const caller = callers?.symbolId === symbol.id ? callers : null;
      const found = caller?.state.status === 'done' ? caller.state.result : null;
      return <li key={symbol.id} data-symbol-id={symbol.id}>
        <div className="file-guide__function-heading"><strong>{symbol.name}</strong><span className="hint">{symbol.evidence.startLine}–{symbol.evidence.endLine}행</span></div>
        {fact?.tags.map(tag => <p key={tag}><span className="tag">{tag} · 모양으로 판단</span></p>)}
        {fact?.routeNote && <p className="hint">{fact.routeNote}</p>}
        <p>받는 것: {functionParams(symbol.params)}</p>
        {!!fact?.calls.length && <p>부르는 것: {fact.calls.join(', ')}{fact.callsOmitted > 0 && ` 외 ${fact.callsOmitted}개`}</p>}
        {!!fact?.hooks.length && <p>훅처럼 이름 붙인 호출: {fact.hooks.join(', ')}{fact.hooksOmitted > 0 && ` 외 ${fact.hooksOmitted}개`}</p>}
        {hasActions && <>
          <h5>하는 일</h5>
          <ul>
            {actions?.requests.map((action, index) => <li key={`request${index}`}>
              {action.text} ({action.line}행){' '}
              {action.links.length ? action.links.map((link, index) => <React.Fragment key={index}>
                → {link.text}{' '}{link.inferred && <span className="tag tag--unknown" title={link.reasons.join(' · ')}>추정 연결</span>}{' '}
              </React.Fragment>) : <span className="hint">서버 주소와 잇지 못했어요</span>}
            </li>)}
            {actions?.after.map((action, index) => <li key={`after${index}`}>{action.text} · 모양으로 판단 ({action.line}행)</li>)}
            {fact?.stops.map((stop, index) => <li key={`stop${index}`}>{stopText(stop)}{stop.condition ? ` · 조건: ${stop.condition}` : ''} ({stop.site.startLine}행)</li>)}
            {fact?.stores.map((store, index) => <li key={`store${index}`}>{storeText(store)} · 모양으로 판단 ({store.site.startLine}행)</li>)}
          </ul>
          {actions?.afterPartly && <p className="hint">요청 뒤 할 일 일부 생략</p>}
          {!!fact?.stopsOmitted && <p className="hint">오류 외 {fact.stopsOmitted}개</p>}
          {!!fact?.storesOmitted && <p className="hint">저장소 호출 외 {fact.storesOmitted}개</p>}
        </>}
        {!fact?.tags.length && !fact?.calls.length && !fact?.hooks.length && !hasActions && <p className="hint">{aiSummary
          ? '코드에서 찾은 할 일이 없어요.' : '코드에서 찾은 할 일이 없어요. AI에게 물어볼 수 있어요.'}</p>}
        {aiSummary && <>
          <h5>AI 요약</h5>
          <p><span className="tag tag--unknown">AI 해석</span> {aiSummary}</p>
        </>}
        <h5>부르는 곳</h5>
        {!caller && <button className="btn btn--small" disabled={locked} onClick={() => onFindCallers(symbol)}>부르는 곳 찾기</button>}
        {caller?.state.status === 'finding' && <>
          <p role="status">부르는 곳을 찾는 중…</p>
          <button className="btn btn--small" onClick={onCancelCallers}>찾기 취소</button>
        </>}
        {caller?.state.status === 'failed' && <>
          <p>{caller.state.message}</p>
          <button className="btn btn--small" disabled={locked} onClick={() => onFindCallers(symbol)}>다시 찾기</button>
        </>}
        {found && <>
          {caller?.stale && <>
            <p>찾은 뒤 프로젝트가 바뀌었어요. 다시 찾아 주세요.</p>
            <button className="btn btn--small" disabled={locked} onClick={() => onFindCallers(symbol)}>다시 찾기</button>
          </>}
          {found.callers === null && <p>이름이 없는 함수라 부르는 곳을 찾지 않았어요.</p>}
          {found.callers?.length === 0 && <p>확정한 부르는 곳이 없어요.</p>}
          {[found.callers ?? [], found.typedCallers].map((sites: (CallSite & { basis?: string })[], group) => <React.Fragment key={group}>
            {sites.length > 0 && <ul className="map-list">{sites.slice(0, 5).map(site => <li key={`${site.fileId}:${site.startUtf16}`}>
              {pathOf(site.fileId)} {site.startLine}행 · {site.inFunction ? `${site.inFunction.name} 안` : '함수 밖(파일 최상위·클래스 본문)'}{' '}
              <button className="btn btn--small" disabled={locked} onClick={() => onShowCallSite(site)}>호출 위치</button>{' '}
              {site.inTest && <span className="tag">시험 코드</span>}{' '}
              {site.basis !== undefined && <span className="tag" title={site.basis}>타입으로 찾음</span>}
            </li>)}</ul>}
            {sites.length > 5 && <p className="hint">외 {sites.length - 5}개</p>}
          </React.Fragment>)}
          {found.maybeCallers.length > 0 && <p className="hint">이름이 같지만 잇지 못한 호출 {found.maybeCallers.length}개 · 함수 흐름 화면에서 자세히 볼 수 있어요</p>}
          {found.unexamined.length > 0 && <p className="hint">보지 못한 파일 {found.unexamined.length}개가 있어 더 있을 수 있어요.</p>}
        </>}
        <p>크기: {symbol.complexity.lines}줄 · 깊이 {symbol.complexity.depth}</p>
        <ComplexityTags {...symbol.complexity} />
        <div className="file-guide__actions">
          <button className="btn btn--small" disabled={locked} onClick={() => onShow(symbol.evidence)}>코드 보기</button>
          <button className="btn btn--small" disabled={locked} onClick={() => onSelect(symbol.id)}>이 함수 고르기</button>
        </div>
      </li>;
    })}</ol>
    {analysis.symbols.length > FIRST_FUNCTIONS && <button className="btn btn--small" disabled={locked} onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '더 보기'}</button>}
    <details>
      <summary>그 밖의 코드 {otherChunks.length}개</summary>
      <ol className="file-guide__chunks">{(otherExpanded ? otherChunks : otherChunks.slice(0, 8)).map(({ chunk, about }) => {
        const importsLabel = about.startsWith('다시 내보내기') ? '다시 내보내기' : about.includes(' · 다시 내보내기') ? '가져오기·다시 내보내기' : '가져오기';
        const label = chunk.kind === 'imports' ? importsLabel : kinds[chunk.kind];
        const name = chunk.kind === 'imports' ? `${label} (${chunk.range.endLine - chunk.range.startLine + 1}줄)` : chunk.name;
        return <li key={chunk.id}>
          <span className="badge">{label}</span> <strong>{name}</strong> <span className="hint">{chunk.range.startLine}–{chunk.range.endLine}행</span>
          <p>{about}</p>
          <button className="btn btn--small" disabled={locked} onClick={() => onShow(chunk.range)}>코드 보기</button>
        </li>;
      })}</ol>
      {otherChunks.length > 8 && <button className="btn btn--small" disabled={locked} onClick={() => setOtherExpanded(value => !value)}>{otherExpanded ? '접기' : '더 보기'}</button>}
    </details>
  </details>;
}
