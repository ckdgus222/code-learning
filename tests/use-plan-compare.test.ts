import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningEvent } from '../src/shared/ai';
import type { LearningApi, ProjectEvent, Result } from '../src/shared/contracts';
import type { PlanCompareResult } from '../src/shared/plan-compare';

// Exercise the hook's async requests and subscriptions without a DOM or additional test packages.
const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (() => unknown)[], stateIndex: 0, refIndex: 0,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: initial };
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
import { usePlanCompare } from '../src/renderer/use-plan-compare';

const project = { id: 'project' };
const saved: PlanCompareResult = {
  jobId: 'saved-job', projectId: project.id, mode: 'codex', structureOnly: true, review: 'AI 대조 없음', models: [],
  document: { documentId: 'doc', name: 'plan.md' }, sent: [], excluded: [], plan: [], files: [], read: [], edges: [],
  compare: { items: [], unrequested: [], designMismatches: [], unknowns: [] },
  basis: { planHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), mapHash: 'c'.repeat(64) }, limitations: [],
};
const savedAt = '2026-11-02T03:00:00.000Z';
let learningEvent: (event: LearningEvent) => void;
let projectEvent: (event: ProjectEvent) => void;
let load: (value: Awaited<ReturnType<LearningApi['savedPlanCompare']>>) => void;
let api: {
  savedPlanCompare: ReturnType<typeof vi.fn<LearningApi['savedPlanCompare']>>;
  savePlanCompare: ReturnType<typeof vi.fn<LearningApi['savePlanCompare']>>;
  deletePlanCompare: ReturnType<typeof vi.fn<LearningApi['deletePlanCompare']>>;
  pickPlanDocument: ReturnType<typeof vi.fn<LearningApi['pickPlanDocument']>>;
  startPlanCompare: ReturnType<typeof vi.fn<LearningApi['startPlanCompare']>>;
  cancelExplanation: ReturnType<typeof vi.fn<LearningApi['cancelExplanation']>>;
};
function render() {
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = [];
  return usePlanCompare(project);
}
async function loaded(reasons: string[] = []) {
  load({ ok: true, value: { result: saved, savedAt, reasons } });
  await Promise.resolve();
  return render();
}
beforeEach(() => {
  hooks.state = []; hooks.refs = [];
  api = {
    savedPlanCompare: vi.fn(() => new Promise(resolve => { load = resolve; })),
    savePlanCompare: vi.fn(async () => ({ ok: true as const, value: { savedAt } })),
    deletePlanCompare: vi.fn(async () => ({ ok: true as const, value: null })),
    pickPlanDocument: vi.fn(async () => ({ ok: true as const, value: { ...saved.document, bytes: 3, lines: 1, lineBytes: [3], sections: [] } })),
    startPlanCompare: vi.fn(async () => ({ ok: true as const, value: { jobId: 'new-job' } })),
    cancelExplanation: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  vi.stubGlobal('window', { learning: { ...api,
    onLearningEvent: (receive: typeof learningEvent) => { learningEvent = receive; return () => {}; },
    onProjectEvent: (receive: typeof projectEvent) => { projectEvent = receive; return () => {}; },
  } });
  render();
  hooks.effects.forEach(effect => effect());
});

afterEach(() => vi.unstubAllGlobals());

it('restores a result and date without an AI request', async () => {
  const state = await loaded();
  expect(state.result).toBe(saved);
  expect(state.savedAt).toBe(savedAt);
  expect(state.freshness).toEqual({ status: 'fresh', reasons: [] });
  expect(api.startPlanCompare).not.toHaveBeenCalled();
});
it.each(['pick', 'selection', 'cancel', 'forget'])('discards a late restore after %s', async action => {
  const state = render();
  if (action === 'pick') await state.pick();
  if (action === 'selection') state.setSelection({ documentId: 'doc', startLine: 1, endLine: 1 });
  if (action === 'cancel') state.cancel();
  if (action === 'forget') state.forget();
  const next = await loaded();
  expect(next.result).toBeNull();
  expect(next.savedAt).toBeNull();
});
it('discards an older load after reopening the same project with a new request', async () => {
  const first = load;
  render();
  hooks.effects[2]();
  const second = load;
  second({ ok: true, value: { result: { ...saved, jobId: 'latest' }, savedAt, reasons: [] } });
  await Promise.resolve();
  first({ ok: true, value: { result: saved, savedAt, reasons: [] } });
  await Promise.resolve();
  expect(render().result?.jobId).toBe('latest');
});
it.each(['changed', 'watch-error'] as const)('prioritizes %s received while loading over the saved reasons', async kind => {
  projectEvent({ projectId: project.id, kind });
  const state = await loaded(['saved reason']);
  expect(state.freshness.status).toBe('stale');
  expect(state.freshness.reasons).toEqual([kind === 'watch-error'
    ? '파일 감시가 멈춰 바뀐 코드를 알 수 없어요. 폴더를 다시 열어 주세요'
    : '대조 뒤 코드나 제외 규칙이 바뀌었어요(또는 잠자기에서 돌아왔어요)']);
});
it('ignores foreign project events and retains restoration reasons', async () => {
  projectEvent({ projectId: 'other', kind: 'watch-error' });
  expect((await loaded(['saved reason'])).freshness).toEqual({ status: 'stale', reasons: ['saved reason'] });
});
it.each(['IO', 'PROJECT_CLOSED'] as const)('handles %s load failures without a card', async code => {
  load({ ok: false, code, message: 'underlying error' });
  await Promise.resolve();
  const state = render();
  expect(state.error).toBe(code === 'IO' ? '저장한 대조 결과를 불러오지 못했어요.' : '');
  expect(state.result).toBeNull();
});
it('deletes only an idle result and clears its date', async () => {
  await (await loaded()).remove();
  expect(api.deletePlanCompare).toHaveBeenCalledExactlyOnceWith({ projectId: project.id });
  expect(render().result).toBeNull();
  expect(render().savedAt).toBeNull();
});
it('keeps the result and reports deletion failure', async () => {
  api.deletePlanCompare.mockResolvedValueOnce({ ok: false, code: 'IO', message: 'delete failed' });
  await (await loaded()).remove();
  expect(render().result).toBe(saved);
  expect(render().error).toBe('delete failed');
});
it('saves only the accepted completion job and shows save failure', async () => {
  await render().pick();
  render().setConsent(true);
  await render().start('codex');
  api.savePlanCompare.mockResolvedValueOnce({ ok: false, code: 'IO', message: 'save failed' });
  learningEvent({ kind: 'plan-compare-completed', projectId: project.id, jobId: 'foreign', result: saved });
  expect(api.savePlanCompare).not.toHaveBeenCalled();
  const result = { ...saved, jobId: 'new-job' };
  learningEvent({ kind: 'plan-compare-completed', projectId: project.id, jobId: result.jobId, result });
  await Promise.resolve();
  expect(api.savePlanCompare).toHaveBeenCalledExactlyOnceWith({ projectId: project.id, jobId: result.jobId });
  expect(render().error).toBe('대조 결과를 저장하지 못했어요. 앱을 닫으면 사라져요.');
  expect(render().savedAt).toBeNull();
});
it('ignores a late save reply after the result is cleared', async () => {
  await render().pick();
  render().setConsent(true);
  await render().start('codex');
  let finish!: (value: Result<{ savedAt: string }>) => void;
  api.savePlanCompare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = { ...saved, jobId: 'new-job' };
  learningEvent({ kind: 'plan-compare-completed', projectId: project.id, jobId: result.jobId, result });
  render().setSelection({ documentId: 'doc', startLine: 1, endLine: 1 });
  finish({ ok: true, value: { savedAt } });
  await Promise.resolve();
  expect(render().result).toBeNull();
  expect(render().savedAt).toBeNull();
});

it('reports a rejected restore request', async () => {
  api.savedPlanCompare.mockRejectedValueOnce(new Error('transport failed'));
  render();
  hooks.effects[2]();
  await Promise.resolve();
  expect(render().error).toBe('저장한 대조 결과를 불러오지 못했어요.');
});
it('reports a rejected save request for the current result', async () => {
  await render().pick();
  render().setConsent(true);
  await render().start('codex');
  api.savePlanCompare.mockRejectedValueOnce(new Error('transport failed'));
  const result = { ...saved, jobId: 'new-job' };
  learningEvent({ kind: 'plan-compare-completed', projectId: project.id, jobId: result.jobId, result });
  await Promise.resolve();
  expect(render().error).toBe('대조 결과를 저장하지 못했어요. 앱을 닫으면 사라져요.');
});
it('reports a rejected delete request and retains the result', async () => {
  api.deletePlanCompare.mockRejectedValueOnce(new Error('transport failed'));
  await (await loaded()).remove();
  expect(render().result).toBe(saved);
  expect(render().error).toBe('대조 결과를 지우지 못했어요.');
});
