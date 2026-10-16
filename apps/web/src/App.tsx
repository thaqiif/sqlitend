import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SystemInfo, Workspace } from "@sqlitend/shared";
import { api } from "./api/client";
import { DatabasesPage } from "./pages/DatabasesPage";
import type { DbSubTab } from "./pages/DatabaseDetail";
import { Alert, Button, Skeleton } from "@heroui/react";
import { StatusChip } from "./components/StatusChip";
import { ActivityIcon, BackupIcon, DatabaseIcon, ExplorerIcon, LogoutIcon, MoonIcon, SunIcon, TrashIcon } from "./components/icons";
import { useTheme } from "./theme";

// Everything except the databases list is split out to keep the first load small.
const DatabaseDetail = lazy(() => import("./pages/DatabaseDetail").then((m) => ({ default: m.DatabaseDetail })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const BackupsPage = lazy(() => import("./pages/BackupsPage").then((m) => ({ default: m.BackupsPage })));
const TrashPage = lazy(() => import("./pages/TrashPage").then((m) => ({ default: m.TrashPage })));
const ExplorerDrawer = lazy(() => import("./components/ExplorerDrawer").then((m) => ({ default: m.ExplorerDrawer })));

const SYSTEM_POLL_MS = 30_000;
type View =
  | { name: "list" }
  | { name: "detail"; databaseId: string; tab?: DbSubTab; table?: string | null }
  | { name: "activity" }
  | { name: "backups" }
  | { name: "trash" };

const NAV_VIEWS = {
  list: { name: "list" },
  activity: { name: "activity" },
  backups: { name: "backups" },
  trash: { name: "trash" },
} as const satisfies Record<string, View>;

/** `onLogout` is absent when the server runs without auth (SQLITEND_AUTH=off). */
export function App({ onLogout }: { onLogout?: () => void } = {}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "list" });
  const [explorerOpen, setExplorerOpen] = useState(false);

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

  async function handleDeleteWorkspace(id: string, confirmSlug: string) {
    await api.deleteWorkspace(id, confirmSlug);
    await refreshWorkspaces();
    void loadSystem();
  }

  if (loading) {
    return (
      <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 p-4">
        <Skeleton className="h-7 w-44 rounded-lg" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </main>
    );
  }

  if (error && workspaces.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 p-4">
        <h1 className="text-xl font-semibold tracking-tight">sqlitend</h1>
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      </main>
    );
  }

  const navItems: { key: keyof typeof NAV_VIEWS; label: string; icon: ReactNode }[] = [
    { key: "list", label: "Databases", icon: <DatabaseIcon /> },
    { key: "activity", label: "Activity", icon: <ActivityIcon /> },
    { key: "backups", label: "Backups", icon: <BackupIcon /> },
    { key: "trash", label: "Trash", icon: <TrashIcon /> },
  ];
  const activeNav = view.name === "detail" ? "list" : view.name;
  const sqldOk = !systemError && systemInfo?.sqldOk === true;
  const healthText = systemError
    ? `system info unavailable — ${systemError}`
    : systemInfo?.sqldOk
      ? "sqld ready"
      : `sqld degraded${systemInfo?.sqldReason ? ` — ${systemInfo.sqldReason}` : ""}`;

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-separator bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-1 px-3 md:gap-2 md:px-6">
          <button
            type="button"
            className="flex min-h-11 items-baseline gap-2 rounded-lg px-1"
            onClick={() => setView({ name: "list" })}
          >
            <span className="text-lg font-semibold tracking-tight">sqlitend</span>
            {systemInfo && <span className="hidden text-xs text-muted md:inline">v{systemInfo.version}</span>}
          </button>

          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 sm:flex">
            {navItems.map((n) => (
              <button
                key={n.key}
                type="button"
                aria-current={activeNav === n.key ? "page" : undefined}
                onClick={() => setView(NAV_VIEWS[n.key])}
                className={`min-h-11 rounded-lg px-3 text-sm font-medium ${
                  activeNav === n.key ? "bg-accent-soft text-accent-soft-foreground" : "text-muted hover:bg-default"
                }`}
              >
                {n.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            {(systemInfo || systemError) && (
              <div role="status" aria-label="sqld health" className="mr-1 flex items-center gap-2" title={healthText}>
                <span className="md:hidden">
                  <span
                    className={`inline-block size-2.5 rounded-full ${sqldOk ? "bg-success" : "bg-warning"}`}
                    aria-hidden="true"
                  />
                  <span className="sr-only">{healthText}</span>
                </span>
                <span className="hidden md:inline">
                  <StatusChip tone={sqldOk ? "success" : "warning"}>{healthText}</StatusChip>
                </span>
                {systemInfo && !systemError && (
                  <span className="hidden text-xs text-muted lg:inline">
                    {systemInfo.counts.workspaces} ws · {systemInfo.counts.databases} db
                  </span>
                )}
              </div>
            )}
            <Button isIconOnly variant="ghost" aria-label="Open schema explorer" className="min-h-11 min-w-11" onPress={() => setExplorerOpen(true)}>
              <ExplorerIcon />
            </Button>
            <Button
              isIconOnly
              variant="ghost"
              className="min-h-11 min-w-11"
              onPress={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </Button>
            {onLogout && (
              <Button isIconOnly variant="ghost" aria-label="Log out" className="min-h-11 min-w-11" onPress={onLogout}>
                <LogoutIcon />
              </Button>
            )}
          </div>
        </div>
      </header>

      {(systemError || (systemInfo && !systemInfo.sqldOk)) && (
        <div className="border-b border-separator bg-warning/10 px-4 py-2 text-sm md:hidden" role="status">
          {healthText}
        </div>
      )}

      <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
        <Suspense fallback={<Skeleton className="m-4 h-36 rounded-xl" />}>
        {view.name === "trash" ? (
          <TrashPage
            onRestored={(id) => {
              void refreshWorkspaces();
              void loadSystem();
              void workspaceDbsQuery.refetch();
              setView({ name: "detail", databaseId: id, tab: "data" });
            }}
          />
        ) : view.name === "backups" ? (
          <BackupsPage
            workspaces={workspaces}
            onOpenDatabase={(id) => {
              void refreshWorkspaces();
              setView({ name: "detail", databaseId: id, tab: "data" });
            }}
          />
        ) : view.name === "activity" ? (
          <ActivityPage />
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
            onWorkspacesChanged={refreshWorkspaces}
            publicHost={systemInfo?.publicHost}
            onChanged={() => {
              void loadSystem();
              void workspaceDbsQuery.refetch();
            }}
          />
        )}
        </Suspense>
      </div>

      {/* Bottom tab bar on phones (< 600px) */}
      <nav
        aria-label="Mobile navigation"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-separator bg-surface sm:hidden"
      >
        {navItems.map((n) => (
          <button
            key={n.key}
            type="button"
            aria-current={activeNav === n.key ? "page" : undefined}
            onClick={() => setView(NAV_VIEWS[n.key])}
            className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
              activeNav === n.key ? "text-accent" : "text-muted"
            }`}
          >
            {n.icon}
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      {explorerOpen && (
        <Suspense fallback={null}>
        <ExplorerDrawer
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={setSelectedWorkspaceId}
          databases={workspaceDbsQuery.data ?? []}
          activeDatabaseId={view.name === "detail" ? view.databaseId : null}
          tables={activeSchemaQuery.data?.tables ?? []}
          activeTable={view.name === "detail" ? view.table : null}
          onOpenDatabase={(id) => setView({ name: "detail", databaseId: id, tab: "data" })}
          onOpenTable={(databaseId, table) => {
            setView({ name: "detail", databaseId, tab: "data", table });
            setExplorerOpen(false);
          }}
          onClose={() => setExplorerOpen(false)}
        />
        </Suspense>
      )}
    </div>
  );
}
