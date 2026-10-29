import React, { useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Dimensions, type Edge, type Node, type NodeChange, type NodeProps,
  type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ChangeKind, FileChange, MapExport, MapFile, MapFunction, MapImport, MapUnresolvedReason, ProjectChanges, ProjectMap, ProjectView, UnusedExcludeKind } from '../shared/contracts';
import { boxName, boxPlace, closeArea, expandableIds, folderArrows, folderName, linkedArrows, visibleGraph, type MapArrow, type MapBox } from './map-layout';
import { COMPLEXITY_NOTE, ComplexityTags } from './complexity';
import { ChangeList, kindLabels } from './changes';

// One file can hold thousands of imports, so each list shows this many rows and counts the rest.
const LIST_LIMIT = 300;
export const firstRows = <T,>(items: T[]) => items.slice(0, LIST_LIMIT);
export function Omitted({ count }: { count: number }) {
  return count > LIST_LIMIT ? <p className="hint">처음 {LIST_LIMIT}개만 보여요. 나머지 {count - LIST_LIMIT}개는 생략했어요.</p> : null;
}
const checkedLabels: Record<Exclude<MapFile['checked'], 'full'>, string> = {
  partial: '일부만 봄', failed: '못 읽음', skipped: '읽지 않음', 'not-code': '코드 아님',
};
const unusedExcludeLabels: Record<UnusedExcludeKind, string> = {
  start: '시작 파일(main·bin·index 등)', test: '시험 파일', config: '설정 파일', types: '타입 선언',
  framework: '프레임워크가 부르는 파일', script: '실행 명령에 적힌 파일', reference: '설정·HTML에 적힌 파일',
};
const unresolvedLabels: Record<MapUnresolvedReason, string> = {
  'not-found': '찾지 못함(파일이 없거나 탐색 목록에서 제외됨)', ambiguous: '후보 여럿', outside: '프로젝트 밖',
  'not-static': '정적 import 아님(동적 import·require)', syntax: 'import 문에 구문 오류',
  unavailable: '대상을 지금 확인할 수 없음(삭제·제외·링크)',
  unreadable: '경로 글을 그대로 읽을 수 없음(빈 경로·이스케이프 문자)',
};
export interface MapEntry { map: ProjectMap; revision: number; build: number }

/** A comparison with a commit shown on the map (plan v2.3 C-2), and whether files changed after it. */
export interface MapChanges { result: ProjectChanges; stale: boolean }
interface BoxData { box: MapBox; change: ChangeKind | null; changed: number; focused: boolean; onFocus(): void }

function BoxLabel({ box, change, changed }: Pick<BoxData, 'box' | 'change' | 'changed'>) {
  const status = box.file && box.file.checked !== 'full' ? checkedLabels[box.file.checked] : null;
  return <span className="map-box__label">
    <b>{box.label}</b>
    {box.file?.start && <span className="tag tag--doc">시작점 후보</span>}
    {status && <span className="tag tag--unknown">{status}</span>}
    {change && <span className={`tag tag--change tag--${change}`}>{kindLabels[change]}</span>}
    {changed > 0 && <span className="tag tag--change">바뀐 파일 {changed}개</span>}
  </span>;
}

/**
 * A box with a way in and out on each side. Arrows between columns leave on the right and enter on the
 * left; arrows inside one column go straight up or down instead of looping around the boxes.
 */
function MapNode({ data }: NodeProps<Node<BoxData & Record<string, unknown>>>) {
  return <>
    <Handle type="target" id="in-left" position={Position.Left} />
    <Handle type="target" id="in-top" position={Position.Top} />
    <Handle type="target" id="in-bottom" position={Position.Bottom} />
    <BoxLabel box={data.box} change={data.change} changed={data.changed} />
    <button className="btn btn--small nodrag" aria-pressed={data.focused} aria-label={`${data.box.label} 이어진 것만 보기`}
      onClick={event => { event.stopPropagation(); data.onFocus(); }}>이어진 것만</button>
    <Handle type="source" id="out-right" position={Position.Right} />
    <Handle type="source" id="out-bottom" position={Position.Bottom} />
    <Handle type="source" id="out-top" position={Position.Top} />
  </>;
}
// Defined once, outside rendering, as React Flow expects.
const nodeTypes = { box: MapNode };

export const ARROW_MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: 'var(--accent)' };
const FIT = { maxZoom: 1, minZoom: 0.1 };

/** The read-only dark canvas both maps draw on: boxes cannot be dragged or connected. */
export function MapCanvas({ testId, canvasKey, height, nodes, edges, nodeTypes, onNodeClick, onNodeHover, onEdgeClick }: {
  testId: string; canvasKey?: string; height?: number; nodes: Node[]; edges: Edge[]; nodeTypes?: NodeTypes;
  onNodeClick(id: string): void; onNodeHover?(id: string | null): void; onEdgeClick?(id: string): void;
}) {
  // Nodes are rebuilt on every render. Without their measured size, React Flow hides and re-measures
  // every box, so a click landing during a hover re-render falls through to the pane.
  const [sizes, setSizes] = useState<ReadonlyMap<string, Dimensions>>(() => new Map());
  const measured = nodes.map(node => ({ ...node, measured: sizes.get(node.id) }));
  const onNodesChange = (changes: NodeChange[]) => {
    const resized = changes.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions] as const] : []);
    if (resized.length) setSizes(current => new Map([...current, ...resized]));
  };
  return <div className="map-canvas" data-testid={testId} style={height === undefined ? undefined : { height }}>
    <ReactFlow colorMode="system" key={canvasKey} nodes={measured} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      // Only boxes in view are drawn, so the fit may zoom out far enough to show a whole opened folder.
      fitView fitViewOptions={FIT} minZoom={0.1} onlyRenderVisibleElements
      // A canvas sized to its content has nothing to scroll inside, so the wheel scrolls the page instead of zooming.
      zoomOnScroll={height === undefined} preventScrolling={height === undefined}
      nodesDraggable={false} nodesConnectable={false}
      onNodeClick={(_event, node) => onNodeClick(node.id)}
      onNodeMouseEnter={onNodeHover && ((_event, node) => onNodeHover(node.id))}
      onNodeMouseLeave={onNodeHover && (() => onNodeHover(null))}
      onEdgeClick={onEdgeClick && ((_event, edge) => onEdgeClick(edge.id))}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}

function MapBody({ map, changes, locked, onOpenFile, onShowImport, onShowFunction, onShowChange }: {
  map: ProjectMap; changes: MapChanges | null; locked: boolean; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void;
  onShowFunction(item: MapFunction | MapExport): void; onShowChange(change: FileChange): void;
}) {
  const expandable = useMemo(() => expandableIds(map), [map]);
  const paths = useMemo(() => new Map(map.files.map(file => [file.id, file.relativePath])), [map]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<MapArrow | null>(null);
  const [focus, setFocus] = useState<{ id: string; opened: ReadonlySet<string> } | null>(null);
  const [hovered, setHovered] = useState<{ id: string; opened: ReadonlySet<string> } | null>(null);
  const graph = useMemo(() => visibleGraph(map, opened, expandable), [map, opened, expandable]);
  const placeOf = new Map(graph.boxes.map(box => [box.id, box]));
  // A pick made before the last open or fold no longer applies, even if its box is shown again.
  const stillShown = (pick: { id: string; opened: ReadonlySet<string> } | null) => pick && pick.opened === opened && placeOf.has(pick.id) ? pick.id : null;
  const focused = stillShown(focus);
  const connections = focused ? linkedArrows(graph.arrows, focused) : null;
  const highlighted = stillShown(hovered) ?? focused;
  const lit = highlighted ? linkedArrows(graph.arrows, highlighted).linked : null;
  // The folder-to-folder arrows are the design at a glance, so they are also listed as text.
  const design = useMemo(() => folderArrows(map), [map]);
  const pathOf = (id: string) => paths.get(id) ?? '(목록에 없는 파일)';
  // A file now has a box; a deleted file and a rename's old path have none and are only in the list below.
  const changeOf = useMemo(() => new Map((changes?.result.changes ?? []).flatMap(change => change.fileId ? [[change.fileId, change.kind] as const] : [])),
    [changes]);
  const changedIn = (box: MapBox) => map.files.filter(file => changeOf.has(file.id)
    && (file.folder === box.folder || (box.id.startsWith('folder:') && file.folder.startsWith(`${box.folder}/`)))).length;
  const nodes: Node[] = graph.boxes.map(box => ({ id: box.id, type: 'box', position: { x: box.x, y: box.y },
    data: { box, change: box.file ? changeOf.get(box.file.id) ?? null : null, changed: box.kind === 'folder' ? changedIn(box) : 0,
      focused: focused === box.id, onFocus: () => setFocus(focused === box.id ? null : { id: box.id, opened }) },
    className: `map-box map-box--${box.kind}${focused === box.id ? ' map-box--focus' : ''}${lit && highlighted !== box.id && !lit.has(box.id) ? ' map-box--dim' : ''}`,
    draggable: false, connectable: false }));
  const handlesFor = (arrow: MapArrow) => {
    const from = placeOf.get(arrow.source)!;
    const to = placeOf.get(arrow.target)!;
    if (from.x !== to.x) return { sourceHandle: 'out-right', targetHandle: 'in-left' };
    return to.y > from.y ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' } : { sourceHandle: 'out-top', targetHandle: 'in-bottom' };
  };
  const edges: Edge[] = (connections?.arrows ?? graph.arrows).map(arrow => {
    const strong = selected?.id === arrow.id || arrow.source === highlighted || arrow.target === highlighted;
    return { id: arrow.id, source: arrow.source, target: arrow.target, ...handlesFor(arrow),
      label: strong && arrow.items.length > 1 ? `import ${arrow.items.length}개` : undefined,
      className: `map-arrow map-arrow--${strong ? 'strong' : 'faint'}${arrow.back ? ' map-arrow--back' : ''}`,
      markerEnd: ARROW_MARKER, selected: selected?.id === arrow.id };
  });
  const connectionGroups = new Map<string, MapBox[]>();
  for (const box of firstRows(graph.boxes)) {
    const { area } = boxPlace(box);
    if (!connectionGroups.has(area)) connectionGroups.set(area, []);
    connectionGroups.get(area)!.push(box);
  }
  const areas = [...connectionGroups.keys()].sort((a, b) =>
    (b ? b.split('/').length : 0) - (a ? a.split('/').length : 0) || a.localeCompare(b));
  const namesOf = (arrows: MapArrow[], other: (arrow: MapArrow) => string, area: string) => arrows
    .map(arrow => {
      const neighbour = boxPlace(placeOf.get(other(arrow))!);
      const details = [];
      if (neighbour.area !== area) details.push(neighbour.area ? `${neighbour.area} 안` : '최상위');
      if (arrow.items.length > 1) details.push(`import ${arrow.items.length}개`);
      return `${neighbour.short}${details.length ? `(${details.join(', ')})` : ''}`;
    }).sort((a, b) => a.localeCompare(b)).join(', ');
  const showButton = (item: MapImport) => <button className="btn btn--small" disabled={locked} onClick={() => onShowImport(item)}>코드 보기</button>;
  const externals = [...map.external.reduce((groups, item) => groups.set(item.specifier ?? '', (groups.get(item.specifier ?? '') ?? 0) + 1),
    new Map<string, number>())];
  const openChips = [...opened].filter(id => expandable.has(id));
  const unexamined = map.files.filter(file => file.checked === 'partial' || file.checked === 'failed' || file.checked === 'skipped');

  return <>
    <div className="map-actions" role="group" aria-label="지도 보기">
      <button className="btn btn--small" aria-pressed={opened.size === 0} onClick={() => setOpened(new Set())}>설계 보기</button>
      <button className="btn btn--small" aria-pressed={graph.boxes.every(box => box.kind === 'file')} onClick={() => setOpened(new Set(expandable))}>파일 보기</button>
      <span className="hint">상자를 누르면 그 안을 한 단계 펼쳐요. 위 ‘접기’로 다시 접어요. 파일 상자를 누르면 코드를 열어요. 점선은 오른쪽에서 왼쪽으로 거꾸로 가는 연결이라, 서로 가져다 쓰는 곳일 수 있어요. 상자에 마우스를 올리면 그 상자의 화살표가 진해져요. ‘이어진 것만’을 누르면 그 상자와 이어진 화살표만 남아요. 펼치거나 접으면 다시 모두 보여요.</span>
    </div>
    {openChips.length > 0 && <div className="map-actions" role="group" aria-label="펼친 곳">
      <span className="hint">펼친 곳</span>
      {openChips.map(id => <button key={id} className="btn btn--small"
        onClick={() => setOpened(current => closeArea(current, id))}>
        {folderName(id.slice(id.indexOf(':') + 1))}{id.startsWith('files:') ? ' 바로 아래 파일' : ''} 접기
      </button>)}
    </div>}
    {connections && <div className="map-actions" role="group" aria-label="이어진 것만 보는 중">
      <span className="hint">‘{graph.boxes.find(box => box.id === focused)!.label}’과 이어진 것만 보는 중 · {connections.arrows.length
        ? `가져다 씀 ${connections.uses}곳 · 이 상자를 가져다 씀 ${connections.usedBy}곳`
        : '지금 보이는 다른 상자와 이어진 import가 없어요.'}</span>
      <button className="btn btn--small" onClick={() => setFocus(null)}>모두 보기</button>
    </div>}
    {/* Remounting on every fold refits the view to the boxes now shown. */}
    <MapCanvas testId="map-canvas" canvasKey={[...opened].sort().join('|')} nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodeClick={id => {
        const box = graph.boxes.find(item => item.id === id);
        if (box?.kind === 'folder') setOpened(current => new Set([...current, box.id]));
        else if (box?.file) onOpenFile(box.file.id);
      }}
      onNodeHover={id => setHovered(id === null ? null : { id, opened })}
      onEdgeClick={id => setSelected(graph.arrows.find(item => item.id === id) ?? null)} />
    <section className="card" aria-label="상자별 연결">
      <h3>상자별 연결 · 상자 {graph.boxes.length}개</h3>
      <p className="hint">지금 지도에 보이는 상자끼리의 import예요. 펼치거나 접으면 함께 바뀌어요.</p>
      {areas.map(area => <React.Fragment key={area}>
        <h4>{folderName(area)} 안 · 상자 {connectionGroups.get(area)!.length}개</h4>
        <ul className="map-list map-connections">{connectionGroups.get(area)!.map(box => {
          const uses = graph.arrows.filter(arrow => arrow.source === box.id);
          const usedBy = graph.arrows.filter(arrow => arrow.target === box.id);
          return <li key={box.id}>
            <button className="btn btn--small" aria-label={boxName(box)} aria-pressed={focused === box.id}
              onClick={() => setFocus(focused === box.id ? null : { id: box.id, opened })}>{boxPlace(box).short}</button>
            {uses.length > 0 && <span className="map-connections__line"><b>가져다 씀 {uses.length}곳:</b> {namesOf(uses, arrow => arrow.target, area)}</span>}
            {usedBy.length > 0 && <span className="map-connections__line"><b>이 상자를 가져다 씀 {usedBy.length}곳:</b> {namesOf(usedBy, arrow => arrow.source, area)}</span>}
            {uses.length + usedBy.length === 0 && <span className="map-connections__line">지금 보이는 다른 상자와 이어진 import가 없어요.</span>}
          </li>;
        })}</ul>
      </React.Fragment>)}
      <Omitted count={graph.boxes.length} />
    </section>
    <section className="card" aria-label="변경 목록">
      <h3>변경 목록{changes && ` · ${changes.result.changes.length}개`}</h3>
      {changes ? <>
        <p className="hint">기준 커밋 {changes.result.commit.slice(0, 7)} ↔ 지금 파일. 상자가 없는 삭제·이름 변경 전 경로는 이 목록에만 있어요.</p>
        {changes.stale && <p className="notice notice--warn"><b>다시 확인 필요:</b> 비교한 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 달라진 내용에서 다시 비교해 주세요.</p>}
        <ChangeList result={changes.result} locked={locked} onOpen={onShowChange} />
      </> : <p className="hint">달라진 내용에서 기준 커밋을 고르면 바뀐 파일이 여기와 지도 상자에 보여요.</p>}
    </section>
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
    <section className="card" aria-label="아무도 가져다 쓰지 않는 파일 후보">
      <h3>아무도 가져다 쓰지 않는 파일 후보 · {map.unused.candidates.length}개</h3>
      <p className="hint">지도가 확인한 범위에서, 다른 파일의 정적 import로 연결되지 않은 파일 후보예요. 실행 명령·프레임워크·다른 프로그램이 직접 부를 수도 있으니 지우기 전에 직접 확인해 주세요.</p>
      {map.unused.candidates.length ? <ul className="map-list">{firstRows(map.unused.candidates).map(file => <li key={file.fileId}>
        <button className="btn btn--small path" disabled={locked} onClick={() => onOpenFile(file.fileId)}>{file.relativePath}</button>
      </li>)}</ul> : <p className="hint">후보가 없어요.</p>}
      <Omitted count={map.unused.candidates.length} />
      {map.unused.unsure.length > 0 && <details><summary>확인 못 함 · {map.unused.unsure.length}개</summary>
        <ul className="map-list">{firstRows(map.unused.unsure).map(file => <li key={file.fileId}>
          <button className="btn btn--small path" disabled={locked} onClick={() => onOpenFile(file.fileId)}>{file.relativePath}</button> · {file.reason}
        </li>)}</ul>
        <Omitted count={map.unused.unsure.length} />
      </details>}
      {map.unused.excluded.length > 0 && <p className="hint">뺀 파일: {map.unused.excluded.map(item => `${unusedExcludeLabels[item.kind]} ${item.count}`).join(' · ')}</p>}
      {map.unused.notes.map(note => <p key={note} className="hint">{note}</p>)}
    </section>
    <section className="card" aria-label="다른 파일이 가져다 쓰지 않는 export 후보">
      <h3>다른 파일이 가져다 쓰지 않는 export 후보 · {map.unused.exports.candidates.length}개</h3>
      <p className="hint">다른 파일의 import에 이름이 나오지 않는 함수·클래스·값이에요. 프레임워크나 다른 프로그램이 이름으로 부를 수도 있으니 직접 확인해 주세요.</p>
      {map.unused.exports.candidates.length ? <ul className="map-list">{firstRows(map.unused.exports.candidates).map(item =>
        <li key={`${item.fileId}:${item.startUtf16}:${item.name}`}>
          <button className="btn btn--small" disabled={locked} onClick={() => onShowFunction(item)}>
            {item.displayName} · {{ function: '함수', class: '클래스', value: '값' }[item.kind]} · {item.relativePath}:{item.startLine}
          </button> {item.usedInFile && <span className="tag tag--doc">파일 안에서는 씀</span>}
        </li>)}</ul> : <p className="hint">후보가 없어요.</p>}
      <Omitted count={map.unused.exports.candidates.length} />
      {map.unused.exports.unsure.length > 0 && <details><summary>확인 못 함 · {map.unused.exports.unsure.length}개 파일</summary>
        <ul className="map-list">{firstRows(map.unused.exports.unsure).map(file => <li key={file.fileId}>
          <button className="btn btn--small path" disabled={locked} onClick={() => onOpenFile(file.fileId)}>{file.relativePath}</button>
          {' '}· {file.reason} · export {file.count}개
        </li>)}</ul>
        <Omitted count={map.unused.exports.unsure.length} />
      </details>}
      {map.unused.exports.notes.map(note => <p key={note} className="hint">{note}</p>)}
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

export function ProjectMapView({ project, entry, stale, mapping, locked, changes, onBuild, onCancel, onOpenFile, onShowImport, onShowFunction,
  onShowChange }: {
  project: ProjectView; entry: MapEntry | null; stale: boolean; mapping: boolean; changes: MapChanges | null; onShowChange(change: FileChange): void;
  /** A folder is opening or a file is being read, so moving to code would drop that work. */
  locked: boolean;
  onBuild(): void; onCancel(): void; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void; onShowFunction(item: MapFunction | MapExport): void;
}) {
  return <>
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
    {entry && <MapBody key={entry.build} map={entry.map} changes={changes} locked={locked} onOpenFile={onOpenFile} onShowImport={onShowImport}
      onShowFunction={onShowFunction} onShowChange={onShowChange} />}
    <p className="hint">지도는 TS/JS 파일의 import만 봐요. 새 파일은 폴더를 다시 열어야 지도에 들어와요.</p>
  </>;
}
