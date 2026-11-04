import React, { useEffect, useId, useRef, useState } from 'react';
import { savedDate } from './overview';
import { GEMINI_MODEL, type ConnectionReport, type FeatureGuideResult, type LearningEvent, type LearningMode, type LearningPhase } from '../shared/ai';

const modes: Record<LearningMode, string> = {
  'local-worker': '로컬 워커 · Gemini 정리 → Codex 대조', codex: 'Codex 단독 · 대조 없음',
  antigravity: 'Gemini 단독 (Antigravity) · 대조 없음', 'claude-code': 'Claude Code 단독 · 준비 중',
};
const phases: Record<LearningPhase, string> = {
  collecting: '기능 목록 확인 중', organizing: '작업 정리 중', 'reading-related': '자료 확인 중',
  explaining: '기능 정리 요청 중', reviewing: 'Codex가 주소·함수 이름과 대조 중', validating: '기능 목록 변경 여부 확인 중',
};

export type SavedFeatureGuide = FeatureGuideResult & { savedAt: string | null; changed: boolean };

/** Mounted for one routesId/revision only; leaving that result cancels even an IPC start still in flight. */
export function FeatureGuideCard({ projectId, routesId, result, mode, locked, running, checking, connections, onInspect, onEnsure, onResult, onRunning, onDelete, storageError = '' }: {
  projectId: string; routesId: string; result: SavedFeatureGuide | null; mode: LearningMode;
  locked: boolean; running: boolean; checking: boolean; connections: ConnectionReport | null;
  onEnsure(): Promise<string | null>; onInspect(): Promise<string | null>; onResult(result: FeatureGuideResult): void; onRunning(value: boolean): void; onDelete(): Promise<void>;
  /** A failed save, load or deletion of the stored guide. */
  storageError?: string;
}) {
  const [deleting, setDeleting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [phase, setPhase] = useState<LearningPhase | null>(null);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const descriptionId = useId();
  const sequence = useRef(0);
  const job = useRef<{ id: string | null; starting: boolean; queued: LearningEvent[] }>({ id: null, starting: false, queued: [] });
  const receive = useRef((_event: LearningEvent) => {});
  receive.current = event => {
    if (event.projectId !== projectId) return;
    if (job.current.starting) { if (job.current.queued.length < 16) job.current.queued.push(event); return; }
    if (event.jobId !== job.current.id) return;
    if (event.kind === 'progress') { setPhase(event.phase); return; }
    if (event.kind !== 'failed' && event.kind !== 'feature-guide-completed') return;
    job.current.id = null; setWorking(false); onRunning(false);
    if (event.kind === 'failed') { setError(event.error.message); setCancelled(event.error.code === 'CANCELLED'); return; }
    if (event.result.projectId !== projectId || event.result.routesId !== routesId) {
      setError('기능 목록이 바뀌었어요. 주소를 다시 찾아 주세요.'); return;
    }
    onResult(event.result); setPreparing(false); setConsent(false);
  };
  useEffect(() => {
    const unsubscribe = window.learning.onLearningEvent(event => receive.current(event));
    return () => {
      unsubscribe(); sequence.current++;
      if (job.current.id) void window.learning.cancelExplanation({ jobId: job.current.id });
      onRunning(false);
    };
  }, [projectId, routesId, onRunning]);
  useEffect(() => { setPreparing(false); setConsent(false); }, [mode]);
  const ready = connections?.modes.find(item => item.mode === mode);
  async function start() {
    if (locked || running || deleting || checking || !consent || !ready?.ready) return;
    const token = ++sequence.current;
    job.current = { id: null, starting: true, queued: [] };
    setConsent(false); setWorking(true); onRunning(true); setPhase(null); setError(''); setCancelled(false);
    const response = await window.learning.startFeatureGuide({ projectId, routesId, mode, consent: true });
    if (token !== sequence.current) {
      if (response.ok) void window.learning.cancelExplanation({ jobId: response.value.jobId });
      return;
    }
    const queued = job.current.queued;
    job.current = { id: response.ok ? response.value.jobId : null, starting: false, queued: [] };
    if (!response.ok) { setWorking(false); onRunning(false); setError(response.message); }
    queued.forEach(event => receive.current(event));
  }
  function cancel() {
    sequence.current++;
    const id = job.current.id;
    job.current = { id: null, starting: false, queued: [] };
    setWorking(false); onRunning(false); setError('AI 작업을 취소했습니다.'); setCancelled(true);
    if (id) void window.learning.cancelExplanation({ jobId: id });
  }
  return <div className="feature-guide-ai" aria-label="AI 기능 정리">
    {!preparing && !working && <button className="btn" disabled={locked || running || deleting} onClick={() => { setPreparing(true); setError(''); void onEnsure().then(message => setError(message ?? '')); }}>AI로 기능 정리하기</button>}
    {preparing && !working && <div>
      <p>{modes[mode]}</p>
      <p className="hint">방식은 ‘질문’ 칸의 ‘설정’에서 고를 수 있어요. 답변 생성은 AI 제공자 서버에서 이뤄져요.
        {mode !== 'codex' && mode !== 'claude-code' && ` Gemini 3.8 Flash · High (${GEMINI_MODEL})를 요청해요.`}</p>
      <button className="btn" disabled={checking || running} onClick={() => void onInspect().then(message => setError(message ?? ''))}>{checking ? '설치 확인 중…' : '로컬 AI 설치 확인'}</button>
      <p className="hint">{ready?.reason ?? '먼저 설치 상태를 확인해 주세요. 설치 확인만으로 로그인이나 실제 AI 연결이 검증되는 것은 아닙니다.'}</p>
      <label className="ai-consent"><input type="checkbox" checked={consent} disabled={running || !ready?.ready}
        aria-describedby={descriptionId} onChange={event => setConsent(event.target.checked)} />보낼 자료에 동의</label>
      <details className="consent-details"><summary>무엇을 보내나요?</summary>
        <p id={descriptionId}>프로젝트 이름, 앱이 찾은 서버 주소·요청·화면 목록(파일 경로와 함수 이름 포함)을
          {mode === 'local-worker' ? ' Gemini와 Codex' : mode === 'codex' ? ' Codex' : mode === 'antigravity' ? ' Gemini(Antigravity)' : ' Claude Code'}에 보내는 데 동의합니다.
          코드 원문은 보내지 않습니다. 비밀값처럼 보이는 부분은 가리지만 모두 찾는다고 보장하지 않습니다.</p>
      </details>
      <button className="btn btn--primary" disabled={!consent || !ready?.ready || locked || running || deleting || checking} onClick={() => void start()}>동의하고 정리하기</button>
    </div>}
    {working && <p role="status">{phase === 'explaining'
      ? mode === 'codex' ? 'Codex에 정리 요청 중' : `Gemini 3.8 Flash · High (${GEMINI_MODEL})에 정리 요청 중`
      : phase ? phases[phase] : 'AI 작업 시작 중'} <button className="btn btn--small" onClick={cancel}>AI 작업 취소</button></p>}
    {error && <p role={cancelled ? 'status' : 'alert'}>{error}</p>}
    {storageError && <p role="alert">{storageError}</p>}
    {result && <>
      {result.changed && <>
        <p role="alert" className="notice notice--warn">다시 확인 필요: 기능 정리를 만든 뒤 서버 주소나 그 코드가 바뀌었어요. 다시 정리해 주세요.</p>
        <p>{result.guide.summary}</p>
      </>}
      {!working && !running && <p>
        {result.savedAt && <span className="hint">저장됨 · {savedDate(result.savedAt)} </span>}
        <button className="btn btn--small" disabled={deleting} onClick={() => {
          if (running || working || deleting) return;
          setDeleting(true); void onDelete().finally(() => setDeleting(false));
        }}>지우기</button>
      </p>}
      {!result.changed && <>
      <p className="hint">AI 정리 · 정확성을 보장하지 않아요 · {modes[result.mode]} · {result.review}</p>
      <ul className="hint">{result.models.map((model, index) => <li key={index}>{model.provider === 'codex' ? 'Codex' : 'Gemini 3.8 Flash · High'}
        {' · '}{model.stage === 'reviewing' ? '대조' : '정리'} · 요청 모델: {model.requestedModel ?? '실행기 기본값'} · 응답 모델: {model.reportedModel ?? '알려 주지 않음'}</li>)}</ul>
      {result.limitations.map((item, index) => <p className="hint" key={index}>{item}</p>)}
      </>}
      {result.guide.unknowns.length > 0 && <details><summary>확인하지 못한 것</summary><ul>{result.guide.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    </>}
  </div>;
}
