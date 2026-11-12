import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningApi, ProjectMap, ProjectView } from '../src/shared/contracts';
import type { View } from '../src/renderer/selection';

// Keep effect dependencies so a state update does not simulate leaving and re-entering the file tab.
const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (() => void)[],
  dependencies: [] as unknown[][], stateIndex: 0, refIndex: 0, effectIndex: 0,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = value; }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.effectIndex++;
    const previous = hooks.dependencies[index];
    if (!previous || dependencies.some((value, at) => !Object.is(value, previous[at]))) hooks.effects.push(effect);
    hooks.dependencies[index] = dependencies;
  },
}));
import { useMap } from '../src/renderer/use-map';
import { mapMarkdown } from '../src/renderer/map-export';

const project: ProjectView = { id: 'project', name: 'project', files: [], excluded: {}, warnings: [],
  overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
const map: ProjectMap = { projectId: project.id, files: [], edges: [], unresolved: [], external: [], missing: [], missingCut: false, complexFunctions: [], symbols: [], symbolsCut: false,
  exports: [], reading: { steps: [], total: 0, incomplete: false }, unused: { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } },
  limited: false, notes: [] };
const openedAt = { current: 0 };
const setNotice = vi.fn();
const exportMap = vi.fn<LearningApi['exportMap']>();
const revision = { current: 0 };
const setError = vi.fn();
const projectMap = vi.fn<LearningApi['projectMap']>();
const cancelProjectMap = vi.fn<LearningApi['cancelProjectMap']>();
let finish: (result: Awaited<ReturnType<LearningApi['projectMap']>>) => void;

function render(view: View = 'overview', currentProject: ProjectView | null = project, tab: 'feature' | 'file' = 'file') {
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.effects = [];
  const result = useMap({ project: currentProject, revision, view, tab, setError, openedAt, setNotice });
  hooks.effects.forEach(effect => effect());
  return result;
}

beforeEach(() => {
  hooks.state = []; hooks.refs = []; hooks.dependencies = [];
  revision.current = 0; openedAt.current = 0; setNotice.mockReset(); exportMap.mockReset();
  setError.mockReset(); projectMap.mockReset(); cancelProjectMap.mockReset();
  projectMap.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  cancelProjectMap.mockResolvedValue({ ok: true, value: null });
  vi.stubGlobal('window', { learning: { projectMap, cancelProjectMap, exportMap } });
});
afterEach(() => vi.unstubAllGlobals());

it('starts once in the overview and shares the result with both map tabs', async () => {
  render();
  expect(render().mapping).toBe(true);
  expect(projectMap).toHaveBeenCalledExactlyOnceWith({ projectId: project.id });
  finish({ ok: true, value: map });
  await Promise.resolve();
  expect(render().entry?.map).toBe(map);
  render('map', project, 'feature');
  render('map');
  render();
  expect(projectMap).toHaveBeenCalledTimes(1);
});

it('does not start without a project or from the feature tab alone', () => {
  render('overview', null);
  render('map', project, 'feature');
  expect(projectMap).not.toHaveBeenCalled();
  render();
  expect(projectMap).toHaveBeenCalledTimes(1);
});

it.each(['overview', 'map'] as const)('does not retry a failed %s build when returning to the overview', async view => {
  render(view);
  finish({ ok: false, code: 'IO', message: 'map failed' });
  await Promise.resolve();
  expect(render(view).mapping).toBe(false);
  render('code');
  expect(render().entry).toBeNull();
  expect(projectMap).toHaveBeenCalledTimes(1);
  expect(setError).toHaveBeenLastCalledWith('map failed');
  const retry = render().build();
  finish({ ok: true, value: map });
  await retry;
  expect(render().entry?.map).toBe(map);
  expect(projectMap).toHaveBeenCalledTimes(2);
});

it.each(['overview', 'map'] as const)('keeps a cancelled %s build cancelled in the overview and discards its late reply', async view => {
  render(view);
  const cancelledReply = finish;
  await render('map').cancel();
  expect(render('map').mapping).toBe(false);
  expect(render().entry).toBeNull();
  cancelledReply({ ok: true, value: map });
  await Promise.resolve();
  expect(render().entry).toBeNull();
  expect(projectMap).toHaveBeenCalledTimes(1);
  expect(cancelProjectMap).toHaveBeenCalledExactlyOnceWith({ projectId: project.id });
  expect(setError).toHaveBeenLastCalledWith('');
});

it.each(['overview', 'map'] as const)('tries once again after reopening the same folder in %s', async view => {
  render(view);
  await render(view).cancel();
  render(view).forget();
  const reopened = { ...project };
  render(view, reopened);
  expect(projectMap).toHaveBeenCalledTimes(2);
  await render(view, reopened).cancel();
  render('overview', reopened);
  expect(projectMap).toHaveBeenCalledTimes(2);
});

it('leaves the file map tab able to retry after an overview failure', async () => {
  render();
  finish({ ok: false, code: 'IO', message: 'map failed' });
  await Promise.resolve();
  render();
  render('map');
  expect(projectMap).toHaveBeenCalledTimes(2);
});

it.each(['file', 'clipboard'] as const)('exports the current map to %s and shows the result', async to => {
  render(); finish({ ok: true, value: map }); await Promise.resolve();
  exportMap.mockResolvedValue({ ok: true, value: { done: true, name: to === 'file' ? 'project-map.md' : null } });
  await render().export(to);
  expect(exportMap).toHaveBeenCalledExactlyOnceWith({ projectId: project.id, to,
    text: expect.stringContaining('# `project` 프로젝트 지도\n') });
  expect(exportMap.mock.calls[0][0].text).toBe(mapMarkdown(project, map, new Date()));
  expect(setNotice).toHaveBeenCalledExactlyOnceWith(to === 'file' ? '지도를 저장했어요: project-map.md' : '지도를 클립보드에 복사했어요.');
});

it('does not export without both the project and map', async () => {
  await render('code').export('file');
  render(); finish({ ok: true, value: map }); await Promise.resolve();
  await render('code', null).export('clipboard');
  expect(exportMap).not.toHaveBeenCalled();
});

it('leaves notices alone on cancellation and shows errors on failure', async () => {
  render(); finish({ ok: true, value: map }); await Promise.resolve();
  setError.mockClear();
  exportMap.mockResolvedValueOnce({ ok: true, value: { done: false, name: null } });
  await render().export('file');
  expect(setNotice).not.toHaveBeenCalled(); expect(setError).not.toHaveBeenCalled();
  exportMap.mockResolvedValueOnce({ ok: false, code: 'IO', message: '저장 실패' });
  await render().export('file');
  expect(setNotice).not.toHaveBeenCalled(); expect(setError).toHaveBeenCalledExactlyOnceWith('저장 실패');
});

it.each(['success', 'failure'] as const)('discards a late %s after closing or reopening the same project', async outcome => {
  for (const reopen of [false, true]) {
    render(); finish({ ok: true, value: map }); await Promise.resolve();
    let reply!: (result: Awaited<ReturnType<LearningApi['exportMap']>>) => void;
    exportMap.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const pending = render().export('file');
    render().forget(); openedAt.current++;
    if (reopen) { render('overview', { ...project }); finish({ ok: true, value: map }); await Promise.resolve(); }
    setError.mockClear(); setNotice.mockClear();
    reply(outcome === 'success' ? { ok: true, value: { done: true, name: 'old.md' } } : { ok: false, code: 'IO', message: 'old error' });
    await pending;
    expect(setNotice).not.toHaveBeenCalled(); expect(setError).not.toHaveBeenCalled();
  }
});
