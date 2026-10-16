import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Metrics } from "@sqlitend/shared";
import { mockFetch, type Call } from "./fetch-mock";

// uPlot draws on <canvas>, which happy-dom does not implement: replace it with a recorder.
interface PlotRec {
  opts: { series: { label?: string }[] };
  data: unknown[][];
  destroyed: boolean;
}
const plots: PlotRec[] = [];
mock.module("uplot", () => ({
  default: class FakeUPlot {
    rec: PlotRec;
    constructor(opts: PlotRec["opts"], data: unknown[][]) {
      this.rec = { opts, data, destroyed: false };
      plots.push(this.rec);
    }
    setSize() {}
    destroy() {
      this.rec.destroyed = true;
    }
  },
}));
const { default: MetricsTab } = await import("../src/components/MetricsTab");

const stability = {
  level: "warning",
  label: "Unstable",
  rule: "Unstable = 2+ crashes in 24h or availability below 99.5%",
  availabilityPct24h: 98.76,
  crashes24h: 2,
  totalCrashes: 5,
  restartCount: 6,
  lastCrashAt: Date.now() - 3_600_000,
  lastCrashReason: "OOM killed",
};
const point = (i: number) => ({
  t: 1_700_000_000_000 + i * 60_000,
  status: "running",
  cpuPct: i,
  memoryBytes: (i + 1) * 1024 * 1024,
  diskBytes: 2048 * (i + 1),
  walBytes: 1024 * (i + 1),
  queryCount: i,
  queryErrors: 0,
  p50Ms: 1 + i,
  p95Ms: 5 + i,
  p99Ms: 9 + i,
});
const history = (range: string) => ({
  range,
  points: [point(0), point(1), point(2)],
  diskGrowthBytesPerHour: 2048,
  stability,
  latency: { p50Ms: 1, p95Ms: 5, p99Ms: 9, totalQueries: 1234, totalErrors: 3, errorRatePct: 0.2 },
});
const LIVE = { databaseId: "d1", status: "running", cpuPct: 3.2, memoryBytes: 52_428_800, diskBytes: 4096, uptimeSec: 7200, sampledAt: 1_700_000_000_000 } as unknown as Metrics;

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tab = (qc: QueryClient, over: Partial<Parameters<typeof MetricsTab>[0]> = {}) => (
  <QueryClientProvider client={qc}>
    <MetricsTab dbId="d1" dbStatus="running" liveMetrics={LIVE} metricsPolling={false} metricsDegraded={false} {...over} />
  </QueryClientProvider>
);
function renderTab(over: Partial<Parameters<typeof MetricsTab>[0]> = {}) {
  const qc = client();
  const r = render(tab(qc, over));
  return { ...r, rerenderTab: (o: Partial<Parameters<typeof MetricsTab>[0]>) => r.rerender(tab(qc, o)) };
}
const api = () =>
  mockFetch((c: Call) => {
    if (c.url.startsWith("/api/databases/d1/metrics/history")) return { json: history(new URL(c.url, "http://x").searchParams.get("range")!) };
    if (c.url === "/api/databases/d1/storage")
      return { json: { pageCount: 100, pageSize: 4096, freelistCount: 2, walBytes: 0, diskBytes: 409_600, tableRowCounts: [{ name: "users", count: 1500 }] } };
    return undefined;
  });

beforeEach(() => {
  plots.length = 0;
});

describe("MetricsTab", () => {
  test("shows the stability badge with its rule, availability and last crash", async () => {
    api();
    renderTab();
    const card = await screen.findByLabelText("Stability");
    expect(within(card).getByText("Unstable")).toBeTruthy();
    expect(within(card).getByText(`Rule: ${stability.rule}`)).toBeTruthy();
    expect(within(card).getByText(/98\.76%/)).toBeTruthy();
    expect(within(card).getByText(/2 crashes in 24h \(5 total, 6 total restarts\)/)).toBeTruthy();
    expect(within(card).getByText(/OOM killed/)).toBeTruthy();
  });

  test("draws four charts and hands uPlot the aligned data", async () => {
    api();
    renderTab();
    await waitFor(() => expect(plots.length).toBe(4));
    const cpu = plots[0]!;
    const ts = [1_700_000_000, 1_700_000_060, 1_700_000_120];
    expect(cpu.data).toEqual([ts, [0, 1, 2]]);
    expect(plots[1]!.data).toEqual([ts, [1, 2, 3]]); // memory RSS in MB
    expect(plots[2]!.data).toEqual([ts, [2, 4, 6], [1, 2, 3]]); // disk KB, WAL KB
    expect(plots[3]!.data).toEqual([ts, [1, 2, 3], [5, 6, 7]]); // p50, p95
    expect(cpu.opts.series.map((s) => s.label)).toEqual([undefined, "CPU %"]);
    expect(screen.getByText("CPU (%)")).toBeTruthy();
  });

  test("does not rebuild the charts on an unrelated re-render", async () => {
    api();
    const { rerenderTab } = renderTab();
    await waitFor(() => expect(plots.length).toBe(4));
    rerenderTab({ liveMetrics: { ...LIVE, cpuPct: 9 }, metricsPolling: true });
    expect(await screen.findByText("9.0%")).toBeTruthy();
    expect(plots.length).toBe(4);
    expect(plots.some((p) => p.destroyed)).toBe(false);
  });

  test("rebuilds the charts when the theme changes", async () => {
    api();
    renderTab();
    await waitFor(() => expect(plots.length).toBe(4));
    act(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await waitFor(() => expect(plots.length).toBe(8));
    expect(plots.slice(0, 4).every((p) => p.destroyed)).toBe(true);
  });

  test("range tabs 1h / 24h / 7d refetch the history for that range", async () => {
    const { calls } = api();
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText("Stability");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["1h", "24h", "7d"]);
    expect(screen.getByRole("tab", { name: "1h" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "7d" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("range=7d"))).toBe(true));
    expect(screen.getByRole("tab", { name: "7d" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "24h" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("range=24h"))).toBe(true));
  });

  test("shows latency, WAL size, growth, live tiles and storage breakdown", async () => {
    api();
    renderTab();
    expect(await screen.findByText("1 / 5 / 9 ms")).toBeTruthy();
    expect(screen.getByText("1,234 (0.2% err)")).toBeTruthy();
    expect(screen.getByText("+2.0 KB/hr")).toBeTruthy();
    expect(screen.getByText("3.2%")).toBeTruthy();
    const storage = await screen.findByRole("table", { name: "Row counts" });
    expect(within(storage).getByText("1,500")).toBeTruthy();
    expect(screen.getByText("100 x 4096 B")).toBeTruthy();
  });

  test("with no samples it says so, and degraded metrics are flagged", async () => {
    mockFetch((c) =>
      c.url.includes("/metrics/history")
        ? { json: { ...history("1h"), points: [], diskGrowthBytesPerHour: null, latency: { p50Ms: null, p95Ms: null, p99Ms: null, totalQueries: 0, totalErrors: 0, errorRatePct: 0 } } }
        : undefined,
    );
    renderTab({ metricsDegraded: true, dbStatus: "stopped", liveMetrics: null });
    expect(await screen.findByText("Collecting time-series samples...")).toBeTruthy();
    expect(screen.getByText("Metrics unavailable")).toBeTruthy();
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(plots.length).toBe(0);
  });
});
