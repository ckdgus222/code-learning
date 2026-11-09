import React, { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Compartment, EditorState, RangeSet } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, lineNumbers, drawSelection, highlightSpecialChars, keymap, type KeyBinding } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import {
  cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorLineDown,
  cursorLineUp, cursorPageDown, cursorPageUp, selectAll, selectCharLeft, selectCharRight, selectDocEnd, selectDocStart,
  selectLineBoundaryBackward, selectLineBoundaryForward, selectLineDown, selectLineUp, selectPageDown, selectPageUp,
} from '@codemirror/commands';
import { codeTheme, codeHighlightStyle, HIDDEN_CHARS } from './code-theme';
import { javascript } from '@codemirror/lang-javascript';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import type { CodeStep, Evidence, SourceView } from '../shared/contracts';
import { groupStepMarkers, type StepMarkerGroup } from './step-markers';
import { functionBands, type FunctionBandItem } from './code-bands';

// Reading only: move, select and select all. Copying is the browser's own, and Tab is left unbound so
// it moves focus out of the code as anywhere else.
const readingKeys: KeyBinding[] = [
  { key: 'ArrowLeft', run: cursorCharLeft, shift: selectCharLeft },
  { key: 'ArrowRight', run: cursorCharRight, shift: selectCharRight },
  { key: 'ArrowUp', run: cursorLineUp, shift: selectLineUp },
  { key: 'ArrowDown', run: cursorLineDown, shift: selectLineDown },
  { key: 'Home', mac: 'Cmd-ArrowLeft', run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward },
  { key: 'End', mac: 'Cmd-ArrowRight', run: cursorLineBoundaryForward, shift: selectLineBoundaryForward },
  { key: 'PageUp', run: cursorPageUp, shift: selectPageUp },
  { key: 'PageDown', run: cursorPageDown, shift: selectPageDown },
  { key: 'Mod-Home', mac: 'Cmd-ArrowUp', run: cursorDocStart, shift: selectDocStart },
  { key: 'Mod-End', mac: 'Cmd-ArrowDown', run: cursorDocEnd, shift: selectDocEnd },
  { key: 'Mod-a', run: selectAll },
];

// Korean labels for the search panel. In a read-only editor the panel leaves out the replace field and
// buttons, so their labels are never shown.
const searchPhrases = EditorState.phrases.of({
  'Find': '찾기', 'next': '다음', 'previous': '이전', 'all': '모두 선택', 'match case': '대소문자 구분',
  'regexp': '정규식', 'by word': '단어 단위', 'close': '닫기', 'current match': '현재 찾은 곳', 'on line': '줄',
  'Go to line': '줄 번호로 이동', 'go': '이동',
});
const wrapping = new Compartment();
// The code text size goes in through a theme: CodeMirror measures its lines again when the theme
// changes, but not when outside CSS does, which would leave the line numbers at the old height.
const sizing = new Compartment();
const sizeTheme = (px: number) => EditorView.theme({ '.cm-scroller': { fontSize: `${px}px` } });
const stepGutter = new Compartment();
const functionBandsCompartment = new Compartment();
const selectedFunction = new Compartment();

class FunctionHeader extends WidgetType {
  constructor(readonly items: FunctionBandItem[], readonly locked: boolean, readonly onFunction: (id: string) => void) { super(); }

  toDOM() {
    const header = document.createElement('div');
    header.className = 'code-function-header';
    for (const item of this.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `code-function-button cm-function-band--${item.kind}`;
      button.dataset.symbolId = item.symbolId;
      button.textContent = item.text;
      button.title = item.text;
      button.tabIndex = -1;
      button.disabled = this.locked;
      button.onclick = () => { if (!this.locked) this.onFunction(item.symbolId); };
      header.append(button);
    }
    return header;
  }
}

class StepMarker extends GutterMarker {
  constructor(readonly group: StepMarkerGroup, readonly selected: boolean, readonly locked: boolean,
    readonly onStep: (step: CodeStep) => void) { super(); }

  toDOM() {
    const button = document.createElement('button');
    const first = this.group.steps[0];
    button.type = 'button';
    button.className = 'code-step-marker';
    button.textContent = `${this.group.number}${this.group.steps.length > 1 ? '+' : ''}`;
    button.title = `${this.group.number}단계 · ${first.title}`;
    button.tabIndex = -1;
    button.disabled = this.locked;
    button.setAttribute('aria-pressed', String(this.selected));
    button.onclick = () => { if (!this.locked) this.onStep(first); };
    return button;
  }
}

export interface ReaderHandle { openSearch(): void }

export function Reader({ source, evidence, codeSize, wrap, symbolId, stepId, locked, onStep, bands = false, tint = false, onFunction, ref }: {
  source: SourceView; evidence: Evidence | null; codeSize: number; wrap: boolean; ref?: Ref<ReaderHandle>;
  bands?: boolean; tint?: boolean; onFunction?: (symbolId: string) => void;
  symbolId: string | null; stepId: string | null; locked: boolean; onStep?: (step: CodeStep) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useImperativeHandle(ref, () => ({ openSearch: () => { if (view.current) openSearchPanel(view.current); } }), []);
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: source.text,
      extensions: [
        // Keep CR and BOM characters rather than silently changing raw-source offsets.
        EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true), EditorView.editable.of(false),
        highlightSpecialChars({ specialChars: HIDDEN_CHARS }),
        codeTheme, stepGutter.of([]), functionBandsCompartment.of([]), selectedFunction.of([]), lineNumbers(), drawSelection(), keymap.of([...readingKeys, ...searchKeymap]), search({ top: true }), searchPhrases,
        // A new editor is made for each file and starts with the current choices; later changes reconfigure it.
        wrapping.of(wrap ? EditorView.lineWrapping : []), sizing.of(sizeTheme(codeSize)),
        // A non-editable element takes keyboard focus only with a tabindex (CodeMirror read-only example).
        EditorView.contentAttributes.of({ 'aria-label': '원본 코드 (읽기 전용)', role: 'textbox', 'aria-readonly': 'true', tabindex: '0' }),
        ...(source.analysis.language !== 'text' ? [javascript({ typescript: source.analysis.language === 'typescript', jsx: true }),
          // The language support parses; this is what colours keywords, strings and comments.
          syntaxHighlighting(codeHighlightStyle)] : []),
      ],
    }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [source]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const symbol = tint ? source.analysis.symbols.find(item => item.id === symbolId) : undefined;
    const range = symbol?.evidence;
    if (!range || range.startLine < 1 || range.endLine < range.startLine || range.endLine > editor.state.doc.lines) {
      editor.dispatch({ effects: selectedFunction.reconfigure([]) });
      return;
    }
    const lines = [];
    for (let line = range.startLine; line <= range.endLine; line++) {
      lines.push(Decoration.line({ class: 'cm-selected-function' }).range(editor.state.doc.line(line).from));
    }
    editor.dispatch({ effects: selectedFunction.reconfigure(EditorView.decorations.of(Decoration.set(lines))) });
  }, [source, symbolId, tint]);
  // The parent passes a new handler on every render; reading the latest one here keeps the gutter from being rebuilt each time.
  const latestOnStep = useRef(onStep);
  useEffect(() => { latestOnStep.current = onStep; });
  const latestOnFunction = useRef(onFunction);
  useEffect(() => { latestOnFunction.current = onFunction; });
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!bands) { editor.dispatch({ effects: functionBandsCompartment.reconfigure([]) }); return; }
    const groups = functionBands(source.analysis, source.guide, editor.state.doc.lines);
    const headers = groups.headers.map(header => Decoration.widget({
      widget: new FunctionHeader(header.items, locked, id => latestOnFunction.current?.(id)), block: true, side: -1,
    }).range(editor.state.doc.line(header.line).from));
    const lines = groups.lines.map(line => Decoration.line({ class: `cm-function-band cm-function-band--${line.kind}` })
      .range(editor.state.doc.line(line.line).from));
    editor.dispatch({ effects: functionBandsCompartment.reconfigure(EditorView.decorations.of(Decoration.set([...headers, ...lines], true))) });
  }, [source, bands, locked]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const symbol = source.analysis.symbols.find(item => item.id === symbolId);
    const groups = groupStepMarkers(symbol);
    const markers = RangeSet.of(groups.map(group => new StepMarker(group, group.steps.some(step => step.id === stepId), locked,
      step => latestOnStep.current?.(step)).range(editor.state.doc.line(group.line).from)));
    editor.dispatch({ effects: stepGutter.reconfigure(groups.length ? gutter({
      class: 'cm-step-gutter', markers: () => markers,
    }) : []) });
  }, [source, symbolId, stepId, locked]);
  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  useEffect(() => {
    view.current?.dispatch({ effects: sizing.reconfigure(sizeTheme(codeSize)) });
  }, [codeSize]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!evidence) { editor.dispatch({ selection: { anchor: 0 } }); return; }
    if (evidence.fileHash !== source.hash || evidence.fileId !== source.fileId || evidence.projectId !== source.projectId ||
      evidence.startUtf16 < 0 || evidence.endUtf16 > source.text.length) return;
    editor.dispatch({ selection: { anchor: evidence.startUtf16, head: evidence.endUtf16 }, scrollIntoView: true });
  }, [source, evidence]);
  return <div ref={host} data-testid="source-editor" />;
}
