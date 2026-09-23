import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * The editor in Notea's own colours, so it sits in the workspace instead of on top of
 * it: the canvas behind the text, green for keywords and the cursor, a warm tone for
 * strings, quiet grey for comments.
 */
const chrome = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--color-canvas)',
      color: '#d9dcd3',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-content': {
      padding: '10px 0 24px',
      caretColor: 'var(--color-accent)',
    },
    '.cm-line': {
      padding: '0 16px 0 6px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-accent)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgb(124 196 160 / 0.2)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgb(124 196 160 / 0.12)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgb(255 255 255 / 0.028)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-canvas)',
      color: '#4b524d',
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 6px',
      minWidth: '32px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--color-fg-muted)',
    },
    '.cm-foldGutter .cm-gutterElement': {
      color: '#4b524d',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-strong)',
      color: 'var(--color-fg-muted)',
      borderRadius: '4px',
      padding: '0 4px',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgb(124 196 160 / 0.16)',
      outline: '1px solid rgb(124 196 160 / 0.35)',
    },
    '&.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: 'rgb(236 124 115 / 0.18)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgb(220 174 90 / 0.22)',
      outline: '1px solid rgb(220 174 90 / 0.4)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgb(220 174 90 / 0.38)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-panel)',
      color: 'var(--color-fg)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--color-line)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--color-line)',
    },
    '.cm-panel input, .cm-panel button, .cm-textfield': {
      fontFamily: 'var(--font-sans)',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--color-canvas)',
      border: '1px solid #333c36',
      borderRadius: '5px',
      color: 'var(--color-fg)',
    },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: '5px',
      color: 'var(--color-fg)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: '8px',
      color: 'var(--color-fg)',
      boxShadow: '0 12px 32px -12px rgb(0 0 0 / 0.8)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-selected)',
      color: 'var(--color-fg)',
    },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#8fcfae' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#d9dcd3' },
  { tag: [t.propertyName], color: '#c5d0c8' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#e9e3c9' },
  { tag: [t.definition(t.name), t.separator], color: '#d9dcd3' },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.modifier, t.self], color: '#a9c6e6' },
  { tag: [t.number, t.bool, t.atom, t.constant(t.name), t.standard(t.name), t.special(t.variableName)], color: '#c4b0ef' },
  { tag: [t.string, t.special(t.string), t.inserted, t.processingInstruction], color: '#dcb67c' },
  { tag: [t.regexp, t.escape, t.url], color: '#e0a58a' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#9aa39c' },
  { tag: [t.comment, t.meta], color: '#697169', fontStyle: 'italic' },
  { tag: t.heading, color: '#ecede6', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#8fb4e6', textDecoration: 'underline' },
  { tag: t.invalid, color: '#ec7c73' },
]);

export const noteaEditorTheme = [chrome, syntaxHighlighting(highlight)];
