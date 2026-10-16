import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
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

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.86rem",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    borderRadius: "8px",
    border: "1px solid var(--border)",
  },
  ".cm-content": {
    padding: "0.65rem 0",
    minHeight: "150px",
    caretColor: "var(--accent)",
  },
  ".cm-focused": {
    outline: "2px solid var(--accent)",
    outlineOffset: "-1px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--panel)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border-soft)",
    borderTopLeftRadius: "8px",
    borderBottomLeftRadius: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--panel-2)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(79, 140, 255, 0.06)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--fg)",
  },
});

export function CodeMirrorSqlEditor({ value, onChange, onRun, tables, placeholder }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartmentRef = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const schemaObj: Record<string, string[]> = {};
    for (const t of tables) {
      schemaObj[t.name] = t.columns.map((c) => c.name);
    }

    const runCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      const selectedText = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to).trim();
      const targetSql = selectedText.length > 0 ? selectedText : view.state.doc.toString();
      onRunRef.current(targetSql);
      return true;
    };

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        editorTheme,
        placeholder ? cmPlaceholder(placeholder) : [],
        sqlCompartmentRef.current.of(
          sql({
            dialect: SQLite,
            schema: schemaObj,
            upperCaseKeywords: true,
          }),
        ),
        keymap.of([
          { key: "Mod-Enter", run: runCommand },
          { key: "Shift-Enter", run: runCommand },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: el });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only mount once; value/schema updates are synced in effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. clicking a history or snippet item)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  // Sync live table/column schema for autocomplete
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const schemaObj: Record<string, string[]> = {};
    for (const t of tables) {
      schemaObj[t.name] = t.columns.map((c) => c.name);
    }
    view.dispatch({
      effects: sqlCompartmentRef.current.reconfigure(
        sql({
          dialect: SQLite,
          schema: schemaObj,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [tables]);

  return <div ref={containerRef} className="cm-sql-host" data-testid="sql-editor" />;
}
