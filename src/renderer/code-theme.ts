import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import type { SourceLanguage } from '../shared/languages';

// Unlike CodeMirror's default, cover all bidi controls and word joiners, but keep CRLF unmarked.
export const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff\ufff9-\ufffc]/gu;

// Shared by the reader and both sides of a comparison, including plain text files.
export const codeTheme = EditorView.theme({
  '&': { color: 'var(--code-ink)', backgroundColor: 'var(--surface)' },
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
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName),
    tags.function(tags.definition(tags.variableName)), tags.function(tags.definition(tags.propertyName))], color: 'var(--syntax-function)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--syntax-property)' },
  { tag: tags.definition(tags.variableName), color: 'var(--code-ink)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.string, tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
]);

/** The parser and colours for a language. Plain text gets none. */
export function codeHighlighting(language: SourceLanguage): Extension[] {
  switch (language) {
    case 'text': return [];
    case 'python': return [python(), syntaxHighlighting(codeHighlightStyle)];
    case 'typescript': case 'javascript':
      return [javascript({ typescript: language === 'typescript', jsx: true }), syntaxHighlighting(codeHighlightStyle)];
  }
}
