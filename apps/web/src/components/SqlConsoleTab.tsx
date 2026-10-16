import { useEffect, useState } from "react";
import { Alert, Button, Card, Chip, Input, Modal as HeroModal, Switch, Tabs, TextField } from "@heroui/react";
import type { QueryResponse, StatementResult, StatementStatus, TableSchemaItem } from "@sqlitend/shared";
import { api, ApiError } from "../api/client";
import { CodeMirrorSqlEditor } from "./CodeMirrorSqlEditor";
import { PlayIcon } from "./icons";
import { Modal } from "./Modal";
import { SimpleSelect } from "./SimpleSelect";
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

const HISTORY_MAX = 50;
const CAPS = [100, 500, 1000, 5000, 10000].map((n) => ({ id: String(n), label: `${n.toLocaleString("en-US")} rows` }));

// Statements that deserve a second look: schema changes, VACUUM, DELETE/UPDATE without a WHERE.
const DESTRUCTIVE_RE =
  /\b(DROP\s+TABLE|DROP\s+VIEW|DROP\s+INDEX|DROP\s+TRIGGER|TRUNCATE|ALTER\s+TABLE|VACUUM|DELETE\s+FROM\s+[^\s;]+(?:\s*;|\s*$)|UPDATE\s+[^\s;]+\s+SET\s+(?:(?!\bWHERE\b)[\s\S])*?(?:;|$))/i;

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
    // quota exceeded or storage blocked: the in-memory state still works for this session
  }
}

const STATUS_TONE: Record<StatementStatus, "success" | "danger" | "default"> = {
  ok: "success",
  error: "danger",
  not_executed: "default",
};
const STATUS_LABEL: Record<StatementStatus, string> = { ok: "ok", error: "error", not_executed: "not executed" };

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
  const [error, setError] = useState<{ message: string; timedOut: boolean } | null>(null);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [failedIdx, setFailedIdx] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadLocal(historyKey, []));
  const [snippets, setSnippets] = useState<SavedSnippet[]>(() => loadLocal(snippetsKey, []));
  const [sidePanel, setSidePanel] = useState<"none" | "history" | "snippets">("none");
  const [snippetTitle, setSnippetTitle] = useState("");
  const [confirmSql, setConfirmSql] = useState<string | null>(null);

  useEffect(() => {
    saveLocal(draftKey, sqlText);
  }, [draftKey, sqlText]);

  const pushHistory = (sql: string, durationMs: number, ok: boolean) => {
    const next = [{ id: newId(), sql, at: Date.now(), durationMs, ok }, ...history.filter((h) => h.sql !== sql)].slice(0, HISTORY_MAX);
    setHistory(next);
    saveLocal(historyKey, next);
  };

  const executeSql = async (target: string, confirmed = false) => {
    const sql = target.trim();
    if (!sql) return;
    if (allowWrites && !confirmed && DESTRUCTIVE_RE.test(sql)) {
      setConfirmSql(sql);
      return;
    }
    setConfirmSql(null);
    setRunning(true);
    setError(null);
    setFailedIdx(null);
    const t0 = performance.now();
    try {
      const res = await api.runQuery(dbId, { sql, readOnly: !allowWrites, limit, timeoutMs: 15_000 });
      setResponse(res);
      setActiveIdx(0);
      pushHistory(sql, res.totalDurationMs, true);
      if (allowWrites && /\b(CREATE|DROP|ALTER|INSERT|DELETE|UPDATE)\b/i.test(sql)) onSchemaMayHaveChanged();
    } catch (err) {
      let message = err instanceof ApiError ? (err.detail ? `${err.message}: ${err.detail}` : err.message) : (err as Error).message;
      const timedOut = err instanceof ApiError && err.status === 408;
      if (timedOut && !/still be running/i.test(message)) message += " The query may still be running inside the database.";
      setError({ message, timedOut });
      if (err instanceof ApiError && Array.isArray(err.body?.results)) {
        const idx = typeof err.body.failedStatementIndex === "number" ? err.body.failedStatementIndex : 0;
        setResponse({
          results: err.body.results as StatementResult[],
          totalDurationMs: typeof err.body.totalDurationMs === "number" ? err.body.totalDurationMs : 0,
        });
        setFailedIdx(idx);
        setActiveIdx(idx);
      }
      pushHistory(sql, Number((performance.now() - t0).toFixed(1)), false);
    } finally {
      setRunning(false);
    }
  };

  const saveSnippet = () => {
    const title = snippetTitle.trim() || sqlText.trim().slice(0, 36) || "Untitled query";
    const next = [{ id: `${Date.now()}`, title, sql: sqlText.trim() }, ...snippets];
    setSnippets(next);
    saveLocal(snippetsKey, next);
    setSnippetTitle("");
    setSidePanel("snippets");
  };

  const deleteSnippet = (id: string) => {
    const next = snippets.filter((s) => s.id !== id);
    setSnippets(next);
    saveLocal(snippetsKey, next);
  };

  const results = response?.results ?? [];
  const active: StatementResult | undefined = results[activeIdx] ?? results[0];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" className="min-h-11" isPending={running} isDisabled={!sqlText.trim()} onPress={() => void executeSql(sqlText)}>
          <PlayIcon size={16} />
          {running ? "Running..." : "Run"}
        </Button>
        <Switch isSelected={allowWrites} onChange={setAllowWrites} className="min-h-11">
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Allow writes
          </Switch.Content>
        </Switch>
        {allowWrites && (
          <Chip color="warning" variant="soft" size="sm">
            Writes enabled
          </Chip>
        )}
        <SimpleSelect label="Row cap" hideLabel value={String(limit)} onChange={(v) => setLimit(Number(v))} options={CAPS} className="w-36" />
        <div className="ml-auto flex gap-2">
          <Button variant={sidePanel === "history" ? "secondary" : "ghost"} className="min-h-11" onPress={() => setSidePanel(sidePanel === "history" ? "none" : "history")}>
            History ({history.length})
          </Button>
          <Button variant={sidePanel === "snippets" ? "secondary" : "ghost"} className="min-h-11" onPress={() => setSidePanel(sidePanel === "snippets" ? "none" : "snippets")}>
            Snippets ({snippets.length})
          </Button>
        </div>
      </div>

      <CodeMirrorSqlEditor
        value={sqlText}
        onChange={setSqlText}
        onRun={(s) => void executeSql(s)}
        tables={tables}
        placeholder="Write SQL here. Ctrl/Cmd+Enter runs the selection, or everything if nothing is selected."
      />

      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="m-0 text-xs text-muted">
          Select a statement and press <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> to run only the selection.
        </p>
        <div className="flex w-full items-end gap-2 sm:w-auto">
          <TextField aria-label="Snippet title" value={snippetTitle} onChange={setSnippetTitle} className="min-w-0 flex-1">
            <Input placeholder="Save query as snippet" className="min-h-11" />
          </TextField>
          <Button variant="secondary" className="min-h-11 shrink-0" isDisabled={!sqlText.trim()} onPress={saveSnippet}>
            Save snippet
          </Button>
        </div>
      </div>

      {sidePanel !== "none" && (
        <Card aria-label={sidePanel === "history" ? "Query history" : "Saved snippets"} className="gap-2 p-3">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-sm font-semibold">{sidePanel === "history" ? "Recent queries (last 50)" : "Saved snippets"}</h3>
            <Button size="sm" variant="ghost" onPress={() => setSidePanel("none")}>
              Close
            </Button>
          </div>
          {sidePanel === "history" ? (
            history.length === 0 ? (
              <p className="m-0 text-sm text-muted">No queries executed in this browser yet.</p>
            ) : (
              <ul className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-auto p-0">
                {history.map((h) => (
                  <li key={h.id}>
                    <button type="button" className="flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-lg p-2 text-left hover:bg-surface-hover" onClick={() => setSqlText(h.sql)}>
                      <code className="truncate text-xs">{h.sql}</code>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <Chip size="sm" variant="soft" color={h.ok ? "success" : "danger"}>
                          {h.ok ? "ok" : "failed"}
                        </Chip>
                        {h.durationMs} ms - {new Date(h.at).toLocaleTimeString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : snippets.length === 0 ? (
            <p className="m-0 text-sm text-muted">Save frequent queries to find them here.</p>
          ) : (
            <ul className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-auto p-0">
              {snippets.map((s) => (
                <li key={s.id} className="flex items-center gap-1">
                  <button type="button" className="flex min-h-11 min-w-0 flex-1 flex-col gap-1 rounded-lg p-2 text-left hover:bg-surface-hover" onClick={() => setSqlText(s.sql)}>
                    <strong className="truncate text-sm">{s.title}</strong>
                    <code className="truncate text-xs text-muted">{s.sql}</code>
                  </button>
                  <Button size="sm" variant="ghost" aria-label={`Remove snippet ${s.title}`} onPress={() => deleteSnippet(s.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {error && (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error.timedOut ? "Query timed out" : "SQL error"}</Alert.Title>
            <Alert.Description>{error.message}</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="ghost" onPress={() => setError(null)}>
            Dismiss
          </Button>
        </Alert>
      )}

      {response && (
        <Card aria-label="Query results" className="min-w-0 gap-3 p-3">
          <Tabs selectedKey={String(activeIdx)} onSelectionChange={(k) => setActiveIdx(Number(k))}>
            <Tabs.ListContainer>
              <Tabs.List aria-label="Statements">
                {results.map((r, i) => (
                  <Tabs.Tab key={i} id={String(i)} className="min-h-11 gap-2">
                    Stmt {i + 1}
                    <Chip size="sm" variant="soft" color={STATUS_TONE[r.status]}>
                      {r.status === "ok" ? (r.columns.length > 0 ? `${r.rows.length} rows` : `${r.rowsAffected} affected`) : STATUS_LABEL[r.status]}
                    </Chip>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>

          <p className="m-0 text-xs text-muted">
            Total <strong>{response.totalDurationMs} ms</strong>
            {active && (
              <>
                {" - "}statement <strong>{active.durationMs} ms</strong>
                {active.rowsAffected > 0 && (
                  <>
                    {" - "}affected <strong>{active.rowsAffected}</strong>
                  </>
                )}
              </>
            )}
            {active?.truncated && (
              <Chip size="sm" color="warning" variant="soft" className="ml-2">
                Truncated at {limit.toLocaleString("en-US")} rows
              </Chip>
            )}
          </p>

          {active && <StatementView result={active} index={activeIdx} failedIdx={failedIdx} />}
        </Card>
      )}

      {confirmSql && (
        <Modal ariaLabel="Confirm destructive SQL" onClose={() => setConfirmSql(null)}>
          <HeroModal.Header>
            <HeroModal.Heading className="text-danger">Confirm destructive SQL</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body className="flex flex-col gap-3 p-1">
            <p className="m-0 text-sm text-muted">
              This changes the schema, or deletes/updates rows without a WHERE clause. It runs with writes enabled and cannot be undone.
            </p>
            <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-3 font-mono text-xs">{confirmSql}</pre>
          </HeroModal.Body>
          <HeroModal.Footer>
            <Button variant="ghost" className="min-h-11" onPress={() => setConfirmSql(null)}>
              Cancel
            </Button>
            <Button variant="danger" className="min-h-11" onPress={() => void executeSql(confirmSql, true)}>
              Execute anyway
            </Button>
          </HeroModal.Footer>
        </Modal>
      )}
    </div>
  );
}

function StatementView({ result, index, failedIdx }: { result: StatementResult; index: number; failedIdx: number | null }) {
  const sql = <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-2 font-mono text-xs">{result.statement}</pre>;
  if (result.status === "error") {
    return (
      <div className="flex flex-col gap-2">
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Statement {index + 1} failed</Alert.Title>
            <Alert.Description>{result.error ?? "SQL error"}</Alert.Description>
          </Alert.Content>
        </Alert>
        {sql}
      </div>
    );
  }
  if (result.status === "not_executed") {
    return (
      <div className="flex flex-col gap-2">
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Not executed</Alert.Title>
            <Alert.Description>
              Statement {index + 1} did not run because {failedIdx !== null ? `statement ${failedIdx + 1}` : "an earlier statement"} failed.
            </Alert.Description>
          </Alert.Content>
        </Alert>
        {sql}
      </div>
    );
  }
  if (result.columns.length > 0) return <VirtualResultTable columns={result.columns} rows={result.rows} />;
  return (
    <p className="m-0 text-sm">
      Executed in <strong>{result.durationMs} ms</strong>, <strong>{result.rowsAffected}</strong> row(s) affected
      {result.lastInsertRowid ? ` (last insert rowid: ${result.lastInsertRowid})` : ""}.
    </p>
  );
}
