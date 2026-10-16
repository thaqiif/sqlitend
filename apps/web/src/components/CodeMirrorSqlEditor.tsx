import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { sql, SQLite } from "@codemirror/lang-sql";
import type { TableSchemaItem } from "@sqlitend/shared";

interface Props {
  value: string;
  onChange: (next: string) => void;
  onRun: (selectionOrFull: string) => void;
  tables: TableSchemaItem[];
  placeholder?: string;
}

// Colours come from HeroUI's CSS variables (and the --sql-* tokens in styles.css), so the editor
// follows light/dark without rebuilding the CodeMirror state.
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.875rem",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    backgroundColor: "var(--field-background)",
    color: "var(--field-foreground)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--focus)",
    outlineOffset: "1px",
  },
  ".cm-scroller": { fontFamily: "inherit", maxHeight: "50vh" },
  ".cm-content": {
    padding: "0.65rem 0",
    minHeight: "160px",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0 0.65rem" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-secondary)",
    color: "var(--muted)",
    border: "none",
    borderRight: "1px solid var(--separator)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-tertiary)" },
  ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft-hover)" },
  ".cm-placeholder": { color: "var(--field-placeholder)" },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--overlay)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--overlay-foreground)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  // 16px stops iOS Safari zooming the page when the editor is focused.
  "@media (max-width: 599px)": { "&": { fontSize: "16px" } },
});

const sqlHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--sql-keyword)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--sql-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--sql-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--sql-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--muted)" },
]);

function schemaOf(tables: TableSchemaItem[]): Record<string, string[]> {
  return Object.fromEntries(tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
}

const sqlLang = (tables: TableSchemaItem[]) => sql({ dialect: SQLite, schema: schemaOf(tables), upperCaseKeywords: true });

export function CodeMirrorSqlEditor({ value, onChange, onRun, tables, placeholder }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartmentRef = useRef(new Compartment());
  // Latest props for the mount-once editor: callbacks are read at event time, and the first-render
  // values seed the initial state. Later changes of value/tables are synced by the effects below.
  const latest = useRef({ value, tables, placeholder, onRun, onChange });
  latest.current = { value, tables, placeholder, onRun, onChange };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const runCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      const selectedText = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to).trim();
      latest.current.onRun(selectedText.length > 0 ? selectedText : view.state.doc.toString());
      return true;
    };

    const initial = latest.current;
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          syntaxHighlighting(sqlHighlight),
          editorTheme,
          EditorView.contentAttributes.of({ "aria-label": "SQL editor", "aria-multiline": "true" }),
          initial.placeholder ? cmPlaceholder(initial.placeholder) : [],
          sqlCompartmentRef.current.of(sqlLang(initial.tables)),
          keymap.of([
            { key: "Mod-Enter", run: runCommand },
            { key: "Shift-Enter", run: runCommand },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value changes (history / snippet click).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  // Live schema for autocomplete.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: sqlCompartmentRef.current.reconfigure(sqlLang(tables)) });
  }, [tables]);

  return <div ref={containerRef} className="min-w-0" data-testid="sql-editor" />;
}
