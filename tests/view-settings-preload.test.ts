import { afterEach, expect, it, vi } from 'vitest';
import { channels, type LearningApi } from '../src/shared/contracts';

const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke },
}));
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  [[], 'default'], [['--code-colors=default'], 'default'], [['--code-colors=contrast'], 'contrast'],
  [['--code-colors=unknown'], 'default'], [['--code-colors=contrast-extra'], 'default'],
  [['--other=contrast'], 'default'],
])('applies only an allowed code colour argument before rendering: %j', async (arguments_, expected) => {
  vi.resetModules();
  process.argv = ['electron', ...arguments_];
  const documentElement = { dataset: {} };
  vi.stubGlobal('document', { documentElement });
  await import('../src/preload/preload');
  expect(documentElement.dataset).toEqual({ codeColors: expected });
  const api = bridge.expose.mock.calls[0][1] as LearningApi;
  const settings = { screen: 'dark', codeColors: 'contrast' } as const;
  await api.getViewSettings();
  await api.setViewSettings(settings);
  expect(bridge.invoke.mock.calls).toEqual([[channels.getViewSettings], [channels.setViewSettings, settings]]);
});

it('exposes update actions without invoking them or passing arguments', async () => {
  vi.resetModules();
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  await import('../src/preload/preload');
  const api = bridge.expose.mock.calls[0][1] as LearningApi;
  expect(bridge.invoke).not.toHaveBeenCalled();
  await api.checkForUpdate();
  await api.openReleasePage();
  expect(bridge.invoke.mock.calls).toEqual([[channels.checkForUpdate], [channels.openReleasePage]]);
});

it('sets the attribute as soon as the HTML root is inserted, without waiting for DOMContentLoaded', async () => {
  vi.resetModules();
  process.argv = ['electron', '--code-colors=contrast'];
  const document = { documentElement: null as { dataset: Record<string, string> } | null };
  const observe = vi.fn(), disconnect = vi.fn();
  let inserted!: () => void;
  vi.stubGlobal('document', document);
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { inserted = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  await import('../src/preload/preload');
  expect(observe).toHaveBeenCalledWith(document, { childList: true });
  inserted();
  expect(disconnect).not.toHaveBeenCalled();
  document.documentElement = { dataset: {} };
  inserted();
  expect(document.documentElement.dataset.codeColors).toBe('contrast');
  expect(disconnect).toHaveBeenCalledOnce();
});
