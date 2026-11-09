import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ state: [] as unknown[], stateIndex: 0 }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = value; }];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => 'test-id',
  useEffect: () => {},
}));
import { AiPanel } from '../src/renderer/ai-panel';

const refresh = vi.fn(async () => {});
const save = vi.fn(async () => null);
function render() {
  hooks.stateIndex = 0;
  return AiPanel({ open: true, onClose() {}, projectId: 'project', evidence: null, relativePath: '', stale: false, draft: null,
    connections: null, checking: false, otherRunning: false, mode: 'antigravity',
    geminiKeyStatus: { saved: false, readable: false, canEncrypt: false },
    onRefreshGeminiKeyStatus: refresh, onChangeGeminiKey: save,
    onMode() {}, onRunning() {}, async onInspect() { return null; }, async onEnsure() { return null; }, onEvidence() {},
  });
}
function controls(node: ReactNode): ReactElement<{
  children?: ReactNode; type?: string; disabled?: boolean;
  onClick?(): void; onChange?(event: { target: { value: string } }): void;
}>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<{ children?: ReactNode }>(child)) return [];
    if (child.type === 'button' || child.type === 'input') return [child];
    return controls(child.props.children);
  });
}
beforeEach(() => {
  hooks.state = [];
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => vi.unstubAllGlobals());

it('refreshes key status each time settings opens, but not when it closes', () => {
  const toggle = () => controls(render()).find(control => control.props.children === '설정')!.props.onClick!();
  toggle();
  expect(refresh).toHaveBeenCalledOnce();
  toggle();
  expect(refresh).toHaveBeenCalledOnce();
  toggle();
  expect(refresh).toHaveBeenCalledTimes(2);
});
it('allows entering and saving a key again when the last encryption check failed', () => {
  const input = controls(render()).find(control => control.props.type === 'password')!;
  expect(input.props.disabled).toBe(false);
  input.props.onChange!({ target: { value: 'fake-gemini-key-for-tests-only' } });
  const button = controls(render()).find(control => control.props.children === '저장')!;
  expect(button.props.disabled).toBe(false);
  button.props.onClick!();
  expect(save).toHaveBeenCalledExactlyOnceWith('fake-gemini-key-for-tests-only');
});
