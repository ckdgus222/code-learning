import { SCAN_LIMIT_WARNING, type MapUnresolvedReason, type ProjectMap, type ProjectView } from '../shared/contracts';
import { folderName, guessedLinks, importCycles, unresolvedLabels } from './map-layout';

export const EXPORT_ARROWS = 40, EXPORT_ROWS = 100, EXPORT_TOP_FILES = 10, EXPORT_CYCLES = 10, EXPORT_CYCLE_FILES = 10;

/**
 * Project text as a Markdown code span, so a file or folder name can never be read as a link, an image or HTML.
 * The fence is one backtick longer than any run inside. CommonMark strips one space from each end when both ends
 * are spaces, so a text that starts or ends with a backtick or a space gets one added on each side.
 */
function code(text: string, inTable = false): string {
  const clean = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  const ticks = '`'.repeat(Math.max(0, ...Array.from(clean.matchAll(/`+/g), match => match[0].length)) + 1);
  const padding = /^[` ]|[` ]$/.test(clean) && !/^ *$/.test(clean) ? ' ' : '';
  const content = inTable ? clean.replace(/\|/g, '\\|') : clean;
  return `${ticks}${padding}${content}${padding}${ticks}`;
}

/**
 * Project text inside a quoted Mermaid label. Only letters, digits, spaces and `/ . - _` stay as they are; every
 * other character becomes its number, because Mermaid reads more than quotes there (`%%{…}%%` changes the drawing).
 */
function label(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[^\p{L}\p{N} /.\-_]/gu, character => `#${character.codePointAt(0)};`);
}

/** Everything from the project is code or an encoded Mermaid label, never Markdown. */
export function mapMarkdown(project: Pick<ProjectView, 'name' | 'warnings'>, map: ProjectMap, when: Date): string {
  const files = new Map(map.files.map(file => [file.id, file]));
  const scanLimited = project.warnings.includes(SCAN_LIMIT_WARNING);
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  const lines = [`# ${code(project.name)} 프로젝트 지도`, '',
    `Code Learning이 프로젝트 파일을 읽어 만든 요약이에요. 파일 ${map.files.length}개 · 확정 import 연결 ${map.edges.length}개 · ${date}`, ''];
  if (map.limited || map.reading.incomplete || scanLimited) lines.push('> 지도가 다 보지 못한 파일이나 import가 있어 빠진 내용이 있을 수 있어요.', '');

  const folders = new Map<string, Map<string, { from: string; to: string; imports: ProjectMap['edges'] }>>();
  const users = new Map<string, Set<string>>();
  for (const edge of map.edges) {
    const from = files.get(edge.fromFileId), to = files.get(edge.toFileId);
    if (!from || !to) continue;
    if (from.id !== to.id) {
      if (!users.has(to.id)) users.set(to.id, new Set());
      users.get(to.id)!.add(from.id);
    }
    if (from.folder === to.folder) continue;
    if (!folders.has(from.folder)) folders.set(from.folder, new Map());
    const targets = folders.get(from.folder)!;
    if (!targets.has(to.folder)) targets.set(to.folder, { from: from.folder, to: to.folder, imports: [] });
    targets.get(to.folder)!.imports.push(edge);
  }
  const arrows = [...folders.values()].flatMap(targets => [...targets.values()])
    .sort((a, b) => b.imports.length - a.imports.length || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  lines.push('## 폴더 사이 연결', '');
  if (!arrows.length) lines.push('폴더 사이에 이어진 import가 없어요.', '');
  if (arrows.length) {
    const drawn = arrows.slice(0, EXPORT_ARROWS);
    const ids = new Map<string, string>();
    for (const folder of drawn.flatMap(arrow => [arrow.from, arrow.to])) {
      if (!ids.has(folder)) ids.set(folder, `f${ids.size}`);
    }
    lines.push('```mermaid', 'flowchart LR');
    for (const [folder, id] of ids) lines.push(`  ${id}["${folder ? label(folder) : folderName(folder)}"]`);
    for (const arrow of drawn) lines.push(`  ${ids.get(arrow.from)} -->|${arrow.imports.length}| ${ids.get(arrow.to)}`);
    lines.push('```', '');
    if (arrows.length > EXPORT_ARROWS) lines.push(`그림에는 import가 많은 연결 ${EXPORT_ARROWS}개만 그렸어요. 전체는 ${arrows.length}개예요.`, '');
    lines.push('| 쓰는 폴더 | 쓰이는 폴더 | import 수 | 예 |', '|---|---|---|---|');
    for (const arrow of arrows.slice(0, EXPORT_ROWS)) {
      const first = arrow.imports[0];
      lines.push(`| ${code(folderName(arrow.from), true)} | ${code(folderName(arrow.to), true)} | ${arrow.imports.length} | ${code(`${files.get(first.fromFileId)!.relativePath}:${first.startLine}`, true)} |`);
    }
    lines.push('');
    if (arrows.length > EXPORT_ROWS) lines.push(`이 밖에 ${arrows.length - EXPORT_ROWS}개가 더 있어요.`, '');
  }

  lines.push('## 이 순서로 읽어 보세요', '');
  const steps = map.reading.steps.filter(step => files.has(step.fileId));
  if (!steps.length) lines.push('읽는 순서를 정할 만한 import 연결이 없어요.');
  steps.forEach((step, index) => {
    const reason = step.kind === 'start' ? `시작 파일 후보 · 파일 ${step.reaches}개로 이어져요`
      : `시작에서 ${step.depth}걸음 · 파일 ${step.usedBy}개가 가져다 써요`;
    lines.push(`${index + 1}. ${code(files.get(step.fileId)!.relativePath)}: ${reason}`);
  });
  lines.push('');
  if (map.reading.total > steps.length) lines.push(`이 밖에 ${map.reading.total - steps.length}개가 더 있어요.`, '');

  lines.push('## 많이 쓰이는 파일', '');
  const popular = [...users].sort((a, b) => b[1].size - a[1].size || files.get(a[0])!.relativePath.localeCompare(files.get(b[0])!.relativePath));
  if (!popular.length) lines.push('다른 파일이 가져다 쓰는 파일이 없어요.');
  for (const [id, incoming] of popular.slice(0, EXPORT_TOP_FILES)) lines.push(`- ${code(files.get(id)!.relativePath)}: 파일 ${incoming.size}개가 가져다 써요`);

  lines.push('', '## 서로 가져다 쓰는 파일 묶음', '');
  const cycles = importCycles(map);
  if (!cycles.length) lines.push('서로 가져다 쓰는 파일 묶음이 없어요.');
  for (const cycle of cycles.slice(0, EXPORT_CYCLES)) {
    const names = cycle.files.slice(0, EXPORT_CYCLE_FILES).map(file => code(file.relativePath)).join(', ');
    const extra = cycle.files.length > EXPORT_CYCLE_FILES ? `, 그 밖에 ${cycle.files.length - EXPORT_CYCLE_FILES}개` : '';
    lines.push(`- 파일 ${cycle.files.length}개: ${names}${extra}`);
  }
  lines.push('');
  if (cycles.length > EXPORT_CYCLES) lines.push(`이 밖에 묶음 ${cycles.length - EXPORT_CYCLES}개가 더 있어요.`, '');

  lines.push('## 확인하지 못한 것', '');
  const unknown: string[] = [];
  const reasons = Object.keys(unresolvedLabels) as MapUnresolvedReason[];
  const counts = reasons.map(reason => ({ reason, count: map.unresolved.filter(item => item.reason === reason).length }));
  if (map.unresolved.length) unknown.push(`- 확인 못 한 import ${map.unresolved.length}개: ${counts.filter(item => item.count > 0).map(item => `${unresolvedLabels[item.reason]} ${item.count}개`).join(' · ')}`);
  if (map.external.length) unknown.push(`- 외부 패키지 또는 경로 별칭 import ${map.external.length}개`);
  const partial = map.files.filter(file => file.checked === 'partial').length;
  const failed = map.files.filter(file => file.checked === 'failed').length;
  const skipped = map.files.filter(file => file.checked === 'skipped').length;
  if (partial + failed + skipped) unknown.push(`- 다 읽지 못한 파일 ${partial + failed + skipped}개(일부 조사 ${partial}개 · 읽기 실패 ${failed}개 · 읽지 않음 ${skipped}개)`);
  if (scanLimited) unknown.push('- 폴더를 열 때 탐색 한도에 닿아 일부 파일을 모으지 못했어요. 그 파일들은 이 문서에 없어요.');
  if (map.limited || map.reading.incomplete) unknown.push('- 일부 파일이나 import를 확인하지 못해 빠진 내용이 있을 수 있어요.');
  const guesses = guessedLinks(map).length;
  if (guesses) unknown.push(`- Python 추정 연결 ${guesses}개는 이 문서에 넣지 않았어요.`);
  lines.push(...(unknown.length ? unknown : ['확인하지 못한 import가 없어요.']), '', '## 읽을 때 알아둘 점', '',
    '- 실행 순서가 아니라 TS/JS와 Python 파일의 import 연결이에요.',
    '- 프로젝트를 실행하지 않고 파일만 읽어서 만들었어요.',
    '- 폴더 사이 연결과 순서는 대상이 하나로 정해진 import만 셌어요.',
    '- 폴더를 열 때 모은 파일만 다뤄요. 제외된 폴더와 파일은 들어 있지 않아요.');
  return `${lines.join('\n')}\n`;
}
