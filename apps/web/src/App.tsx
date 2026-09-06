import { useCallback, useEffect, useState } from "react";
import type { SystemInfo, Workspace } from "@sqlitend/shared";
import { api } from "./api/client";
import { DatabasesPage } from "./pages/DatabasesPage";
import { DatabaseDetail } from "./pages/DatabaseDetail";

const SYSTEM_POLL_MS = 30_000;

type View =
  | { name: "list" }
  | { name: "detail"; databaseId: string };

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  /** Non-fatal: /api/system failing must not block the workspace UI. */
  const [systemError, setSystemError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "list" });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSystem = useCallback(async () => {
    try {
      const sys = await api.getSystemInfo();
      setSystemInfo(sys);
      setSystemError(null);
    } catch (err) {
      setSystemError(err instanceof Error ? err.message : "System info unavailable");
    }
  }, []);

  // Initial load + slow system-info poll so the sqld health banner stays fresh.
  useEffect(() => {
    let alive = true;
    (async () => {
      // Workspaces are required; system info is optional. A /api/system failure
      // must not tank the whole app.
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
    setSelectedWorkspaceId(ws.id);
  }

  async function handleDeleteWorkspace(id: string) {
    await api.deleteWorkspace(id); // 409 (has databases) surfaces as ApiError
    await refreshWorkspaces();
  }

  if (loading) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1 className="brand-title">sqlitend</h1>
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
            {/* Counts are only meaningful when the system info is FRESH — don't
                show the last-good numbers next to an "unavailable" message. */}
            {systemInfo && !systemError && (
              <span className="sys-counts">
                {systemInfo.counts.workspaces} ws · {systemInfo.counts.databases} db
              </span>
            )}
          </div>
        )}
      </header>

      {view.name === "detail" ? (
        <DatabaseDetail
          databaseId={view.databaseId}
          onBack={() => setView({ name: "list" })}
        />
      ) : (
        <DatabasesPage
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={setSelectedWorkspaceId}
          onOpenDatabase={(id) => setView({ name: "detail", databaseId: id })}
          onCreateWorkspace={handleCreateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          publicHost={systemInfo?.publicHost}
        />
      )}
    </div>
  );
}