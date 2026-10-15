import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import type { Evidence, SourceView } from '../shared/contracts';

export function Reader({ source, evidence }: { source: SourceView; evidence: Evidence | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: source.text,
      extensions: [
        // Keep CR and BOM characters rather than silently changing raw-source offsets.
        EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true), EditorView.editable.of(false),
        lineNumbers(), drawSelection(), keymap.of([]),
        EditorView.contentAttributes.of({ 'aria-label': '원본 코드 (읽기 전용)', role: 'textbox' }),
        ...(source.analysis.language !== 'text' ? [javascript({ typescript: source.analysis.language === 'typescript', jsx: true })] : []),
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
