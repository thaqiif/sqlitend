import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Database, SystemInfo, Workspace } from "@sqlitend/shared";
import { api } from "./api/client";
import { DatabasesPage } from "./pages/DatabasesPage";
import { DatabaseDetail, type DbSubTab } from "./pages/DatabaseDetail";
import { ActivityPage } from "./pages/ActivityPage";
import { BackupsPage } from "./pages/BackupsPage";
import { Modal } from "./components/Modal";

const SYSTEM_POLL_MS = 30_000;
const THEME_STORAGE_KEY = "sqlitend:theme";

type ThemeMode = "dark" | "light";

type View =
  | { name: "list" }
  | { name: "detail"; databaseId: string; tab?: DbSubTab; table?: string | null }
  | { name: "activity" }
  | { name: "backups" };

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/** `onLogout` is absent when the server runs without auth (SQLITEND_AUTH=off). */
export function App({ onLogout }: { onLogout?: () => void } = {}) {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "list" });
  const [explorerOpen, setExplorerOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  const loadSystem = useCallback(async () => {
    try {
      const sys = await api.getSystemInfo();
      setSystemInfo(sys);
      setSystemError(null);
    } catch (err) {
      setSystemError(err instanceof Error ? err.message : "System info unavailable");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ws = await api.listWorkspaces();
        if (!alive) return;
        setWorkspaces(ws);
        setSelectedWorkspaceId(ws[0]?.id ?? null);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    loadSystem();
    const t = setInterval(loadSystem, SYSTEM_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [loadSystem]);

  // Fetch databases in the active workspace so the Explorer drawer & mobile bottom bar can navigate quickly
  const workspaceDbsQuery = useQuery({
    queryKey: ["workspaceDbs", selectedWorkspaceId],
    queryFn: () => api.listDatabases(selectedWorkspaceId!),
    enabled: !!selectedWorkspaceId,
  });

  const activeDbId = view.name === "detail" ? view.databaseId : workspaceDbsQuery.data?.[0]?.id ?? null;

  const activeSchemaQuery = useQuery({
    queryKey: ["schema", activeDbId],
    queryFn: () => api.getSchema(activeDbId!),
    enabled: !!activeDbId && view.name === "detail",
  });

  const refreshWorkspaces = useCallback(async () => {
    const ws = await api.listWorkspaces();
    setWorkspaces(ws);
    setSelectedWorkspaceId((prev) =>
      prev && ws.some((w) => w.id === prev) ? prev : (ws[0]?.id ?? null),
    );
  }, []);

  async function handleCreateWorkspace(name: string) {
    const ws = await api.createWorkspace({ name });
    await refreshWorkspaces();
    void loadSystem();
    setSelectedWorkspaceId(ws.id);
  }

  async function handleDeleteWorkspace(id: string) {
    await api.deleteWorkspace(id);
    await refreshWorkspaces();
    void loadSystem();
  }

  if (loading) {
    return (
      <main className="shell">
        <div className="skeleton-line" style={{ width: "180px", height: "28px", marginBottom: "16px" }} />
        <div className="skeleton-line" style={{ width: "100%", height: "140px" }} />
      </main>
    );
  }

  if (error && workspaces.length === 0) {
    return (
      <main className="shell">
        <h1 className="brand-title">sqlitend</h1>
        <p className="error" role="alert">{error}</p>
      </main>
    );
  }

  const currentTab: DbSubTab = view.name === "detail" ? (view.tab ?? "data") : "data";

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <button
            type="button"
            className="brand-home-btn"
            onClick={() => setView({ name: "list" })}
          >
            <h1 className="brand-title">sqlitend</h1>
          </button>
          {systemInfo && <span className="sys-version">v{systemInfo.version}</span>}
        </div>
        {(systemInfo || systemError) && (
          <div
            className={`sys-banner ${systemInfo?.sqldOk ? "ok" : "warn"}`}
            role="status"
            aria-label="sqld health"
          >
            <span className={`status-dot ${systemInfo?.sqldOk ? "ok" : "warn"}`} />
            <span className="sys-msg">
              {systemError
                ? `system info unavailable — ${systemError}`
                : systemInfo?.sqldOk
                  ? "sqld ready"
                  : `sqld degraded${systemInfo?.sqldReason ? ` — ${systemInfo.sqldReason}` : ""}`}
            </span>
            {systemInfo && !systemError && (
              <span className="sys-counts">
                {systemInfo.counts.workspaces} ws · {systemInfo.counts.databases} db
              </span>
            )}
          </div>
        )}
        <nav className="header-actions" aria-label="Global actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setExplorerOpen(true)}
            title="Open schema explorer"
          >
            Explorer
          </button>
          <button type="button" className="btn ghost small" onClick={() => setView({ name: "backups" })}>
            Backups
          </button>
          <button type="button" className="btn ghost small" onClick={() => setView({ name: "activity" })}>
            Activity
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Theme: ${theme}`}
          >
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          {onLogout && (
            <button type="button" className="btn ghost small" onClick={onLogout}>
              Log out
            </button>
          )}
        </nav>
      </header>

      <div className="app-body">
        {view.name === "backups" ? (
          <BackupsPage
            workspaces={workspaces}
            onBack={() => setView({ name: "list" })}
            onOpenDatabase={(id) => {
              void refreshWorkspaces();
              setView({ name: "detail", databaseId: id, tab: "data" });
            }}
          />
        ) : view.name === "activity" ? (
          <ActivityPage onBack={() => setView({ name: "list" })} />
        ) : view.name === "detail" ? (
          <DatabaseDetail
            key={view.databaseId}
            databaseId={view.databaseId}
            workspaces={workspaces}
            activeTab={view.tab ?? "data"}
            onTabChange={(tab) => setView({ ...view, tab })}
            selectedTable={view.table}
            onSelectTable={(table) => setView({ ...view, table })}
            onOpenExplorerDrawer={() => setExplorerOpen(true)}
            onOpenDatabase={(id) => setView({ name: "detail", databaseId: id, tab: "data" })}
            onBack={() => setView({ name: "list" })}
          />
        ) : (
          <DatabasesPage
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={setSelectedWorkspaceId}
            onOpenDatabase={(id) => setView({ name: "detail", databaseId: id, tab: "data" })}
            onCreateWorkspace={handleCreateWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
            publicHost={systemInfo?.publicHost}
            onChanged={() => {
              void loadSystem();
              void workspaceDbsQuery.refetch();
            }}
          />
        )}
      </div>

      {/* Mobile Bottom Tab Bar (< 600px) */}
      <nav className="mobile-bottom-bar" aria-label="Mobile navigation">
        <button
          type="button"
          className={`mobile-tab-btn ${view.name === "list" ? "active" : ""}`}
          onClick={() => setView({ name: "list" })}
        >
          <span className="mobile-tab-icon">▦</span>
          <span>Databases</span>
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${explorerOpen || (view.name === "detail" && currentTab === "data") ? "active" : ""}`}
          onClick={() => {
            if (view.name === "detail") {
              setView({ ...view, tab: "data" });
            } else if (activeDbId) {
              setView({ name: "detail", databaseId: activeDbId, tab: "data" });
            } else {
              setExplorerOpen(true);
            }
          }}
        >
          <span className="mobile-tab-icon">☰</span>
          <span>Explorer</span>
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${view.name === "detail" && currentTab === "sql" ? "active" : ""}`}
          onClick={() => {
            if (view.name === "detail") {
              setView({ ...view, tab: "sql" });
            } else if (activeDbId) {
              setView({ name: "detail", databaseId: activeDbId, tab: "sql" });
            }
          }}
          disabled={!activeDbId}
        >
          <span className="mobile-tab-icon">&gt;_</span>
          <span>SQL</span>
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${view.name === "detail" && currentTab === "metrics" ? "active" : ""}`}
          onClick={() => {
            if (view.name === "detail") {
              setView({ ...view, tab: "metrics" });
            } else if (activeDbId) {
              setView({ name: "detail", databaseId: activeDbId, tab: "metrics" });
            }
          }}
          disabled={!activeDbId}
        >
          <span className="mobile-tab-icon">∿</span>
          <span>Metrics</span>
        </button>
      </nav>

      {/* Slide-over Explorer Drawer (Workspaces -> Databases -> Tables/Views) */}
      {explorerOpen && (
        <Modal ariaLabel="Database & Table Explorer" onClose={() => setExplorerOpen(false)}>
          <div className="panel-head">
            <h2>Schema Explorer</h2>
            <button type="button" className="btn ghost small" onClick={() => setExplorerOpen(false)}>
              Close
            </button>
          </div>
          <div className="explorer-tree">
            <label className="field">
              <span className="field-label">Workspace</span>
              <select
                value={selectedWorkspaceId ?? ""}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.slug})
                  </option>
                ))}
              </select>
            </label>

            <div className="explorer-section">
              <h3 className="subhead">Databases</h3>
              {(workspaceDbsQuery.data ?? []).length === 0 ? (
                <p className="muted small">No databases in this workspace.</p>
              ) : (
                <ul className="explorer-list">
                  {(workspaceDbsQuery.data ?? []).map((d: Database) => {
                    const isSelectedDb = view.name === "detail" && view.databaseId === d.id;
                    return (
                      <li key={d.id} className="explorer-db-node">
                        <button
                          type="button"
                          className={`explorer-db-btn ${isSelectedDb ? "active" : ""}`}
                          onClick={() => {
                            setView({ name: "detail", databaseId: d.id, tab: "data" });
                          }}
                        >
                          <span className={`status-dot ${d.status === "running" ? "ok" : "warn"}`} />
                          <strong>{d.name}</strong>
                          <span className="muted small">{d.status}</span>
                        </button>
                        {isSelectedDb && (activeSchemaQuery.data?.tables ?? []).length > 0 && (
                          <ul className="explorer-table-list">
                            {(activeSchemaQuery.data?.tables ?? []).map((t) => (
                              <li key={t.name}>
                                <button
                                  type="button"
                                  className={`explorer-table-btn ${view.name === "detail" && view.table === t.name ? "active" : ""}`}
                                  onClick={() => {
                                    setView({
                                      name: "detail",
                                      databaseId: d.id,
                                      tab: "data",
                                      table: t.name,
                                    });
                                    setExplorerOpen(false);
                                  }}
                                >
                                  <span className="type-tag">{t.type === "view" ? "VIEW" : "TBL"}</span>
                                  <span>{t.name}</span>
                                  {t.rowCountEstimate !== null && (
                                    <span className="muted small">{t.rowCountEstimate}</span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
