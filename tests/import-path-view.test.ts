import React from 'react';
import * as ReactHooks from 'react';
import * as JSX from 'react/jsx-dev-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapFile } from '../src/shared/contracts';
import type { MapLink } from '../src/renderer/map-layout';
import * as Paths from '../src/renderer/import-path';
import { ImportPathCard } from '../src/renderer/project-map';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useMemo: vi.fn(actual.useMemo) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: vi.fn(actual.jsxDEV) };
});
vi.mock('../src/renderer/import-path', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/import-path')>();
  return { ...actual, pathGraph: vi.fn(actual.pathGraph), importPath: vi.fn(actual.importPath) };
});

const file = (id: string, relativePath = `app/${id}.py`): MapFile => ({ id, relativePath, folder: 'app', start: false, entry: false, checked: 'full', reason: null });
const link = (fromFileId: string, toFileId: string, startLine = 1, guess?: string): MapLink => ({ fromFileId, toFileId, guess,
  names: [], fileHash: 'hash', startUtf16: 0, endUtf16: 10, startLine, endLine: startLine, text: `from .${toFileId} import run`, specifier: `.${toFileId}` });
const files = [file('api'), file('service'), file('models')];
const links = [link('api', 'service', 2), link('service', 'models', 3)];
const defaults = { files, links, incomplete: false, locked: false, onShowImport: vi.fn() };
const elements = () => vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<Record<string, unknown>>);
const buttons = () => elements().filter(element => element.type === 'button');

function render(from = '', to = '', props: Partial<React.ComponentProps<typeof ImportPathCard>> = {}, setFrom = vi.fn(), setTo = vi.fn()) {
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [from, setFrom]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [to, setTo]);
  return renderToStaticMarkup(React.createElement(ImportPathCard, { ...defaults, ...props }));
}
afterEach(() => vi.clearAllMocks());

describe('import path card', () => {
  it('starts with labelled editable inputs, all path options and guidance but no search', () => {
    const html = render();
    expect(html).toContain('aria-label="두 파일 사이 길"');
    expect(html.match(/<input type="text" list="map-path-files"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="출발 파일"');
    expect(html).toContain('aria-label="도착 파일"');
    expect(html).toContain('placeholder="경로를 적거나 목록에서 고르기"');
    expect(html).toContain('<datalist id="map-path-files">');
    expect(html.match(/<option[^>]*><\/option>/g)).toEqual(files.map(item => `<option value="${item.relativePath}"></option>`));
    expect(html).toContain('출발 파일과 도착 파일을 고르면');
    expect(html).not.toContain('칸: 지도에');
    expect(html).not.toContain('<ol');
    expect(Paths.importPath).not.toHaveBeenCalled();
  });

  it.each([
    ['app/api.py', '', []], ['', 'app/models.py', []],
    ['missing.py', 'app/models.py', ['출발']], ['app/api.py', 'missing.py', ['도착']],
    ['missing.py', 'other.py', ['출발', '도착']], ['   ', '', ['출발']],
  ])('does not search incomplete or unknown inputs (%s, %s)', (from, to, invalid) => {
    const html = render(from, to);
    expect(html).toContain('출발 파일과 도착 파일을 고르면');
    for (const label of ['출발', '도착']) {
      expect(html.includes(`${label} 파일 칸: 지도에 이 경로의 파일이 없어요. 목록에서 골라 주세요.`)).toBe(invalid.includes(label));
    }
    expect(html).not.toContain('<ol');
    expect(Paths.importPath).not.toHaveBeenCalled();
  });

  it.each([
    ['main.ts ', 'plain', true], [' main.ts', 'spaced', true], ['main.ts', 'plain', true], [' main.ts', 'spaced', false],
  ])('resolves exact text before trimmed text (%s → %s)', (input, expected, includePlain) => {
    const spaced = file('spaced', ' main.ts');
    const plain = file('plain', 'main.ts');
    const target = file('target', 'target.ts');
    const source = { files: includePlain ? [plain, spaced, target] : [spaced, target],
      links: [link('plain', 'target', 7), link('spaced', 'target', 9)] };
    const html = render(input, 'target.ts ', source);
    expect(Paths.importPath).toHaveBeenCalledWith(expect.anything(), expected, 'target');
    expect(html).toContain(`${expected === 'plain' ? 'main.ts 7' : ' main.ts 9'}행 → target.ts`);
    expect(html).toContain('가장 짧은 길 · 1걸음');
  });

  it('shows same-file guidance without a path', () => {
    const html = render('app/api.py', 'app/api.py');
    expect(html).toContain('출발과 도착이 같은 파일이에요.');
    expect(html).not.toContain('<ol');
  });

  it('shows ordered full paths, import lines, first evidence and the shortest-path caveat', () => {
    const html = render('app/api.py', 'app/models.py', { links: [...links, link('api', 'service', 5)] });
    expect(html).toContain('<h4>가장 짧은 길 · 2걸음</h4>');
    const rows = html.match(/<li>.*?<\/li>/g)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('<b>1.</b>');
    expect(rows[0]).toContain('app/api.py 2행 → app/service.py');
    expect(rows[0]).toContain('<code>from .service import run</code>');
    expect(rows[0]).toContain('근거 2개 중 첫 번째');
    expect(rows[0]).not.toContain('5행');
    expect(rows[1]).toContain('<b>2.</b>');
    expect(rows[1]).toContain('app/service.py 3행 → app/models.py');
    expect(rows[1]).toContain('<code>from .models import run</code>');
    expect(rows[1]).not.toContain('근거 ');
    expect(rows.every(row => row.includes('>코드 보기</button>'))).toBe(true);
    expect(html).toContain('가장 짧은 길 하나예요. 다른 길도 있을 수 있어요.');
    expect(html).not.toContain('notice--warn');
    expect(elements().filter(element => element.type === 'li').map(element => element.key)).toEqual(['api->service', 'service->models']);
  });

  it('warns about guesses and marks only guessed steps with their reason', () => {
    const html = render('app/api.py', 'app/models.py', { links: [links[0], { ...links[1], guess: '실행 환경에 따라 달라져요' }] });
    expect(html).toContain('<b>추정이 섞인 길:</b>');
    expect(html).toContain('‘추정’ 표시가 있는 걸음은 틀릴 수 있어요.');
    const rows = html.match(/<li>.*?<\/li>/g)!;
    expect(rows[0]).not.toContain('tag--unknown');
    expect(rows[1]).toContain('<span class="tag tag--unknown">추정</span> 실행 환경에 따라 달라져요');
    expect(html.indexOf('추정이 섞인 길:')).toBeLessThan(html.indexOf('<h4>'));
  });

  it.each([false, true])('explains missing paths and shows incomplete guidance only when incomplete=%s', incomplete => {
    const html = render('app/api.py', 'app/models.py', { links: [], incomplete });
    expect(html).toContain('출발 파일에서 도착 파일로 가는 import 길을 찾지 못했어요.');
    expect(html).toContain('지도에 화살표로 그려진 import만 출발에서 도착 방향으로 따라가요.');
    expect(html).toContain('화살표가 없는 import(동적 import, 후보가 없는 ‘확인 못 함’, 외부 패키지·경로 별칭)로 이어진 곳은 찾지 못해요.');
    expect(html.includes('끝까지 읽지 못한 파일이 있어 빠진 연결이 있을 수 있어요.')).toBe(incomplete);
    expect(html).not.toContain('반대 방향으로는');
    expect(html).not.toContain('<ol');
  });

  it.each([undefined, '실행 환경에 따라 달라져요'])('distinguishes settled and guessed reverse paths (%s)', guess => {
    const html = render('app/api.py', 'app/models.py', { links: [link('models', 'api', 1, guess)] });
    expect(html.includes('반대 방향으로는 길이 있어요.')).toBe(guess === undefined);
    expect(html.includes('반대 방향으로는 추정 연결이 섞인 길이 있어요.')).toBe(guess !== undefined);
    expect(html).toContain('‘출발·도착 바꾸기’를 눌러 보세요.');
  });

  it.each([false, true])('locks only code navigation (locked=%s)', locked => {
    render('app/api.py', 'app/models.py', { locked });
    const inputs = elements().filter(element => element.type === 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs.every(input => !input.props.disabled)).toBe(true);
    expect(buttons().find(button => button.props.children === '출발·도착 바꾸기')!.props.disabled).toBeUndefined();
    const code = buttons().filter(button => button.props.children === '코드 보기');
    expect(code).toHaveLength(2);
    expect(code.every(button => button.props.disabled === locked)).toBe(true);
  });

  it('opens the first settled evidence even when guesses arrived first', () => {
    const onShowImport = vi.fn();
    render('app/api.py', 'app/models.py', { links: [{ ...links[0], guess: 'candidate' }, ...links, link('api', 'service', 8)], onShowImport });
    for (const button of buttons().filter(button => button.props.children === '코드 보기')) (button.props.onClick as () => void)();
    expect(onShowImport.mock.calls).toEqual([[links[0]], [links[1]]]);
  });

  it('swaps the raw input text while locked and keeps typing available', () => {
    const setFrom = vi.fn();
    const setTo = vi.fn();
    render(' app/api.py ', 'unfinished', { locked: true }, setFrom, setTo);
    const swap = buttons().find(button => button.props.children === '출발·도착 바꾸기')!;
    (swap.props.onClick as () => void)();
    expect(setFrom).toHaveBeenCalledWith('unfinished');
    expect(setTo).toHaveBeenCalledWith(' app/api.py ');
    const inputs = elements().filter(element => element.type === 'input');
    (inputs[0].props.onChange as (event: unknown) => void)({ target: { value: 'typed source' } });
    (inputs[1].props.onChange as (event: unknown) => void)({ target: { value: 'typed target' } });
    expect(setFrom).toHaveBeenLastCalledWith('typed source');
    expect(setTo).toHaveBeenLastCalledWith('typed target');
  });

  it('renders only 300 steps of a 301-step path and counts the omitted step', () => {
    const chain = Array.from({ length: 302 }, (_, i) => file(String(i)));
    const edges = chain.slice(1).map((target, i) => link(String(i), target.id));
    const html = render('app/0.py', 'app/301.py', { files: chain, links: edges });
    expect(html).toContain('가장 짧은 길 · 301걸음');
    expect(html.match(/<li>/g)).toHaveLength(300);
    expect(html).toContain('<b>300.</b>');
    expect(html).not.toContain('<b>301.</b>');
    expect(html).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
  });

  it('memoizes the graph by files and links and the search by resolved files', () => {
    render('app/api.py', 'app/models.py');
    expect(vi.mocked(ReactHooks.useMemo).mock.calls.map(call => call[1])).toEqual([
      [files, links], [vi.mocked(Paths.pathGraph).mock.results[0].value, files[0], files[2]],
    ]);
    expect(Paths.pathGraph).toHaveBeenCalledTimes(1);
    expect(Paths.importPath).toHaveBeenCalledTimes(1);
  });
});
