import React from 'react';
import * as ReactHooks from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlow, type Edge, type Node } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARROW_MARKER, MapCanvas, ProjectMapView, type MapChanges } from '../src/renderer/project-map';
import { boxName, expandableIds, visibleGraph, type MapArrow } from '../src/renderer/map-layout';
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
  start: false, checked: 'full', reason: null });
const map: ProjectMap = { projectId: 'p', files: [file('a', 'web/app'), file('b', 'web/lib'), file('index', 'web'), file('root', ''), file('sibling', 'website')],
  edges: [{ fromFileId: 'a', toFileId: 'b', fileHash: 'h', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'import', specifier: '../lib/b' }],
  unresolved: [], external: [], complexFunctions: [], limited: false, notes: [] };
const project: ProjectView = { id: 'p', name: 'project', files: [], excluded: {}, warnings: [],
  overview: { intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } };
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

  it('lists boxes in canvas order before changes, with only nonzero directions', () => {
    const html = render(opened);
    const list = connectionSection(html);
    expect(list).toContain('상자별 연결 · 상자 5개');
    expect(list).toContain('지금 지도에 보이는 상자끼리의 import예요. 펼치거나 접으면 함께 바뀌어요.');
    expect(html.indexOf('aria-label="상자별 연결"')).toBeLessThan(html.indexOf('aria-label="변경 목록"'));
    expect(rows(html).map(row => row.match(/<button[^>]*>(.*?)<\/button>/)![1]))
      .toEqual(visibleGraph(map, opened).boxes.map(boxName));
    const app = rows(html).find(row => row.includes('>web/app</button>'))!;
    expect(app).toContain('가져다 씀 1곳: web/lib');
    expect(app).not.toContain('이 상자를 가져다 씀');
    const lib = rows(html).find(row => row.includes('>web/lib</button>'))!;
    expect(lib).toContain('이 상자를 가져다 씀 1곳: web/app');
    expect(lib).not.toContain('가져다 씀 0곳');
    expect(list).not.toContain('(import 1개)');
    // A box that both uses and is used shows the two directions on separate lines.
    const both = render(opened, null, null, { ...map, edges: [...map.edges, { ...map.edges[0], fromFileId: 'b', toFileId: 'a', startUtf16: 5 }] });
    expect(rows(both).find(row => row.includes('>web/lib</button>'))!.match(/class="map-connections__line"/g)).toHaveLength(2);
    expect(rows(html).find(row => row.includes('>web 바로 아래 파일</button>')))
      .toContain('지금 보이는 다른 상자와 이어진 import가 없어요.');
  });

  it('keeps all rows and connections when focus hides arrows, and reflects the selected button', () => {
    const html = render(opened, { id: 'files:web', opened });
    expect(drawnEdges()).toEqual([]);
    expect(rows(html)).toHaveLength(5);
    expect(connectionSection(html)).toContain('가져다 씀 1곳: web/lib');
    expect(connectionSection(html)).toContain('aria-pressed="true">web 바로 아래 파일</button>');
    expect(connectionSection(html)).toContain('aria-pressed="false">web/app</button>');
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
    const center = rows(html).find(row => row.includes('>center</button>'))!;
    const names = neighbours.map((file, index) => `${file.folder}${index === 0 ? '(import 2개)' : ''}`).join(', ');
    expect(center).toContain(`가져다 씀 11곳: ${names}`);
    expect(center).toContain(`이 상자를 가져다 씀 11곳: ${names}`);
    expect(center).not.toContain('(import 1개)');
    expect(center).not.toContain('생략');
  });

  it('updates group names to full file paths when folders open', () => {
    const sameNames = { ...map, files: [
      { ...file('a', 'web/app'), relativePath: 'web/app/index.ts' },
      { ...file('b', 'web/lib'), relativePath: 'web/lib/index.ts' },
    ] };
    const folded = connectionSection(render(new Set(), null, null, sameNames));
    expect(folded).toContain('상자별 연결 · 상자 1개');
    expect(folded).toContain('>web</button>');
    const expanded = connectionSection(render(expandableIds(sameNames), null, null, sameNames));
    expect(expanded).toContain('상자별 연결 · 상자 2개');
    expect(expanded).toContain('>web/app/index.ts</button>');
    expect(expanded).toContain('>web/lib/index.ts</button>');
    expect(expanded).toContain('가져다 씀 1곳: web/lib/index.ts');
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
