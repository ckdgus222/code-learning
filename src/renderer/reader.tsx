import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, keymap, type KeyBinding } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorLineDown,
  cursorLineUp, cursorPageDown, cursorPageUp, selectAll, selectCharLeft, selectCharRight, selectDocEnd, selectDocStart,
  selectLineBoundaryBackward, selectLineBoundaryForward, selectLineDown, selectLineUp, selectPageDown, selectPageUp,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
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

export function Reader({ source, evidence }: { source: SourceView; evidence: Evidence | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: source.text,
      extensions: [
        // Keep CR and BOM characters rather than silently changing raw-source offsets.
        EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true), EditorView.editable.of(false),
        lineNumbers(), drawSelection(), keymap.of(readingKeys),
        // A non-editable element takes keyboard focus only with a tabindex (CodeMirror read-only example).
        EditorView.contentAttributes.of({ 'aria-label': '원본 코드 (읽기 전용)', role: 'textbox', 'aria-readonly': 'true', tabindex: '0' }),
        ...(source.analysis.language !== 'text' ? [javascript({ typescript: source.analysis.language === 'typescript', jsx: true }),
          // The language support parses; this is what colours keywords, strings and comments.
          syntaxHighlighting(defaultHighlightStyle)] : []),
      ],
    }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [source]);
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
