import React from 'react';
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
  expect(html).toContain('aria-label="보기 설정"');
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
