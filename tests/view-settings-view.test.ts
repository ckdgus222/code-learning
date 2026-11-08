import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningApi } from '../src/shared/contracts';

// Match the existing hook tests: run async handlers without installing a DOM package.
const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (() => unknown)[],
  stateIndex: 0, refIndex: 0,
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => {
      hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value;
    }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
import { ViewSettingsButton } from '../src/renderer/view-settings';

let api: {
  getViewSettings: ReturnType<typeof vi.fn<LearningApi['getViewSettings']>>;
  setViewSettings: ReturnType<typeof vi.fn<LearningApi['setViewSettings']>>;
  checkForUpdate: ReturnType<typeof vi.fn<LearningApi['checkForUpdate']>>;
  openReleasePage: ReturnType<typeof vi.fn<LearningApi['openReleasePage']>>;
};
type Element = React.ReactElement<Record<string, any>>;
function render() {
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = [];
  return ViewSettingsButton();
}
function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node as Element, ...React.Children.toArray(node.props.children as React.ReactNode).flatMap(elements)];
}
async function loadAndOpen() {
  const tree = render();
  hooks.effects[0]();
  await Promise.resolve();
  elements(tree).find(node => node.type === 'button')!.props.onClick();
  return render();
}
beforeEach(() => {
  hooks.state = []; hooks.refs = [];
  api = {
    getViewSettings: vi.fn(async () => ({ ok: true, value: { screen: 'dark', codeColors: 'contrast' } })),
    setViewSettings: vi.fn(async value => ({ ok: true, value })),
    checkForUpdate: vi.fn(async () => ({ ok: true, value: { current: '1.0.0', latest: '1.1.0', status: 'newer' } })),
    openReleasePage: vi.fn(async () => ({ ok: true, value: null })),
  };
  vi.stubGlobal('window', { learning: api });
  vi.stubGlobal('document', {
    documentElement: { dataset: { codeColors: 'contrast' } },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('shows a named settings button without requiring a project', () => {
  const html = renderToStaticMarkup(render());
  expect(html).toContain('aria-label="앱 설정"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('role="dialog"');
});

it('shows two native radio groups with the saved selections', async () => {
  const tree = await loadAndOpen();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('<legend>화면</legend>');
  expect(html).toContain('<legend>코드 색</legend>');
  const radios = elements(tree).filter(node => node.type === 'input');
  expect(radios.map(node => node.props.value)).toEqual(['system', 'light', 'dark', 'default', 'contrast']);
  expect(radios.filter(node => node.props.checked).map(node => node.props.value)).toEqual(['dark', 'contrast']);
  expect(document.documentElement.dataset.codeColors).toBe('contrast');
});

it('applies the successful IPC result to the radio and document colours', async () => {
  const tree = await loadAndOpen();
  elements(tree).find(node => node.type === 'input' && node.props.value === 'default')!.props.onChange();
  await Promise.resolve();
  expect(api.setViewSettings).toHaveBeenCalledWith({ screen: 'dark', codeColors: 'default' });
  expect(document.documentElement.dataset.codeColors).toBe('default');
  const checked = elements(render()).filter(node => node.type === 'input' && node.props.checked);
  expect(checked.map(node => node.props.value)).toEqual(['dark', 'default']);
});

it.each(['IO', 'rejection'])('restores saved selections after %s and allows a retry', async failure => {
  const tree = await loadAndOpen();
  if (failure === 'IO') api.setViewSettings.mockResolvedValueOnce({ ok: false, code: 'IO', message: '저장 실패' });
  if (failure === 'rejection') api.setViewSettings.mockRejectedValueOnce(new Error('IPC unavailable'));
  elements(tree).find(node => node.type === 'input' && node.props.value === 'light')!.props.onChange();
  await Promise.resolve();
  const restored = render();
  expect(elements(restored).filter(node => node.type === 'input' && node.props.checked).map(node => node.props.value)).toEqual(['dark', 'contrast']);
  expect(renderToStaticMarkup(restored)).toContain('role="alert"');
  expect(document.documentElement.dataset.codeColors).toBe('contrast');
  elements(restored).find(node => node.type === 'input' && node.props.value === 'light')!.props.onChange();
  await Promise.resolve();
  expect(api.setViewSettings).toHaveBeenCalledTimes(2);
  expect(elements(render()).find(node => node.type === 'input' && node.props.value === 'light')!.props.checked).toBe(true);
});

it('blocks another edit until the first save finishes', async () => {
  const tree = await loadAndOpen();
  let finish!: (result: Awaited<ReturnType<LearningApi['setViewSettings']>>) => void;
  api.setViewSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const radio = elements(tree).find(node => node.type === 'input' && node.props.value === 'light')!;
  radio.props.onChange();
  radio.props.onChange();
  expect(api.setViewSettings).toHaveBeenCalledTimes(1);
  expect(elements(render()).filter(node => node.type === 'fieldset')
    .every(node => node.props['aria-disabled'] && !node.props.disabled)).toBe(true);
  finish({ ok: true, value: { screen: 'light', codeColors: 'contrast' } });
  await Promise.resolve();
  expect(elements(render()).filter(node => node.type === 'fieldset').every(node => !node.props['aria-disabled'])).toBe(true);
});

it('closes with Escape or an outside pointer, restoring button focus for Escape', async () => {
  await loadAndOpen();
  const focus = vi.fn();
  hooks.refs[0].current = { contains: (target: unknown) => target === 'inside' };
  hooks.refs[1].current = { focus };
  const cleanup = hooks.effects[1]() as () => void;
  const listeners = vi.mocked(document.addEventListener).mock.calls;
  const escape = listeners.find(([type]) => type === 'keydown')![1] as (event: unknown) => void;
  const pointer = listeners.find(([type]) => type === 'pointerdown')![1] as (event: unknown) => void;
  pointer({ target: 'inside' });
  expect(renderToStaticMarkup(render())).toContain('role="dialog"');
  escape({ key: 'Enter' });
  expect(renderToStaticMarkup(render())).toContain('role="dialog"');
  escape({ key: 'Escape', preventDefault: vi.fn() });
  expect(renderToStaticMarkup(render())).not.toContain('role="dialog"');
  expect(focus).toHaveBeenCalledOnce();
  elements(render()).find(node => node.type === 'button')!.props.onClick();
  pointer({ target: 'outside' });
  expect(renderToStaticMarkup(render())).not.toContain('role="dialog"');
  cleanup();
  expect(document.removeEventListener).toHaveBeenCalledWith('keydown', escape);
  expect(document.removeEventListener).toHaveBeenCalledWith('pointerdown', pointer);
});

it('does not check for updates after mount or opening settings, including effects and microtasks', async () => {
  const tree = render();
  await act(async () => { hooks.effects.forEach(effect => effect()); });
  expect(api.checkForUpdate).not.toHaveBeenCalled();
  elements(tree).find(node => node.type === 'button')!.props.onClick();
  render();
  await act(async () => { hooks.effects.forEach(effect => effect()); });
  expect(api.checkForUpdate).not.toHaveBeenCalled();
  expect(api.openReleasePage).not.toHaveBeenCalled();
  const html = renderToStaticMarkup(render());
  expect(html).toContain('role="dialog" aria-label="앱 설정"');
  expect(html).toContain('role="group" aria-label="버전"');
  expect(html).toContain('새 버전 확인');
  expect(html).not.toContain('내려받기 페이지 열기');
});

it('disables checking while pending, blocks repeated clicks and keeps the result when reopened', async () => {
  const tree = await loadAndOpen();
  let finish!: (result: Awaited<ReturnType<LearningApi['checkForUpdate']>>) => void;
  api.checkForUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const check = elements(tree).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!;
  check.props.onClick();
  check.props.onClick();
  expect(api.checkForUpdate).toHaveBeenCalledOnce();
  expect(elements(render()).find(node => node.type === 'button' && node.props.children === '확인 중…')!.props.disabled).toBe(true);
  await act(async () => { finish({ ok: true, value: { current: '1.0.0', latest: '1.1.0', status: 'newer' } }); });
  expect(elements(render()).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!.props.disabled).toBe(false);
  elements(render()).find(node => node.type === 'button')!.props.onClick();
  elements(render()).find(node => node.type === 'button')!.props.onClick();
  expect(renderToStaticMarkup(render())).toContain('새 버전 1.1.0이 있어요. 지금은 1.0.0예요.');
  expect(api.checkForUpdate).toHaveBeenCalledOnce();
  expect(api.setViewSettings).not.toHaveBeenCalled();
});

it.each([
  ['newer', '1.1.0', '새 버전 1.1.0이 있어요. 지금은 1.0.0예요.'],
  ['latest', '1.0.0', '지금 버전 1.0.0이 최신이에요.'],
  ['none', null, '아직 공개된 버전이 없어요. 지금은 1.0.0예요.'],
] as const)('shows the %s status and offers the release page only for newer releases', async (status, latest, message) => {
  const tree = await loadAndOpen();
  api.checkForUpdate.mockResolvedValueOnce({ ok: true, value: { current: '1.0.0', latest, status } });
  await act(async () => {
    elements(tree).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!.props.onClick();
  });
  const result = render();
  expect(renderToStaticMarkup(elements(result).find(node => node.props.role === 'status')!)).toContain(message);
  const release = elements(result).find(node => node.type === 'button' && node.props.children === '내려받기 페이지 열기');
  expect(Boolean(release)).toBe(status === 'newer');
  if (!release) return;
  await act(async () => { release.props.onClick(); });
  expect(api.openReleasePage).toHaveBeenCalledExactlyOnceWith();
});

it.each(['IO', 'rejection'])('shows update failure %s as an alert and allows retry', async failure => {
  const tree = await loadAndOpen();
  if (failure === 'IO') api.checkForUpdate.mockResolvedValueOnce({ ok: false, code: 'IO', message: 'main의 실패 안내' });
  if (failure === 'rejection') api.checkForUpdate.mockRejectedValueOnce(new Error('private IPC details'));
  await act(async () => {
    elements(tree).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!.props.onClick();
  });
  const result = render();
  const html = renderToStaticMarkup(result);
  expect(html).toContain('role="alert"');
  expect(html).toContain(failure === 'IO' ? 'main의 실패 안내' : '인터넷 연결을 확인하고 다시 눌러 주세요.');
  expect(html).not.toContain('private IPC details');
  expect(html).not.toContain('내려받기 페이지 열기');
  const retry = elements(result).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!;
  expect(retry.props.disabled).toBe(false);
  await act(async () => { retry.props.onClick(); });
  expect(api.checkForUpdate).toHaveBeenCalledTimes(2);
  expect(renderToStaticMarkup(render())).not.toContain('role="alert"');
});

it.each(['result', 'failure', 'rejection'])('ignores a late update %s after unmount', async outcome => {
  const tree = await loadAndOpen();
  const cleanup = hooks.effects[0]() as () => void;
  let finish!: (result: Awaited<ReturnType<LearningApi['checkForUpdate']>>) => void;
  let reject!: (error: Error) => void;
  api.checkForUpdate.mockImplementationOnce(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  await act(async () => {
    elements(tree).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!.props.onClick();
  });
  cleanup();
  const before = [...hooks.state];
  await act(async () => {
    if (outcome === 'rejection') { reject(new Error('late rejection')); return; }
    finish(outcome === 'failure' ? { ok: false, code: 'IO', message: 'late failure' }
      : { ok: true, value: { current: '1.0.0', latest: '1.1.0', status: 'newer' } });
  });
  expect(hooks.state).toEqual(before);
});

it('shows a release-page failure from main without losing the update result', async () => {
  const tree = await loadAndOpen();
  await act(async () => {
    elements(tree).find(node => node.type === 'button' && node.props.children === '새 버전 확인')!.props.onClick();
  });
  api.openReleasePage.mockResolvedValueOnce({ ok: false, code: 'IO', message: '페이지 열기 실패' });
  await act(async () => {
    elements(render()).find(node => node.type === 'button' && node.props.children === '내려받기 페이지 열기')!.props.onClick();
  });
  const html = renderToStaticMarkup(render());
  expect(html).toContain('role="alert">페이지 열기 실패');
  expect(html).toContain('새 버전 1.1.0이 있어요.');
});
