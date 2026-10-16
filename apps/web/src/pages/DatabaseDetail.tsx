import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Skeleton, Tabs } from "@heroui/react";
import type { Database, Metrics, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { DataGridTab } from "../components/DataGridTab";
import { ErrorAlert } from "../components/ErrorAlert";
import { ArrowLeftIcon, ExplorerIcon } from "../components/icons";
import { SettingsTab } from "../components/SettingsTab";
import { StatusChip } from "../components/StatusChip";
import { dbStatusTone } from "../components/status-tones";
import { StructureTab } from "../components/StructureTab";

const SqlConsoleTab = lazy(() => import("../components/SqlConsoleTab"));
const MetricsTab = lazy(() => import("../components/MetricsTab"));

export type DbSubTab = "data" | "sql" | "structure" | "metrics" | "settings";

const POLL_MS = 5000;
const METRIC_ERROR_THRESHOLD = 2;

interface Props {
  databaseId: string;
  onBack: () => void;
  workspaces?: Workspace[];
  onOpenDatabase?: (id: string) => void;
  activeTab?: DbSubTab;
  onTabChange?: (tab: DbSubTab) => void;
  selectedTable?: string | null;
  onSelectTable?: (table: string) => void;
  onOpenExplorerDrawer?: () => void;
}

const lazyFallback = (h: string): ReactNode => <Skeleton className={`${h} w-full rounded-xl`} />;

export function DatabaseDetail({
  databaseId,
  onBack,
  workspaces = [],
  onOpenDatabase,
  activeTab: controlledTab,
  onTabChange,
  selectedTable: controlledTable,
  onSelectTable,
  onOpenExplorerDrawer,
}: Props) {
  const queryClient = useQueryClient();
  const [internalTab, setInternalTab] = useState<DbSubTab>("data");
  const [internalTable, setInternalTable] = useState<string | null>(null);

  const tab = controlledTab ?? internalTab;
  const setTab = (next: DbSubTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const selectedTable = controlledTable !== undefined ? controlledTable : internalTable;
  const setSelectedTable = (name: string) => {
    setInternalTable(name);
    onSelectTable?.(name);
  };

  const [db, setDb] = useState<Database | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [metricErrors, setMetricErrors] = useState(0);
  const [metricsPolling, setMetricsPolling] = useState(false);
  const metricsBusy = useRef(false);

  const schemaQuery = useQuery({
    queryKey: ["schema", databaseId],
    queryFn: () => api.getSchema(databaseId),
    enabled: db?.status === "running",
  });
  const tables = schemaQuery.data?.tables;
  const tableList = tables ?? [];

  // Default the selected table to the first one once the schema loads (or when the old one is gone).
  // The parent callback is read through a ref so it does not retrigger the effect.
  const selectRef = useRef(setSelectedTable);
  selectRef.current = setSelectedTable;
  useEffect(() => {
    if (tables && tables.length > 0 && (!selectedTable || !tables.some((t) => t.name === selectedTable))) {
      selectRef.current(tables[0]!.name);
    }
  }, [tables, selectedTable]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getDatabase(databaseId)
      .then((d) => {
        if (!alive) return;
        setDb(d);
        setError(null);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Failed to load database"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [databaseId]);

  const status = db?.status;
  useEffect(() => {
    if (status !== "restoring") return;
    const t = setInterval(async () => {
      const d = await api.getDatabase(databaseId).catch(() => null);
      if (d) setDb(d);
    }, 2_000);
    return () => clearInterval(t);
  }, [status, databaseId]);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (metricsBusy.current) return;
      metricsBusy.current = true;
      setMetricsPolling(true);
      try {
        const m = await api.getMetrics(databaseId);
        if (alive) {
          setMetrics(m);
          setMetricErrors(0);
        }
      } catch {
        if (alive) setMetricErrors((n) => n + 1);
      } finally {
        metricsBusy.current = false;
        if (alive) setMetricsPolling(false);
      }
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [databaseId]);

  async function runAction(fn: () => Promise<Database>) {
    setActionError(null);
    try {
      const d = await fn();
      setDb(d);
      if (d.status === "running") void queryClient.invalidateQueries({ queryKey: ["schema", databaseId] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  }

  if (error && !db) {
    return (
      <main className="flex min-w-0 flex-col gap-3 p-4 md:p-6">
        <div>
          <Button variant="ghost" className="min-h-11" onPress={onBack}>
            <ArrowLeftIcon size={18} />
            Back
          </Button>
        </div>
        <ErrorAlert>{error}</ErrorAlert>
      </main>
    );
  }
  if (loading && !db) {
    return (
      <main className="flex min-w-0 flex-col gap-3 p-4 md:p-6" aria-busy="true">
        <Skeleton className="h-8 w-56 rounded-lg" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </main>
    );
  }
  if (!db) return null;

  const notRunning = db.status !== "running";
  const startable = db.status === "stopped" || db.status === "failed" || db.status === "crashed";
  const gate = (content: ReactNode): ReactNode =>
    notRunning ? (
      <Card className="items-center gap-3 p-6 text-center">
        <p className="m-0">
          Database is currently <strong>{db.status}</strong>. Start the database to inspect tables or execute SQL queries.
        </p>
        <Button variant="primary" className="min-h-11" isDisabled={!startable} onPress={() => void runAction(() => api.startDatabase(databaseId))}>
          Start database
        </Button>
      </Card>
    ) : (
      content
    );

  return (
    <main className="flex min-w-0 flex-col gap-3 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="min-h-11" onPress={onBack}>
          <ArrowLeftIcon size={18} />
          Databases
        </Button>
        {onOpenExplorerDrawer && (
          <Button variant="secondary" className="min-h-11" onPress={onOpenExplorerDrawer}>
            <ExplorerIcon size={18} />
            Explorer ({tableList.length})
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="m-0 min-w-0 max-w-full truncate text-xl font-semibold">{db.name}</h2>
          {db.slug !== db.name && <code className="text-xs text-muted">{db.slug}</code>}
          <StatusChip tone={dbStatusTone(db.status)}>{db.status}</StatusChip>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="min-h-11" isDisabled={!startable} onPress={() => void runAction(() => api.startDatabase(databaseId))}>
            Start
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            isDisabled={db.status !== "running" && db.status !== "starting"}
            onPress={() => void runAction(() => api.stopDatabase(databaseId))}
          >
            Stop
          </Button>
        </div>
      </div>

      {actionError && <ErrorAlert>{actionError}</ErrorAlert>}
      {db.status === "failed" && db.failedReason && <ErrorAlert>{`Start failed: ${db.failedReason}`}</ErrorAlert>}
      {db.status === "restoring" && (
        <p className="m-0 text-sm text-muted" role="status">
          Restoring from backup: downloading, verifying with integrity_check, then starting...
        </p>
      )}

      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k) as DbSubTab)} className="min-w-0">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Database client views">
            <Tabs.Tab id="data" className="min-h-11 whitespace-nowrap">
              Data ({tableList.length})
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="sql" className="min-h-11 whitespace-nowrap">
              SQL
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="structure" className="min-h-11 whitespace-nowrap">
              Structure
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="metrics" className="min-h-11 whitespace-nowrap">
              Metrics
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="settings" className="min-h-11 whitespace-nowrap">
              Settings
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="data" className="min-w-0 pt-3">
          {gate(
            <DataGridTab
              dbId={databaseId}
              tables={tableList}
              selectedTable={selectedTable}
              onSelectTable={setSelectedTable}
              onOpenSqlTab={() => setTab("sql")}
            />,
          )}
        </Tabs.Panel>
        <Tabs.Panel id="sql" className="min-w-0 pt-3">
          {gate(
            <Suspense fallback={lazyFallback("h-48")}>
              <SqlConsoleTab
                dbId={databaseId}
                tables={tableList}
                onSchemaMayHaveChanged={() => {
                  void queryClient.invalidateQueries({ queryKey: ["schema", databaseId] });
                  void queryClient.invalidateQueries({ queryKey: ["tableRows", databaseId] });
                }}
              />
            </Suspense>,
          )}
        </Tabs.Panel>
        <Tabs.Panel id="structure" className="min-w-0 pt-3">
          {gate(
            <StructureTab
              tables={tableList}
              selectedTable={selectedTable}
              onSelectTable={setSelectedTable}
              onRefresh={() => void schemaQuery.refetch()}
            />,
          )}
        </Tabs.Panel>
        <Tabs.Panel id="metrics" className="min-w-0 pt-3">
          <Suspense fallback={lazyFallback("h-56")}>
            <MetricsTab
              dbId={databaseId}
              dbStatus={db.status}
              liveMetrics={metrics}
              metricsPolling={metricsPolling}
              metricsDegraded={metricErrors >= METRIC_ERROR_THRESHOLD}
            />
          </Suspense>
        </Tabs.Panel>
        <Tabs.Panel id="settings" className="min-w-0 pt-3">
          <SettingsTab db={db} workspaces={workspaces} onDbChange={setDb} onOpenDatabase={onOpenDatabase} onBack={onBack} />
        </Tabs.Panel>
      </Tabs>
    </main>
  );
}
