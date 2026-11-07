import React, { useEffect, useId, useState } from 'react';
import { savedDate } from './overview';
import type { SourceView } from '../shared/contracts';
import { GEMINI_MODEL, type ConnectionReport, type FileExplanationRange, type FileExplanationResult,
  type ResultMode, type LearningMode, type LearningPhase } from '../shared/ai';

export interface FileExplanationEntry { result: FileExplanationResult; revision: number; savedAt: string | null }
export type FileExplanationState =
  | { status: 'running'; fileId: string; revision: number; phase: LearningPhase | null; mode: LearningMode }
  | { status: 'failed'; fileId: string; message: string; cancelled: boolean };

/** One current result per file, keyed by its ID and hash, with the oldest of 20 files removed together with its ranges. */
export function rememberFileExplanation(previous: FileExplanationEntry[], entry: FileExplanationEntry): FileExplanationEntry[] {
  return [...previous.filter(item => item.result.range.fileId !== entry.result.range.fileId).slice(-19), entry];
}

const modes: Record<ResultMode, string> = {
  'local-worker': '로컬 워커(이전 방식)', codex: 'Codex 단독 · 대조 없음',
  antigravity: 'Gemini 단독 (Antigravity) · 대조 없음', 'claude-code': 'Claude Code 단독 · 준비 중',
};
const phases: Record<LearningPhase, string> = {
  collecting: '설명할 파일 확인 중', organizing: '작업 정리 중', 'reading-related': '자료 확인 중',
  explaining: '설명 요청 중', validating: '파일 변경 여부 확인 중',
};

export function FileExplanationCard({ source, entry, state, stale, mode, locked, running, checking, connections, onInspect, onEnsure, onStart, onCancel, onDelete, onShow }: {
  source: SourceView; entry: FileExplanationEntry | null; state: FileExplanationState | null; stale: boolean;
  mode: LearningMode; locked: boolean; running: boolean; checking: boolean; connections: ConnectionReport | null;
  onEnsure(): void; onInspect(): void; onStart(): void; onCancel(): void; onDelete(): void; onShow(range: FileExplanationRange): void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [consent, setConsent] = useState(false);
  const consentDescriptionId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setPreparing(false); setConsent(false); setExpanded(false); }, [source.fileId, source.hash, mode, entry?.result.jobId]);
  const ready = connections?.modes.find(item => item.mode === mode);
  const working = state?.status === 'running';
  const result = entry?.result;
  const chunks = result ? (expanded ? result.chunks : result.chunks.slice(0, 6)) : [];
  const tooLarge = new TextEncoder().encode(source.text).length > 32 * 1024;
  return <section className="card file-explanation" aria-label="이 파일 설명">
    <h3>이 파일 설명</h3>
    <p className="hint">이 파일의 경로와 원문(비밀값처럼 보이는 형태는 가림), 덩어리 목록(ID·종류·이름·행 범위)을 보내요. 다른 파일은 보내지 않아요.</p>
    {stale && result && <p className="notice notice--warn">다시 확인 필요: 설명을 만든 뒤 코드가 바뀌었어요.</p>}
    {tooLarge && <p className="hint">파일이 32 KiB를 넘어 설명을 만들지 않았어요.</p>}
    {!preparing && !working && <button className="btn" disabled={locked || running || tooLarge}
      onClick={() => { setPreparing(true); onEnsure(); }}>이 파일 설명 만들기</button>}
    {preparing && !working && <div>
      <p>{source.relativePath} · {modes[mode]}</p>
      <p className="hint">방식은 ‘질문’ 칸의 ‘설정’에서 고를 수 있어요. 답변 생성은 AI 제공자 서버에서 이뤄져요.
        {mode !== 'codex' && mode !== 'claude-code' && ` Gemini 3.8 Flash · High (${GEMINI_MODEL})를 요청해요.`}</p>
      <button className="btn" disabled={checking || running} onClick={onInspect}>{checking ? '설치 확인 중…' : '로컬 AI 설치 확인'}</button>
      <p className="hint">{ready?.reason ?? '먼저 설치 상태를 확인해 주세요. 설치 확인만으로 로그인이나 실제 AI 연결이 검증되는 것은 아닙니다.'}</p>
      <label className="ai-consent"><input type="checkbox" checked={consent} disabled={running || !ready?.ready}
        aria-describedby={consentDescriptionId} onChange={event => setConsent(event.target.checked)} />보낼 자료에 동의</label>
      <details className="consent-details">
        <summary>무엇을 보내나요?</summary>
        <p id={consentDescriptionId}>이 파일의 경로와 원문(비밀값처럼 보이는 형태는 가림)·덩어리 목록(ID·종류·이름·행 범위)을
          {mode === 'codex' ? ' Codex' : mode === 'antigravity' ? ' Gemini(Antigravity)' : ' Claude Code'}에 보내는 데 동의합니다.
          다른 파일은 보내지 않습니다. 모든 비밀값을 찾는다고 보장하지는 않습니다.</p>
      </details>
      <button className="btn btn--primary" disabled={!consent || !ready?.ready || locked || running || checking || tooLarge}
        onClick={() => { setConsent(false); onStart(); }}>동의하고 파일 설명 만들기</button>
    </div>}
    {working && <p role="status">{state.phase === 'explaining'
      ? state.mode === 'codex' ? 'Codex에 설명 요청 중' : `Gemini 3.8 Flash · High (${GEMINI_MODEL})에 설명 요청 중`
      : state.phase ? phases[state.phase] : 'AI 작업 시작 중'} <button className="btn btn--small" onClick={onCancel}>AI 작업 취소</button></p>}
    {state?.status === 'failed' && <p role={state.cancelled ? 'status' : 'alert'}>{state.message}</p>}
    {entry && !working && <p className="hint">
      {entry.savedAt && <>저장됨 · {savedDate(entry.savedAt)} </>}
      <button className="btn btn--small" disabled={locked || running} onClick={onDelete}>지우기</button>
    </p>}
    {result && <>
      <p data-testid="file-summary">{result.explanation.summary}</p>
      <button className="btn btn--small" disabled={locked || stale} onClick={() => onShow(result.range)}>파일 전체 근거</button>
      <ul className="file-explanation__chunks">{chunks.map(chunk => <li key={chunk.id}>
        <b>{chunk.name}</b> <span className="hint">{chunk.range.startLine}–{chunk.range.endLine}행</span>
        <p>{result.explanation.chunks.find(item => item.chunkId === chunk.id)?.summary ?? '설명 없음'}</p>
        <button className="btn btn--small" disabled={locked || stale} onClick={() => onShow(chunk.range)}>코드 보기</button>
      </li>)}</ul>
      {result.chunks.length > 6 && <button className="btn btn--small" onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '더 보기'}</button>}
      <h4>확인하지 못한 것</h4>
      {result.explanation.unknowns.length ? <ul>{result.explanation.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>
        : <p className="hint">AI가 따로 적은 항목이 없어요.</p>}
      {result.limitations.map((item, index) => <p className="hint" key={index}>{item}</p>)}
      <p className="hint">AI 해석이며 정확성을 보장하지 않아요 · {modes[result.mode]} · {result.review}</p>
      <ul className="hint">{result.models.map((model, index) => <li key={index}>{model.provider === 'codex' ? 'Codex' : 'Gemini 3.8 Flash · High'}
        {' · '}{model.stage === 'reviewing' ? '대조' : '설명'} · 요청 모델: {model.requestedModel ?? '실행기 기본값'} · 응답 모델: {model.reportedModel ?? '알려 주지 않음'}</li>)}</ul>
    </>}
  </section>;
}
