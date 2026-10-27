import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Shared by the reader and both sides of a comparison, including plain text files.
export const codeTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--surface)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': { color: 'var(--dim)', backgroundColor: 'var(--surface)', borderColor: 'var(--line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--mark)' },
  '.cm-content ::selection, .cm-content::selection': { backgroundColor: 'var(--mark)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panels': { color: 'var(--ink)', backgroundColor: 'var(--side)' },
  '.cm-search': { borderColor: 'var(--line)' },
  '.cm-textfield, .cm-button, .cm-button:active': { color: 'var(--ink)', background: 'var(--raised)', border: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--mark)' },
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'var(--danger-soft)' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'var(--ok-soft)' },
  '&.cm-merge-a .cm-changedText': { background: 'var(--danger-soft)', textDecoration: 'underline var(--danger)' },
  '&.cm-merge-b .cm-changedText': { background: 'var(--ok-soft)', textDecoration: 'underline var(--ok)' },
  '&.cm-merge-a .cm-changedLineGutter': { backgroundColor: 'var(--danger)' },
  '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: 'var(--ok)' },
  '.cm-collapsedLines': { color: 'var(--muted)', background: 'var(--side)' },
});

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--muted)' },
]);
