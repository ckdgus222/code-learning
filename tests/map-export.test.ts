import { expect, it, vi } from 'vitest';
import { MAP_EXPORT_MAX, SCAN_LIMIT_WARNING, type MapFile, type MapUnresolvedReason, type ProjectMap } from '../src/shared/contracts';
import { mapMarkdown, EXPORT_ARROWS, EXPORT_ROWS, EXPORT_TOP_FILES, EXPORT_CYCLES, EXPORT_CYCLE_FILES } from '../src/renderer/map-export';

const when = new Date(2026, 10, 12, 23, 59);
const project = { name: 'example', warnings: [] as string[] };
const file = (id: string, folder = ''): MapFile => ({ id, relativePath: `${folder ? `${folder}/` : ''}${id}.ts`, folder,
  start: false, entry: false, checked: 'full', reason: null });
const edge = (fromFileId: string, toFileId: string, startLine = 1): ProjectMap['edges'][number] => ({ fromFileId, toFileId, startLine,
  endLine: startLine, startUtf16: 0, endUtf16: 1, fileHash: 'hash', text: 'PRIVATE_IMPORT_TEXT', specifier: 'PRIVATE_SPECIFIER', names: [] });
function empty(): ProjectMap {
  return { projectId: 'project', files: [], edges: [], unresolved: [], external: [], missing: [], missingCut: false,
    complexFunctions: [], symbols: [], symbolsCut: false, exports: [], reading: { steps: [], total: 0, incomplete: false },
    unused: { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } }, limited: false, notes: [] };
}
const markdown = (map: ProjectMap) => mapMarkdown(project, map, when);
const section = (text: string, title: string) => text.split(`## ${title}\n\n`)[1].split('\n## ')[0];

it('writes the entire small map in the specified order and local date', () => {
  const map = empty();
  map.files = [file('main', 'src/main'), file('shared', 'src/core')];
  map.edges = [edge('main', 'shared', 7), edge('shared', 'main', 3)];
  map.reading = { steps: [{ kind: 'start', fileId: 'main', reaches: 1 }, { kind: 'next', fileId: 'shared', depth: 1, usedBy: 1 }], total: 2, incomplete: false };
  expect(markdown(map)).toBe(`# \`example\` 프로젝트 지도

Code Learning이 프로젝트 파일을 읽어 만든 요약이에요. 파일 2개 · 확정 import 연결 2개 · 2026-11-12

## 폴더 사이 연결

\`\`\`mermaid
flowchart LR
  f0["src/core"]
  f1["src/main"]
  f0 -->|1| f1
  f1 -->|1| f0
\`\`\`

| 쓰는 폴더 | 쓰이는 폴더 | import 수 | 예 |
|---|---|---|---|
| \`src/core\` | \`src/main\` | 1 | \`src/core/shared.ts:3\` |
| \`src/main\` | \`src/core\` | 1 | \`src/main/main.ts:7\` |

## 이 순서로 읽어 보세요

1. \`src/main/main.ts\`: 시작 파일 후보 · 파일 1개로 이어져요
2. \`src/core/shared.ts\`: 시작에서 1걸음 · 파일 1개가 가져다 써요

## 많이 쓰이는 파일

- \`src/core/shared.ts\`: 파일 1개가 가져다 써요
- \`src/main/main.ts\`: 파일 1개가 가져다 써요

## 서로 가져다 쓰는 파일 묶음

- 파일 2개: \`src/core/shared.ts\`, \`src/main/main.ts\`

## 확인하지 못한 것

확인하지 못한 import가 없어요.

## 읽을 때 알아둘 점

- 실행 순서가 아니라 TS/JS와 Python 파일의 import 연결이에요.
- 프로젝트를 실행하지 않고 파일만 읽어서 만들었어요.
- 폴더 사이 연결과 순서는 대상이 하나로 정해진 import만 셌어요.
- 폴더를 열 때 모은 파일만 다뤄요. 제외된 폴더와 파일은 들어 있지 않아요.
`);
});

it('sorts by count, source and target, keeps the first import and ignores same-folder and unknown files', () => {
  const map = empty(); map.files = [file('a', 'a'), file('a2', 'a'), file('b', 'b'), file('c', 'c'), file('root')];
  map.edges = [edge('a', 'c', 9), edge('a', 'b', 8), edge('b', 'c', 7), edge('b', 'c', 2), edge('root', 'a'), edge('a', 'a2'), edge('a', 'missing'), edge('missing', 'b')];
  const result = section(markdown(map), '폴더 사이 연결');
  expect(result).toContain('f0["b"]\n  f1["c"]\n  f2["(최상위 폴더)"]\n  f3["a"]');
  expect(result).toContain('f0 -->|2| f1\n  f2 -->|1| f3\n  f3 -->|1| f0\n  f3 -->|1| f1');
  expect(result.match(/^\| `/gm)).toHaveLength(4);
  expect(result).toContain('| `b` | `c` | 2 | `b/b.ts:7` |');
  expect(result).toContain('| `(최상위 폴더)` | `a` | 1 | `root.ts:1` |');
});

it('keeps folder pairs distinct even when names contain the old arrow separator', () => {
  const map = empty(); map.files = [file('a', 'src'), file('b', 'util->folder:shared'), file('c', 'src->folder:util'), file('d', 'shared')];
  map.edges = [edge('a', 'b'), edge('c', 'd')];
  const result = section(markdown(map), '폴더 사이 연결');
  expect(result.match(/ -->\|1\| /g)).toHaveLength(2);
  expect(result).toContain('| `src` | `util->folder:shared` | 1 |');
  expect(result).toContain('| `src->folder:util` | `shared` | 1 |');
});

it.each([EXPORT_ARROWS, EXPORT_ARROWS + 1, EXPORT_ROWS, EXPORT_ROWS + 1])('limits %i folder pairs independently for diagram and table', count => {
  const map = empty(); map.files = [file('root'), ...Array.from({ length: count }, (_, i) => file(`target${i}`, `folder${String(i).padStart(3, '0')}`))];
  map.edges = map.files.slice(1).map(item => edge('root', item.id));
  const result = section(markdown(map), '폴더 사이 연결');
  expect(result.match(/ -->\|1\| /g)).toHaveLength(Math.min(count, EXPORT_ARROWS));
  expect(result.match(/^\| `/gm)).toHaveLength(Math.min(count, EXPORT_ROWS));
  expect(result.includes(`그림에는 import가 많은 연결 40개만 그렸어요. 전체는 ${count}개예요.`)).toBe(count > EXPORT_ARROWS);
  expect(result.includes('이 밖에 1개가 더 있어요.')).toBe(count > EXPORT_ROWS);
  // Exactly at the limit nothing is left out, so no count of the rest is written.
  expect(result.includes('이 밖에')).toBe(count > EXPORT_ROWS);
});

it.each([EXPORT_CYCLES, EXPORT_CYCLES + 1])('limits %i cycle groups and each group to ten sorted paths', count => {
  const map = empty();
  for (let group = 0; group < count; group++) {
    const members = Array.from({ length: group === 0 ? EXPORT_CYCLE_FILES + 1 : EXPORT_CYCLE_FILES }, (_, i) => file(`${group}-${String(i).padStart(2, '0')}`));
    map.files.push(...members);
    map.edges.push(...members.map((item, i) => edge(item.id, members[(i + 1) % members.length].id)));
  }
  const result = section(markdown(map), '서로 가져다 쓰는 파일 묶음');
  expect(result.match(/^- 파일 /gm)).toHaveLength(EXPORT_CYCLES);
  expect(result.split('\n')[0]).toContain('- 파일 11개: `0-00.ts`, `0-01.ts`');
  expect(result).toContain('`0-09.ts`, 그 밖에 1개');
  expect(result).not.toContain('`0-10.ts`');
  expect(result.match(/그 밖에/g)).toHaveLength(1);
  expect(result.includes('이 밖에 묶음 1개가 더 있어요.')).toBe(count > EXPORT_CYCLES);
});

it.each([EXPORT_TOP_FILES, EXPORT_TOP_FILES + 1])('limits %i popular files by distinct users, ignores self imports and orders ties by path', count => {
  const map = empty(); map.files = [file('z'), file('y'), ...Array.from({ length: count }, (_, i) => file(`a${String(i).padStart(2, '0')}`))];
  map.edges = map.files.slice(2).map(item => edge('z', item.id));
  map.edges.push(edge('z', 'a00'), edge('a00', 'a00'), edge('y', 'a01'));
  const result = section(markdown(map), '많이 쓰이는 파일');
  expect(result.match(/^- `/gm)).toHaveLength(EXPORT_TOP_FILES);
  expect(result.split('\n').slice(0, 3)).toEqual(['- `a01.ts`: 파일 2개가 가져다 써요', '- `a00.ts`: 파일 1개가 가져다 써요', '- `a02.ts`: 파일 1개가 가져다 써요']);
  expect(result).not.toContain('`a10.ts`');
});

it('writes all five empty states and omits unknown reading files while counting omitted steps', () => {
  const map = empty(); const result = markdown(map);
  for (const text of ['폴더 사이에 이어진 import가 없어요.', '읽는 순서를 정할 만한 import 연결이 없어요.',
    '다른 파일이 가져다 쓰는 파일이 없어요.', '서로 가져다 쓰는 파일 묶음이 없어요.', '확인하지 못한 import가 없어요.']) expect(result).toContain(text);
  expect(result).not.toContain('이 밖에');
  map.files = [file('a')]; map.reading = { steps: [{ kind: 'start', fileId: 'missing', reaches: 4 }, { kind: 'next', fileId: 'a', depth: 2, usedBy: 3 }], total: 4, incomplete: false };
  const reading = section(markdown(map), '이 순서로 읽어 보세요');
  expect(reading).toBe('1. `a.ts`: 시작에서 2걸음 · 파일 3개가 가져다 써요\n\n이 밖에 3개가 더 있어요.\n');
  expect(reading).not.toContain('missing');
});

it.each(['limited', 'incomplete', 'scan', 'failed', 'normal'] as const)('reports %s without copying free-form warnings or guessing the cause', kind => {
  const map = empty(); map.limited = kind === 'limited'; map.reading.incomplete = kind === 'incomplete' || kind === 'failed';
  if (kind === 'failed') map.files = [{ ...file('a'), checked: 'failed' }];
  const warnings = [kind === 'scan' ? SCAN_LIMIT_WARNING : '파일별 최대 256 KiB. UTF-8 텍스트만 읽으며 소스·설정·스크립트를 실행하지 않습니다.', 'PRIVATE_WARNING'];
  const result = mapMarkdown({ ...project, warnings }, map, when);
  expect(result.includes('> 지도가 다 보지 못한 파일이나 import가 있어')).toBe(kind !== 'normal');
  expect(result.includes('폴더를 열 때 탐색 한도에 닿아')).toBe(kind === 'scan');
  expect(result.includes('일부 파일이나 import를 확인하지 못해 빠진 내용이 있을 수 있어요.')).toBe(['limited', 'incomplete', 'failed'].includes(kind));
  expect(result.includes('확인하지 못한 import가 없어요.')).toBe(kind === 'normal');
  if (kind !== 'scan') expect(result).not.toContain('한도');
  for (const warning of warnings) expect(result).not.toContain(warning);
});

it('counts unresolved reasons in screen order, file statuses, external imports and Python guesses', () => {
  const map = empty(); map.files = [{ ...file('a'), relativePath: 'a.py', checked: 'partial' },
    { ...file('b'), checked: 'failed' }, { ...file('c'), checked: 'skipped' }, { ...file('d'), checked: 'not-code' }];
  const reasons: MapUnresolvedReason[] = ['unreadable', 'unavailable', 'syntax', 'not-static', 'outside', 'ambiguous', 'not-found', 'not-found'];
  map.unresolved = reasons.map(reason => ({ ...edge('a', 'b'), reason, candidates: ['b.ts'], reasonText: 'PRIVATE_REASON' }));
  map.external = [edge('a', 'outside')]; map.notes = ['PRIVATE_NOTE'];
  const result = markdown(map), unknown = section(result, '확인하지 못한 것');
  expect(unknown).toContain('- 확인 못 한 import 8개: 찾지 못함(파일이 없거나 탐색 목록에서 제외됨) 2개 · 후보 여럿 1개 · 프로젝트 밖 1개 · 정적 import 아님(동적 import·require) 1개 · import 문에 구문 오류 1개 · 대상을 지금 확인할 수 없음(삭제·제외·링크) 1개 · 경로 글을 그대로 읽을 수 없음(빈 경로·이스케이프 문자) 1개');
  expect(unknown).toContain('- 외부 패키지 또는 경로 별칭 import 1개');
  expect(unknown).toContain('- 다 읽지 못한 파일 3개(일부 조사 1개 · 읽기 실패 1개 · 읽지 않음 1개)');
  expect(unknown).toContain('- Python 추정 연결 3개는 이 문서에 넣지 않았어요.');
  for (const text of ['PRIVATE_IMPORT_TEXT', 'PRIVATE_SPECIFIER', 'PRIVATE_NOTE', 'PRIVATE_REASON']) expect(result).not.toContain(text);
  map.unresolved = map.unresolved.slice(0, 1);
  expect(section(markdown(map), '확인하지 못한 것')).not.toContain('후보 여럿');
  expect(markdown(map)).not.toContain('Python 추정 연결');
});

it.each(['src', ' src ', ' src', 'src ', '   ', '`src', 'src`', '```src``', 'a|b', 'a\nb\r\t\0\u007f\u2028\u2029'])('preserves the code-span name %j after CommonMark whitespace normalization', name => {
  const heading = mapMarkdown({ name, warnings: [] }, empty(), when).split('\n')[0];
  const match = /^# (`+)(.*?)\1 프로젝트 지도$/.exec(heading)!;
  expect(match).not.toBeNull();
  let displayed = match[2];
  if (displayed.startsWith(' ') && displayed.endsWith(' ') && !/^ *$/.test(displayed)) displayed = displayed.slice(1, -1);
  expect(displayed).toBe(name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
  expect(match[1].length).toBe(Math.max(0, ...Array.from(name.matchAll(/`+/g), match => match[0].length)) + 1);
});

it('keeps hostile project text inside code spans and allowlisted Mermaid labels', () => {
  const names = ['`|\n<script>![x](http://e)[a](b)"#quot;```', 'src/%%{wrap}%%', "%%{init: {'theme':'dark'}}%%"];
  const map = empty(); map.files = names.map((name, i) => ({ ...file(String(i), name), relativePath: name }));
  map.edges = [edge('0', '1'), edge('1', '2'), edge('2', '0')];
  map.reading = { steps: [{ kind: 'start', fileId: '0', reaches: 2 }], total: 1, incomplete: false };
  const text = mapMarkdown({ name: names[0], warnings: [] }, map, when);
  const diagram = text.match(/```mermaid\n([\s\S]*?)\n```/)![1];
  expect(text.match(/^```mermaid$/gm)).toHaveLength(1); expect(text.match(/^```$/gm)).toHaveLength(1);
  const labels = Array.from(diagram.matchAll(/f\d+\["(.*?)"\]/g), match => match[1]);
  expect(labels).toHaveLength(3);
  for (const value of labels) {
    expect(value).toMatch(/^(?:[\p{L}\p{N} /.\-_]|#\d+;)*$/u);
    expect(value).not.toMatch(/["`<%{']/);
  }
  const decoded = labels.map(value => value.replace(/#(\d+);/g, (_, point) => String.fromCodePoint(Number(point))));
  expect(decoded.sort()).toEqual(names.map(name => name.replace(/\n/g, ' ')).sort());
  const rest = text.replace(/```mermaid\n[\s\S]*?\n```/, '').split('\n').map(line => line.replace(/(`+)(.*?)\1/g, '')).join('\n');
  for (const token of ['<script>', '![x]', '[a](b)', '#quot;', 'wrap', 'theme', '%%']) expect(rest).not.toContain(token);
  for (const row of text.split('\n').filter(line => line.startsWith('| '))) expect(row.match(/(?<!\\)\|/g)).toHaveLength(5);
});

it('keeps bounded exports under the IPC cap and does not mutate the map', () => {
  // The full 1,024-character stress measurement is left to the planner; this checks all row caps together.
  const map = empty();
  for (let i = 0; i < 120; i++) {
    map.files.push(file(`f${i}`, `folder${i}`));
    map.edges.push(edge(`f${i}`, `f${(i + 1) % 120}`));
  }
  map.reading = { steps: map.files.slice(0, 30).map(item => ({ kind: 'next', fileId: item.id, depth: 1, usedBy: 1 })), total: 120, incomplete: false };
  const before = structuredClone(map);
  expect(markdown(map).length).toBeLessThan(MAP_EXPORT_MAX);
  expect(map).toEqual(before);
});

it('uses the shared scan warning for an actual traversal limit without changing existing scan tests', async () => {
  const { mkdtemp, mkdir, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { scanProject } = await import('../src/core/project/files');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'learning-map-scan-')));
  try {
    const folder = path.join(root, ...Array(21).fill('a'));
    await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'main.ts'), 'export const value = 1;');
    const scanned = await scanProject(root, 'test-project');
    expect(scanned.warnings).toContain(SCAN_LIMIT_WARNING);
    expect(mapMarkdown(scanned, empty(), when)).toContain('폴더를 열 때 탐색 한도에 닿아');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('formats the computer date rather than the UTC date', () => {
  vi.stubEnv('TZ', 'Asia/Seoul');
  try {
    const local = new Date(2026, 0, 2, 0, 1);
    expect(local.toISOString()).toContain('2026-01-01');
    expect(mapMarkdown(project, empty(), local)).toContain(' · 2026-01-02\n');
  } finally { vi.unstubAllEnvs(); }
});

it('keeps maximum-length paths below the export cap with every section at its limit', () => {
  for (const character of ['`', '"']) {
    const map = empty();
    for (let group = 0; group <= EXPORT_CYCLES; group++) {
      const members = Array.from({ length: EXPORT_CYCLE_FILES + 1 }, (_, i) => {
        const id = `${group}-${i}`, folder = `${character.repeat(900)}${id}`;
        return { ...file(id, folder), relativePath: `${folder}/${character.repeat(1023 - folder.length)}` };
      });
      map.files.push(...members);
      map.edges.push(...members.map((item, i) => edge(item.id, members[(i + 1) % members.length].id)));
    }
    map.reading = { steps: map.files.slice(0, 30).map(item => ({ kind: 'next', fileId: item.id, depth: 1, usedBy: 1 })), total: map.files.length, incomplete: true };
    const before = structuredClone(map);
    const result = mapMarkdown({ name: character.repeat(1024), warnings: [SCAN_LIMIT_WARNING] }, map, when);
    expect(map.files.every(file => file.relativePath.length === 1024)).toBe(true);
    expect(result.length).toBeLessThan(MAP_EXPORT_MAX);
    expect(result.match(/ -->\|1\| /g)).toHaveLength(EXPORT_ARROWS);
    expect(result.match(/^\| `/gm)).toHaveLength(EXPORT_ROWS);
    expect(map).toEqual(before);
  }
});
