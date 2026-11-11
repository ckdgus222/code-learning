import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, useStore, type Dimensions, type Edge,
  type FitViewOptions, type Node, type NodeChange, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ChangeKind, FileChange, MapExport, MapFile, MapFunction, MapImport, MapUnresolvedReason, ProjectChanges, ProjectMap, ProjectView, UnusedExcludeKind } from '../shared/contracts';
import { arrowCounts, arrowLabel, guessedLinks, BIG_FOLDER_LIMIT, boxName, boxPlace, closeArea, expandableIds, FILE_VIEW_LIMIT, fileViewFolder, fileViewOf, folderArrows, folderFileList, folderName,
  foldersWithFiles, importCycles, linkedArrows, NEIGHBOR_LIMIT, NEIGHBOR_ROW_HEIGHT, neighborhoodGraph, shownBigFolder, visibleGraph, type MapArrow, type MapBox, type MapLink } from './map-layout';
import { importPath, pathGraph } from './import-path';
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
interface BoxData { box: MapBox; change: ChangeKind | null; changed: number; focused: boolean; onFocus?(): void }

function BoxLabel({ box, change, changed }: Pick<BoxData, 'box' | 'change' | 'changed'>) {
  const status = box.file && box.file.checked !== 'full' ? checkedLabels[box.file.checked] : null;
  const separator = box.kind === 'folder' ? box.label.lastIndexOf(' · ') : -1;
  return <span className="map-box__label" title={boxName(box)}>
    <b>{separator < 0 ? box.label : <>
      <span className="map-box__name">{box.label.slice(0, separator)}</span><span className="visually-hidden"> · </span><span className="map-box__count">{box.label.slice(separator + 3)}</span>
    </>}</b>
    <span className="map-box__tags">
      {box.file?.start && <span className="tag tag--doc">시작점 후보</span>}
      {status && <span className="tag tag--unknown">{status}</span>}
      {change && <span className={`tag tag--change tag--${change}`}>{kindLabels[change]}</span>}
      {changed > 0 && <span className="tag tag--change">바뀐 파일 {changed}개</span>}
    </span>
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
    {data.onFocus && <button className="btn btn--small nodrag" aria-pressed={data.focused} aria-label={`${data.box.label} 이어진 것만 보기`}
      onClick={event => { event.stopPropagation(); data.onFocus?.(); }}>이어진 것만</button>}
    <Handle type="source" id="out-right" position={Position.Right} />
    <Handle type="source" id="out-bottom" position={Position.Bottom} />
    <Handle type="source" id="out-top" position={Position.Top} />
  </>;
}
// Defined once, outside rendering, as React Flow expects.
const nodeTypes = { box: MapNode };

export const ARROW_MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: 'var(--accent)' };
export const GUESS_MARKER = { ...ARROW_MARKER, color: 'var(--muted)' };
const FIT = { maxZoom: 1, minZoom: 0.1 };

/**
 * Opening or closing the question panel changes the canvas width; the boxes are fitted again (user decision:
 * always refit). React Flow's own measured width is used, so the fit runs after it knows the new size.
 */
export function FitOnWidthChange({ options }: { options: FitViewOptions }) {
  const width = useStore(state => state.width);
  const { fitView } = useReactFlow();
  const previous = useRef<number | null>(null);
  useEffect(() => {
    // 0 is the width before React Flow has measured; the first real width is the initial fit's.
    if (width === 0) return;
    if (previous.current !== null && previous.current !== width) void fitView(options);
    previous.current = width;
  }, [width, fitView, options]);
  return null;
}

/** The read-only canvas both maps draw on: boxes cannot be dragged or connected. */
export function MapCanvas({ testId, canvasKey, height, fitPadding, nodes, edges, nodeTypes, onNodeClick, onNodeHover, onEdgeClick }: {
  testId: string; canvasKey?: string; height?: number; fitPadding?: number; nodes: Node[]; edges: Edge[]; nodeTypes?: NodeTypes;
  onNodeClick(id: string): void; onNodeHover?(id: string | null): void; onEdgeClick?(id: string): void;
}) {
  const fitOptions = useMemo(() => fitPadding === undefined ? FIT : { ...FIT, padding: fitPadding }, [fitPadding]);
  // Nodes are rebuilt on every render. Without their measured size, React Flow hides and re-measures
  // every box, so a click landing during a hover re-render falls through to the pane.
  const [sizes, setSizes] = useState<ReadonlyMap<string, Dimensions>>(() => new Map());
  const measured: Node[] = nodes.map(node => ({ ...node, measured: sizes.get(node.id) }));
  const onNodesChange = (changes: NodeChange[]) => {
    const resized = changes.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions] as const] : []);
    if (resized.length) setSizes(current => new Map([...current, ...resized]));
  };
  return <div className="map-canvas" data-testid={testId} style={height === undefined ? undefined : { height }}>
    <ReactFlow colorMode="system" key={canvasKey} nodes={measured} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      // Only boxes in view are drawn, so the fit may zoom out far enough to show a whole opened folder.
      fitView fitViewOptions={fitOptions} minZoom={0.1} onlyRenderVisibleElements
      // A canvas sized to its content has nothing to scroll inside, so the wheel scrolls the page instead of zooming.
      zoomOnScroll={height === undefined} preventScrolling={height === undefined}
      nodesDraggable={false} nodesConnectable={false}
      onNodeClick={(_event, node) => onNodeClick(node.id)}
      onNodeMouseEnter={onNodeHover && ((_event, node) => onNodeHover(node.id))}
      onNodeMouseLeave={onNodeHover && (() => onNodeHover(null))}
      onEdgeClick={onEdgeClick && ((_event, edge) => onEdgeClick(edge.id))}>
      <Background variant={BackgroundVariant.Lines} gap={24} />
      <FitOnWidthChange options={fitOptions} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}

export function ImportPathCard({ files, links, incomplete, locked, onShowImport }: {
  files: MapFile[]; links: MapLink[]; incomplete: boolean; locked: boolean; onShowImport(item: MapImport): void;
}): React.ReactNode {
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  // A file name may itself start or end with a space, so the text as typed is tried before its trimmed form.
  const fileAt = (text: string) => files.find(file => file.relativePath === text) ?? files.find(file => file.relativePath === text.trim());
  const from = fileAt(fromText);
  const to = fileAt(toText);
  const graph = useMemo(() => pathGraph(files, links), [files, links]);
  const result = useMemo(() => from && to ? importPath(graph, from.id, to.id) : null, [graph, from, to]);
  return <section className="card map-path" aria-label="두 파일 사이 길">
    <h3>두 파일 사이 길</h3>
    <div className="map-actions">
      <label>출발 파일 <input type="text" list="map-path-files" aria-label="출발 파일" placeholder="경로를 적거나 목록에서 고르기"
        value={fromText} onChange={event => setFromText(event.target.value)} /></label>
      <label>도착 파일 <input type="text" list="map-path-files" aria-label="도착 파일" placeholder="경로를 적거나 목록에서 고르기"
        value={toText} onChange={event => setToText(event.target.value)} /></label>
      <button type="button" className="btn btn--small" onClick={() => { setFromText(toText); setToText(fromText); }}>출발·도착 바꾸기</button>
      <datalist id="map-path-files">{files.map(file => <option key={file.id} value={file.relativePath} />)}</datalist>
    </div>
    {!result && <>
      <p className="hint">출발 파일과 도착 파일을 고르면, 출발 파일에서 import를 따라 도착 파일에 닿는 가장 짧은 길을 보여 줘요.</p>
      {fromText && !from && <p className="hint">출발 파일 칸: 지도에 이 경로의 파일이 없어요. 목록에서 골라 주세요.</p>}
      {toText && !to && <p className="hint">도착 파일 칸: 지도에 이 경로의 파일이 없어요. 목록에서 골라 주세요.</p>}
    </>}
    {result?.status === 'same' && <p className="hint">출발과 도착이 같은 파일이에요.</p>}
    {result?.status === 'found' && <>
      {result.guessed && <p className="notice notice--warn"><b>추정이 섞인 길:</b> 확정된 import만으로는 길이 없어, 추정 연결(확정하지 못한 Python import의 후보)까지 따라갔어요. ‘추정’ 표시가 있는 걸음은 틀릴 수 있어요.</p>}
      <h4>가장 짧은 길 · {result.steps.length}걸음</h4>
      <ol className="map-list">{firstRows(result.steps).map((step, index) => <li key={`${step.from.id}->${step.to.id}`}>
        <b>{index + 1}.</b> <span className="path">{step.from.relativePath} {step.links[0].startLine}행 → {step.to.relativePath}</span> <code>{step.links[0].text}</code>
        {step.links[0].guess !== undefined && <> <span className="tag tag--unknown">추정</span> {step.links[0].guess}</>}
        {step.links.length > 1 && <> <span className="hint">근거 {step.links.length}개 중 첫 번째</span></>}
        {' '}<button className="btn btn--small" disabled={locked} onClick={() => onShowImport(step.links[0])}>코드 보기</button>
      </li>)}</ol>
      <Omitted count={result.steps.length} />
      <p className="hint">가장 짧은 길 하나예요. 다른 길도 있을 수 있어요.</p>
    </>}
    {result?.status === 'none' && <>
      <p>출발 파일에서 도착 파일로 가는 import 길을 찾지 못했어요.</p>
      {result.reverse === 'settled' && <p className="hint">반대 방향으로는 길이 있어요. ‘출발·도착 바꾸기’를 눌러 보세요.</p>}
      {result.reverse === 'guessed' && <p className="hint">반대 방향으로는 추정 연결이 섞인 길이 있어요. ‘출발·도착 바꾸기’를 눌러 보세요.</p>}
      <p className="hint">지도에 화살표로 그려진 import만 출발에서 도착 방향으로 따라가요. 화살표가 없는 import(동적 import, 후보가 없는 ‘확인 못 함’, 외부 패키지·경로 별칭)로 이어진 곳은 찾지 못해요.</p>
      {incomplete && <p className="hint">지도가 다 보지 못한 import가 있어 빠진 연결이 있을 수 있어요.</p>}
    </>}
  </section>;
}

function MapBody({ map, changes, locked, onOpenFile, onShowImport, onShowFunction, onShowChange }: {
  map: ProjectMap; changes: MapChanges | null; locked: boolean; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void;
  onShowFunction(item: MapFunction | MapExport): void; onShowChange(change: FileChange): void;
}) {
  const drawn = useMemo(() => ({ ...map, edges: [...map.edges, ...guessedLinks(map)] }), [map]);
  const expandable = useMemo(() => expandableIds(map), [map]);
  const folders = useMemo(() => foldersWithFiles(map), [map]);
  const cycles = useMemo(() => importCycles(map), [map]);
  const paths = useMemo(() => new Map(map.files.map(file => [file.id, file.relativePath])), [map]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const large = map.files.length > FILE_VIEW_LIMIT;
  const fileFolder = large ? fileViewFolder(opened, folders, expandable) : null;
  const [selected, setSelected] = useState<MapArrow | null>(null);
  const [focus, setFocus] = useState<{ id: string; opened: ReadonlySet<string> } | null>(null);
  const [hovered, setHovered] = useState<{ id: string; opened: ReadonlySet<string> } | null>(null);
  const [pickedFile, setPickedFile] = useState<{ fileId: string; opened: ReadonlySet<string> } | null>(null);
  const listMode = large && fileFolder !== null && folders.some(item => item.folder === fileFolder && item.count > BIG_FOLDER_LIMIT);
  const files = useMemo(() => listMode ? folderFileList(map, fileFolder!) : [], [map, listMode, fileFolder]);
  const pickedId = pickedFile?.opened === opened && files.some(item => item.file.id === pickedFile.fileId) ? pickedFile.fileId : null;
  const neighborhood = useMemo(() => pickedId === null ? null : neighborhoodGraph(drawn, pickedId), [drawn, pickedId]);
  const graph = useMemo(() => listMode ? neighborhood ?? { boxes: [], arrows: [] } : visibleGraph(drawn, opened, expandable),
    [drawn, opened, expandable, listMode, neighborhood]);
  const placeOf = new Map(graph.boxes.map(box => [box.id, box]));
  // A pick made before the last open or fold no longer applies, even if its box is shown again.
  const stillShown = (pick: { id: string; opened: ReadonlySet<string> } | null) => pick && pick.opened === opened && placeOf.has(pick.id) ? pick.id : null;
  const focused = listMode ? null : stillShown(focus);
  const connections = focused ? linkedArrows(graph.arrows, focused) : null;
  const highlighted = listMode ? null : stillShown(hovered) ?? focused;
  const lit = highlighted ? linkedArrows(graph.arrows, highlighted).linked : null;
  // The folder-to-folder arrows are the design at a glance, so they are also listed as text.
  const design = useMemo(() => folderArrows(drawn), [drawn]);
  const pathOf = (id: string) => paths.get(id) ?? '(목록에 없는 파일)';
  // A file now has a box; a deleted file and a rename's old path have none and are only in the list below.
  const changeOf = useMemo(() => new Map((changes?.result.changes ?? []).flatMap(change => change.fileId ? [[change.fileId, change.kind] as const] : [])),
    [changes]);
  const changedIn = (box: MapBox) => map.files.filter(file => changeOf.has(file.id)
    && (file.folder === box.folder || (box.id.startsWith('folder:') && file.folder.startsWith(`${box.folder}/`)))).length;
  const nodes: Node[] = graph.boxes.map(box => ({ id: box.id, type: 'box', position: { x: box.x, y: box.y },
    data: { box, change: box.file ? changeOf.get(box.file.id) ?? null : null, changed: box.kind === 'folder' ? changedIn(box) : 0,
      focused: focused === box.id, onFocus: listMode ? undefined : () => setFocus(focused === box.id ? null : { id: box.id, opened }) },
    ariaLabel: boxName(box),
    className: `map-box map-box--${box.kind}${listMode ? ' map-box--neighbor' : ''}${focused === box.id ? ' map-box--focus' : ''}${lit && highlighted !== box.id && !lit.has(box.id) ? ' map-box--dim' : ''}`,
    draggable: false, connectable: false }));
  const handlesFor = (arrow: MapArrow) => {
    const from = placeOf.get(arrow.source)!;
    const to = placeOf.get(arrow.target)!;
    if (from.x !== to.x) return { sourceHandle: 'out-right', targetHandle: 'in-left' };
    return to.y > from.y ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' } : { sourceHandle: 'out-top', targetHandle: 'in-bottom' };
  };
  const edges: Edge[] = (connections?.arrows ?? graph.arrows).map(arrow => {
    const strong = listMode || selected?.id === arrow.id || arrow.source === highlighted || arrow.target === highlighted;
    const guessedOnly = arrowCounts(arrow).sure === 0;
    return { id: arrow.id, source: arrow.source, target: arrow.target, ...handlesFor(arrow),
      label: strong ? arrowLabel(arrow) ?? undefined : undefined,
      className: `map-arrow map-arrow--${strong ? 'strong' : 'faint'}${arrow.back ? ' map-arrow--back' : ''}${guessedOnly ? ' map-arrow--guess' : ''}`,
      markerEnd: guessedOnly ? GUESS_MARKER : ARROW_MARKER, selected: selected?.id === arrow.id };
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
      const label = arrowLabel(arrow);
      if (label) details.push(label);
      return `${neighbour.short}${details.length ? `(${details.join(', ')})` : ''}`;
    }).sort((a, b) => a.localeCompare(b)).join(', ');
  const showButton = (item: MapImport) => <button className="btn btn--small" disabled={locked} onClick={() => onShowImport(item)}>코드 보기</button>;
  const externals = [...map.external.reduce((groups, item) => groups.set(item.specifier ?? '', (groups.get(item.specifier ?? '') ?? 0) + 1),
    new Map<string, number>())];
  const openChips = [...opened].filter(id => expandable.has(id));
  const unexamined = map.files.filter(file => file.checked === 'partial' || file.checked === 'failed' || file.checked === 'skipped');
  // A neighbour of the picked file joined by no settled import is there by a guess. Built once per map:
  // this body runs again on every hover.
  const settledPairs = useMemo(() => new Set(map.edges.map(item => `${item.fromFileId}->${item.toFileId}`)), [map]);
  const userNames = neighborhood?.users.map(file => `${file.relativePath}${settledPairs.has(`${file.id}->${pickedId}`) ? '' : ' (추정)'}`) ?? [];
  const usedNames = neighborhood?.used.map(file => `${file.relativePath}${settledPairs.has(`${pickedId}->${file.id}`) ? '' : ' (추정)'}`) ?? [];
  const selectedCounts = selected ? arrowCounts(selected) : null;
  const neighborhoodHeight = Math.max(1, ...graph.boxes.map(box => box.y / NEIGHBOR_ROW_HEIGHT + 1)) * NEIGHBOR_ROW_HEIGHT + 80;
  const focusedBox = focused ? placeOf.get(focused)! : null;
  const focusedUses = connections?.arrows.filter(arrow => arrow.source === focused) ?? [];
  const focusedUsers = connections?.arrows.filter(arrow => arrow.target === focused) ?? [];
  const reviewPlaces = [
    { id: 'map-import-cycles', label: '서로 가져다 쓰는 파일 묶음', count: cycles.length },
    { id: 'map-unused-files', label: '아무도 가져다 쓰지 않는 파일 후보', count: map.unused.candidates.length },
    { id: 'map-unused-exports', label: '다른 파일이 가져다 쓰지 않는 export 후보', count: map.unused.exports.candidates.length },
    { id: 'map-complex-functions', label: '어려운 코드 살펴볼 곳', count: map.complexFunctions.length },
    { id: 'map-unresolved', label: '확인 못 한 import', count: map.unresolved.length },
  ];
  const openBox = (id: string) => {
    const box = graph.boxes.find(item => item.id === id);
    if (box?.file) { onOpenFile(box.file.id); return; }
    if (box?.kind !== 'folder') return;
    const next = new Set([...opened, box.id]);
    const big = large ? shownBigFolder(next, folders, expandable) : null;
    setOpened(big === null ? next : fileViewOf(big, expandable));
  };

  return <div className="file-map">
    <div className="map-actions" role="group" aria-label="지도 보기">
      <div className="map-view-toggle">
        <button className="btn btn--small" aria-pressed={opened.size === 0} onClick={() => setOpened(new Set())}>설계 보기</button>
        {!large && <button className="btn btn--small" aria-pressed={graph.boxes.every(box => box.kind === 'file')}
          onClick={() => setOpened(new Set(expandable))}>파일 보기</button>}
      </div>
      {large && <>
        <label>파일 볼 폴더 <select aria-label="파일 볼 폴더" value={fileFolder === null ? '' : `folder:${fileFolder}`}
          onChange={event => setOpened(event.target.value ? fileViewOf(event.target.value.slice('folder:'.length), expandable) : new Set())}>
          <option value="">폴더 고르기</option>
          {folders.map(({ folder, count }) => <option key={folder} value={`folder:${folder}`}>{folderName(folder)} · 파일 {count}개</option>)}
        </select></label>
        {!listMode && <span className="hint">파일이 {map.files.length}개라 한 번에 그리면 선이 엉켜요. 폴더를 고르면 그 폴더의 파일을 상자로 보여 줘요.</span>}
      </>}
      {!listMode && <span className="hint map-instruction">상자를 누르면 그 안을 펼쳐요 · 파일 상자를 누르면 코드를 열어요</span>}
      {listMode && <span className="hint">'{folderName(fileFolder!)}' 바로 아래 파일이 {files.length}개라 상자로 그리면 화살표가 엉켜요. 많이 쓰이는 파일부터 보여 줘요. 파일을 고르면 바로 이어진 파일만 지도로 보여 줘요.</span>}
    </div>
    {!listMode && <details className="map-help"><summary>지도 읽는 법</summary>
      <p>설계 보기는 폴더끼리, 파일 보기는 파일끼리 보여 줘요.</p>
      <p>상자를 누르면 그 안을 한 단계 펼쳐요. 위 ‘접기’로 다시 접어요. 파일 상자를 누르면 코드를 열어요. 긴 점선은 오른쪽에서 왼쪽으로 거꾸로 가는 연결이라, 서로 가져다 쓰는 곳일 수 있어요. 상자에 마우스를 올리면 그 상자의 화살표가 진해져요. ‘이어진 것만’을 누르면 그 상자와 이어진 화살표만 남아요. 펼치거나 접으면 다시 모두 보여요.</p>
      <p>촘촘한 회색 점선은 추정이에요. 코드만으로는 확정하지 못한 Python import를, 그 파일일 수 있는 후보마다 이은 선이에요. 틀릴 수 있고, ‘확인 못 함’ 목록에 이유와 함께 그대로 있어요.</p>
    </details>}
    {openChips.length > 0 && <div className="map-actions" role="group" aria-label="펼친 곳">
      <span className="hint">펼친 곳</span>
      {openChips.map(id => <button key={id} className="btn btn--small"
        onClick={() => setOpened(current => closeArea(current, id))}>
        {folderName(id.slice(id.indexOf(':') + 1))}{id.startsWith('files:') ? ' 바로 아래 파일' : ''} 접기
      </button>)}
    </div>}
    <div className="map-layout">
      <div className="map-main">
        {listMode ? <>
          <section className="card" aria-label="큰 폴더 파일 목록">
            <div className="map-list-heading"><h3>{folderName(fileFolder!)} 바로 아래 파일 · {files.length}개</h3>
              <span className="hint">많이 쓰이는 파일부터 · 고르면 바로 이어진 파일만 지도로</span></div>
            <ul className="map-list map-big-folder">{files.map(({ file, uses, usedBy }) => <li key={file.id}>
              <button className="btn btn--small" aria-label={file.relativePath} aria-pressed={pickedId === file.id}
                onClick={() => setPickedFile({ fileId: file.id, opened })}>{file.relativePath.split('/').at(-1)}</button>
              <span>가져다 씀 {uses}곳 · 이 파일을 가져다 씀 {usedBy}곳</span>
            </li>)}</ul>
          </section>
          {neighborhood ? <>
            <div className="map-neighborhood-scroll">
              <MapCanvas testId="map-neighborhood" canvasKey={pickedId!} height={neighborhoodHeight} fitPadding={0.02}
                nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={onOpenFile}
                onEdgeClick={id => setSelected(graph.arrows.find(item => item.id === id) ?? null)} />
            </div>
            {neighborhood.hidden.users > 0 && <p className="hint">지도에는 '이 파일을 가져다 씀'을 {NEIGHBOR_LIMIT}개까지만 그렸어요. 나머지 {neighborhood.hidden.users}개는 고른 상자 카드의 목록에 있어요.</p>}
            {neighborhood.hidden.used > 0 && <p className="hint">지도에는 '가져다 씀'을 {NEIGHBOR_LIMIT}개까지만 그렸어요. 나머지 {neighborhood.hidden.used}개는 고른 상자 카드의 목록에 있어요.</p>}
          </> : null}
        </> : <MapCanvas testId="map-canvas" canvasKey={[...opened].sort().join('|')} nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodeClick={openBox}
          onNodeHover={id => setHovered(id === null ? null : { id, opened })}
          onEdgeClick={id => setSelected(graph.arrows.find(item => item.id === id) ?? null)} />}
      </div>
      <aside className="map-side">
        <section className="card map-picked" aria-label="고른 상자">
          <p className="map-side__label">고른 상자</p>
          {listMode ? neighborhood ? <>
            <p className="map-picked__path">{pathOf(pickedId!)}</p>
            <div className="map-connections">
              <p>이 파일을 가져다 씀 {userNames.length}곳: {userNames.join(', ') || '없음'}</p>
              <p>가져다 씀 {usedNames.length}곳: {usedNames.join(', ') || '없음'}</p>
            </div>
          </> : <p className="hint">파일을 고르면 그 파일과 바로 이어진 파일만 지도로 보여 줘요.</p>
            : focusedBox && connections ? <>
              <p className="map-picked__name">{boxName(focusedBox)}</p>
              <div className="map-actions" role="group" aria-label="이어진 것만 보는 중">
                <span className="hint">‘{focusedBox.label}’과 이어진 것만 보는 중 · {connections.arrows.length
                  ? `가져다 씀 ${connections.uses}곳 · 이 상자를 가져다 씀 ${connections.usedBy}곳`
                  : '지금 보이는 다른 상자와 이어진 import가 없어요.'}</span>
                <button className="btn btn--small" onClick={() => setFocus(null)}>모두 보기</button>
              </div>
              <div className="map-connections">
                {focusedUses.length > 0 && <p>가져다 씀 {focusedUses.length}곳: {namesOf(focusedUses, arrow => arrow.target, boxPlace(focusedBox).area)}</p>}
                {focusedUsers.length > 0 && <p>이 상자를 가져다 씀 {focusedUsers.length}곳: {namesOf(focusedUsers, arrow => arrow.source, boxPlace(focusedBox).area)}</p>}
              </div>
              {focusedBox.kind === 'folder' && <button className="btn btn--small" onClick={() => openBox(focusedBox.id)}>안의 파일 펼치기</button>}
            </> : <p className="hint">상자의 ‘이어진 것만’을 누르면 그 상자의 연결이 여기에 보여요.</p>}
        </section>
        <section className="card map-review" aria-label="살펴볼 곳">
          <p className="map-side__label">살펴볼 곳</p>
          {reviewPlaces.map(({ id, label, count }) => <button key={id} className="map-review__link" aria-label={`${label} ${count}개`}
            onClick={() => {
              const heading = document.getElementById(id);
              if (!heading) return;
              const details = heading.closest('details');
              if (details) details.open = true;
              heading.scrollIntoView({ block: 'start' });
              heading.focus({ preventScroll: true });
            }}><span>{label}</span><b>{count}</b></button>)}
        </section>
      </aside>
    </div>
    {/* Whether imports are missing is decided where the map is built: a cut of Python results leaves every file fully read. */}
    <ImportPathCard files={map.files} links={drawn.edges} incomplete={map.reading.incomplete} locked={locked} onShowImport={onShowImport} />
    {!listMode && <section className="card" aria-label="상자별 연결">
      <h3>상자별 연결 · 상자 {graph.boxes.length}개</h3>
      <p className="hint">지금 지도에 보이는 상자끼리의 import예요. 펼치거나 접으면 함께 바뀌어요.</p>
      {graph.arrows.some(arrow => arrowCounts(arrow).guessed > 0) && <p className="hint">추정으로 이은 곳은 (추정)이라고 적었어요. 확정된 연결이 아니에요.</p>}
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
    </section>}
    <section className="card" aria-label="변경 목록">
      <h3>변경 목록{changes && ` · ${changes.result.changes.length}개`}</h3>
      {changes ? <>
        <p className="hint">기준 커밋 {changes.result.commit.slice(0, 7)} ↔ 지금 파일. 상자가 없는 삭제·이름 변경 전 경로는 이 목록에만 있어요.</p>
        {changes.stale && <p className="notice notice--warn"><b>다시 확인 필요:</b> 비교한 뒤 파일이 바뀌었거나 잠자기에서 돌아왔어요. 달라진 내용에서 다시 비교해 주세요.</p>}
        <ChangeList result={changes.result} locked={locked} onOpen={onShowChange} />
      </> : <p className="hint">달라진 내용에서 기준 커밋을 고르면 바뀐 파일이 여기와 지도 상자에 보여요.</p>}
    </section>
    {selected && <section className="card" aria-label="고른 화살표의 근거">
      <h3>고른 화살표의 근거{selectedCounts!.sure > 0 && ` · import ${selectedCounts!.sure}개`}{selectedCounts!.guessed > 0 && ` · 추정 ${selectedCounts!.guessed}개`}</h3>
      <ul className="map-list">{firstRows(selected.items).map((item, index) => <li key={`${item.fromFileId}:${item.startUtf16}:${index}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행 → {pathOf(item.toFileId)}</span> <code>{item.text}</code>
        {item.guess !== undefined && <> <span className="tag tag--unknown">추정</span> {item.guess}</>} {showButton(item)}
      </li>)}</ul>
      <Omitted count={selected.items.length} />
    </section>}
    <section className="card" aria-label="폴더 사이 연결">
      <h3>폴더 사이 연결(설계) · {design.length}개</h3>
      {design.length ? <ul className="map-list">{firstRows(design).map(arrow => <li key={arrow.id}>
        {folderName(arrow.source.replace(/^folder:/, ''))} → {folderName(arrow.target.replace(/^folder:/, ''))} · {arrowLabel(arrow) ?? 'import 1개'}
      </li>)}</ul> : <p className="hint">폴더 사이에 이어진 import가 없어요.</p>}
      <Omitted count={design.length} />
    </section>
    <section className="card" aria-label="서로 가져다 쓰는 파일 묶음">
      <h3 id="map-import-cycles" tabIndex={-1}>서로 가져다 쓰는 파일 묶음 · {cycles.length}개</h3>
      <p className="hint">import를 따라가면 처음 파일로 돌아오는 묶음이에요(순환 import). 서로 기대고 있으니 함께 읽으면 좋아요. 타입만 가져오는 import도 세기 때문에, 실행할 때 문제가 생긴다는 뜻은 아니에요.</p>
      {cycles.length ? <ul className="map-list">{firstRows(cycles).map(group => <li key={group.files[0].id}>
        <p>파일 {group.files.length}개 · import {group.imports.length}개</p>
        {firstRows(group.files).map(file => <button key={file.id} className="btn btn--small path" disabled={locked}
          onClick={() => onOpenFile(file.id)}>{file.relativePath}</button>)}
        <Omitted count={group.files.length} />
        <details><summary>묶음 안 import {group.imports.length}개</summary>
          <ul className="map-list">{firstRows(group.imports).map((item, index) => <li key={`${item.fromFileId}:${item.startUtf16}:${index}`}>
            <span className="path">{pathOf(item.fromFileId)} {item.startLine}행 → {pathOf(item.toFileId)}</span> <code>{item.text}</code> {showButton(item)}
          </li>)}</ul>
          <Omitted count={group.imports.length} />
        </details>
      </li>)}</ul> : <p className="hint">돌고 도는 import가 없어요.</p>}
      <Omitted count={cycles.length} />
    </section>
    <section className="card" aria-label="아무도 가져다 쓰지 않는 파일 후보">
      <h3 id="map-unused-files" tabIndex={-1}>아무도 가져다 쓰지 않는 파일 후보 · {map.unused.candidates.length}개</h3>
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
      <h3 id="map-unused-exports" tabIndex={-1}>다른 파일이 가져다 쓰지 않는 export 후보 · {map.unused.exports.candidates.length}개</h3>
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
      <h3 id="map-complex-functions" tabIndex={-1}>어려운 코드 살펴볼 곳 · {map.complexFunctions.length}개</h3>
      <p className="hint">{COMPLEXITY_NOTE}</p>
      {map.complexFunctions.length ? <ul className="map-list">{firstRows(map.complexFunctions).map(item => <li key={`${item.fileId}:${item.startUtf16}`}>
        <span className="path">{pathOf(item.fileId)} {item.startLine}행</span> <b>{item.name}</b> <ComplexityTags lines={item.lines} depth={item.depth} />
        <button className="btn btn--small" disabled={locked} onClick={() => onShowFunction(item)}>코드 보기</button>
      </li>)}</ul> : <p className="hint">지도가 본 파일에서 기준을 넘는 함수가 없어요.</p>}
      <Omitted count={map.complexFunctions.length} />
    </section>
    <details className="card"><summary>연결 목록 · {map.edges.length}개</summary>
      <ul className="map-list">{firstRows(map.edges).map((item, index) => <li key={`${item.fromFileId}:${item.startUtf16}:${index}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행 → {pathOf(item.toFileId)}</span> {showButton(item)}
      </li>)}</ul>
      <Omitted count={map.edges.length} />
    </details>
    <details className="card" open={map.unresolved.length > 0}><summary id="map-unresolved" tabIndex={-1}>확인 못 함 · {map.unresolved.length}개</summary>
      <ul className="map-list">{firstRows(map.unresolved).map((item, index) => <li key={`${item.fromFileId}:${item.startUtf16}:${index}`}>
        <span className="path">{pathOf(item.fromFileId)} {item.startLine}행</span> <code>{item.text}</code> · {item.reasonText ?? unresolvedLabels[item.reason]}
        {item.candidates.length > 0 && <> · 후보: {item.candidates.join(', ')}</>} {showButton(item)}
      </li>)}</ul>
      <Omitted count={map.unresolved.length} />
    </details>
    <details className="card"><summary>외부 패키지 또는 경로 별칭 · {externals.length}개</summary>
      <p className="hint">import 글만으로는 설치한 패키지와 경로 별칭(@/… 등)을 구분할 수 없어 선을 긋지 않았어요. Python은 표준 라이브러리와 설치한 패키지가 여기에 들어가요.</p>
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
  </div>;
}

export function ProjectMapView({ project, entry, stale, mapping, locked, changes, onBuild, onCancel, onOpenFile, onShowImport, onShowFunction,
  onShowChange }: {
  project: ProjectView; entry: MapEntry | null; stale: boolean; mapping: boolean; changes: MapChanges | null; onShowChange(change: FileChange): void;
  /** A folder is opening or a file is being read, so moving to code would drop that work. */
  locked: boolean;
  onBuild(): void; onCancel(): void; onOpenFile(fileId: string): void; onShowImport(item: MapImport): void; onShowFunction(item: MapFunction | MapExport): void;
}) {
  return <>
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
    <p className="hint">지도는 TS/JS와 Python 파일의 import만 봐요. 새 파일은 폴더를 다시 열어야 지도에 들어와요.</p>
  </>;
}
