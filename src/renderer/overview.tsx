import React, { useState } from 'react';
import type { Evidence, ProjectView } from '../shared/contracts';
import type { LearningPhase, OverviewFeature, OverviewResult } from '../shared/ai';
import { SourceButtons } from './ai-panel';

/** Plan G1: the AI overview of the opened folder, asked for by the user and kept until the folder is opened again. */
export type OverviewState =
  | { status: 'running'; phase: LearningPhase | null; revision: number }
  | { status: 'failed'; message: string; cancelled: boolean }
  | { status: 'done'; result: OverviewResult; revision: number };

/**
 * Plan F1: where learning started and under what name. A start whose place is known (a start candidate, the chosen
 * function) is found again by name and place; an AI feature only names its function, so that must be the only one.
 */
export interface Topic {
  name: string;
  /** The original name it started from (a function, or the file), shown beside a name the user gave. */
  original: string;
  origin: 'ai' | 'start' | 'function';
  start: { fileId: string; fileHash: string; relativePath: string; functionName: string | null; startUtf16: number | null };
  /** What '한눈에 보기로' puts the focus back on. */
  anchor: string | null;
}
const origins: Record<Topic['origin'], string> = {
  ai: 'AI가 제안한 기능 후보', start: '코드 구조로 고른 시작점 후보', function: '지금 고른 함수',
};
const phases: Record<LearningPhase, string> = {
  collecting: '개요 자료를 모으는 중', organizing: 'Codex가 읽을 파일을 고르는 중', 'reading-related': '고른 파일을 읽는 중',
  explaining: 'Gemini가 개요를 쓰는 중', reviewing: 'Codex가 코드와 대조하는 중', validating: '근거와 코드 변경 여부 확인 중',
};
const SHOWN = 6;
const documentFile = /\.(?:md|txt)$/i;

export function OverviewAi({ project, state, stale, locked, readiness, checking, revealAnchor, onInspect, onStart, onCancel,
  onEvidence, onFollow, onFunction }: {
  project: ProjectView; state: OverviewState | null; stale: boolean; locked: boolean;
  readiness: { ready: boolean; reason: string } | null; checking: boolean;
  /** A feature card to keep shown even past the first six, as the focus returns to it. */
  revealAnchor: string | null;
  onInspect(): void; onStart(startFileId: string | null): void; onCancel(): void;
  onEvidence(evidence: Evidence): void;
  onFollow(feature: OverviewFeature, anchor: string): void;
  onFunction(name: string, at: Evidence): void;
}) {
  const intro = project.overview.intro;
  // App remounts this card for every opened folder, so a choice or a consent never carries over to another one.
  const [startFileId, setStartFileId] = useState(intro?.fileId ?? '');
  const [consent, setConsent] = useState(false);
  const running = state?.status === 'running';
  const candidates = [...new Map(project.overview.candidates.filter(item => item.fileId !== intro?.fileId)
    .map(item => [item.fileId, item.relativePath])).entries()];
  return <section className="card card--wide" aria-labelledby="overview-ai">
    <h3 id="overview-ai">기능과 구성 (AI 개요)</h3>
    <p className="hint">로컬 워커(Codex → Gemini → Codex)가 시작 파일 하나와 Codex가 고른 파일 최대 4개만 읽고 써요. 조사한 범위의 개요이고, 정확성을 보장하지 않아요.</p>
    <div className="overview-form">
      <label>개요 시작 파일
        <select aria-label="개요 시작 파일" value={startFileId} disabled={running} onChange={event => setStartFileId(event.target.value)}>
          <optgroup label="추천">
            {intro && <option value={intro.fileId}>{intro.relativePath} · 문서에 적힌 소개</option>}
            {candidates.map(([fileId, relativePath]) => <option key={fileId} value={fileId}>{relativePath} · 시작점 후보</option>)}
            <option value="">시작 파일 없이 (AI가 파일 목록에서 고름)</option>
          </optgroup>
          <optgroup label="모든 파일">
            {project.files.map(file => <option key={file.id} value={file.id}>{file.relativePath}</option>)}
          </optgroup>
        </select>
      </label>
      <p className="hint" data-testid="overview-readiness">{readiness?.reason ?? '먼저 로컬 AI 설치 상태를 확인해 주세요. 설치 확인만으로 로그인이나 실제 AI 연결이 검증되는 것은 아니에요.'}</p>
      {!readiness?.ready && <button className="btn btn--small" disabled={checking || running} onClick={onInspect}>{checking ? '설치 확인 중…' : '로컬 AI 설치 확인'}</button>}
      <label className="ai-consent"><input type="checkbox" checked={consent} disabled={running || !readiness?.ready}
        onChange={event => setConsent(event.target.checked)} />프로젝트 파일 목록, 고른 시작 파일, Codex가 고른 관련 파일(최대 4개)을 Codex와 Gemini에 보내는 데 동의합니다. 비밀값처럼 보이는 부분은 가린 뒤 보내지만 모두 찾는다고 보장하지는 않습니다.</label>
      <div className="ai-actions">
        <button className="btn btn--primary" disabled={!readiness?.ready || !consent || running || locked}
          onClick={() => { setConsent(false); onStart(startFileId || null); }}>{state?.status === 'done' ? '개요 다시 만들기' : '개요 만들기'}</button>
        {running && <button className="btn" onClick={onCancel}>개요 작업 취소</button>}
      </div>
    </div>
    {!state && <p className="unknown"><span className="tag tag--unknown">개요 미생성</span>아직 AI 개요를 만들지 않았어요. 위의 시작점 후보와 코드 읽기로 먼저 살펴볼 수 있어요.</p>}
    {running && <p role="status" className="hint">{state.phase ? phases[state.phase] : '개요 작업 시작 중'}</p>}
    {state?.status === 'failed' && <p role={state.cancelled ? 'status' : 'alert'} className={state.cancelled ? 'hint' : 'notice'}>{state.message}</p>}
    {state?.status === 'done' && <OverviewAnswer result={state.result} stale={stale} locked={locked} revealAnchor={revealAnchor}
      onEvidence={onEvidence} onFollow={onFollow} onFunction={onFunction} />}
  </section>;
}

function OverviewAnswer({ result, stale, locked, revealAnchor, onEvidence, onFollow, onFunction }: {
  result: OverviewResult; stale: boolean; locked: boolean; revealAnchor: string | null;
  onEvidence(evidence: Evidence): void; onFollow(feature: OverviewFeature, anchor: string): void; onFunction(name: string, at: Evidence): void;
}) {
  const [allFeatures, setAllFeatures] = useState(false);
  const [allRoles, setAllRoles] = useState(false);
  const { overview, sources } = result;
  const blocked = stale || locked;
  const sourceOf = (id: string) => sources.find(item => item.evidence.id === id)!;
  const buttons = (ids: string[], label: string) =>
    <SourceButtons ids={ids} sources={sources} selectionId={null} stale={blocked} label={label} onEvidence={onEvidence} />;
  const revealed = revealAnchor?.startsWith('feature:') ? Number(revealAnchor.slice('feature:'.length)) : -1;
  const features = allFeatures || revealed >= SHOWN ? overview.features : overview.features.slice(0, SHOWN);
  const roles = allRoles ? overview.roles : overview.roles.slice(0, SHOWN);
  const fromDocuments = overview.intro?.evidenceIds.every(id => documentFile.test(sourceOf(id).relativePath));
  return <div className="overview-answer">
    {stale && <p className="notice notice--warn"><b>다시 확인 필요:</b> 개요를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 이전 코드 기준이라 근거 보기와 따라가기를 막았어요. 개요를 다시 만들어 주세요.</p>}
    <p className="hint">{result.review === 'AI 검토됨' ? 'AI 검토됨 · 개요의 정확성을 보장하지 않습니다.' : '읽은 자료가 없어 개요를 쓰지 않았어요.'}</p>
    <section aria-label="이 프로젝트가 하는 일 (AI 개요)">
      <h4>이 프로젝트가 하는 일</h4>
      {overview.intro ? <>
        <span className="tag tag--doc">{fromDocuments ? '문서에서 읽은 소개(AI 요약)' : 'AI 해석'}</span>
        <p>{overview.intro.text}</p>
        {buttons(overview.intro.evidenceIds, '소개의 근거')}
      </> : <p className="unknown"><span className="tag tag--unknown">확인하지 못함</span>읽은 자료로 이 프로그램이 하는 일을 확인하지 못했어요.</p>}
    </section>
    <section aria-label="주요 기능 후보">
      <h4>주요 기능 후보 · {overview.features.length}개</h4>
      {overview.features.length === 0 && <p className="hint">읽은 범위에서 기능 후보를 찾지 못했어요. 기능이 없다는 뜻은 아니에요.</p>}
      <ul className="overview-items">{features.map((feature, index) => {
        const start = sourceOf(feature.start.evidenceId);
        const anchor = `feature:${index}`;
        return <li key={anchor} className="fact">
          <span className="tag tag--unknown">AI가 제안한 기능 후보</span>
          <b>{feature.name}</b>
          <p>{feature.summary}</p>
          <p className="hint">출발점: {start.relativePath}{feature.start.functionName ? ` › ${feature.start.functionName}` : ' (함수는 정하지 못함, 파일을 열어 골라요)'}</p>
          {buttons(feature.evidenceIds, `‘${feature.name}’의 근거`)}
          <button className="btn btn--small" data-anchor={anchor} disabled={blocked} onClick={() => onFollow(feature, anchor)}>이 기능 따라가기</button>
        </li>;
      })}</ul>
      {features.length < overview.features.length && <button className="btn btn--small" onClick={() => setAllFeatures(true)}>{overview.features.length - features.length}개 더 보기</button>}
    </section>
    <section aria-label="큰 구성과 역할">
      <h4>큰 구성과 역할 · {overview.roles.length}개</h4>
      <p className="hint">역할로 묶은 것은 AI 해석이에요. 지도의 선은 코드에서 확인한 import만 그대로예요.</p>
      <ul className="overview-items">{roles.map((role, index) => <li key={index} className="fact">
        <span className="tag tag--unknown">AI 해석 · 구성 역할</span>
        <b>{role.name}</b>
        <p>{role.summary}</p>
        {buttons(role.evidenceIds, `‘${role.name}’의 근거`)}
        {role.functions.length > 0 && <ul className="sources" aria-label={`‘${role.name}’의 관련 함수`}>{role.functions.map(item => {
          const at = sourceOf(item.evidenceId);
          return <li key={`${item.name}:${item.evidenceId}`}>
            <button className="btn btn--small" disabled={blocked} onClick={() => onFunction(item.name, at.evidence)}>{item.name} · {at.relativePath}</button>
          </li>;
        })}</ul>}
      </li>)}</ul>
      {roles.length < overview.roles.length && <button className="btn btn--small" onClick={() => setAllRoles(true)}>{overview.roles.length - roles.length}개 더 보기</button>}
    </section>
    {overview.unknowns.length > 0 && <section aria-label="개요에서 확인하지 못한 것">
      <h4>확인하지 못한 것</h4>
      <ul>{overview.unknowns.map((unknown, index) => <li key={index}><span className="tag tag--unknown">확인하지 못함</span>{unknown}</li>)}</ul>
    </section>}
    <details>
      <summary>조사 범위 · AI가 실제로 읽은 파일 {sources.length}개</summary>
      <ul>{sources.map(source => <li key={source.evidence.id}>{source.relativePath}</li>)}</ul>
      <p className="hint">파일 목록에서 이름만 본 파일은 읽은 것이 아니에요.</p>
      {result.limitations.map((limitation, index) => <p key={index} className="hint">읽기 범위: {limitation}</p>)}
    </details>
  </div>;
}

/** Plan F1·U1: the topic being learned, above every view, and the ways back to its start and to the overview. */
export function TopicBar({ topic, canStartHere, canAsk, locked, onRename, onStartHere, onStart, onAsk, onOverview, onClose }: {
  topic: Topic | null; canStartHere: boolean; canAsk: boolean; locked: boolean;
  onRename(name: string): void; onStartHere(): void; onStart(): void; onAsk(): void; onOverview(): void; onClose(): void;
}) {
  if (!topic) {
    return canStartHere ? <section className="topic topic--empty" aria-label="학습 주제">
      <span className="hint">학습 주제가 없어요.</span>
      <button className="btn btn--small" disabled={locked} onClick={onStartHere}>이 함수에서 학습 시작</button>
    </section> : null;
  }
  const start = `${topic.start.relativePath}${topic.start.functionName ? ` › ${topic.start.functionName}` : ''}`;
  return <section className="topic" aria-label="학습 주제">
    <span className="tag tag--unknown">학습 주제 · {origins[topic.origin]}</span>
    <label className="topic__name">학습 이름
      <input aria-label="학습 이름" maxLength={80} value={topic.name} onChange={event => onRename(event.target.value)} />
    </label>
    {topic.name.trim() !== topic.original && <span className="hint">원래 이름: {topic.original}</span>}
    <span className="hint">출발점: {start}</span>
    <div className="topic__actions">
      <button className="btn btn--small" disabled={locked} onClick={onStart}>출발점으로</button>
      <button className="btn btn--small" disabled={locked || !canAsk} title={canAsk ? undefined : '함수를 먼저 골라 주세요.'}
        onClick={onAsk}>시작·처리·결과 질문 준비</button>
      <button className="btn btn--small" onClick={onOverview}>한눈에 보기로</button>
      <button className="btn btn--small btn--ghost" onClick={onClose}>주제 닫기</button>
    </div>
  </section>;
}
