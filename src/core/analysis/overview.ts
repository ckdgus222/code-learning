import path from 'node:path';
import type { ProjectFile, ProjectFiles, ProjectIntro, ProjectOverview, StartCandidate } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { readAllowed } from '../project/files';
import { analyzeSource } from './syntax';
import { closesMarkdownFence, openMarkdownFence, type MarkdownFence } from './markdown-fence';

// Opening a project waits for this, so only a bounded number of files is read and parsed.
const MAX_CHECKED_FILES = 20;
const MAX_CANDIDATES = 8;
const MAX_INTRO = 400;
const codeFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const entryName = /^(?:[^/]+\/)?(?:src\/)?(?:index|main|app)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
// An extensionless README is excluded by the file policy, so it is not looked for here.
const readmeName = /^readme\.(?:md|txt)$/i;
const atxHeading = /^#{1,6}(?:\s|$)/;
// `===`/`---` under a line makes it a heading; on its own, `---` is a divider like `***`.
const underline = /^(?:=+|-+)$/;
const divider = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// Paragraphs that are layout rather than prose: images and badges, tables.
const layout = /^(?:!\[|\[!|\|)/;
// CommonMark 4.6 type 6: a block-level tag starts an HTML block that runs to the next blank line.
const htmlBlockTag = new RegExp(`^</?(?:${[
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd',
  'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu',
  'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
].join('|')})(?:\\s|/?>|$)`, 'i');
// Type 7: one complete open or closing tag alone on its line. It cannot interrupt a paragraph, and
// a tag followed by text (`<strong>Name</strong> does …`) or an autolink (`<https://…>`) is prose.
const htmlTagLine = /^(?:<[a-z][a-z0-9-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[a-z][a-z0-9-]*\s*>)$/i;

/**
 * HTML blocks that, in CommonMark (4.6), run past blank lines until a closing marker.
 * Other HTML blocks such as `<div>` end at a blank line, so text after one is a real paragraph.
 */
function closingMarkers(line: string): string[] | null {
  if (line.startsWith('<!--')) return ['-->'];
  // Any of the four closing tags ends one of these blocks, matched without case.
  if (/^<(?:pre|script|style|textarea)(?:\s|>|$)/i.test(line)) return ['</pre>', '</script>', '</style>', '</textarea>'];
  if (line.startsWith('<?')) return ['?>'];
  if (line.startsWith('<![CDATA[')) return [']]>'];
  if (/^<![a-z]/i.test(line)) return ['>'];
  return null;
}

const clip = (value: string, limit: number): string => value.length > limit ? `${value.slice(0, limit)}…` : value;
const depth = (file: ProjectFile): number => file.relativePath.split('/').length;
const byDepthThenPath = (a: ProjectFile, b: ProjectFile): number =>
  depth(a) - depth(b) || a.relativePath.localeCompare(b.relativePath);

/**
 * What a first look at the project can show without AI: the README's own introduction and
 * places that look like starting points. Files are only read as text, never run, and every
 * start point is a candidate chosen from code structure, not a confirmed entry point.
 */
export async function buildOverview(root: string, project: ProjectFiles, shouldStop: () => boolean = () => false): Promise<ProjectOverview> {
  const notes: string[] = [];
  const intro = await readIntro(root, project.files);
  const order = await candidateFiles(root, project.files, notes);

  const entryFileIds = order.filter(([, reason]) => reason !== 'exported').map(([file]) => file.id);
  const candidates: StartCandidate[] = [];
  let examined = 0;
  let checkedFiles = 0;
  let unreadable = 0;
  for (const [file, reason] of order) {
    if (examined >= MAX_CHECKED_FILES || candidates.length >= MAX_CANDIDATES) break;
    examined++;
    let source: { text: string; hash: string };
    try { source = await readAllowed(root, file.relativePath); } catch { unreadable++; continue; }
    checkedFiles++;
    // Checked before each parse: the session ends this worker only after it stops (project-session.ts).
    if (shouldStop()) throw new AppError('CANCELLED', '작업을 취소했습니다.');
    const analysis = analyzeSource(source.text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: source.hash });
    const base = { fileId: file.id, relativePath: file.relativePath, reason, fileHash: source.hash };
    const exported = analysis.symbols.filter(symbol => symbol.exported);
    for (const symbol of exported) {
      candidates.push({ ...base, name: symbol.name, startUtf16: symbol.evidence.startUtf16, startLine: symbol.evidence.startLine });
    }
    // A named entry file is worth opening even when it exports nothing (a script that runs at the top).
    if (exported.length === 0 && reason !== 'exported') candidates.push({ ...base, name: null, startUtf16: 0, startLine: 1 });
  }
  if (unreadable) notes.push(`읽지 못한 파일 ${unreadable}개는 건너뛰었어요.`);
  return { intro, entryFileIds, candidates: candidates.slice(0, MAX_CANDIDATES), checkedFiles, limited: examined < order.length, notes };
}

// README display text loses its Markdown marks in three passes. A URL or an HTML tag is matched first in the
// later two and kept as written, so marks inside it (`a_b`, `*`) are left alone.
/** `#` heading marks at a line start (a heading inside a quote keeps them in the text). */
const headingMark = /^ {0,3}#{1,6}(?:\s+|$)/gm;
/** `![alt](src)` and `[text](href)`, which keep only their label. */
const urlTagOrLink = /https?:\/\/[^\s<>]+|<[^>\n]+>|!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
/** Inline code, and emphasis that starts and ends at a word boundary (so `snake_case` and `a*b*c` stay), keep their content. */
const codeOrEmphasis = /(`+)([^\n]*?)\1|https?:\/\/[^\s<>]+|<[^>\n]+>|(?<![\p{L}\p{N}_*])(\*\*|__|\*|_)(?=\S)([^\n]*?\S)\3(?![\p{L}\p{N}_*])/gu;

/** Plain display text only; source lines and HTML handling stay unchanged. */
function introText(value: string): string {
  return value.replace(headingMark, '')
    .replace(urlTagOrLink, (match, label: string | undefined) => label ?? match)
    .replace(codeOrEmphasis, (match, ticks: string | undefined, code: string, marker: string | undefined, content: string) =>
      ticks ? code : marker ? content : match)
    .trim();
}

/** The first nonempty heading and introduction paragraph of a root README. */
async function readIntro(root: string, files: ProjectFile[]): Promise<ProjectIntro | null> {
  const readme = files.find(file => readmeName.test(file.relativePath));
  if (!readme) return null;
  let text: string;
  try { ({ text } = await readAllowed(root, readme.relativePath)); } catch { return null; }

  // A CommonMark-shaped line walk, checked in this order so nothing inside code or HTML is read
  // as a heading or paragraph: open fence/HTML → blank line → open HTML or indented code →
  // block starts (indent of 3 or less) → paragraph text. An HTML block runs to the next blank
  // line; indented code ends at the first less indented line, which is then read again.
  type Block = { start: number; lines: string[]; kind: 'prose' | 'quote' | 'layout' | 'html' | 'code' };
  let title: string | null = null;
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fence: MarkdownFence | null = null;
  let htmlUntil: string[] | null = null;
  const closes = (line: string, markers: string[], from = 0) => markers.some(marker => line.toLowerCase().includes(marker, from));
  const startBlock = (index: number, line: string, kind: Block['kind']) => {
    current = { start: index + 1, lines: [line], kind };
    blocks.push(current);
  };
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const indent = /^[ \t]*/.exec(raw)![0].replace(/\t/g, '    ').length;
    // Inside fenced code only a closing fence of the same character and at least the same length
    // counts; inside marker-closed HTML only its marker. Blank lines do not end either, and an
    // unclosed one hides the rest of the file.
    if (fence) {
      if (closesMarkdownFence(raw, fence)) fence = null;
      return;
    }
    if (htmlUntil) {
      if (closes(line, htmlUntil)) htmlUntil = null;
      return;
    }
    if (!line) { current = null; return; }
    if (current?.kind === 'html') { current.lines.push(line); return; }
    if (current?.kind === 'code') {
      if (indent >= 4) { current.lines.push(line); return; }
      current = null;
    }
    // Four spaces start indented code between blocks; inside a paragraph they only continue it.
    if (indent >= 4) {
      if (current) current.lines.push(line);
      else startBlock(index, line, 'code');
      return;
    }
    const opening = openMarkdownFence(raw);
    if (opening) { fence = opening; current = null; return; }
    const markers = closingMarkers(line);
    if (markers) {
      // Offset 2 skips the opening `<!`/`<?`/`<p` so an opener cannot close itself.
      if (!closes(line, markers, 2)) htmlUntil = markers;
      current = null;
      return;
    }
    if (htmlBlockTag.test(line) || (!current && htmlTagLine.test(line))) { startBlock(index, line, 'html'); return; }
    if (/^ {0,3}>/.test(raw)) {
      const quoted = raw.replace(/^ {0,3}> ?/, '');
      if (current?.kind === 'quote') current.lines.push(quoted);
      else startBlock(index, quoted, 'quote');
      return;
    }
    if (atxHeading.test(line)) { title ??= introText(line) || null; current = null; return; }
    if (underline.test(line) || divider.test(line)) {
      // Under a paragraph `===`/`---` makes it a heading; anything else is a divider.
      if (current && (current.kind === 'prose' || current.kind === 'layout') && underline.test(line)) {
        blocks.pop();
        if (current.kind === 'prose') title ??= introText(current.lines.join(' ')) || null;
      }
      current = null;
      return;
    }
    // Text right under a badge or image line shares its paragraph; keep that text as prose.
    if (current && current.kind !== 'quote' && !(current.kind === 'layout' && !layout.test(line))) current.lines.push(line);
    else startBlock(index, line, layout.test(line) ? 'layout' : 'prose');
  });
  const prose = blocks.find(block => (block.kind === 'prose' || block.kind === 'quote')
    && !(block.kind === 'quote' && /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.test(block.lines[0].trim()))
    && introText(block.lines.join('\n')));
  if (!title && !prose) return null;
  return {
    fileId: readme.id, relativePath: readme.relativePath, title: title === null ? null : clip(title, 120),
    text: prose ? clip(introText(prose.lines.join('\n')), MAX_INTRO) : null,
    startLine: prose?.start ?? null, endLine: prose ? prose.start + prose.lines.length - 1 : null,
  };
}

/** TS/JS files in the order they are worth checking: package.json targets, entry names, then the rest. */
async function candidateFiles(root: string, files: ProjectFile[], notes: string[]): Promise<[ProjectFile, StartCandidate['reason']][]> {
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const order = new Map<ProjectFile, StartCandidate['reason']>();
  const add = (file: ProjectFile, reason: StartCandidate['reason']) => {
    if (codeFile.test(file.relativePath) && !order.has(file)) order.set(file, reason);
  };

  if (byPath.has('package.json')) {
    try {
      const data: unknown = JSON.parse((await readAllowed(root, 'package.json')).text);
      const fields = data && typeof data === 'object' ? data as { main?: unknown; bin?: unknown } : {};
      const targets: [unknown, 'package-main' | 'package-bin'][] = [[fields.main, 'package-main'],
        ...(fields.bin && typeof fields.bin === 'object' ? Object.values(fields.bin) : [fields.bin]).map(value => [value, 'package-bin'] as [unknown, 'package-bin'])];
      for (const [target, reason] of targets) {
        if (typeof target !== 'string') continue;
        const relative = path.posix.normalize(target.replace(/^\.\//, ''));
        const file = relative.startsWith('..') || path.posix.isAbsolute(relative) ? undefined : byPath.get(relative);
        if (file) add(file, reason);
        else notes.push(`package.json의 ${reason === 'package-main' ? 'main' : 'bin'}(${clip(target, 80)})은 제외되었거나 없는 파일이라 살펴보지 않았어요.`);
      }
    } catch {
      notes.push('package.json을 읽거나 해석하지 못해 그 안의 시작 파일은 살펴보지 않았어요.');
    }
  }
  for (const file of files.filter(item => entryName.test(item.relativePath)).sort(byDepthThenPath)) add(file, 'entry-name');
  for (const file of [...files].sort(byDepthThenPath)) add(file, 'exported');
  return [...order];
}
