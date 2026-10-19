import React, { useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { MapFile, MapFunction, MapImport, MapUnresolvedReason, ProjectMap, ProjectView } from '../shared/contracts';
import { folderName, visibleGraph, type MapArrow, type MapBox } from './map-layout';
import { COMPLEXITY_NOTE, ComplexityTags } from './complexity';

// Plan v2.3 A (user, 2026-10-19): with more code files than this the map starts in the design view.
const FOLD_OVER = 60;
// One file can hold thousands of imports, so each list shows this many rows and counts the rest.
const LIST_LIMIT = 300;
export const firstRows = <T,>(items: T[]) => items.slice(0, LIST_LIMIT);
export function Omitted({ count }: { count: number }) {
  return count > LIST_LIMIT ? <p className="hint">처음 {LIST_LIMIT}개만 보여요. 나머지 {count - LIST_LIMIT}개는 생략했어요.</p> : null;
}
const checkedLabels: Record<Exclude<MapFile['checked'], 'full'>, string> = {
  partial: '일부만 봄', failed: '못 읽음', skipped: '읽지 않음', 'not-code': '코드 아님',
};
const unresolvedLabels: Record<MapUnresolvedReason, string> = {
  'not-found': '찾지 못함(파일이 없거나 탐색 목록에서 제외됨)', ambiguous: '후보 여럿', outside: '프로젝트 밖',
  'not-static': '정적 import 아님(동적 import·require)', syntax: 'import 문에 구문 오류',
  unavailable: '대상을 지금 확인할 수 없음(삭제·제외·링크)',
  unreadable: '경로 글을 그대로 읽을 수 없음(빈 경로·이스케이프 문자)',
};
export interface MapEntry { map: ProjectMap; revision: number; build: number }

function BoxLabel({ box }: { box: MapBox }) {
  const status = box.file && box.file.checked !== 'full' ? checkedLabels[box.file.checked] : null;
  return <span className="map-box__label">
    <b>{box.label}</b>
    {box.file?.start && <span className="tag tag--doc">시작점 후보</span>}
    {status && <span className="tag tag--unknown">{status}</span>}
  </span>;
}

/**
 * A box with a way in and out on each side. Arrows between columns leave on the right and enter on the
 * left; arrows inside one column go straight up or down instead of looping around the boxes.
 */
function MapNode({ data }: NodeProps<Node<{ box: MapBox }>>) {
  return <>
    <Handle type="target" id="in-left" position={Position.Left} />
    <Handle type="target" id="in-top" position={Position.Top} />
    <Handle type="target" id="in-bottom" position={Position.Bottom} />
    <BoxLabel box={data.box} />
    <Handle type="source" id="out-right" position={Position.Right} />
    <Handle type="source" id="out-bottom" position={Position.Bottom} />
    <Handle type="source" id="out-top" position={Position.Top} />
  </>;
}
// Defined once, outside rendering, as React Flow expects.
const nodeTypes = { box: MapNode };

function MapBody({ map, locked, onOpenFile, onShowImport, onShowFunction }: {
  map: ProjectMap; locked: boolean; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void; onShowFunction(item: MapFunction): void;
}) {
  const folders = useMemo(() => [...new Set(map.files.map(file => file.folder))], [map]);
  const paths = useMemo(() => new Map(map.files.map(file => [file.id, file.relativePath])), [map]);
  const codeFiles = map.files.filter(file => file.checked !== 'not-code').length;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(codeFiles > FOLD_OVER ? [] : folders));
  const [selected, setSelected] = useState<MapArrow | null>(null);
  const graph = useMemo(() => visibleGraph(map, expanded), [map, expanded]);
  // The folder-to-folder arrows are the design at a glance, so they are also listed as text.
  const design = useMemo(() => visibleGraph(map, new Set()).arrows, [map]);
  const pathOf = (id: string) => paths.get(id) ?? '(목록에 없는 파일)';
  const nodes: Node[] = graph.boxes.map(box => ({ id: box.id, type: 'box', position: { x: box.x, y: box.y }, data: { box },
    className: `map-box map-box--${box.kind}`, draggable: false, connectable: false }));
  const placeOf = new Map(graph.boxes.map(box => [box.id, box]));
  const handlesFor = (arrow: MapArrow) => {
    const from = placeOf.get(arrow.source)!;
    const to = placeOf.get(arrow.target)!;
    if (from.x !== to.x) return { sourceHandle: 'out-right', targetHandle: 'in-left' };
    return to.y > from.y ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' } : { sourceHandle: 'out-top', targetHandle: 'in-bottom' };
  };
  const edges: Edge[] = graph.arrows.map(arrow => ({ id: arrow.id, source: arrow.source, target: arrow.target, ...handlesFor(arrow),
    label: arrow.items.length > 1 ? `import ${arrow.items.length}개` : undefined, className: arrow.back ? 'map-arrow map-arrow--back' : 'map-arrow',
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: '#2a55c9' }, selected: selected?.id === arrow.id }));
  const toggle = (folder: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(folder)) next.delete(folder); else next.add(folder);
    return next;
  });
  const showButton = (item: MapImport) => <button className="btn btn--small" disabled={locked} onClick={() => onShowImport(item)}>코드 보기</button>;
  const externals = [...map.external.reduce((groups, item) => groups.set(item.specifier ?? '', (groups.get(item.specifier ?? '') ?? 0) + 1),
    new Map<string, number>())];
  const unexamined = map.files.filter(file => file.checked === 'partial' || file.checked === 'failed' || file.checked === 'skipped');

  return <>
    <div className="map-actions" role="group" aria-label="지도 보기">
      <button className="btn btn--small" aria-pressed={expanded.size === 0} onClick={() => setExpanded(new Set())}>설계 보기</button>
      <button className="btn btn--small" aria-pressed={expanded.size === folders.length} onClick={() => setExpanded(new Set(folders))}>파일 보기</button>
      <span className="hint">폴더 상자를 누르면 펼치거나 접어요. 파일 상자를 누르면 코드를 열어요. 점선은 오른쪽에서 왼쪽으로 거꾸로 가는 연결이라, 서로 가져다 쓰는 곳일 수 있어요.</span>
    </div>
    {/* Remounting on every fold refits the view to the boxes now shown. */}
    <div className="map-canvas" data-testid="map-canvas">
      <ReactFlow key={[...expanded].sort().join('|')} nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        // Only boxes in view are drawn, so the fit may zoom out far enough to show a whole expanded folder.
        fitView fitViewOptions={{ maxZoom: 1, minZoom: 0.1 }} minZoom={0.1} onlyRenderVisibleElements
        nodesDraggable={false} nodesConnectable={false}
        onNodeClick={(_event, node) => {
          const box = graph.boxes.find(item => item.id === node.id);
          if (box?.kind === 'folder') toggle(box.folder);
          else if (box?.file) onOpenFile(box.file.id);
        }}
        onEdgeClick={(_event, edge) => setSelected(graph.arrows.find(item => item.id === edge.id) ?? null)}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    {selected && <section className="card" aria-label="고른 화살표의 근거">
      <h3>고른 화살표의 근거 · import {selected.items.length}개</h3>
      <ul className="map-list">{firstRows(selected.items).map(item => <li key={`${item.fromFileId}:${item.startUtf16}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행 → {pathOf(item.toFileId)}</span> <code>{item.text}</code> {showButton(item)}
      </li>)}</ul>
      <Omitted count={selected.items.length} />
    </section>}
    <section className="card" aria-label="폴더 사이 연결">
      <h3>폴더 사이 연결(설계) · {design.length}개</h3>
      {design.length ? <ul className="map-list">{firstRows(design).map(arrow => <li key={arrow.id}>
        {folderName(arrow.source.replace(/^folder:/, ''))} → {folderName(arrow.target.replace(/^folder:/, ''))} · import {arrow.items.length}개
      </li>)}</ul> : <p className="hint">폴더 사이에 이어진 import가 없어요.</p>}
      <Omitted count={design.length} />
    </section>
    <section className="card" aria-label="어려운 코드 살펴볼 곳">
      <h3>어려운 코드 살펴볼 곳 · {map.complexFunctions.length}개</h3>
      <p className="hint">{COMPLEXITY_NOTE}</p>
      {map.complexFunctions.length ? <ul className="map-list">{firstRows(map.complexFunctions).map(item => <li key={`${item.fileId}:${item.startUtf16}`}>
        <span className="path">{pathOf(item.fileId)} {item.startLine}행</span> <b>{item.name}</b> <ComplexityTags lines={item.lines} depth={item.depth} />
        <button className="btn btn--small" disabled={locked} onClick={() => onShowFunction(item)}>코드 보기</button>
      </li>)}</ul> : <p className="hint">지도가 본 파일에서 기준을 넘는 함수가 없어요.</p>}
      <Omitted count={map.complexFunctions.length} />
    </section>
    <details className="card"><summary>연결 목록 · {map.edges.length}개</summary>
      <ul className="map-list">{firstRows(map.edges).map(item => <li key={`${item.fromFileId}:${item.startUtf16}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행 → {pathOf(item.toFileId)}</span> {showButton(item)}
      </li>)}</ul>
      <Omitted count={map.edges.length} />
    </details>
    <details className="card" open={map.unresolved.length > 0}><summary>확인 못 함 · {map.unresolved.length}개</summary>
      <ul className="map-list">{firstRows(map.unresolved).map(item => <li key={`${item.fromFileId}:${item.startUtf16}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행</span> <code>{item.text}</code> · {unresolvedLabels[item.reason]}
        {item.candidates.length > 0 && <> · 후보: {item.candidates.join(', ')}</>} {showButton(item)}
      </li>)}</ul>
      <Omitted count={map.unresolved.length} />
    </details>
    <details className="card"><summary>외부 패키지 또는 경로 별칭 · {externals.length}개</summary>
      <p className="hint">import 글만으로는 설치한 패키지와 경로 별칭(@/… 등)을 구분할 수 없어 선을 긋지 않았어요.</p>
      <ul className="map-list">{firstRows(externals).map(([specifier, count]) => <li key={specifier}><code>{specifier}</code> · {count}곳</li>)}</ul>
      <Omitted count={externals.length} />
    </details>
    {unexamined.length > 0 && <details className="card" open><summary>끝까지 보지 못한 파일 · {unexamined.length}개</summary>
      <ul className="map-list">{firstRows(unexamined).map(file => <li key={file.id}>
        <span className="path">{file.relativePath}</span> · {checkedLabels[file.checked as keyof typeof checkedLabels]}{file.reason && ` · ${file.reason}`}
      </li>)}</ul>
      <Omitted count={unexamined.length} />
    </details>}
    {map.notes.map(note => <p key={note} className="notice notice--warn">{note}</p>)}
  </>;
}

export function ProjectMapView({ project, entry, stale, mapping, locked, onBuild, onCancel, onOpenFile, onShowImport, onShowFunction }: {
  project: ProjectView; entry: MapEntry | null; stale: boolean; mapping: boolean;
  /** A folder is opening or a file is being read, so moving to code would drop that work. */
  locked: boolean;
  onBuild(): void; onCancel(): void; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void; onShowFunction(item: MapFunction): void;
}) {
  return <div className="page map-page">
    <h2 className="page__title">프로젝트 지도</h2>
    <p className="hint">화살표는 ‘가져다 씀(import)’이에요. 실행 순서가 아니에요. 설계 보기는 폴더끼리, 파일 보기는 파일끼리 보여 줘요.</p>
    {/* The map only covers the files listed when the folder was opened, so a cut-short scan is said here too. */}
    {project.warnings.length > 0 && <p className="notice"><b>폴더를 열 때:</b> {project.warnings.join(' ')}</p>}
    {entry && stale && <p className="notice notice--warn"><b>다시 확인 필요:</b> 지도를 만든 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 지도를 다시 만들어 주세요.</p>}
    <div className="map-actions">
      {mapping ? <>
        <span role="status" className="busy"><span className="spinner" aria-hidden="true" />지도를 만드는 중…</span>
        <button className="btn btn--small" onClick={onCancel}>지도 만들기 취소</button>
      </> : <button className="btn btn--small" onClick={onBuild}>{entry ? '지도 다시 만들기' : '지도 만들기'}</button>}
    </div>
    {entry && <MapBody key={entry.build} map={entry.map} locked={locked} onOpenFile={onOpenFile} onShowImport={onShowImport}
      onShowFunction={onShowFunction} />}
    <p className="hint">지도는 TS/JS 파일의 import만 봐요. 새 파일은 폴더를 다시 열어야 지도에 들어와요.</p>
  </div>;
}
