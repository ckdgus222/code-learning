import React from 'react';
import * as ReactHooks from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlow, type Edge, type Node } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARROW_MARKER, MapCanvas, ProjectMapView, type MapChanges } from '../src/renderer/project-map';
import { boxName, boxPlace, expandableIds, visibleGraph, type MapArrow } from '../src/renderer/map-layout';
import type { MapFile, ProjectMap, ProjectView } from '../src/shared/contracts';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, ReactFlow: vi.fn(() => null) };
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
  hovered: { id: string; opened: ReadonlySet<string> } | null = null, source = map, selected: MapArrow | null = null) {
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [opened, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [selected, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [focus, vi.fn()]);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [hovered, vi.fn()]);
  return renderToStaticMarkup(React.createElement(ProjectMapView, { project, entry: { map: source, revision: 0, build: 1 },
    stale: false, mapping: false, locked: false, changes,
    onBuild() {}, onCancel() {}, onOpenFile() {}, onShowImport() {}, onShowFunction() {}, onShowChange() {} }));
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
    const files = Array.from({ length: 301 }, (_, index) => file(`f${String(index).padStart(3, '0')}`, ''));
    const large = { ...map, files, edges: [{ ...map.edges[0], fromFileId: 'f000', toFileId: 'f300' }] };
    const html = render(expandableIds(large), null, null, large);
    const list = connectionSection(html);
    expect(list).toContain('상자별 연결 · 상자 301개');
    expect(rows(html)).toHaveLength(300);
    expect(rows(html).map(row => row.match(/<button[^>]*>(.*?)<\/button>/)![1]))
      .toEqual(visibleGraph(large, expandableIds(large)).boxes.slice(0, 300).map(boxName));
    expect(list).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
    expect(list).toContain('가져다 씀 1곳: f300.ts');
    expect(list).not.toContain('>f300.ts</button>');
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
