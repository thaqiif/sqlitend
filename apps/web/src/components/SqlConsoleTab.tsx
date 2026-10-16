import { useEffect, useState } from "react";
import type { QueryResponse, StatementResult, TableSchemaItem } from "@sqlitend/shared";
import { api, ApiError } from "../api/client";
import { CodeMirrorSqlEditor } from "./CodeMirrorSqlEditor";
import { Modal } from "./Modal";
import { VirtualResultTable } from "./VirtualResultTable";

interface Props {
  dbId: string;
  tables: TableSchemaItem[];
  onSchemaMayHaveChanged: () => void;
}

interface HistoryEntry {
  id: string;
  sql: string;
  at: number;
  durationMs: number;
  ok: boolean;
}

interface SavedSnippet {
  id: string;
  title: string;
  sql: string;
}

const DESTRUCTIVE_RE = /\b(DROP\s+TABLE|DROP\s+VIEW|DROP\s+INDEX|DROP\s+TRIGGER|TRUNCATE|ALTER\s+TABLE|VACUUM|DELETE\s+FROM\s+[^\s;]+(?:\s*;|\s*$)|UPDATE\s+[^\s;]+\s+SET\s+(?:(?!\bWHERE\b)[\s\S])*?(?:;|$))/i;

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal<T>(key: string, val: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // ignore storage quota errors
  }
}

export default function SqlConsoleTab({ dbId, tables, onSchemaMayHaveChanged }: Props) {
  const historyKey = `sqlitend:sql-history:${dbId}`;
  const snippetsKey = `sqlitend:sql-snippets:${dbId}`;
  const draftKey = `sqlitend:sql-draft:${dbId}`;

  const [sqlText, setSqlText] = useState<string>(() =>
    loadLocal(draftKey, tables[0] ? `SELECT * FROM "${tables[0].name}" LIMIT 100;` : "SELECT sqlite_version(), datetime('now');"),
  );
  const [allowWrites, setAllowWrites] = useState(false);
  const [limit, setLimit] = useState(1000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [activeStmtIdx, setActiveStmtIdx] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadLocal(historyKey, []));
  const [snippets, setSnippets] = useState<SavedSnippet[]>(() => loadLocal(snippetsKey, []));
  const [sidePanel, setSidePanel] = useState<"none" | "history" | "snippets">("none");
  const [snippetTitle, setSnippetTitle] = useState("");
  const [destructiveConfirmSql, setDestructiveConfirmSql] = useState<string | null>(null);

  useEffect(() => {
    saveLocal(draftKey, sqlText);
  }, [draftKey, sqlText]);

  const executeSql = async (targetSql: string, confirmedDestructive = false) => {
    const trimmed = targetSql.trim();
    if (!trimmed) return;

    if (allowWrites && !confirmedDestructive && DESTRUCTIVE_RE.test(trimmed)) {
      setDestructiveConfirmSql(trimmed);
      return;
    }

    setDestructiveConfirmSql(null);
    setRunning(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await api.runQuery(dbId, {
        sql: trimmed,
        readOnly: !allowWrites,
        limit,
        timeoutMs: 15_000,
      });
      setResponse(res);
      setActiveStmtIdx(0);
      const nextHistory: HistoryEntry[] = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sql: trimmed,
          at: Date.now(),
          durationMs: res.totalDurationMs,
          ok: true,
        },
        ...history.filter((h) => h.sql !== trimmed),
      ].slice(0, 50);
      setHistory(nextHistory);
      saveLocal(historyKey, nextHistory);

      if (allowWrites && /\b(CREATE|DROP|ALTER|INSERT|DELETE|UPDATE)\b/i.test(trimmed)) {
        onSchemaMayHaveChanged();
      }
    } catch (err) {
      const msg = err instanceof ApiError ? (err.detail ? `${err.message}: ${err.detail}` : err.message) : (err as Error).message;
      setError(msg);
      if (err instanceof ApiError && Array.isArray(err.body?.results)) {
        const partialResults = err.body.results as StatementResult[];
        const totalDurationMs = typeof err.body.totalDurationMs === "number" ? err.body.totalDurationMs : 0;
        const failedIdx = typeof err.body.failedStatementIndex === "number" ? err.body.failedStatementIndex : 0;
        setResponse({ results: partialResults, totalDurationMs });
        setActiveStmtIdx(failedIdx);
      }
      const nextHistory: HistoryEntry[] = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sql: trimmed,
          at: Date.now(),
          durationMs: Number((performance.now() - t0).toFixed(1)),
          ok: false,
        },
        ...history.filter((h) => h.sql !== trimmed),
      ].slice(0, 50);
      setHistory(nextHistory);
      saveLocal(historyKey, nextHistory);
    } finally {
      setRunning(false);
    }
  };

  const handleSaveSnippet = () => {
    const title = snippetTitle.trim() || sqlText.trim().slice(0, 36) || "Untitled query";
    const next: SavedSnippet[] = [
      { id: `${Date.now()}`, title, sql: sqlText.trim() },
      ...snippets,
    ];
    setSnippets(next);
    saveLocal(snippetsKey, next);
    setSnippetTitle("");
    setSidePanel("snippets");
  };

  const handleDeleteSnippet = (id: string) => {
    const next = snippets.filter((s) => s.id !== id);
    setSnippets(next);
    saveLocal(snippetsKey, next);
  };

  const activeResult: StatementResult | undefined = response?.results[activeStmtIdx] ?? response?.results[0];

  return (
    <div className="sql-console-layout">
      <div className="sql-toolbar">
        <div className="sql-toolbar-left">
          <button
            type="button"
            className="btn primary"
            disabled={running || !sqlText.trim()}
            onClick={() => void executeSql(sqlText)}
            title="Run SQL (Ctrl/Cmd + Enter)"
          >
            {running ? "Running…" : "▶ Run"}
          </button>

          <label className={`write-toggle-chip ${allowWrites ? "write-enabled" : ""}`}>
            <input
              type="checkbox"
              checked={allowWrites}
              onChange={(e) => setAllowWrites(e.target.checked)}
            />
            <span>{allowWrites ? "Writes enabled" : "Read-only"}</span>
          </label>

          <label className="sql-limit-select">
            <span className="muted small">Cap</span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100 rows</option>
              <option value={500}>500 rows</option>
              <option value={1000}>1,000 rows</option>
              <option value={5000}>5,000 rows</option>
              <option value={10000}>10,000 rows</option>
            </select>
          </label>
        </div>

        <div className="sql-toolbar-right">
          <button
            type="button"
            className={`btn ghost small ${sidePanel === "history" ? "active" : ""}`}
            onClick={() => setSidePanel(sidePanel === "history" ? "none" : "history")}
          >
            History ({history.length})
          </button>
          <button
            type="button"
            className={`btn ghost small ${sidePanel === "snippets" ? "active" : ""}`}
            onClick={() => setSidePanel(sidePanel === "snippets" ? "none" : "snippets")}
          >
            Snippets ({snippets.length})
          </button>
        </div>
      </div>

      <div className="sql-editor-and-drawer">
        <div className="sql-editor-pane">
          <CodeMirrorSqlEditor
            value={sqlText}
            onChange={setSqlText}
            onRun={(s) => void executeSql(s)}
            tables={tables}
            placeholder="Write SQL here… Press Cmd/Ctrl+Enter to run selection or full script."
          />
          <div className="sql-Save-row">
            <span className="muted small">Tip: Select a statement and press <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> to run only selection.</span>
            <div className="snippet-quick-save">
              <input
                type="text"
                placeholder="Save query as snippet…"
                value={snippetTitle}
                onChange={(e) => setSnippetTitle(e.target.value)}
                className="input-compact"
              />
              <button
                type="button"
                className="btn ghost small"
                disabled={!sqlText.trim()}
                onClick={handleSaveSnippet}
              >
                Bookmark
              </button>
            </div>
          </div>
        </div>

        {sidePanel !== "none" && (
          <aside className="sql-side-panel" aria-label={sidePanel === "history" ? "Query history" : "Saved snippets"}>
            <div className="panel-head">
              <h3>{sidePanel === "history" ? "Recent Queries (max 50)" : "Saved Snippets"}</h3>
              <button type="button" className="btn ghost small" onClick={() => setSidePanel("none")}>
                Close
              </button>
            </div>
            {sidePanel === "history" ? (
              history.length === 0 ? (
                <p className="muted small">No queries executed in this browser yet.</p>
              ) : (
                <ul className="sql-list">
                  {history.map((h) => (
                    <li key={h.id} className="sql-list-item">
                      <button
                        type="button"
                        className="sql-list-btn"
                        onClick={() => setSqlText(h.sql)}
                      >
                        <code className="sql-preview">{h.sql}</code>
                        <span className="muted small">
                          {h.ok ? "✓" : "✕"} {h.durationMs}ms · {new Date(h.at).toLocaleTimeString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : snippets.length === 0 ? (
              <p className="muted small">Bookmark frequent queries to access them here.</p>
            ) : (
              <ul className="sql-list">
                {snippets.map((s) => (
                  <li key={s.id} className="sql-list-item snippet-row">
                    <button type="button" className="sql-list-btn" onClick={() => setSqlText(s.sql)}>
                      <strong>{s.title}</strong>
                      <code className="sql-preview">{s.sql}</code>
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => handleDeleteSnippet(s.id)}
                      aria-label={`Remove snippet ${s.title}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>SQL Error:</strong> {error}
          </div>
          <button type="button" className="btn ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {response && (
        <section className="panel sql-results-panel" aria-label="Query results">
          <div className="sql-results-header">
            <div className="stmt-tabs" role="tablist">
              {response.results.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === activeStmtIdx}
                  className={`stmt-tab ${i === activeStmtIdx ? "active" : ""}`}
                  onClick={() => setActiveStmtIdx(i)}
                >
                  Stmt #{i + 1} (
                  {r.status === "error"
                    ? "error"
                    : r.status === "not_executed"
                      ? "not executed"
                      : r.columns.length > 0
                        ? `${r.rows.length} rows`
                        : `${r.rowsAffected} affected`}
                  )
                </button>
              ))}
            </div>
            <div className="sql-timing-meta muted small">
              Total: <strong>{response.totalDurationMs} ms</strong>
              {activeResult && (
                <>
                  {" · "}Stmt: <strong>{activeResult.durationMs} ms</strong>
                  {activeResult.rowsAffected > 0 && (
                    <>
                      {" · "}Affected: <strong>{activeResult.rowsAffected}</strong>
                    </>
                  )}
                  {activeResult.truncated && (
                    <span className="badge-warn" style={{ marginLeft: "0.5rem" }}>
                      Truncated at {limit} rows
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {activeResult && (
            activeResult.status === "error" ? (
              <div className="empty-state compact">
                <p>
                  <strong>Statement #{activeStmtIdx + 1} failed:</strong> {activeResult.error ?? "SQL error"}
                </p>
              </div>
            ) : activeResult.status === "not_executed" ? (
              <div className="empty-state compact">
                <p>
                  Statement #{activeStmtIdx + 1} was <strong>not executed</strong> because an earlier statement failed.
                </p>
              </div>
            ) : activeResult.columns.length > 0 ? (
              <VirtualResultTable
                columns={activeResult.columns}
                rows={activeResult.rows}
              />
            ) : (
              <div className="empty-state compact">
                <p>
                  Statement executed in <strong>{activeResult.durationMs} ms</strong> —{" "}
                  <strong>{activeResult.rowsAffected}</strong> row(s) affected
                  {activeResult.lastInsertRowid ? ` (last insert rowid: ${activeResult.lastInsertRowid})` : ""}.
                </p>
              </div>
            )
          )}
        </section>
      )}

      {destructiveConfirmSql && (
        <Modal ariaLabel="Confirm destructive SQL" onClose={() => setDestructiveConfirmSql(null)}>
          <h2>Confirm Destructive SQL</h2>
          <p className="muted">
            This statement appears to modify schema or delete/update rows without a WHERE clause:
          </p>
          <pre className="code-block">{destructiveConfirmSql}</pre>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setDestructiveConfirmSql(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => void executeSql(destructiveConfirmSql, true)}
            >
              Execute Anyway
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
