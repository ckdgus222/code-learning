import React from 'react';
import * as ReactHooks from 'react';
import * as JSX from 'react/jsx-dev-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARROW_MARKER, FitOnWidthChange, MapCanvas, ProjectMapView, type MapChanges } from '../src/renderer/project-map';
import { boxName, boxPlace, expandableIds, fileViewOf, visibleGraph, type MapArrow } from '../src/renderer/map-layout';
import type { MapFile, ProjectMap, ProjectView } from '../src/shared/contracts';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: vi.fn(actual.useRef), useEffect: vi.fn(actual.useEffect) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: vi.fn(actual.jsxDEV) };
});
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, ReactFlow: vi.fn(() => null), useStore: vi.fn(actual.useStore), useReactFlow: vi.fn(actual.useReactFlow) };
});

const file = (id: string, folder: string): MapFile => ({ id, folder, relativePath: `${folder ? `${folder}/` : ''}${id}.ts`,
  start: false, entry: false, checked: 'full', reason: null });
const map: ProjectMap = { projectId: 'p', files: [file('a', 'web/app'), file('b', 'web/lib'), file('index', 'web'), file('root', ''), file('sibling', 'website')],
  edges: [{ fromFileId: 'a', toFileId: 'b', names: [], fileHash: 'h', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'import', specifier: '../lib/b' }],
  unresolved: [], external: [], complexFunctions: [], exports: [], unused: { exports: { candidates: [], unsure: [], notes: [] }, candidates: [], unsure: [], excluded: [], notes: [] }, limited: false, notes: [] };
const project: ProjectView = { id: 'p', name: 'project', files: [], excluded: {}, warnings: [],
  overview: { entryFileIds: [], intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
const changes: MapChanges = { stale: false, result: { projectId: 'p', commit: '1234567', notCompared: [], notes: [],
  changes: map.files.map(file => ({ kind: 'modified', fileId: file.id, path: file.relativePath, oldPath: null })) } };

function render(opened: ReadonlySet<string> = new Set(), focus: { id: string; opened: ReadonlySet<string> } | null = null,
  hovered: { id: string; opened: ReadonlySet<string> } | null = null, source = map, selected: MapArrow | null = null,
  picked: { fileId: string; opened: ReadonlySet<string> } | null = null, onOpenFile = vi.fn()) {
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [opened, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [selected, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [focus, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [hovered, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [picked, vi.fn()]);
  return renderToStaticMarkup(React.createElement(ProjectMapView, { project, entry: { map: source, revision: 0, build: 1 },
    stale: false, mapping: false, locked: false, changes,
    onBuild() {}, onCancel() {}, onOpenFile, onShowImport() {}, onShowFunction() {}, onShowChange() {} }));
}
function drawnNodes(): Node[] {
  return vi.mocked(ReactFlow).mock.calls.at(-1)![0].nodes!;
}
function drawnEdges(): Edge[] {
  return vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges!;
}
afterEach(() => vi.clearAllMocks());

it('renders file map contents without a page wrapper or title', () => {
  const html = render();
  expect(html).not.toContain('<h2');
  expect(html).not.toContain('class="page');
  expect(html).toContain('지도 다시 만들기');
  expect(html).toContain('data-testid="map-canvas"');
  expect(html).toContain('지도는 TS/JS 파일의 import만 봐요.');
});

it.each([undefined, 0, 1080])('sets canvas height and lets wheel events scroll the page only with height=%s', height => {
  const html = renderToStaticMarkup(React.createElement(MapCanvas, { testId: 'height-map', height, nodes: [], edges: [], onNodeClick() {} }));
  const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
  if (height === undefined) expect(html).not.toContain('style=');
  if (height !== undefined) expect(html).toContain(`style="height:${height}${height === 0 ? '' : 'px'}"`);
  expect(props.zoomOnScroll).toBe(height === undefined);
  expect(props.preventScrolling).toBe(height === undefined);
  expect(props.fitViewOptions?.maxZoom).toBe(1);
  expect(props.colorMode).toBe('system');
});

it('keeps the project map at its CSS height with wheel zoom enabled', () => {
  const html = render();
  expect(html).toContain('<div class="map-canvas" data-testid="map-canvas">');
  const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
  expect(props.zoomOnScroll).toBe(true);
  expect(props.preventScrolling).toBe(true);
});

describe('project map area controls', () => {
  it('starts without a chip row and explains one-level opening and folding', () => {
    const html = render();
    expect(html).not.toContain('aria-label="펼친 곳"');
    expect(html).toContain('aria-pressed="true">설계 보기</button>');
    expect(html).toContain('aria-pressed="false">파일 보기</button>');
    expect(html).toContain('상자를 누르면 그 안을 한 단계 펼쳐요. 위 ‘접기’로 다시 접어요.');
  });

  it('shows fold buttons in opening order, with separate labels for direct-file groups', () => {
    const html = render(new Set(['files:', 'folder:web', 'files:web', 'folder:web/app']));
    expect(html).toContain('aria-label="펼친 곳"');
    const labels = ['(최상위 폴더) 바로 아래 파일 접기', 'web 접기', 'web 바로 아래 파일 접기', 'web/app 접기'];
    const positions = labels.map(label => html.indexOf(`${label}</button>`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('aria-pressed="false">설계 보기</button>');
    expect(html).toContain('aria-pressed="false">파일 보기</button>');
  });

  it('marks file view only when all files have their own boxes', () => {
    const html = render(expandableIds(map));
    expect(html).toContain('aria-pressed="true">파일 보기</button>');
    expect(drawnNodes().map(node => node.id).sort()).toEqual(map.files.map(file => file.id).sort());
  });

  it('ignores obsolete paths in the chip row and canvas', () => {
    const html = render(new Set(['folder:removed', 'files:removed']));
    expect(html).not.toContain('aria-label="펼친 곳"');
    expect(drawnNodes().map(node => node.id).sort()).toEqual(['files:', 'folder:web', 'folder:website']);
  });

  it('counts changed descendants in areas and only direct changes in file groups', () => {
    render();
    expect(drawnNodes().find(node => node.id === 'folder:web')!.data.changed).toBe(3);
    expect(drawnNodes().find(node => node.id === 'files:')!.data.changed).toBe(1);
    render(new Set(['folder:web']));
    expect(drawnNodes().find(node => node.id === 'files:web')!.data.changed).toBe(1);
    expect(drawnNodes().find(node => node.id === 'folder:web/app')!.data.changed).toBe(1);
  });

  it('keeps innermost-folder connections in the text list when the canvas hides them', () => {
    const html = render();
    expect(vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges).toEqual([]);
    expect(html).toContain('폴더 사이 연결(설계) · 1개');
    expect(html).toContain('web/app → web/lib · import 1개');
  });
});

describe('large project file view controls', () => {
  const large: ProjectMap = { ...map, files: [...map.files, ...Array.from({ length: 76 }, (_, index) => file(`extra${index}`, 'web/app'))] };
  const expandable = expandableIds(large);

  it.each([80, 81])('uses the file count to choose the control for %i files even when only a few boxes are visible', count => {
    const source = { ...large, files: large.files.slice(0, count) };
    const html = render(new Set(), null, null, source);
    expect(drawnNodes()).toHaveLength(3);
    expect(html.includes('>파일 보기</button>')).toBe(count === 80);
    expect(html.includes('<select aria-label="파일 볼 폴더"')).toBe(count === 81);
    expect(html.includes(`파일이 ${count}개라 한 번에 그리면 선이 엉켜요. 폴더를 고르면 그 폴더의 파일을 상자로 보여 줘요.`)).toBe(count === 81);
    if (count === 80) {
      expect(render(expandableIds(source), null, null, source)).toContain('aria-pressed="true">파일 보기</button>');
      expect(drawnNodes()).toHaveLength(80);
      expect(drawnNodes().every(node => node.className?.includes('map-box--file'))).toBe(true);
    }
  });

  it('lists direct-file counts in path order and distinguishes no selection from the root', () => {
    const html = render(new Set(), null, null, large);
    expect(html.match(/<option[^>]*>.*?<\/option>/g)).toEqual([
      '<option value="" selected="">폴더 고르기</option>',
      '<option value="folder:">(최상위 폴더) · 파일 1개</option>',
      '<option value="folder:web">web · 파일 1개</option>',
      '<option value="folder:web/app">web/app · 파일 77개</option>',
      '<option value="folder:web/lib">web/lib · 파일 1개</option>',
      '<option value="folder:website">website · 파일 1개</option>',
    ]);
  });

  it('selects only the root option for root files and restores the placeholder in design view', () => {
    const html = render(fileViewOf('', expandable), null, null, large);
    expect(html).toContain('<option value="folder:" selected="">(최상위 폴더) · 파일 1개</option>');
    expect(html).toContain('<option value="">폴더 고르기</option>');
    expect(html.match(/<option[^>]* selected=""/g)).toHaveLength(1);
    expect(drawnNodes().filter(node => node.className?.includes('map-box--file')).map(node => node.id)).toEqual(['root']);
    const folded = render(new Set(), null, null, large);
    expect(folded).toContain('<option value="" selected="">폴더 고르기</option>');
    expect(folded.match(/<option[^>]* selected=""/g)).toHaveLength(1);
  });

  it('derives the selection from opened areas and clears it after manual changes', () => {
    const opened = fileViewOf('web/app', expandable);
    const html = render(opened, null, null, large);
    expect(html).toContain('<option value="folder:web/app" selected="">web/app · 파일 77개</option>');
    expect(html).not.toContain('data-testid="map-canvas"');
    expect(html.match(/aria-label="큰 폴더 파일 목록">(.*?)<\/section>/)![1].match(/<li>/g)).toHaveLength(77);
    for (const current of [new Set([...opened, 'folder:website']), new Set(['folder:web'])]) {
      expect(render(current, null, null, large)).toContain('<option value="" selected="">폴더 고르기</option>');
    }
  });
});

describe('big folder list view', () => {
  const source: ProjectMap = { ...map, files: [
    ...Array.from({ length: 31 }, (_, i) => file(`a${String(i).padStart(2, '0')}`, 'a')),
    ...Array.from({ length: 30 }, (_, i) => file(`b${i}`, 'b')),
    ...Array.from({ length: 21 }, (_, i) => file(`c${String(i).padStart(2, '0')}`, 'c')),
  ], edges: [
    ...Array.from({ length: 21 }, (_, i) => ({ ...map.edges[0], fromFileId: `c${String(i).padStart(2, '0')}`, toFileId: 'a00' })),
    { ...map.edges[0], fromFileId: 'a00', toFileId: 'b0' },
    { ...map.edges[0], fromFileId: 'a00', toFileId: 'b0', startUtf16: 3 },
    { ...map.edges[0], fromFileId: 'a01', toFileId: 'b0' },
  ] };
  const opened = fileViewOf('a', expandableIds(source));
  const list = (html: string) => html.match(/aria-label="큰 폴더 파일 목록">(.*?)<\/section>/)![1];
  const elements = () => vi.mocked(JSX.jsxDEV).mock.results
    .map(result => result.value as React.ReactElement<Record<string, unknown>>);
  const button = (label: string) => elements().filter(element => element.type === 'button' && element.props['aria-label'] === label).at(-1)!;

  it('keeps thirty direct files as boxes and shows thirty-one as a complete list with the new explanation', () => {
    const small = render(fileViewOf('b', expandableIds(source)), null, null, source);
    expect(small).toContain('data-testid="map-canvas"');
    expect(drawnNodes().filter(node => node.className?.includes('map-box--file'))).toHaveLength(30);
    vi.mocked(ReactFlow).mockClear();
    const html = render(opened, null, null, { ...source, files: source.files.toReversed() });
    expect(ReactFlow).not.toHaveBeenCalled();
    expect(html).not.toContain('data-testid="map-canvas"');
    expect(html).not.toContain('aria-label="상자별 연결"');
    expect(html).not.toContain('상자를 누르면 그 안을 한 단계');
    expect(html).not.toContain('폴더를 고르면 그 폴더의 파일을 상자로');
    expect(html).toContain('바로 아래 파일이 31개라 상자로 그리면 화살표가 엉켜요.');
    expect(html).toContain('파일을 고르면 그 파일과 바로 이어진 파일만 지도로 보여 줘요.');
    expect(list(html).match(/<li>/g)).toHaveLength(31);
    expect(list(html)).toContain('가져다 씀 1곳 · 이 파일을 가져다 씀 21곳');
    expect([...list(html).matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1]))
      .toEqual(source.files.filter(file => file.folder === 'a').map(file => file.relativePath));
    expect(html).toContain('aria-label="변경 목록"');
    expect(html).toContain('aria-label="폴더 사이 연결"');
  });

  it('stores the current opened object when a list button is clicked, including rows after three hundred', () => {
    const many = { ...source, files: Array.from({ length: 302 }, (_, i) => file(`f${String(i).padStart(3, '0')}`, 'a')), edges: [] };
    const html = render(opened, null, null, many);
    expect(list(html).match(/<li>/g)).toHaveLength(302);
    (button('a/f301.ts').props.onClick as () => void)();
    const setter = vi.mocked(ReactHooks.useState).mock.results[4].value[1];
    expect(setter).toHaveBeenCalledWith({ fileId: 'f301', opened });
    expect(setter.mock.calls[0][0].opened).toBe(opened);
    const chosen = render(opened, null, null, many, null, setter.mock.calls[0][0]);
    expect(chosen).toContain('data-testid="map-neighborhood"');
    expect(drawnNodes().map(node => node.id)).toEqual(['f301']);
    expect(list(chosen)).toContain('aria-label="a/f301.ts" aria-pressed="true"');
  });

  it('draws a tall neighbourhood, keeps full sorted neighbour text, and bypasses focus and hover', () => {
    const updated = { ...source, files: source.files.map(file => file.id === 'a00' ? { ...file, start: true, checked: 'partial' as const } : file) };
    const openFile = vi.fn();
    const html = render(opened, { id: 'a00', opened }, { id: 'b0', opened }, updated, null, { fileId: 'a00', opened }, openFile);
    expect(html).toContain('data-testid="map-neighborhood" style="height:3280px"');
    expect(html).not.toContain('aria-label="이어진 것만 보는 중"');
    expect(drawnNodes()).toHaveLength(22);
    expect(drawnEdges()).toHaveLength(21);
    expect(drawnNodes().every(node => node.data.onFocus === undefined && node.className === 'map-box map-box--file map-box--neighbor')).toBe(true);
    expect(drawnNodes().find(node => node.id === 'c00')?.ariaLabel).toBe('c/c00.ts');
    const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    expect(props.onNodeMouseEnter).toBeUndefined();
    expect(props.onNodeMouseLeave).toBeUndefined();
    expect(props.zoomOnScroll).toBe(false);
    expect(props.fitViewOptions?.padding).toBe(0.02);
    props.onNodeClick!({} as React.MouseEvent, drawnNodes().find(node => node.id === 'b0')!);
    expect(openFile).toHaveBeenCalledWith('b0');
    props.onEdgeClick!({} as React.MouseEvent, drawnEdges()[0]);
    const setSelected = vi.mocked(ReactHooks.useState).mock.results[1].value[1];
    const selected = setSelected.mock.calls[0][0] as MapArrow;
    expect(selected.id).toBe(drawnEdges()[0].id);
    expect(html).toContain('지도에는 &#x27;이 파일을 가져다 씀&#x27;을 20개까지만 그렸어요. 나머지 1개는 고른 상자 카드의 목록에 있어요.');
    expect(html).toContain(`이 파일을 가져다 씀 21곳: ${source.files.filter(file => file.folder === 'c').map(file => file.relativePath).join(', ')}`);
    expect(html).toContain('가져다 씀 1곳: b/b0.ts');
    expect(render(opened, null, null, source, selected, { fileId: 'a00', opened })).toContain('고른 화살표의 근거 · import 1개');
  });

  it('refits when another file is picked and omits the focus button while retaining all file tags', () => {
    const tagged = { ...source, files: [...source.files, { ...file('a', 'a'), start: true, checked: 'partial' as const }] };
    render(opened, null, null, tagged, null, { fileId: 'a', opened });
    const first = elements().filter(element => element.type === ReactFlow).at(-1)!;
    expect(first.key).toBe('a');
    const node = drawnNodes()[0];
    const NodeType = vi.mocked(ReactFlow).mock.calls.at(-1)![0].nodeTypes!.box;
    // The real node component renders the same labels and tags as the main map.
    const nodeHtml = renderToStaticMarkup(React.createElement(ReactFlowProvider, {
      children: React.createElement(NodeType, { ...node, data: node.data } as never),
    }));
    expect(nodeHtml).not.toContain('이어진 것만');
    expect(nodeHtml).toContain('시작점 후보');
    expect(nodeHtml).toContain('일부만 봄');
    expect(nodeHtml).toContain('수정');
    render(opened, null, null, tagged, null, { fileId: 'a01', opened });
    expect(elements().filter(element => element.type === ReactFlow).at(-1)!.key).toBe('a01');
    expect(drawnNodes().map(node => node.id)).toEqual(['a01', 'b0']);
  });

  it('invalidates a pick after changing folders, returning to A, folding and reopening, or removing the file', () => {
    const pick = { fileId: 'a00', opened };
    for (const current of [fileViewOf('b', expandableIds(source)), fileViewOf('a', expandableIds(source)), new Set<string>(), new Set(opened)]) {
      const html = render(current, null, null, source, null, pick);
      expect(html).not.toContain('data-testid="map-neighborhood"');
      expect(html).not.toContain('aria-label="a/a00.ts" aria-pressed="true"');
    }
    expect(render(opened, null, null, source, null, { fileId: 'missing', opened })).not.toContain('data-testid="map-neighborhood"');
  });

  it('lists every outgoing neighbour even when only twenty fit on the right', () => {
    const outgoing = { ...source, edges: source.files.filter(file => file.folder === 'b').toReversed()
      .map(file => ({ ...map.edges[0], fromFileId: 'a00', toFileId: file.id })) };
    const html = render(opened, null, null, outgoing, null, { fileId: 'a00', opened });
    expect(drawnNodes()).toHaveLength(21);
    expect(html).toContain('지도에는 &#x27;가져다 씀&#x27;을 20개까지만 그렸어요. 나머지 10개는 고른 상자 카드의 목록에 있어요.');
    expect(html).toContain(`가져다 씀 30곳: ${source.files.filter(file => file.folder === 'b').map(file => file.relativePath).sort((a, b) => a.localeCompare(b)).join(', ')}`);
    expect(html).toContain('이 파일을 가져다 씀 0곳: 없음');
  });

  it.each(['folder', 'files'])('normalizes a large %s box to its own file view when another folder is open', kind => {
    const grouped = { ...source, files: [...source.files, file('child', 'a/child')] };
    const input = kind === 'files' ? grouped : source;
    const previous = new Set(['folder:b', ...(kind === 'files' ? ['folder:a'] : [])]);
    render(previous, null, null, input);
    const flow = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    flow.onNodeClick!({} as React.MouseEvent, drawnNodes().find(node => node.id === `${kind}:a`)!);
    const next = vi.mocked(ReactHooks.useState).mock.results[0].value[1].mock.calls[0][0] as Set<string>;
    expect(next).toEqual(fileViewOf('a', expandableIds(input)));
    const html = render(next, null, null, input);
    expect(html).toContain('<option value="folder:a" selected="">a · 파일 31개</option>');
    expect(html).not.toContain('data-testid="map-canvas"');
    expect(list(html).match(/<li>/g)).toHaveLength(31);
  });
});

describe('project map focus', () => {
  it('keeps box positions and highlights only the chosen box and its neighbours', () => {
    const opened = new Set(['folder:web']);
    render(opened);
    const positions = drawnNodes().map(({ id, position }) => ({ id, position }));
    const html = render(opened, { id: 'folder:web/app', opened });
    expect(html).toContain('aria-label="이어진 것만 보는 중"');
    expect(html).toContain('‘web/app · 파일 1개’과 이어진 것만 보는 중 · 가져다 씀 1곳 · 이 상자를 가져다 씀 0곳');
    expect(drawnNodes().map(({ id, position }) => ({ id, position }))).toEqual(positions);
    expect(drawnNodes().filter(node => node.className?.includes('map-box--focus')).map(node => node.id)).toEqual(['folder:web/app']);
    expect(drawnNodes().filter(node => node.className?.includes('map-box--dim')).map(node => node.id).sort())
      .toEqual(['files:', 'files:web', 'folder:website']);
    expect(drawnNodes().find(node => node.id === 'folder:web/app')!.data.focused).toBe(true);
    expect(vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges?.map(edge => [edge.source, edge.target]))
      .toEqual([['folder:web/app', 'folder:web/lib']]);
    expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--strong'))).toBe(true);
  });

  it('explains a disconnected box while hiding every arrow', () => {
    const opened = new Set(['folder:web']);
    const html = render(opened, { id: 'files:web', opened });
    expect(html).toContain('지금 보이는 다른 상자와 이어진 import가 없어요.');
    expect(vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges).toEqual([]);
    expect(drawnNodes()).toHaveLength(5);
  });

  it('clears focus when the opened set changes, even if the same boxes are visible again', () => {
    const opened = new Set(['folder:web']);
    const focus = { id: 'folder:web/app', opened };
    for (const current of [new Set(['folder:web', 'folder:website']), new Set(['folder:web'])]) {
      const html = render(current, focus);
      expect(html).not.toContain('aria-label="이어진 것만 보는 중"');
      expect(drawnNodes().every(node => !node.data.focused && !/map-box--(?:dim|focus)/.test(node.className ?? ''))).toBe(true);
      expect(vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges).toHaveLength(1);
    }
  });

  it('ignores a chosen box missing from the visible graph', () => {
    const opened = new Set(['folder:web']);
    const html = render(opened, { id: 'folder:removed', opened });
    expect(html).not.toContain('aria-label="이어진 것만 보는 중"');
    expect(vi.mocked(ReactFlow).mock.calls.at(-1)![0].edges).toHaveLength(1);
  });
});

describe('project map arrow emphasis', () => {
  const opened = new Set(['folder:web']);
  const connected: ProjectMap = { ...map, files: [...map.files, file('e', 'web/e2e')], edges: [
    map.edges[0], { ...map.edges[0], startUtf16: 2 },
    { ...map.edges[0], fromFileId: 'b', toFileId: 'a' },
    { ...map.edges[0], fromFileId: 'e' }, { ...map.edges[0], fromFileId: 'e', startUtf16: 2 },
    { ...map.edges[0], toFileId: 'index' },
  ] };

  it('keeps every arrow faint without labels until a box is highlighted', () => {
    const html = render(opened, null, null, connected);
    expect(drawnEdges()).toHaveLength(4);
    expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--faint') && edge.label === undefined)).toBe(true);
    expect(drawnEdges().every(edge => edge.markerEnd === ARROW_MARKER && !edge.selected)).toBe(true);
    expect(drawnNodes().every(node => !/map-box--(?:dim|focus)/.test(node.className ?? ''))).toBe(true);
    expect(html).toContain('상자에 마우스를 올리면 그 상자의 화살표가 진해져요.');
  });

  it('emphasizes incoming and outgoing arrows, labels only grouped imports and preserves backward arrows', () => {
    render(opened, null, { id: 'folder:web/app', opened }, connected);
    expect(drawnEdges().filter(edge => edge.className?.includes('map-arrow--strong')).map(edge => [edge.source, edge.target, edge.label]))
      .toEqual([['folder:web/app', 'folder:web/lib', 'import 2개'], ['folder:web/lib', 'folder:web/app', undefined],
        ['folder:web/app', 'files:web', undefined]]);
    expect(drawnEdges().filter(edge => edge.className?.includes('map-arrow--faint')).map(edge => [edge.source, edge.label]))
      .toEqual([['folder:web/e2e', undefined]]);
    expect(drawnEdges().filter(edge => edge.className?.includes('map-arrow--back')).map(edge => edge.id))
      .toEqual(visibleGraph(connected, opened).arrows.filter(arrow => arrow.back).map(arrow => arrow.id));
    expect(drawnNodes().filter(node => node.className?.includes('map-box--dim')).map(node => node.id).sort())
      .toEqual(['files:', 'folder:web/e2e', 'folder:website']);
    expect(drawnNodes().every(node => !node.className?.includes('map-box--focus') && !node.data.focused)).toBe(true);
  });

  it('keeps focus filtering while another hovered box controls emphasis', () => {
    const focus = { id: 'folder:web/lib', opened };
    render(opened, focus, { id: 'folder:web/app', opened }, connected);
    expect(drawnEdges().map(edge => edge.id)).toEqual([
      'folder:web/app->folder:web/lib', 'folder:web/lib->folder:web/app', 'folder:web/e2e->folder:web/lib']);
    expect(drawnEdges().map(edge => edge.className?.includes('map-arrow--strong'))).toEqual([true, true, false]);
    expect(drawnNodes().filter(node => node.className?.includes('map-box--focus')).map(node => node.id)).toEqual(['folder:web/lib']);
    render(opened, focus, { id: 'folder:website', opened }, connected);
    expect(drawnEdges()).toHaveLength(3);
    expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--faint') && edge.label === undefined)).toBe(true);
    expect(drawnNodes().find(node => node.id === 'folder:website')!.className).not.toContain('map-box--dim');
  });

  it('ignores hover from an earlier opened set even when the same id reappears', () => {
    const hovered = { id: 'folder:web/app', opened };
    for (const current of [new Set(['folder:web', 'folder:website']), new Set(['folder:web'])]) {
      render(current, null, hovered, connected);
      expect(drawnEdges()).toHaveLength(4);
      expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--faint') && edge.label === undefined)).toBe(true);
      expect(drawnNodes().every(node => !/map-box--(?:dim|focus)/.test(node.className ?? ''))).toBe(true);
    }
  });

  it('ignores invisible hovered ids and falls back to focus for invisible or stale hover', () => {
    const invisible = { id: 'folder:removed', opened };
    render(opened, null, invisible, connected);
    expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--faint'))).toBe(true);
    expect(drawnNodes().every(node => !node.className?.includes('map-box--dim'))).toBe(true);
    for (const hovered of [invisible, { id: 'folder:website', opened: new Set(opened) }]) {
      render(opened, { id: 'folder:web/lib', opened }, hovered, connected);
      expect(drawnEdges()).toHaveLength(3);
      expect(drawnEdges().every(edge => edge.className?.includes('map-arrow--strong'))).toBe(true);
      expect(drawnNodes().filter(node => node.className?.includes('map-box--dim')).map(node => node.id).sort())
        .toEqual(['files:', 'files:web', 'folder:website']);
    }
  });

  it('keeps a selected arrow strong and labelled when hover moves away or ends', () => {
    const selected = visibleGraph(connected, opened).arrows.find(arrow => arrow.source === 'folder:web/e2e')!;
    for (const hovered of [{ id: 'folder:web/app', opened }, null]) {
      const html = render(opened, null, hovered, connected, selected);
      expect(drawnEdges().find(edge => edge.id === selected.id)).toMatchObject({
        selected: true, className: 'map-arrow map-arrow--strong', label: 'import 2개', markerEnd: ARROW_MARKER,
      });
      expect(html).toContain('고른 화살표의 근거 · import 2개');
    }
  });

  it('stores the current opened set on enter and clears hover on leave', () => {
    render(opened);
    const flow = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    const setHovered = vi.mocked(ReactHooks.useState).mock.results[3].value[1];
    flow.onNodeMouseEnter!({} as React.MouseEvent, drawnNodes()[0]);
    expect(setHovered).toHaveBeenLastCalledWith({ id: drawnNodes()[0].id, opened });
    expect(setHovered.mock.calls[0][0].opened).toBe(opened);
    flow.onNodeMouseLeave!({} as React.MouseEvent, drawnNodes()[0]);
    expect(setHovered).toHaveBeenLastCalledWith(null);
  });

  it('leaves other canvases without hover handlers', () => {
    renderToStaticMarkup(React.createElement(MapCanvas, { testId: 'other-map', nodes: [], edges: [], onNodeClick() {} }));
    const flow = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    expect(flow.onNodeMouseEnter).toBeUndefined();
    expect(flow.onNodeMouseLeave).toBeUndefined();
  });
});

describe('connections listed by visible box', () => {
  const opened = new Set(['folder:web']);
  // Direction labels are bold; the text checks below read them without the tags.
  const connectionSection = (html: string) => html.match(/<section class="card" aria-label="상자별 연결">(.*?)<\/section>/)![1].replace(/<\/?b>/g, '');
  const rows = (html: string) => [...connectionSection(html).matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1]);

  it('lists deeper areas first and boxes in canvas order within each area, with only nonzero directions', () => {
    const html = render(opened);
    const list = connectionSection(html);
    expect(list).toContain('상자별 연결 · 상자 5개');
    expect(list).toContain('지금 지도에 보이는 상자끼리의 import예요. 펼치거나 접으면 함께 바뀌어요.');
    expect(html.indexOf('aria-label="상자별 연결"')).toBeLessThan(html.indexOf('aria-label="변경 목록"'));
    const boxes = visibleGraph(map, opened).boxes;
    const grouped = [...boxes.filter(box => boxPlace(box).area === 'web'), ...boxes.filter(box => boxPlace(box).area === '')];
    expect([...list.matchAll(/<h4>(.*?)<\/h4>/g)].map(match => match[1]))
      .toEqual(['web 안 · 상자 3개', '(최상위 폴더) 안 · 상자 2개']);
    expect(rows(html).map(row => row.match(/<button[^>]*>(.*?)<\/button>/)![1]))
      .toEqual(grouped.map(box => boxPlace(box).short));
    expect(rows(html).map(row => row.match(/aria-label="([^"]*)"/)![1])).toEqual(grouped.map(boxName));
    const app = rows(html).find(row => row.includes('aria-label="web/app"'))!;
    expect(app).toContain('가져다 씀 1곳: lib/');
    expect(app).not.toContain('이 상자를 가져다 씀');
    const lib = rows(html).find(row => row.includes('aria-label="web/lib"'))!;
    expect(lib).toContain('이 상자를 가져다 씀 1곳: app/');
    expect(lib).not.toContain('가져다 씀 0곳');
    expect(list).not.toContain('(import 1개)');
    // A box that both uses and is used shows the two directions on separate lines.
    const both = render(opened, null, null, { ...map, edges: [...map.edges, { ...map.edges[0], fromFileId: 'b', toFileId: 'a', startUtf16: 5 }] });
    expect(rows(both).find(row => row.includes('aria-label="web/lib"'))!.match(/class="map-connections__line"/g)).toHaveLength(2);
    expect(rows(html).find(row => row.includes('aria-label="web 바로 아래 파일"')))
      .toContain('지금 보이는 다른 상자와 이어진 import가 없어요.');
  });

  it('keeps all rows and connections when focus hides arrows, and reflects the selected button', () => {
    const html = render(opened, { id: 'files:web', opened });
    expect(drawnEdges()).toEqual([]);
    expect(rows(html)).toHaveLength(5);
    expect(connectionSection(html)).toContain('가져다 씀 1곳: lib/');
    expect(connectionSection(html)).toContain('aria-label="web 바로 아래 파일" aria-pressed="true">바로 아래 파일</button>');
    expect(connectionSection(html)).toContain('aria-label="web/app" aria-pressed="false">app/</button>');
  });

  it('shows all eleven neighbours in name order in both directions, with grouped import counts', () => {
    const neighbours = Array.from({ length: 11 }, (_, index) => file(`n${index}`, `part${String(index).padStart(2, '0')}`));
    const many: ProjectMap = { ...map, files: [file('center', 'center'), ...neighbours], edges: [
      ...[...neighbours].reverse().map(file => ({ ...map.edges[0], fromFileId: 'center', toFileId: file.id })),
      ...[...neighbours].reverse().map(file => ({ ...map.edges[0], fromFileId: file.id, toFileId: 'center' })),
      { ...map.edges[0], fromFileId: 'center', toFileId: 'n0', startUtf16: 2 },
      { ...map.edges[0], fromFileId: 'n0', toFileId: 'center', startUtf16: 2 },
    ] };
    const html = render(new Set(), null, null, many);
    const center = rows(html).find(row => row.includes('aria-label="center"'))!;
    const names = neighbours.map((file, index) => `${file.folder}/${index === 0 ? '(import 2개)' : ''}`).join(', ');
    expect(center).toContain(`가져다 씀 11곳: ${names}`);
    expect(center).toContain(`이 상자를 가져다 씀 11곳: ${names}`);
    expect(center).not.toContain('(import 1개)');
    expect(center).not.toContain('생략');
  });

  it('shows file basenames with full accessible names and qualifies neighbours in other areas', () => {
    const sameNames = { ...map, files: [
      { ...file('a', 'web/app'), relativePath: 'web/app/index.ts' },
      { ...file('b', 'web/lib'), relativePath: 'web/lib/index.ts' },
    ] };
    const folded = connectionSection(render(new Set(), null, null, sameNames));
    expect(folded).toContain('상자별 연결 · 상자 1개');
    expect(folded).toContain('>web/</button>');
    const expanded = connectionSection(render(expandableIds(sameNames), null, null, sameNames));
    expect(expanded).toContain('상자별 연결 · 상자 2개');
    expect(expanded).toContain('<h4>web/app 안 · 상자 1개</h4>');
    expect(expanded).toContain('<h4>web/lib 안 · 상자 1개</h4>');
    expect(expanded.indexOf('<h4>web/app 안')).toBeLessThan(expanded.indexOf('<h4>web/lib 안'));
    expect(expanded).toContain('aria-label="web/app/index.ts" aria-pressed="false">index.ts</button>');
    expect(expanded).toContain('aria-label="web/lib/index.ts" aria-pressed="false">index.ts</button>');
    expect(expanded).toContain('가져다 씀 1곳: index.ts(web/lib 안)');
    expect(expanded).toContain('이 상자를 가져다 씀 1곳: index.ts(web/app 안)');
  });

  it('distinguishes same-named neighbours inside the current area and at the root', () => {
    const nested = { ...map, files: [file('x', 'api/src/x'), file('inner', 'api/src/test'), file('outer', 'test')],
      edges: ['inner', 'outer'].map(toFileId => ({ ...map.edges[0], fromFileId: 'x', toFileId })) };
    const html = render(new Set(['folder:api', 'folder:api/src']), null, null, nested);
    const x = rows(html).find(row => row.includes('aria-label="api/src/x"'))!;
    expect(x).toContain('가져다 씀 2곳: test/, test/(최상위)');
    expect(rows(html).find(row => row.includes('aria-label="test"')))
      .toContain('이 상자를 가져다 씀 1곳: x/(api/src 안)');
  });

  it.each([1, 2])('groups repeated folder names by area and qualifies %i imports in one pair of parentheses', count => {
    const nested = { ...map, files: [file('x', 'api/src/x'), file('inner', 'api/src/test'), file('outer', 'api/test'), file('page', 'web')],
      edges: Array.from({ length: count }, (_, startUtf16) => ({ ...map.edges[0], fromFileId: 'x', toFileId: 'outer', startUtf16 })) };
    const opened = new Set(['folder:api', 'folder:api/src']);
    const html = render(opened, null, null, nested);
    const list = connectionSection(html);
    expect([...list.matchAll(/<h4>(.*?)<\/h4>/g)].map(match => match[1]))
      .toEqual(['api/src 안 · 상자 2개', 'api 안 · 상자 1개', '(최상위 폴더) 안 · 상자 1개']);
    for (const name of ['api/src/test', 'api/test']) {
      expect(rows(html).find(row => row.includes(`aria-label="${name}"`))).toContain('>test/</button>');
    }
    expect(rows(html).find(row => row.includes('aria-label="api/src/x"')))
      .toContain(`가져다 씀 1곳: test/(api 안${count > 1 ? ', import 2개' : ''})`);
    expect(rows(html).find(row => row.includes('aria-label="api/test"')))
      .toContain(`이 상자를 가져다 씀 1곳: x/(api/src 안${count > 1 ? ', import 2개' : ''})`);
    expect(rows(html).map(row => row.match(/aria-label="([^"]*)"/)![1]))
      .toEqual(['api/src/x', 'api/src/test', 'api/test', 'web']);
  });

  it('distinguishes a folder named like a direct-file group and qualifies the root group', () => {
    const nested = { ...map, files: [file('main', 'api/src'), file('child', 'api/src/바로 아래 파일'), file('root', '')],
      edges: [{ ...map.edges[0], fromFileId: 'child', toFileId: 'main' }, { ...map.edges[0], fromFileId: 'main', toFileId: 'root' }] };
    const html = render(new Set(['folder:api', 'folder:api/src']), null, null, nested);
    expect(connectionSection(html)).toContain('<h4>api/src 안 · 상자 2개</h4>');
    const group = rows(html).find(row => row.includes('aria-label="api/src 바로 아래 파일"'))!;
    const folder = rows(html).find(row => row.includes('aria-label="api/src/바로 아래 파일"'))!;
    expect(group).toContain('>바로 아래 파일</button>');
    expect(folder).toContain('>바로 아래 파일/</button>');
    expect(group).toContain('이 상자를 가져다 씀 1곳: 바로 아래 파일/');
    expect(folder).toContain('가져다 씀 1곳: 바로 아래 파일');
    expect(group).toContain('가져다 씀 1곳: 바로 아래 파일(최상위)');
  });

  it('limits rows before grouping even when the omitted box is in a deeper area', () => {
    const files = [...Array.from({ length: 300 }, (_, index) => file(`f${String(index).padStart(3, '0')}`, '')), file('last', 'z/deep')];
    const large = { ...map, files, edges: [] };
    const html = render(expandableIds(large), null, null, large);
    expect(rows(html)).toHaveLength(300);
    expect(connectionSection(html)).toContain('<h4>(최상위 폴더) 안 · 상자 300개</h4>');
    expect(connectionSection(html)).not.toContain('<h4>z/deep 안');
    expect(connectionSection(html)).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
    expect(rows(html).map(row => row.match(/aria-label="([^"]*)"/)![1]))
      .toEqual(visibleGraph(large, expandableIds(large)).boxes.slice(0, 300).map(boxName));
  });

  it('limits rows to 300 while counting all boxes and retaining neighbours beyond the row limit', () => {
    const files = Array.from({ length: 301 }, (_, index) =>
      file(`f${String(index).padStart(3, '0')}`, `d${String(Math.floor(index / 30)).padStart(2, '0')}`));
    const large = { ...map, files, edges: [{ ...map.edges[0], fromFileId: 'f000', toFileId: 'f300' }] };
    const html = render(expandableIds(large), null, null, large);
    const list = connectionSection(html);
    expect(list).toContain('상자별 연결 · 상자 301개');
    expect(rows(html)).toHaveLength(300);
    expect(rows(html).map(row => row.match(/aria-label="([^"]*)"/)![1]))
      .toEqual(visibleGraph(large, expandableIds(large)).boxes.slice(0, 300).map(boxName));
    expect(list).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
    expect(list).toContain('가져다 씀 1곳: f300.ts');
    expect(list).not.toContain('>f300.ts</button>');
  });
});

describe('import cycles card', () => {
  const section = (html: string) => html.match(/<section class="card" aria-label="서로 가져다 쓰는 파일 묶음">(.*?)<\/section>/)![1];
  const cycleMap = { ...map, edges: [...map.edges, { ...map.edges[0], fromFileId: 'b', toFileId: 'a',
    startLine: 3, startUtf16: 20, text: "import './a'" }] };

  it.each([false, true])('shows evidence and file actions before unused files with locked=%s', locked => {
    const onOpenFile = vi.fn();
    const onShowImport = vi.fn();
    const html = renderToStaticMarkup(React.createElement(ProjectMapView, { project, entry: { map: cycleMap, revision: 0, build: 1 },
      stale: false, mapping: false, locked, changes: null, onBuild() {}, onCancel() {}, onOpenFile, onShowImport,
      onShowFunction() {}, onShowChange() {} }));
    const card = section(html);
    expect(html).toContain('aria-label="서로 가져다 쓰는 파일 묶음 1개"');
    expect(card).toContain('id="map-import-cycles" tabindex="-1">서로 가져다 쓰는 파일 묶음 · 1개');
    expect(card).toContain('파일 2개 · import 2개');
    expect(card).toContain('<details><summary>묶음 안 import 2개</summary>');
    expect(card).toContain('web/app/a.ts 1행 → web/lib/b.ts');
    expect(card).toContain('web/lib/b.ts 3행 → web/app/a.ts');
    expect(card).toContain('<code>import &#x27;./a&#x27;</code>');
    expect(card).toContain('타입만 가져오는 import도 세기 때문에, 실행할 때 문제가 생긴다는 뜻은 아니에요.');
    const cardEnd = html.indexOf('</section>', html.indexOf('aria-label="서로 가져다 쓰는 파일 묶음"')) + '</section>'.length;
    expect(html.slice(cardEnd)).toMatch(/^<section class="card" aria-label="아무도 가져다 쓰지 않는 파일 후보">/);
    expect(card.match(/<button /g)).toHaveLength(4);
    expect(card.match(/disabled=""/g) ?? []).toHaveLength(locked ? 4 : 0);
    const buttons = vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<Record<string, unknown>>)
      .filter(element => element.type === 'button');
    for (const file of cycleMap.files.slice(0, 2)) {
      const button = buttons.find(element => element.props.children === file.relativePath)!;
      expect(button.props.disabled).toBe(locked);
      if (!locked) (button.props.onClick as () => void)();
    }
    const evidenceButtons = buttons.filter(element => element.props.children === '코드 보기').slice(0, 2);
    for (const button of evidenceButtons) {
      expect(button.props.disabled).toBe(locked);
      if (!locked) (button.props.onClick as () => void)();
    }
    expect(onOpenFile.mock.calls).toEqual(locked ? [] : [['a'], ['b']]);
    expect(onShowImport.mock.calls).toEqual(locked ? [] : cycleMap.edges.map(item => [item]));
  });

  it('shows the empty state without a group list', () => {
    const card = section(render());
    expect(card).toContain('서로 가져다 쓰는 파일 묶음 · 0개');
    expect(card).toContain('<p class="hint">돌고 도는 import가 없어요.</p>');
    expect(card).not.toContain('<ul');
  });

  it('caps the number of groups at 300 and reports omitted groups', () => {
    const files = Array.from({ length: 301 }, (_, index) => file(String(index).padStart(3, '0'), ''));
    const source = { ...map, files, edges: files.map(file => ({ ...map.edges[0], fromFileId: file.id, toFileId: file.id })) };
    const card = section(render(new Set(), null, null, source));
    expect(card).toContain('서로 가져다 쓰는 파일 묶음 · 301개');
    expect(card.match(/<summary>/g)).toHaveLength(300);
    expect(card).not.toContain('300.ts');
    expect(card).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
  });

  it('caps each group file and import list at 300 and keeps full counts', () => {
    const files = Array.from({ length: 301 }, (_, index) => file(String(index).padStart(3, '0'), ''));
    const source = { ...map, files, edges: files.map((file, index) => ({ ...map.edges[0],
      fromFileId: file.id, toFileId: files[(index + 1) % files.length].id })) };
    const card = section(render(new Set(), null, null, source));
    expect(card).toContain('파일 301개 · import 301개');
    expect(card).toContain('묶음 안 import 301개');
    expect(card.match(/class="btn btn--small path"/g)).toHaveLength(300);
    expect(card).not.toContain('>300.ts</button>');
    expect(card.match(/>코드 보기<\/button>/g)).toHaveLength(300);
    expect(card).not.toContain('300.ts 1행');
    expect(card.match(/처음 300개만 보여요. 나머지 1개는 생략했어요./g)).toHaveLength(2);
  });
});

describe('unused file candidates card', () => {
  const section = (html: string) => html.match(/<section class="card" aria-label="아무도 가져다 쓰지 않는 파일 후보">(.*?)<\/section>/)![1];

  it('labels files referenced by config and HTML after script exclusions', () => {
    const card = section(render(new Set(), null, null, { ...map, unused: {
      exports: { candidates: [], unsure: [], notes: [] },
      candidates: [], unsure: [], notes: [], excluded: [{ kind: 'script', count: 2 }, { kind: 'reference', count: 1 }],
    } }));
    expect(card).toContain('뺀 파일: 실행 명령에 적힌 파일 2 · 설정·HTML에 적힌 파일 1');
  });

  it('shows candidates, collapsed uncertainty, exclusion counts and notes before complex functions', () => {
    const html = render(new Set(), null, null, { ...map, unused: {
      exports: { candidates: [], unsure: [], notes: [] },
      candidates: [{ fileId: 'orphan', relativePath: 'lib/orphan.ts' }],
      unsure: [{ fileId: 'lazy', relativePath: 'lib/lazy.ts', reason: '동적 import(또는 require)로 쓰일 수 있어요.' }],
      excluded: [{ kind: 'start', count: 3 }, { kind: 'test', count: 12 }, { kind: 'config', count: 5 },
        { kind: 'types', count: 2 }, { kind: 'framework', count: 9 }, { kind: 'script', count: 1 }],
      notes: ['끝까지 읽지 못한 파일 1개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.'],
    } });
    const card = section(html);
    expect(card).toContain('아무도 가져다 쓰지 않는 파일 후보 · 1개');
    expect(card).toContain('지우기 전에 직접 확인해 주세요.');
    expect(card).toContain('<button class="btn btn--small path">lib/orphan.ts</button>');
    expect(card).toContain('<details><summary>확인 못 함 · 1개</summary>');
    expect(card).toContain('<button class="btn btn--small path">lib/lazy.ts</button> · 동적 import(또는 require)로 쓰일 수 있어요.');
    expect(card).toContain('뺀 파일: 시작 파일(main·bin·index 등) 3 · 시험 파일 12 · 설정 파일 5 · 타입 선언 2 · 프레임워크가 부르는 파일 9 · 실행 명령에 적힌 파일 1');
    expect(card).toContain('<p class="hint">끝까지 읽지 못한 파일 1개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.</p>');
    expect(html.indexOf('aria-label="아무도 가져다 쓰지 않는 파일 후보"')).toBeLessThan(html.indexOf('aria-label="어려운 코드 살펴볼 곳"'));
  });

  it('shows the empty message and hides empty uncertainty and exclusions', () => {
    const card = section(render());
    expect(card).toContain('아무도 가져다 쓰지 않는 파일 후보 · 0개');
    expect(card).toContain('후보가 없어요.');
    expect(card).not.toContain('<details>');
    expect(card).not.toContain('뺀 파일:');
  });

  it('caps both lists at 300 rows and reports omitted entries', () => {
    const entries = Array.from({ length: 301 }, (_, i) => ({ fileId: `id${i}`, relativePath: `file${i}.ts` }));
    const card = section(render(new Set(), null, null, { ...map, unused: {
      exports: { candidates: [], unsure: [], notes: [] },
      candidates: entries, unsure: entries.map(file => ({ ...file, reason: '확인 못 함' })), excluded: [], notes: [],
    } }));
    expect(card).toContain('후보 · 301개');
    expect(card).toContain('확인 못 함 · 301개');
    expect(card.match(/<button /g)).toHaveLength(600);
    expect(card).not.toContain('file300.ts');
    expect(card.match(/처음 300개만 보여요. 나머지 1개는 생략했어요./g)).toHaveLength(2);
  });
});

describe('unused exports card', () => {
  const section = (html: string) => html.match(/<section class="card" aria-label="다른 파일이 가져다 쓰지 않는 export 후보">(.*?)<\/section>/)![1];
  const candidate = { fileId: 'a', fileHash: 'h', relativePath: 'web/app/a.ts', name: 'default', displayName: 'default (Named)',
    kind: 'function' as const, startUtf16: 10, endUtf16: 20, startLine: 2, endLine: 3, usedInFile: true };

  it('renders count, kinds, local-use tag, collapsed uncertainty and notes immediately after unused files', () => {
    const html = render(new Set(), null, null, { ...map, unused: { ...map.unused, exports: {
      candidates: [candidate, { ...candidate, name: 'Class', displayName: 'Class', kind: 'class', usedInFile: false },
        { ...candidate, name: 'value', displayName: 'value', kind: 'value', usedInFile: false }],
      unsure: [{ fileId: 'b', relativePath: 'web/lib/b.ts', reason: '경로 별칭으로 쓰일 수 있어요.', count: 4 }], notes: ['export 이름만 비교했어요.'],
    } } });
    const card = section(html);
    expect(card).toContain('다른 파일이 가져다 쓰지 않는 export 후보 · 3개');
    expect(card).toContain('default (Named) · 함수 · web/app/a.ts:2');
    expect(card).toContain('Class · 클래스 · web/app/a.ts:2');
    expect(card).toContain('value · 값 · web/app/a.ts:2');
    expect(card.match(/파일 안에서는 씀/g)).toHaveLength(1);
    expect(card).toContain('<details><summary>확인 못 함 · 1개 파일</summary>');
    expect(card).toContain('web/lib/b.ts</button> · 경로 별칭으로 쓰일 수 있어요. · export 4개');
    expect(card).toContain('<p class="hint">export 이름만 비교했어요.</p>');
    const fileCardEnd = html.indexOf('</section>', html.indexOf('aria-label="아무도 가져다 쓰지 않는 파일 후보"')) + '</section>'.length;
    expect(html.slice(fileCardEnd)).toMatch(/^<section class="card" aria-label="다른 파일이 가져다 쓰지 않는 export 후보">/);
    expect(html.indexOf('aria-label="다른 파일이 가져다 쓰지 않는 export 후보"')).toBeLessThan(html.indexOf('aria-label="어려운 코드 살펴볼 곳"'));
  });

  it('renders the empty message without empty details', () => {
    const card = section(render());
    expect(card).toContain('다른 파일이 가져다 쓰지 않는 export 후보 · 0개');
    expect(card).toContain('후보가 없어요.');
    expect(card).not.toContain('<details>');
  });

  it('limits candidates and uncertain files to 300 rows each', () => {
    const entries = Array.from({ length: 301 }, (_, i) => ({ ...candidate, fileId: `f${i}`, relativePath: `file${i}.ts` }));
    const card = section(render(new Set(), null, null, { ...map, unused: { ...map.unused, exports: {
      candidates: entries, unsure: entries.map(item => ({ fileId: item.fileId, relativePath: item.relativePath, count: 1, reason: '확인 못 함' })), notes: [],
    } } }));
    expect(card).toContain('후보 · 301개');
    expect(card).toContain('확인 못 함 · 301개 파일');
    expect(card.match(/<button /g)).toHaveLength(600);
    expect(card).not.toContain('file300.ts');
    expect(card.match(/처음 300개만 보여요. 나머지 1개는 생략했어요./g)).toHaveLength(2);
  });
});

it.each([undefined, 0.02])('fits again with the initial options (padding %s) only when the measured width changes', fitPadding => {
  renderToStaticMarkup(React.createElement(MapCanvas, { testId: 'resize-map', nodes: [], edges: [], fitPadding, onNodeClick() {} }));
  const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
  expect(props.fitView).toBe(true);
  expect(props.fitViewOptions).toEqual(fitPadding === undefined ? { minZoom: 0.1, maxZoom: 1 } : { minZoom: 0.1, maxZoom: 1, padding: 0.02 });
  const refit = React.Children.toArray(props.children).find(child => React.isValidElement(child) && child.type === FitOnWidthChange);
  expect(React.isValidElement(refit) && (refit.props as { options: unknown }).options).toBe(props.fitViewOptions);

  const fitView = vi.fn();
  const previous = { current: null as number | null };
  vi.mocked(useReactFlow).mockReturnValue({ fitView } as unknown as ReturnType<typeof useReactFlow>);
  const renderAt = (width: number) => {
    vi.mocked(useStore).mockImplementationOnce(selector => (selector as (state: { width: number }) => number)({ width }));
    vi.mocked(ReactHooks.useRef).mockImplementationOnce(() => previous);
    vi.mocked(ReactHooks.useEffect).mockImplementationOnce(callback => { callback(); });
    renderToStaticMarkup(React.createElement(FitOnWidthChange, { options: props.fitViewOptions! }));
  };
  renderAt(0);
  renderAt(1200);
  renderAt(1200);
  expect(fitView).not.toHaveBeenCalled();
  renderAt(900);
  expect(fitView).toHaveBeenCalledExactlyOnceWith(props.fitViewOptions);
  renderAt(900);
  renderAt(1200);
  expect(fitView).toHaveBeenCalledTimes(2);
});

it('uses a 24px line grid on the shared canvas', () => {
  renderToStaticMarkup(React.createElement(MapCanvas, { testId: 'grid-map', nodes: [], edges: [], onNodeClick() {} }));
  const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
  const background = React.Children.toArray(props.children).find(child => React.isValidElement(child) && child.type === Background);
  expect(background).toBeDefined();
  expect((background as React.ReactElement<React.ComponentProps<typeof Background>>).props).toMatchObject({ variant: BackgroundVariant.Lines, gap: 24 });
});


describe('file map side cards', () => {
  const pickedCard = (html: string) => html.match(/aria-label="고른 상자">(.*?)<\/section>/)![1];

  it('shows guidance without a selection and drops stale selections after folding', () => {
    const opened = new Set(['folder:web']);
    for (const html of [render(), render(new Set(), { id: 'folder:web/app', opened })]) {
      expect(pickedCard(html)).toContain('상자의 ‘이어진 것만’을 누르면 그 상자의 연결이 여기에 보여요.');
      expect(pickedCard(html)).not.toContain('이어진 것만 보는 중');
      expect(pickedCard(html)).not.toContain('안의 파일 펼치기');
    }
  });

  it.each(['folder:web/app', 'folder:web/lib'])('shows the same names and nonempty connection lines for %s', id => {
    const opened = new Set(['folder:web']);
    const html = render(opened, { id, opened });
    const card = pickedCard(html);
    expect(card).toContain(`class="map-picked__name">${id.slice(7)}</p>`);
    expect(card).toContain('aria-label="이어진 것만 보는 중"');
    expect(card).toContain('모두 보기');
    expect(card).toContain('안의 파일 펼치기');
    expect(card).toContain(id.endsWith('app') ? '가져다 씀 1곳: lib/' : '이 상자를 가져다 씀 1곳: app/');
    expect(card).not.toMatch(/0곳:/);
    const expand = vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<Record<string, unknown>>)
      .find(element => element.type === 'button' && element.props.children === '안의 파일 펼치기')!;
    (expand.props.onClick as () => void)();
    const setOpened = vi.mocked(ReactHooks.useState).mock.results[0].value[1];
    expect(setOpened).toHaveBeenCalledWith(new Set(['folder:web', id]));
  });

  it('keeps selected file paths and both list-mode connection lines inside the side card', () => {
    const source = { ...map, files: [...map.files, ...Array.from({ length: 80 }, (_, i) => file(`extra${i}`, 'web/app'))] };
    const opened = fileViewOf('web/app', expandableIds(source));
    const card = pickedCard(render(opened, null, null, source, null, { fileId: 'a', opened }));
    expect(card).toContain('class="map-picked__path">web/app/a.ts</p>');
    expect(card).toContain('<div class="map-connections">');
    expect(card).toContain('이 파일을 가져다 씀 0곳: 없음');
    expect(card).toContain('가져다 씀 1곳: web/lib/b.ts');
    expect(card).not.toContain('안의 파일 펼치기');
  });

  it('routes side-card folder opening through the big-folder selection rule', () => {
    const source = { ...map, files: [...map.files, ...Array.from({ length: 80 }, (_, i) => file(`extra${i}`, 'web/app'))] };
    const opened = new Set(['folder:web']);
    render(opened, { id: 'folder:web/app', opened }, null, source);
    const expand = vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<Record<string, unknown>>)
      .find(element => element.type === 'button' && element.props.children === '안의 파일 펼치기')!;
    (expand.props.onClick as () => void)();
    expect(vi.mocked(ReactHooks.useState).mock.results[0].value[1]).toHaveBeenCalledWith(fileViewOf('web/app', expandableIds(source)));
  });

  it.each([0, 1])('keeps all review counts and focus targets, including %i candidates', count => {
    const source = { ...map, unused: { ...map.unused, candidates: count ? [{ fileId: 'a', relativePath: 'web/app/a.ts' }] : [] } };
    const html = render(new Set(), null, null, source);
    expect(html).toContain(`aria-label="아무도 가져다 쓰지 않는 파일 후보 ${count}개"`);
    expect(html).toContain(`id="map-unused-files" tabindex="-1">아무도 가져다 쓰지 않는 파일 후보 · ${count}개`);
    for (const [label, id] of [
      ['서로 가져다 쓰는 파일 묶음', 'map-import-cycles'],
      ['다른 파일이 가져다 쓰지 않는 export 후보', 'map-unused-exports'],
      ['어려운 코드 살펴볼 곳', 'map-complex-functions'], ['확인 못 한 import', 'map-unresolved'],
    ]) {
      expect(html).toContain(`aria-label="${label} 0개"`);
      expect(html).toContain(`id="${id}" tabindex="-1"`);
    }
  });

  it('opens review details before scrolling and focusing, and tolerates a missing target', () => {
    render();
    const button = vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<Record<string, unknown>>)
      .find(element => element.type === 'button' && element.props['aria-label'] === '확인 못 한 import 0개')!;
    const details = { open: false };
    const heading = { closest: vi.fn(() => details), scrollIntoView: vi.fn(() => expect(details.open).toBe(true)), focus: vi.fn() };
    const getElementById = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(heading);
    vi.stubGlobal('document', { getElementById });
    try {
      const onClick = button.props.onClick as () => void;
      expect(onClick).not.toThrow();
      expect(heading.scrollIntoView).not.toHaveBeenCalled();
      onClick();
      expect(getElementById).toHaveBeenCalledWith('map-unresolved');
      expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
      expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('splits folder labels visually while preserving their exact text and compact change tags', () => {
    render(new Set(['folder:web']));
    const props = vi.mocked(ReactFlow).mock.calls.at(-1)![0];
    const NodeType = props.nodeTypes!.box;
    for (const node of props.nodes!.filter(node => (node.data.box as { kind: string }).kind === 'folder')) {
      const box = node.data.box as { label: string };
      const html = renderToStaticMarkup(React.createElement(ReactFlowProvider, {
        children: React.createElement(NodeType, { ...node, data: node.data } as never),
      }));
      const label = html.match(/<b>(.*?)<\/b>/)![1];
      expect(label.replace(/<[^>]+>/g, '')).toBe(box.label);
      expect(label).toContain('class="map-box__name"');
      expect(label).toContain('class="visually-hidden"> · </span>');
      expect(label).toContain('class="map-box__count"');
      expect(html).toContain('class="map-box__tags"');
      expect(html).toContain('바뀐 파일');
    }
  });
});
