import { useEffect, useRef } from 'react';
import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { tags as t } from '@lezer/highlight';

/** Cores do painel: ciano só em palavras-chave e tipos; strings e números em cinza claro; erro em laranja. */
const theme = EditorView.theme({
  '&': { backgroundColor: '#070B0F', color: '#D9E6EC', fontSize: '15px', borderRadius: '12px', border: '1px solid #263645' },
  '&.cm-focused': { outline: 'none', borderColor: '#45D0E6' },
  '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.6', padding: '8px 0' },
  '.cm-content': { caretColor: '#45D0E6', padding: '0 8px' },
  '.cm-cursor': { borderLeftColor: '#45D0E6', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: '#070B0F', color: '#8AA0AE', border: 'none', paddingLeft: '8px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#D9E6EC' },
  '.cm-activeLine': { backgroundColor: 'rgba(69, 208, 230, 0.05)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(69, 208, 230, 0.22) !important' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(69, 208, 230, 0.25)', outline: '1px solid #45D0E6' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgba(242, 166, 90, 0.35)' },
  '.cm-line-error': { backgroundColor: 'rgba(242, 166, 90, 0.16)', borderLeft: '3px solid #F2A65A' },
  '.cm-gutter-error': { color: '#F2A65A', fontWeight: '700' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: '#45D0E6' },
  { tag: [t.typeName, t.className, t.standard(t.typeName)], color: '#9BE3EF' },
  { tag: [t.string, t.special(t.string)], color: '#C9D6A3' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#E6C79C' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8AA0AE', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#D9E6EC' },
  { tag: [t.operator, t.punctuation], color: '#AFC2CC' },
]);

const setErrors = StateEffect.define<number[]>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrors)) {
        const lines = e.value.filter((n) => n >= 1 && n <= tr.state.doc.lines);
        deco = Decoration.set(lines.map((n) => Decoration.line({ class: 'cm-line-error' }).range(tr.state.doc.line(n).from)), true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface EditorProps {
  value: string; onChange: (v: string) => void;
  /** Linhas com erro de compilação (1-based). */
  errorLines?: number[];
  onRun?: () => void;
  readOnly?: boolean;
  minLines?: number;
  ariaLabel?: string;
}

/** Editor de C# com números de linha, pares de chaves, indentação e a linha do erro marcada. Cmd+Enter roda. */
export function Editor({ value, onChange, errorLines = [], onRun, readOnly = false, minLines = 14, ariaLabel = 'Seu código C#' }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onRunRef = useRef(onRun); onRunRef.current = onRun;
  const ro = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const exts: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(),
      bracketMatching(), closeBrackets(), indentOnInput(), StreamLanguage.define(csharp), syntaxHighlighting(highlight), theme, errorField,
      EditorState.tabSize.of(4),
      keymap.of([
        { key: 'Mod-Enter', run: () => { onRunRef.current?.(); return true; } },
        indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      ro.current.of(EditorState.readOnly.of(readOnly)),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions: exts }), parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // O editor é criado uma vez; valor e erros entram pelos efeitos abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setErrors.of(errorLines) });
    const first = errorLines.find((n) => n >= 1 && n <= v.state.doc.lines);
    if (first) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(first).from, { y: 'center' }) });
  }, [errorLines]);

  return <div ref={host} className="cm-host" style={{ minHeight: `${minLines * 24 + 16}px` }} />;
}
