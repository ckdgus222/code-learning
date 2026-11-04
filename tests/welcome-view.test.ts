import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Welcome } from '../src/renderer/welcome';
import type { RecentProject } from '../src/shared/contracts';

const recentProjects: RecentProject[] = [
  { id: 'first', name: '주문 프로젝트', root: '/projects/orders', openedAt: '2026-11-03T12:00:00.000Z' },
  { id: 'second', name: '로그인 프로젝트', root: '/projects/login', openedAt: '2026-11-02T12:00:00.000Z' },
];

function render(projects = recentProjects, busy = false) {
  return renderToStaticMarkup(React.createElement(Welcome, { recentProjects: projects, busy, onOpen() {} }));
}

it('keeps a space before the heading break and one primary folder button', () => {
  const html = render([]);
  expect(html).toContain('<main class="welcome">');
  expect(html).toContain('<h2>처음 보는 프로젝트를 <br/>설계도처럼 읽어 보세요</h2>');
  expect(html).toContain('읽기 전용 · 코드 근거와 함께');
  expect(html).toContain('폴더 하나를 고르면 화면 → 요청 → 서버 연결을 찾아, 실제 코드 줄과 함께 단계별로 보여 줘요.');
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toContain('btn btn--primary welcome__open');
  expect(buttons[0]).toContain('aria-hidden="true"');
  expect(buttons[0]).toContain('프로젝트 폴더 열기');
});

it('shows three ordered steps and emphasizes only the map card', () => {
  const steps = render().match(/<ol class="welcome__steps" aria-label="쓰는 순서">([\s\S]*?)<\/ol>/)?.[1] ?? '';
  const items = [...steps.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)];
  expect(items).toHaveLength(3);
  expect(items.map(item => item[1])).toEqual(['', ' class="welcome__step--accent"', '']);
  expect(items.map(item => item[2].replace(/<[^>]*>/g, '|'))).toEqual([
    '|1 · 폴더 열기||한눈에 보기||소개와 화면·요청·서버 개수|',
    '|2 · 기능 고르기||프로젝트 지도||화면 → 요청 → 서버 세 칸 지도|',
    '|3 · 단계별로||흐름 따라가기||단계마다 실제 코드 줄|',
  ]);
});

it('keeps each recent project name, full path, date and open label in one button in input order', () => {
  const html = render();
  expect(html).toContain('<section class="welcome__recent" aria-label="최근 프로젝트"><h3>최근 프로젝트</h3>');
  const rows = [...html.matchAll(/<button class="recent-row"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1]);
  expect(rows).toHaveLength(2);
  for (const [index, project] of recentProjects.entries()) {
    expect(rows[index]).toContain(`<b>${project.name}</b>`);
    expect(rows[index]).toContain(`<code>${project.root}</code>`);
    expect(rows[index]).toContain(`<span class="recent-row__date">11월 ${3 - index}일</span>`);
    expect(rows[index]).toContain('<span class="recent-row__open">열기</span>');
    expect(rows[index]).not.toContain('<button');
  }
});

it('omits the recent section when there are no projects', () => {
  expect(render([])).not.toContain('최근 프로젝트');
});

it.each([true, false])('locks every welcome button only while busy is %s', busy => {
  const buttons = render(recentProjects, busy).match(/<button\b[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) expect(button.includes('disabled=""')).toBe(busy);
});

it('keeps the read-only, consent, supported languages and README promises', () => {
  expect(render()).toContain('<p class="welcome__promise">원본 파일을 바꾸거나 실행하지 않아요 · AI는 동의한 질문만 보내요 · TypeScript·JavaScript · 알려진 한계는 README에 있어요</p>');
});
