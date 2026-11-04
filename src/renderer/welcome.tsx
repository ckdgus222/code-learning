import React from 'react';
import type { RecentProject } from '../shared/contracts';
import { Icon } from './icons';
import { savedDate } from './overview';

export function Welcome({ recentProjects, busy, onOpen }: {
  recentProjects: RecentProject[];
  busy: boolean;
  onOpen(projectId?: string): void;
}) {
  return <main className="welcome">
    <div className="welcome__intro">
      <span className="eyebrow">읽기 전용 · 코드 근거와 함께</span>
      <h2>처음 보는 프로젝트를{' '}<br />설계도처럼 읽어 보세요</h2>
      <p className="welcome__lead">폴더 하나를 고르면 화면 → 요청 → 서버 연결을 찾아, 실제 코드 줄과 함께 단계별로 보여 줘요.</p>
      <button className="btn btn--primary welcome__open" disabled={busy} onClick={() => onOpen()}>
        <Icon name="folder" />프로젝트 폴더 열기
      </button>
    </div>
    <ol className="welcome__steps" aria-label="쓰는 순서">
      <li><span className="welcome__step-label">1 · 폴더 열기</span><b>한눈에 보기</b><span>소개와 화면·요청·서버 개수</span></li>
      <li className="welcome__step--accent"><span className="welcome__step-label">2 · 기능 고르기</span><b>프로젝트 지도</b><span>화면 → 요청 → 서버 세 칸 지도</span></li>
      <li><span className="welcome__step-label">3 · 단계별로</span><b>흐름 따라가기</b><span>단계마다 실제 코드 줄</span></li>
    </ol>
    {recentProjects.length > 0 && <section className="welcome__recent" aria-label="최근 프로젝트">
      <h3>최근 프로젝트</h3>
      <ul>{recentProjects.map(recent => <li key={recent.id}>
        <button className="recent-row" disabled={busy} onClick={() => onOpen(recent.id)}>
          <span className="recent-row__project"><b>{recent.name}</b><code>{recent.root}</code></span>
          <span className="recent-row__date">{savedDate(recent.openedAt)}</span>
          <span className="recent-row__open">열기</span>
        </button>
      </li>)}</ul>
    </section>}
    <p className="welcome__promise">원본 파일을 바꾸거나 실행하지 않아요 · AI는 동의한 질문만 보내요 · TypeScript·JavaScript · 알려진 한계는 README에 있어요</p>
  </main>;
}
