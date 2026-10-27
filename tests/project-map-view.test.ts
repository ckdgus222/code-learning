import React from 'react';
import * as ReactHooks from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlow, type Node } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectMapView, type MapChanges } from '../src/renderer/project-map';
import { expandableIds } from '../src/renderer/map-layout';
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

function render(opened: ReadonlySet<string> = new Set()) {
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [opened, vi.fn()]);
  return renderToStaticMarkup(React.createElement(ProjectMapView, { project, entry: { map, revision: 0, build: 1 },
    stale: false, mapping: false, locked: false, changes,
    onBuild() {}, onCancel() {}, onOpenFile() {}, onShowImport() {}, onShowFunction() {}, onShowChange() {} }));
}
function drawnNodes(): Node[] {
  return vi.mocked(ReactFlow).mock.calls.at(-1)![0].nodes!;
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
