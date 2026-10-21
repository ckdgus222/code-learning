import React, { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, keymap, type KeyBinding } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import {
  cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorLineDown,
  cursorLineUp, cursorPageDown, cursorPageUp, selectAll, selectCharLeft, selectCharRight, selectDocEnd, selectDocStart,
  selectLineBoundaryBackward, selectLineBoundaryForward, selectLineDown, selectLineUp, selectPageDown, selectPageUp,
} from '@codemirror/commands';
import { codeTheme, codeHighlightStyle } from './code-theme';
import { javascript } from '@codemirror/lang-javascript';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import type { Evidence, SourceView } from '../shared/contracts';

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

export interface ReaderHandle { openSearch(): void }

export function Reader({ source, evidence, codeSize, wrap, ref }: {
  source: SourceView; evidence: Evidence | null; codeSize: number; wrap: boolean; ref?: Ref<ReaderHandle>;
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
        codeTheme, lineNumbers(), drawSelection(), keymap.of([...readingKeys, ...searchKeymap]), search({ top: true }), searchPhrases,
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
