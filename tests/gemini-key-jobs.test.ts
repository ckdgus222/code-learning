import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { LearningApi, ProjectView, SourceView } from '../src/shared/contracts';
import type { ConnectionReport } from '../src/shared/ai';

const hooks = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0 }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value; }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useEffect: () => {},
}));
import { useAiJobs } from '../src/renderer/use-ai-jobs';
const report: ConnectionReport = { checkedAt: 'test', modes: [{ mode: 'antigravity', ready: true, reason: 'test' }], providers: [] };
let api: { [K in 'saveGeminiKey' | 'clearGeminiKey' | 'checkConnections' | 'startOverview' | 'startFileExplanation']: ReturnType<typeof vi.fn<LearningApi[K]>> };
function render(planCompareRunning = false) {
  hooks.stateIndex = 0; hooks.refIndex = 0;
  return useAiJobs({ project: { id: 'project' } as ProjectView, source: { fileId: 'file' } as SourceView,
    symbol: undefined, revision: { current: 0 }, setError() {}, setNotice() {}, planCompareRunning });
}
beforeEach(() => {
  hooks.state = []; hooks.refs = [];
  api = { saveGeminiKey: vi.fn(), clearGeminiKey: vi.fn(), checkConnections: vi.fn(), startOverview: vi.fn(), startFileExplanation: vi.fn() };
  vi.stubGlobal('window', { learning: api });
});
afterEach(() => vi.unstubAllGlobals());
it.each(['save', 'clear'] as const)('holds the shared lock across %s and exactly one fresh check', async action => {
  let finishChange!: (value: Awaited<ReturnType<LearningApi['saveGeminiKey']>>) => void;
  let finishCheck!: (value: Awaited<ReturnType<LearningApi['checkConnections']>>) => void;
  api.saveGeminiKey.mockImplementation(() => new Promise(resolve => { finishChange = resolve; }));
  api.clearGeminiKey.mockImplementation(() => new Promise(resolve => { finishChange = resolve; }));
  api.checkConnections.mockImplementation(() => new Promise(resolve => { finishCheck = resolve; }));
  const initial = render();
  const operation = initial.changeGeminiKey(action === 'save' ? 'fake-key-for-tests-only' : null);
  expect(render().keyBusy).toBe(true);
  expect(await initial.inspectConnections()).toContain('API 키');
  await initial.startOverview(null);
  await initial.startFileExplanation();
  expect(api.startOverview).not.toHaveBeenCalled();
  expect(api.startFileExplanation).not.toHaveBeenCalled();
  expect(await initial.changeGeminiKey(null)).toContain('API 키');
  expect(api.checkConnections).not.toHaveBeenCalled();
  finishChange({ ok: true, value: { saved: action === 'save', readable: action === 'save', canEncrypt: true } });
  await Promise.resolve();
  expect(api.checkConnections).toHaveBeenCalledTimes(1);
  expect(render().keyBusy).toBe(true);
  expect(await initial.inspectConnections()).toContain('API 키');
  finishCheck({ ok: true, value: report });
  expect(await operation).toBeNull();
  expect(render().keyBusy).toBe(false);
  expect(render().connections).toEqual(report);
});
it.each(['save-failure', 'save-rejection', 'clear-failure', 'check-failure', 'check-rejection'])('releases the lock after %s', async failure => {
  api.saveGeminiKey.mockResolvedValue({ ok: true, value: { saved: true, readable: true, canEncrypt: true } });
  api.clearGeminiKey.mockResolvedValue({ ok: false, code: 'IO', message: 'clear failed' });
  api.checkConnections.mockResolvedValue({ ok: false, code: 'IO', message: 'check failed' });
  if (failure === 'save-failure') api.saveGeminiKey.mockResolvedValue({ ok: false, code: 'IO', message: 'save failed' });
  if (failure === 'save-rejection') api.saveGeminiKey.mockRejectedValue(new Error('synthetic'));
  if (failure === 'check-rejection') api.checkConnections.mockRejectedValue(new Error('synthetic'));
  expect(await render().changeGeminiKey(failure === 'clear-failure' ? null : 'fake-key-for-tests-only')).toBeTruthy();
  expect(render().keyBusy).toBe(false);
  expect(render().checking).toBe(false);
  expect(api.checkConnections).toHaveBeenCalledTimes(failure.startsWith('check') ? 1 : 0);
});
it('refuses a key change during an installation check or another AI job', async () => {
  api.checkConnections.mockReturnValue(new Promise(() => {}));
  const initial = render();
  void initial.inspectConnections();
  expect(await initial.changeGeminiKey(null)).toContain('설치');
  expect(api.clearGeminiKey).not.toHaveBeenCalled();
  expect(await render(true).changeGeminiKey(null)).toContain('대조');
  expect(api.clearGeminiKey).not.toHaveBeenCalled();
});

it.each(['question', 'feature', 'overview', 'file'] as const)('refuses key changes during a %s job', async kind => {
  api.startOverview.mockReturnValue(new Promise(() => {}));
  api.startFileExplanation.mockReturnValue(new Promise(() => {}));
  const initial = render();
  if (kind === 'question') initial.setQuestionRunning(true);
  if (kind === 'feature') initial.setFeatureGuideRunning(true);
  if (kind === 'overview') void initial.startOverview(null);
  if (kind === 'file') void initial.startFileExplanation();
  expect(await render().changeGeminiKey('fake-key-for-tests-only')).toBeTruthy();
  expect(api.saveGeminiKey).not.toHaveBeenCalled();
  expect(api.checkConnections).not.toHaveBeenCalled();
});
