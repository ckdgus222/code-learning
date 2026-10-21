import React from 'react';
import type { CallSite, CallUnknownReason, FunctionCalls } from '../shared/contracts';
import { firstRows, Omitted } from './project-map';

export type CallsState =
  | { status: 'finding' }
  | { status: 'failed'; message: string }
  | { status: 'done'; result: FunctionCalls };
/** A function to move to: a call's target, or the function a call sits in. */
export interface CallFunction { fileId: string; fileHash: string; startUtf16: number; endUtf16: number; startLine: number }

const reasons: Record<CallUnknownReason, string> = {
  member: '멤버 호출이라 대상을 정하지 못했어요',
  expression: '이름이 아닌 식을 불러 대상을 정할 수 없어요',
  'not-function': '가장 가까운 선언이 매개변수나 변수라 들어오는 함수를 정할 수 없어요',
  var: 'var로 선언된 이름이라 범위를 정할 수 없어요',
  'block-function': '블록 안 함수 선언이라 범위를 정할 수 없어요',
  duplicate: '같은 이름이 여러 번 선언됐어요',
  reassigned: '다시 대입돼요',
  undeclared: '선언을 찾지 못했어요(전역·내장 이름일 수 있어요)',
  'unclear-file': '파일에 with·eval·이스케이프로 쓴 이름·전역 객체의 동적 키·using 선언이 있어 이름을 정할 수 없어요',
  namespace: 'TS namespace·enum 안이라 이름을 정할 수 없어요',
  incomplete: '파일을 끝까지 보지 못해 확정하지 않았어요(분석 한도 또는 구문 오류)',
  'import-file': '가져온 파일을 정할 수 없어요',
  export: '가져온 파일에서 그 이름으로 내보낸 함수를 하나로 정할 수 없어요',
};

/**
 * Plan v2.3 F in the flow view's function summary: what the function calls and where it is called from.
 * Found from names in the code only; the buttons move only while the file is as it was when searched.
 */
export function CallsFacts({ state, stale, locked, pathOf, onRetry, onCancel, onShowSite, onShowFunction }: {
  state: CallsState; stale: boolean; locked: boolean; pathOf(fileId: string): string;
  onRetry(): void; onCancel(): void; onShowSite(site: CallSite): void; onShowFunction(target: CallFunction): void;
}) {
  if (state.status !== 'done') {
    return <><dt>부르는 것·부르는 곳</dt><dd>
      {state.status === 'finding' ? <>
        <span role="status" className="busy"><span className="spinner" aria-hidden="true" />호출 관계를 찾는 중…</span>
        <button className="btn btn--small" onClick={onCancel}>찾기 취소</button>
      </> : <><p>{state.message}</p><button className="btn btn--small" disabled={locked} onClick={onRetry}>다시 찾기</button></>}
    </dd></>;
  }
  const { result } = state;
  const at = (site: CallSite, withPath: boolean) => <>
    <span className="path">{withPath && `${pathOf(site.fileId)} `}{site.startLine}행</span> <code>{site.text}</code>
  </>;
  const siteButton = (site: CallSite) => <button className="btn btn--small" disabled={locked} onClick={() => onShowSite(site)}>호출 위치</button>;
  const functionButton = (target: CallFunction) =>
    <button className="btn btn--small" disabled={locked} onClick={() => onShowFunction(target)}>그 함수로</button>;
  // A function is often exported by the name it has in its file, so each name is shown once.
  const named = [...new Set([...result.names.local, ...result.names.exported.map(name => name === 'default' ? '기본 내보내기' : name)])];
  const searchedFor = [named.length > 0 && `찾은 이름: ${named.join(', ')}`,
    result.names.property.length > 0 && `멤버 호출 이름: ${result.names.property.join(', ')}`].filter(Boolean).join(' · ');
  return <>
    {stale && <><dt>다시 확인 필요</dt><dd>
      <p>호출을 찾은 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 아래 목록은 그 전 코드 기준이에요.</p>
      <button className="btn btn--small" disabled={locked} onClick={onRetry}>다시 찾기</button>
    </dd></>}
    <dt>부르는 것 · {result.calls.length}개</dt>
    <dd>
      {result.calls.length ? <ul className="map-list" aria-label="이 함수가 부르는 것">{firstRows(result.calls).map(call => <li key={`${call.startUtf16}:${call.endUtf16}`}>
        {at(call, false)}
        {call.status === 'linked' || call.status === 'typed' ? <> → <b>{call.target.name}</b> <span className="path">{pathOf(call.target.fileId)}</span>{call.status === 'typed' && <span title={call.basis}> · 타입으로 찾음</span>} {functionButton(call.target)}</>
          : call.status === 'external' ? <> · <span className="tag tag--doc">외부 패키지 또는 경로 별칭</span><code>{call.specifier}</code></>
          : <> · <span className="tag tag--unknown">확인 못 함</span>{reasons[call.reason]}{call.detail && ` · ${call.detail}`}</>}
        {' '}{siteButton(call)}
      </li>)}</ul> : <p>이 함수 본문에서 찾은 호출이 없어요.</p>}
      <Omitted count={result.calls.length} />
      <p className="hint">안에 든 함수(콜백 등)의 호출은 그 함수를 골라 보세요.</p>
    </dd>
    <dt>부르는 곳{result.callers && ` · ${result.callers.length}개`}</dt>
    <dd>
      {!result.callers ? <p>이름으로 불리지 않는 함수라 부르는 곳을 찾지 않았어요.</p>
        : result.callers.length ? <ul className="map-list" aria-label="이 함수를 부르는 곳">{firstRows(result.callers).map(site => <li key={`${site.fileId}:${site.startUtf16}`}>
          {at(site, true)} · {site.inFunction ? `${site.inFunction.name} 안` : '함수 밖(파일 최상위·클래스 본문)'}
          {' '}{site.inFunction && functionButton({ ...site.inFunction, fileId: site.fileId, fileHash: site.fileHash })} {siteButton(site)}
        </li>)}</ul> : <p>이 함수로 이어진 호출을 찾지 못했어요.</p>}
      {result.callers && <Omitted count={result.callers.length} />}
      {result.typedCallers.length > 0 && <>
        <p>타입으로 찾은 부르는 곳 · {result.typedCallers.length}개</p>
        <ul className="map-list" aria-label="타입으로 찾은 부르는 곳">{firstRows(result.typedCallers).map(site => <li key={`${site.fileId}:${site.startUtf16}`}>
          {at(site, true)} · <span title={site.basis}>{site.inFunction ? `${site.inFunction.name} 안` : '함수 밖'}</span> {siteButton(site)}
        </li>)}</ul>
        <Omitted count={result.typedCallers.length} />
      </>}
      {result.maybeCallers.length > 0 && <details><summary>이름이 같지만 잇지 못한 호출 · {result.maybeCallers.length}개</summary>
        <ul className="map-list" aria-label="이름이 같지만 잇지 못한 호출">{firstRows(result.maybeCallers).map(site => <li key={`${site.fileId}:${site.startUtf16}`}>
          {at(site, true)} · <span className="tag tag--unknown">확인 못 함</span>{reasons[site.reason]}{site.detail && ` · ${site.detail}`} {siteButton(site)}
        </li>)}</ul>
        <Omitted count={result.maybeCallers.length} />
      </details>}
      {result.unexamined.length > 0 && <details><summary>끝까지 보지 못한 파일 · {result.unexamined.length}개</summary>
        <ul className="map-list">{firstRows(result.unexamined).map(file => <li key={file.fileId}><span className="path">{file.relativePath}</span> · {file.reason}</li>)}</ul>
        <Omitted count={result.unexamined.length} />
      </details>}
      {result.notes.map(note => <p key={note} className="hint">{note}</p>)}
      {searchedFor && <p className="hint">{searchedFor}</p>}
      <p className="hint">타입으로 찾음은 적힌 타입 기준이라 실제로 다른 객체가 들어올 수 있어요.</p>
      <p className="hint">코드에 적힌 이름으로 찾은 호출이에요. 실제로 불리는지, 몇 번 불리는지, 어떤 순서인지는 아니에요.</p>
    </dd>
  </>;
}
