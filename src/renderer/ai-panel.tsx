import React, { useEffect, useId, useRef, useState } from 'react';
import { savedDate } from './overview';
import type { Evidence, SourceView } from '../shared/contracts';
import { GEMINI_MODEL, type ConnectionReport, type LearningEvent, type LearningMode, type LearningPhase, type LearningResult } from '../shared/ai';

const modes: { id: LearningMode; label: string }[] = [
  { id: 'local-worker', label: '로컬 워커 · Codex → Gemini → Codex' },
  { id: 'codex', label: 'Codex 단독 · 대조 없음' },
  { id: 'claude-code', label: 'Claude Code 단독 · 준비 중' },
  { id: 'antigravity', label: 'Gemini 단독 (Antigravity) · 대조 없음' },
];
const shortModes: Record<LearningMode, string> = { 'local-worker': '로컬 워커', codex: 'Codex 단독', antigravity: 'Gemini 단독', 'claude-code': 'Claude Code(준비 중)' };
const names = { codex: 'Codex', 'claude-code': 'Claude Code', antigravity: 'Antigravity' };
// Who receives the code in each mode; the consent text names them.
const recipients: Record<LearningMode, string> = { 'local-worker': 'Codex와 Gemini', codex: 'Codex', antigravity: 'Gemini(Antigravity)', 'claude-code': 'Claude Code' };
const phases: Record<LearningPhase, string> = {
  collecting: '질문할 코드 확인 중', organizing: 'Codex가 작업 정리 중',
  'reading-related': '프로젝트의 관련 파일을 읽는 중',
  explaining: `Gemini 3.8 Flash · High (${GEMINI_MODEL})에 설명 요청 중`,
  reviewing: 'Codex가 원본 코드와 대조 중', validating: '근거와 코드 변경 여부 확인 중',
};

const documentFile = /\.(?:md|txt)$/i;
export function sendBlockedReason(state: {
  checked: boolean; checking: boolean; ready: boolean; readyReason: string | null; hasEvidence: boolean; stale: boolean;
  running: boolean; otherRunning: boolean; question: string; consent: boolean;
}): string | null {
  if (state.checking) return '로컬 AI 설치를 확인하는 중이에요.';
  if (!state.checked) return '먼저 ‘설정’에서 ‘로컬 AI 설치 확인’을 눌러 주세요.';
  if (!state.ready) return '지금 고른 AI 방식은 쓸 수 없어요. ‘설정’에서 다른 방식을 골라 보세요.'
    + (state.readyReason ? ` (이유: ${state.readyReason})` : '');
  if (state.stale) return '코드가 바뀌었어요. 코드 읽기에서 파일을 다시 열고(이미 열려 있으면 ‘파일 다시 읽기’) 함수나 구문을 다시 골라 주세요.';
  if (!state.hasEvidence) return '코드 읽기에서 함수나 구문을 골라 주세요. 고른 부분이 질문할 범위가 돼요.';
  if (state.running) return null;
  if (state.otherRunning) return '다른 AI 작업이 끝나면 보낼 수 있어요.';
  if (!state.question.trim()) return '질문을 적어 주세요.';
  if (!state.consent) return '‘보낼 자료에 동의’에 체크해 주세요.';
  return null;
}

/**
 * How one source of an answer is named: the selected code by its lines; a file given whole (a related file, or the
 * selection's own file) says that no finer place was checked.
 */
export function sourceLabel(source: { evidence: Evidence; relativePath: string }, selectionId: string | null): string {
  if (source.evidence.id === selectionId) return `${source.relativePath} · ${source.evidence.startLine}–${source.evidence.endLine}행`;
  return documentFile.test(source.relativePath) ? `${source.relativePath} · 문서 전체`
    : `${source.relativePath} · 파일 전체 근거 · 세부 위치 미확인`;
}

/** The evidence a step or claim names, each opened like the answer's files: the question and answer stay as they are. */
export function SourceButtons({ ids, sources, selectionId, stale, label, onEvidence }: {
  ids: string[]; sources: { evidence: Evidence; relativePath: string }[]; selectionId: string | null; stale: boolean; label: string;
  onEvidence(evidence: Evidence): void;
}) {
  // main accepts only IDs it gave for this answer, so every one is among the sources; a repeated one is shown once.
  const named = [...new Set(ids)].flatMap(id => sources.filter(item => item.evidence.id === id).slice(0, 1));
  return <ul className="sources" aria-label={label}>{named.map(source => <li key={source.evidence.id}>
    <button className="btn btn--chip" disabled={stale} onClick={() => onEvidence(source.evidence)}>{sourceLabel(source, selectionId)}</button>
  </li>)}</ul>;
}

export function AiPanel({ projectId, openedAt = 0, onSavedEvidence, evidence, relativePath, stale, draft, connections, checking, otherRunning, mode, onMode, onRunning, onInspect, onEnsure, onEvidence }: {
  openedAt?: number; onSavedEvidence?(value: { source: SourceView; evidence: Evidence }): void;
  projectId: string; evidence: Evidence | null; relativePath: string; stale: boolean;
  /**
   * A question to put in the box, put again whenever the id changes (not on mount). A feature question (plan F1) also
   * carries the topic and the code it was prepared for.
   */
  draft: { text: string; id: number; topic?: { name: string; evidenceId: string } } | null;
  /** The installation check, shared with the overview card (App). */
  connections: ConnectionReport | null; checking: boolean;
  /** A check starts the list of AI programs over, so none runs while another AI job still needs it. */
  otherRunning: boolean;
  mode: LearningMode; onMode(mode: LearningMode): void; onRunning(running: boolean): void;
  /** Runs the check; resolves to an error message, or null. */
  onInspect(): Promise<string | null>;
  onEnsure(): Promise<string | null>;
  onEvidence(evidence: Evidence): void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [consent, setConsent] = useState(false);
  const consentDescriptionId = useId();
  const sendBlockedId = useId();
  const [running, setRunning] = useState(false);
  useEffect(() => { onRunning(running); }, [running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<LearningResult[]>([]);
  const [savedAnswers, setSavedAnswers] = useState<{ jobId: string; question: string; savedAt: string }[]>([]);
  const [openedAnswer, setOpenedAnswer] = useState<{ result: LearningResult; changed: boolean } | null>(null);
  const [historyError, setHistoryError] = useState('');
  const historyRequest = useRef(0);
  const listRequest = useRef(0);
  const historyOpening = useRef(openedAt);
  historyOpening.current = openedAt;
  const writes = useRef(new Map<string, number>());
  // The topic each answer's question was prepared under (integrated plan 4.4), by job.
  const [answerTopics, setAnswerTopics] = useState<Record<string, string>>({});
  const prepared = useRef<{ topic: string; evidenceId: string; text: string } | null>(null);
  // A prepared feature question stays prepared until its answer arrives, so sending it again after a failure or a cancel
  // keeps its topic and a new conversation.
  const jobTopics = useRef(new Map<string, string>());
  const active = useRef<string | null>(null);
  const starting = useRef(false);
  const sequence = useRef(0);
  const queued = useRef<LearningEvent[]>([]);
  const mounted = useRef(true);
  const ready = connections?.modes.find(item => item.mode === mode);
  const draftShown = useRef(draft?.id);
  useEffect(() => {
    if (!draft || draft.id === draftShown.current) return;
    draftShown.current = draft.id;
    setQuestion(draft.text);
    setQuestionOpen(true);
    void ensure();
    if (draft.topic) {
      // A feature question is a new question: one still on its way is cancelled and its answer not shown (integrated
      // plan T10). It asks for its material and consent again, and starts a new conversation.
      if (active.current || starting.current) {
        sequence.current++;
        if (active.current) void window.learning.cancelExplanation({ jobId: active.current });
        active.current = null; starting.current = false; queued.current = [];
        setRunning(false);
        setStatus('기능 질문을 새로 준비해 진행 중이던 질문을 취소했어요.');
      } else setStatus('');
      prepared.current = { topic: draft.topic.name, evidenceId: draft.topic.evidenceId, text: draft.text };
      setConsent(false);
    }
  }, [draft]);

  function receive(event: LearningEvent) {
    if (event.projectId !== projectId) return;
    if (starting.current) { if (queued.current.length < 16) queued.current.push(event); return; }
    if (event.jobId !== active.current) return;
    if (event.kind === 'progress') {
      setStatus(event.phase === 'explaining' && mode === 'codex' ? 'Codex에 설명 요청 중' : phases[event.phase]);
      return;
    }
    // The overview's events belong to its own card (the panel never starts one), so its job ID never matches here.
    if (event.kind === 'overview-completed' || event.kind === 'file-explanation-completed' || event.kind === 'feature-guide-completed') return;
    active.current = null;
    setRunning(false);
    if (event.kind === 'failed') {
      if (event.error.code === 'CANCELLED') { setStatus(event.error.message); setError(''); }
      else { setError(event.error.message); setStatus(''); }
      return;
    }
    if (stale || event.result.evidence.id !== evidence?.id || event.result.evidence.fileHash !== evidence?.fileHash) return;
    setAnswers(previous => [...previous.slice(-3), event.result]);
    void saveAnswer(event.result);
    const topic = jobTopics.current.get(event.jobId);
    if (topic !== undefined) {
      setAnswerTopics(previous => ({ ...previous, [event.jobId]: topic }));
      prepared.current = null;
    }
    setQuestion('');
    setStatus(`${event.result.review} · 설명의 정확성을 보장하지 않습니다.`);
  }
  const receiver = useRef(receive);
  receiver.current = receive;
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.learning.onLearningEvent(event => receiver.current(event));
    return () => {
      mounted.current = false;
      sequence.current++;
      unsubscribe();
      if (active.current) void window.learning.cancelExplanation({ jobId: active.current });
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    if (active.current) void window.learning.cancelExplanation({ jobId: active.current });
    active.current = null; starting.current = false; queued.current = [];
    setRunning(false); setAnswers([]); setAnswerTopics({}); setConsent(false); setStatus(''); setError('');
    // A feature question belongs to the code it was prepared for: once that changes, an untouched one goes.
    if (prepared.current && prepared.current.evidenceId !== evidence?.id) {
      if (question === prepared.current.text) {
        setQuestion('');
        setStatus('질문 대상이 바뀌어 준비한 기능 질문을 지웠어요. 다시 준비해 주세요.');
      }
      prepared.current = null;
    }
  }, [projectId, evidence?.id, evidence?.fileHash, stale, mode]);

  useEffect(() => {
    historyRequest.current++;
    listRequest.current++;
    writes.current.clear();
    setOpenedAnswer(null); setSavedAnswers([]); setHistoryError('');
    void loadAnswers();
    return () => { historyRequest.current++; listRequest.current++; };
  }, [projectId, openedAt]);

  async function loadAnswers() {
    const token = ++listRequest.current;
    const opening = historyOpening.current;
    const result = await window.learning.savedAnswers({ projectId });
    if (!mounted.current || token !== listRequest.current || opening !== historyOpening.current) return;
    if (!result.ok) {
      if (result.code !== 'PROJECT_CLOSED') setHistoryError('지난 질문과 답을 불러오지 못했어요.');
      return;
    }
    setSavedAnswers(result.value);
    setOpenedAnswer(previous => previous && result.value.some(item => item.jobId === previous.result.jobId) ? previous : null);
  }
  async function saveAnswer(answer: LearningResult) {
    historyRequest.current++; listRequest.current++;
    const opening = historyOpening.current;
    const token = (writes.current.get(answer.jobId) ?? 0) + 1;
    writes.current.set(answer.jobId, token);
    const result = await window.learning.saveAnswer({ projectId, result: answer });
    if (!mounted.current || opening !== historyOpening.current || writes.current.get(answer.jobId) !== token) return;
    if (!result.ok) {
      if (result.code !== 'PROJECT_CLOSED') setError('질문과 답을 저장하지 못했어요. 앱을 닫으면 사라져요.');
      return;
    }
    void loadAnswers();
  }
  async function openAnswer(jobId: string) {
    const token = ++historyRequest.current;
    const opening = historyOpening.current;
    setOpenedAnswer(null); setHistoryError('');
    const result = await window.learning.savedAnswer({ projectId, jobId });
    if (!mounted.current || token !== historyRequest.current || opening !== historyOpening.current) return;
    if (!result.ok || !result.value) {
      if (result.ok || result.code !== 'PROJECT_CLOSED') setHistoryError('지난 답을 불러오지 못했어요.');
      return;
    }
    if (result.value.result.jobId === jobId) setOpenedAnswer(result.value);
  }
  async function deleteAnswer(jobId: string) {
    historyRequest.current++; listRequest.current++;
    const opening = historyOpening.current;
    const token = (writes.current.get(jobId) ?? 0) + 1;
    writes.current.set(jobId, token);
    setHistoryError('');
    const result = await window.learning.deleteAnswer({ projectId, jobId });
    if (!mounted.current || opening !== historyOpening.current || writes.current.get(jobId) !== token) return;
    if (!result.ok) {
      if (result.code !== 'PROJECT_CLOSED') setHistoryError('지난 답을 지우지 못했어요.');
      return;
    }
    // Also discard a read started while this deletion was in flight.
    historyRequest.current++;
    setSavedAnswers(previous => previous.filter(item => item.jobId !== jobId));
    setOpenedAnswer(previous => previous?.result.jobId === jobId ? null : previous);
    void loadAnswers();
  }
  async function openEvidence(jobId: string, evidenceId: string) {
    const token = ++historyRequest.current;
    const opening = historyOpening.current;
    setHistoryError('');
    const result = await window.learning.openSavedEvidence({ projectId, jobId, evidenceId });
    if (!mounted.current || token !== historyRequest.current || opening !== historyOpening.current) return;
    if (!result.ok) {
      if (result.code === 'CHANGED') {
        setOpenedAnswer(previous => previous?.result.jobId === jobId ? { ...previous, changed: true } : previous);
        setHistoryError('답을 만든 뒤 코드가 바뀌어 열지 않았어요.');
        return;
      }
      if (result.code !== 'PROJECT_CLOSED') setHistoryError(result.message);
      return;
    }
    onSavedEvidence?.(result.value);
  }

  /** Runs an installation check, automatic (`onEnsure`) or asked for (`onInspect`), and shows why it could not run. */
  async function check(run: () => Promise<string | null>) {
    setError('');
    const message = await run();
    if (message && mounted.current) setError(message);
  }
  const ensure = () => check(onEnsure);
  const inspect = () => check(onInspect);
  async function ask() {
    if (checking || !evidence || stale || !consent || !ready?.ready || running || otherRunning || !question.trim()) return;
    const token = ++sequence.current;
    starting.current = true; queued.current = [];
    setRunning(true); setError(''); setStatus('AI 작업 시작 중');
    const topic = prepared.current?.evidenceId === evidence.id ? prepared.current.topic : null;
    const result = await window.learning.startExplanation({ projectId, evidenceId: evidence.id,
      expectedFileHash: evidence.fileHash, question, mode, consent: true,
      ...(answers.length && topic === null ? { conversationId: answers[answers.length - 1].conversationId } : {}),
    });
    if (token !== sequence.current || !mounted.current) {
      if (result.ok) void window.learning.cancelExplanation({ jobId: result.value.jobId });
      return;
    }
    starting.current = false;
    if (!result.ok) { setError(result.message); setRunning(false); setStatus(''); queued.current = []; return; }
    active.current = result.value.jobId;
    if (topic !== null) jobTopics.current.set(result.value.jobId, topic);
    const events = queued.current; queued.current = [];
    events.forEach(event => receiver.current(event));
  }
  async function cancel() {
    sequence.current++;
    starting.current = false; queued.current = [];
    const jobId = active.current;
    active.current = null;
    setRunning(false); setStatus('AI 작업을 취소했습니다.');
    if (jobId) {
      const result = await window.learning.cancelExplanation({ jobId });
      if (!result.ok && mounted.current) setError(result.message);
    }
  }

  const answerScope = running || answers.length > 0;
  const blockedReason = sendBlockedReason({
    checked: connections !== null, checking, ready: ready?.ready ?? false, readyReason: ready?.reason ?? null,
    hasEvidence: evidence !== null, stale, running, otherRunning, question, consent,
  });
  const questionScope = evidence && <p className="hint" data-testid="question-scope">질문 기준: {relativePath} · {evidence.startLine}–{evidence.endLine}행</p>;
  return <div className="panel__body ai-panel">
    <div className="ai-line" role="group" aria-label="AI 연결">
      <span>AI · {shortModes[mode]} · {ready?.ready ? '준비됨' : connections ? '사용할 수 없음' : '설치 확인 필요'}</span>
      <button className="btn btn--small" aria-expanded={questionOpen} onClick={() => { if (!questionOpen) void ensure(); setQuestionOpen(!questionOpen); }}>질문하기</button>
      <button className="btn btn--small" aria-expanded={settingsOpen} onClick={() => { if (!settingsOpen) void ensure(); setSettingsOpen(!settingsOpen); }}>설정</button>
    </div>
    {answerScope && questionScope}
    {status && <p role="status" className="hint">{status}</p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {running && <button className="btn" onClick={cancel}>AI 작업 취소</button>}
    <div className="ai-settings" hidden={!settingsOpen}>
      <label>AI 사용 방식
        <select aria-label="AI 사용 방식" value={mode} disabled={running || otherRunning} onChange={event => onMode(event.target.value as LearningMode)}>
          {modes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <p className="hint">Mac에 설치된 공식 프로그램을 실행합니다. 답변 생성은 각 AI 제공자 서버에서 이뤄집니다.</p>
      <p className="hint">{mode === 'local-worker' && '선택한 프로젝트에서 관련 파일을 찾아 읽습니다. '}원본 파일은 수정·생성·삭제하지 않습니다. 민감 파일·제외 파일·폴더 밖 파일은 읽기 대상에서 제외합니다.</p>
      <button className="btn" disabled={checking || running || otherRunning} onClick={inspect}>{checking ? '설치 확인 중…' : '로컬 AI 설치 확인'}</button>
      {connections && <ul aria-label="로컬 AI 설치 상태">
        {connections.providers.map(item => <li key={item.provider} className="fact fact--muted">
          <b>{names[item.provider]} · {item.installation === 'found' ? `설치 확인 (${item.version})` : item.installation === 'missing' ? '찾지 못함' : '실행 확인 실패'}</b>
          <p>{item.message}</p>
        </li>)}
      </ul>}
      {connections && !connections.providers.some(item => item.provider === 'claude-code') &&
        <p className="hint">자동 확인은 Codex·Antigravity만 해요. Claude Code까지 보려면 ‘로컬 AI 설치 확인’을 눌러요.</p>}
      <p className="hint" data-testid="ai-readiness">{ready?.reason ?? '먼저 설치 상태를 확인해 주세요. 설치 확인만으로 로그인이나 실제 AI 연결이 검증되는 것은 아닙니다.'}</p>
      <p className="hint">{mode === 'local-worker' ? `Codex 정리 → Gemini 3.8 Flash · High (${GEMINI_MODEL}) 설명 → Codex 대조`
        : mode === 'claude-code' ? '단독 실행은 후속 단계에서 연결합니다.'
          : '한 AI가 바로 설명합니다. 관련 파일을 더 읽지 않고 다른 AI의 대조가 없습니다.'}</p>
    </div>
    <div className="ai-question" hidden={!questionOpen}>
      {!answerScope && questionScope}
      <label>선택한 코드에 질문
        <textarea aria-label="선택한 코드에 질문" maxLength={2000} value={question} disabled={running}
          placeholder="이 부분은 어떤 일을 하나요?" onChange={event => setQuestion(event.target.value)} />
      </label>
      <label className="ai-consent"><input type="checkbox" checked={consent} disabled={running || !ready?.ready}
        aria-describedby={consentDescriptionId} onChange={event => setConsent(event.target.checked)} />보낼 자료에 동의</label>
      <details className="consent-details">
        <summary>무엇을 보내나요?</summary>
        <p id={consentDescriptionId}>선택한 코드와 그 파일 전체(크기 제한 안)·프로젝트 파일 목록·{mode === 'local-worker' && '관련 파일(추가 최대 4개)·'}질문·최근 답변을 {recipients[mode]}에 보내는 데 동의합니다.
          {mode !== 'local-worker' && ' 다른 파일은 더 읽지 않습니다.'} 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.</p>
      </details>
      <div className="ai-actions">
        <button className="btn btn--primary" onClick={ask} aria-describedby={blockedReason ? sendBlockedId : undefined}
          // The reason and the lock are one decision; the view test keeps it equal to the earlier explicit gate.
          disabled={running || blockedReason !== null}>질문 보내기</button>
        {blockedReason && <p className="hint" id={sendBlockedId} data-testid="send-blocked">{blockedReason}</p>}
      </div>
      <p className="hint">질문과 답은 최근 50개까지 이 Mac에 저장해요. 이어 묻기는 앱을 켜 둔 동안만 돼요. 코드 범위를 바꾸면 새 대화로 시작합니다.</p>
    </div>
    {answers.map(answer => <AnswerView key={answer.jobId} answer={answer} topic={answerTopics[answer.jobId]} stale={stale} onEvidence={onEvidence} />)}
    {historyError && <p role="alert" className="notice">{historyError}</p>}
    <details className="saved-answers">
      <summary>지난 질문과 답 · {savedAnswers.length}개</summary>
      <p className="hint">지난 답의 대화는 이어지지 않아요.</p>
      <ul aria-label="저장된 질문">{savedAnswers.map(item => <li key={item.jobId}>
        <p className="saved-question" title={item.question}>{item.question}</p>
        <span className="hint">저장됨 · {savedDate(item.savedAt)} </span>
        <button className="btn btn--small" onClick={() => void openAnswer(item.jobId)}>열기</button>
        <button className="btn btn--small" onClick={() => void deleteAnswer(item.jobId)}>지우기</button>
        {openedAnswer?.result.jobId === item.jobId && <>
          {openedAnswer.changed && <p className="notice">다시 확인 필요: 답을 만든 뒤 코드가 바뀌었어요.</p>}
          <AnswerView answer={openedAnswer.result} stale={openedAnswer.changed} onEvidence={next => void openEvidence(item.jobId, next.id)} />
        </>}
      </li>)}</ul>
    </details>
  </div>;
}

export function AnswerView({ answer, topic, stale, onEvidence }: {
  answer: LearningResult; topic?: string; stale: boolean; onEvidence(evidence: Evidence): void;
}) {
  return <section className="fact" aria-label="AI 설명">
    {topic && <span className="tag tag--doc">학습 주제: {topic}</span>}
    <b>{answer.question}</b>
    <h4>쉽게</h4><p>{answer.explanation.summary}</p>
    <span className="tag tag--unknown">{answer.review}</span>
    {answer.explanation.terms.length > 0 && <section aria-label="낱말 풀이">
      <h4>낱말 풀이</h4>
      <dl>{answer.explanation.terms.map((term, index) => <React.Fragment key={index}><dt>{term.term}</dt><dd>{term.meaning}</dd></React.Fragment>)}</dl>
    </section>}
    {answer.explanation.examples.length > 0 && <section aria-label="예시로 따라가기">
      <h4>예시로 따라가기</h4>
      <p className="hint">코드를 실제로 실행한 결과가 아니에요. AI가 코드를 읽고 만든 가상의 값이에요.</p>
      <ol>{answer.explanation.examples.map((example, index) => <li key={index}>
        <span className="tag tag--unknown">가상의 예시 · 실행하지 않음</span>
        <p><b>예를 들어 {example.given}</b></p>
        <p>→ {example.result}</p>
        <SourceButtons ids={example.evidenceIds} sources={answer.sources} selectionId={answer.evidence.id} stale={stale}
          label={`예시 ${index + 1}의 근거`} onEvidence={onEvidence} />
      </li>)}</ol>
    </section>}
    <details>
      <summary>자세히 보기 · 단계 {answer.explanation.steps.length}개 · 설명 {answer.explanation.claims.length}개</summary>
      <ol>{answer.explanation.steps.map((step, index) => <li key={index}>
        <b>{step.title}</b><p>입력: {step.input}</p><p>처리: {step.action}</p><p>결과: {step.output}</p>
        {step.alternatives.map((alternative, i) => <p key={i}>다른 경우: {alternative}</p>)}
        <SourceButtons ids={step.evidenceIds} sources={answer.sources} selectionId={answer.evidence.id} stale={stale}
          label={`‘${step.title}’의 근거`} onEvidence={onEvidence} />
      </li>)}</ol>
      <ul>{answer.explanation.claims.map((claim, index) => <li key={index}>{claim.kind === 'concept' ? '일반 개념: ' : ''}{claim.text}
        {claim.kind === 'code' && <SourceButtons ids={claim.evidenceIds} sources={answer.sources} selectionId={answer.evidence.id}
          stale={stale} label="이 설명의 근거" onEvidence={onEvidence} />}
      </li>)}</ul>
    </details>
    <h4>코드</h4>
    <button className="btn btn--chip" disabled={stale} onClick={() => onEvidence(answer.evidence)}>답변 근거 코드 보기</button>
    <ul aria-label="답변에 제공한 파일">{answer.sources.filter(item => item.evidence.id !== answer.evidence.id).map(item => <li key={item.evidence.id}>
      <button className="btn btn--chip" disabled={stale} onClick={() => onEvidence(item.evidence)}>
        {item.relativePath} · {item.evidence.startLine}–{item.evidence.endLine}행
      </button>
    </li>)}</ul>
    {answer.explanation.unknowns.map((unknown, index) => <p key={index}>확인하지 못함: {unknown}</p>)}
    {answer.limitations.map((limitation, index) => <p className="hint" key={index}>읽기 범위: {limitation}</p>)}
    {answer.models.map(model => <p className="hint" key={model.stage}>{names[model.provider]} · {model.requestedModel ? `호출 모델 ${model.requestedModel}` : 'CLI 기본 모델 요청'} · {model.reportedModel ? `응답 모델 ${model.reportedModel}` : '응답 모델 미보고'}</p>)}
  </section>;
}
