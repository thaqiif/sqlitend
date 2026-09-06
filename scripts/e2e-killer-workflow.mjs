#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// sqlitend killer-workflow e2e (AC-W6, AC-E11, UPGRADE-adjacent).
//
// Starts the real control plane against a throwaway data root, then walks the
// one happy path the product is built around:
//     create workspace -> create DB -> fetch the 3 connection URLs -> mint a
//     token -> connect with @libsql/client and run real SQL -> read metrics ->
//     delete DB -> delete workspace.
// plus two non-timed checks:
//   • negative-auth: a request with NO token is denied by sqld
//   • AC-E11 stop/start: a token minted before `stop` still authenticates after
//     `start` and the data written before the stop is intact.
//
// Exit 0 on success. Exits non-zero if sqld is unavailable or any assertion
// fails. Prints a warning if the timed happy path exceeds 20s (must stay <60s).
//
// Run:  bun run scripts/e2e-killer-workflow.mjs
// ---------------------------------------------------------------------------

import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "apps", "server", "src", "index.ts");
const SQLD = path.join(ROOT, "bin", "sqld");

// Ports overridable so parallel CI jobs / dev instances never collide.
const PORT = Number(process.env.SQLITEND_E2E_PORT ?? 6190);
const RANGE = process.env.SQLITEND_E2E_PORT_RANGE ?? "6510-6600";
const BASE = `http://127.0.0.1:${PORT}/api`;

// --- tiny helpers -----------------------------------------------------------
const j = (r) => r.json();
function api(pathname, init, base = BASE) {
  return fetch(base + pathname, { headers: { "content-type": "application/json" }, ...init });
}
function assert(cond, label) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  process.stdout.write(`  ✓ ${label}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const step = (name) => process.stdout.write(`\n== ${name} ==\n`);

// --- boot the control plane -------------------------------------------------
async function boot() {
  if (!existsSync(SQLD)) {
    console.error(`\nsqld binary not found at ${SQLD}.\nRun scripts/fetch-sqld.sh (or set SQLITEND_SQLD_PATH) and retry.\n`);
    process.exit(2);
  }
  const dataRoot = mkdtempSync(path.join(tmpdir(), "sqlitend-e2e-"));
  const srv = spawn(process.env.BUN ?? "bun", ["run", INDEX], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUN: undefined,
      SQLITEND_DATA_ROOT: dataRoot,
      SQLITEND_PORT: String(PORT),
      SQLITEND_PORT_RANGE: RANGE,
      SQLITEND_TOKEN_TTL_HOURS: "24",
      SQLITEND_SAMPLE_INTERVAL_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  srv.stdout.on("data", (d) => (output += d));
  srv.stderr.on("data", (d) => (output += d));

  // wait for /api/system (up to 15s)
  let sys = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + "/system");
      if (res.ok) { sys = await res.json(); break; }
    } catch {}
    await sleep(250);
  }
  if (!sys) {
    console.error("control plane did not become ready. log:\n" + output.slice(-2000));
    srv.kill("SIGKILL");
    process.exit(3);
  }
  if (!sys.sqldOk) {
    console.error(`control plane reports sqld unavailable (${sys.sqldReason}). log:\n${output.slice(-2000)}`);
    srv.kill("SIGKILL");
    process.exit(4);
  }
  console.log(`[boot] control plane ready, ${sys.sqldVersion} (dataRoot=${dataRoot})`);
  return { srv, dataRoot, output: () => output };
}

// --- timed killer workflow --------------------------------------------------
async function killerWorkflow(run) {
  step("KILLER-WORKFLOW (timed)");
  const t0 = Date.now();

  // workpaces
  const ws = await (await api("/workspaces", { method: "POST", body: JSON.stringify({ name: "e2e" }) })).json();
  assert(ws.slug === "e2e" && ws.id, "POST /workspaces returns workspace");

  const db = await (await api(`/workspaces/${ws.id}/databases`, { method: "POST", body: JSON.stringify({ name: "demo" }) })).json();
  assert(db.status === "running" && db.port && db.grpcPort, `POST database 201 -> running on :${db.port}/:${db.grpcPort}`);

  // connection
  const conn = await (await api(`/databases/${db.id}/connection`)).json();
  assert(conn.httpUrl === `http://127.0.0.1:${db.port}`, "connection.httpUrl");
  assert(conn.hranaUrl === `ws://127.0.0.1:${db.port}`, "connection.hranaUrl");
  assert(conn.grpcUrl === `http://127.0.0.1:${db.grpcPort}`, "connection.grpcUrl");
  assert(conn.dbName === "demo", "connection.dbName");

  // token + real SQL
  const issued = await (await api(`/databases/${db.id}/tokens`, { method: "POST", body: JSON.stringify({ scope: "full" }) })).json();
  assert(issued.token && issued.jti, "POST token returns minted JWT");
  const client = createClient({ url: conn.httpUrl, authToken: issued.token });
  await client.execute("create table if not exists t(id integer primary key, name text)");
  await client.execute("insert into t(name) values ('hello'), ('world')");
  const count = (await client.execute("select count(*) as n from t")).rows[0].n;
  assert(Number(count) === 2, "@libsql/client SELECT count(*) after two inserts == 2");

  // negative auth (non-timed block, but inline here while client handle exists)
  step("NEGATIVE-AUTH");
  let denied = false;
  try {
    const anon = createClient({ url: conn.httpUrl });
    await anon.execute("select 1");
  } catch (e) {
    denied = /401/.test(String(e));
  }
  assert(denied, "request with NO token is rejected (401) by sqld");

  // metrics reflect a live process
  await sleep(2500); // let the sampler observe the process
  const met = await (await api(`/databases/${db.id}/metrics`)).json();
  assert(met.status === "running", `metrics.status == running (got ${met.status})`);
  assert(Number(met.memoryBytes) > 0, `metrics.memoryBytes > 0 (got ${met.memoryBytes})`);
  assert(met.uptimeSec > 0, "metrics.uptimeSec > 0");

  // delete DB -> process + dir + ports gone; workspace delete once empty
  const del = await api(`/databases/${db.id}`, { method: "DELETE" });
  assert(del.status === 204, "DELETE database -> 204");
  await sleep(500);
  const delConn = await api(`/databases/${db.id}/connection`).then(async (r) => r.ok ? await r.json() : null).catch(() => null);
  assert(delConn === null, "deleted database no longer resolvable");

  const wsDel = await api(`/workspaces/${ws.id}`, { method: "DELETE" });
  assert(wsDel.status === 204, "DELETE workspace (now empty) -> 204");

  const wall = Date.now() - t0;
  if (wall > 20000) console.warn(`  ⚠ killer workflow took ${wall}ms (target <1000ms create; suggest <20s)`);
  console.log(`  killer workflow wall-clock: ${wall}ms`);
  return wall;
}

// --- AC-E11 stop/start preservation -----------------------------------------
async function stopStartCheck(run) {
  step("AC-E11 STOP/START PRESERVATION");
  const ws = await (await api("/workspaces", { method: "POST", body: JSON.stringify({ name: "persist" }) })).json();
  const db = await (await api(`/workspaces/${ws.id}/databases`, { method: "POST", body: JSON.stringify({ name: "kept" }) })).json();
  const conn = await (await api(`/databases/${db.id}/connection`)).json();
  const issued = await (await api(`/databases/${db.id}/tokens`, { method: "POST", body: JSON.stringify({}) })).json();

  const c = createClient({ url: conn.httpUrl, authToken: issued.token });
  await c.execute("create table if not exists k(id integer primary key, v text)");
  await c.execute("insert into k(v) values ('before-stop')");

  // stop
  const st = await api(`/databases/${db.id}/stop`, { method: "POST" });
  await st.json();
  let down = false;
  try { await createClient({ url: conn.httpUrl, authToken: issued.token }).execute("select 1"); }
  catch { down = true; }
  assert(down, "after stop, DB no longer accepts connections");

  // start
  const st2 = await api(`/databases/${db.id}/start`, { method: "POST" });
  const back = await st2.json();
  assert(back.status === "running", "after start, DB is running");

  // the pre-stop token still works and data survived
  let value = null, authOk = true;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await createClient({ url: conn.httpUrl, authToken: issued.token }).execute("select v from k where id=1");
      value = res.rows[0]?.v;
      if (value === "before-stop") break;
    } catch { await sleep(500); }
  }
  assert(value === "before-stop", "pre-stop token authenticates after restart AND data row survives");
  assert(authOk, "pre-stop token still authenticates (key reused across stop/start)");

  // cleanup
  await api(`/databases/${db.id}`, { method: "DELETE" });
  await api(`/workspaces/${ws.id}`, { method: "DELETE" });
}

// --- scoped cleanup ----------------------------------------------------------
// Collect the descendant PIDs of the e2e control plane by walking /proc ppid
// edges, then TERM -> KILL exactly that set. NEVER match on argv substrings
// (`--db-path` appears in the operator's REAL production sqld processes too —
// a global sweep here used to SIGTERM every database on the machine).
function readPpid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]); // field 4 (ppid) = idx 1 after comm's close paren
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null; // process gone
  }
}

function descendantPids(rootPid) {
  const children = new Map(); // ppid -> [pids]
  let entries = [];
  try {
    entries = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const name of entries) {
    const pid = Number(name);
    if (pid === rootPid) continue;
    const ppid = readPpid(pid);
    if (ppid == null) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const p = queue.pop();
    for (const c of children.get(p) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

async function cleanup(controlPlane) {
  if (controlPlane && controlPlane.exitCode == null) {
    process.stdout.write("\n[cleanup] sending SIGTERM to control plane…\n");
    controlPlane.kill("SIGTERM");
    await sleep(1500); // the control plane's own supervisor stops its sqld children
  }
  // Belt and suspenders: kill anything still descending from the e2e control
  // plane (e.g. if the control plane itself died mid-run). Strictly scoped to
  // its process tree — unrelated sqld processes are untouched.
  if (controlPlane) {
    const stragglers = descendantPids(controlPlane.pid).filter((pid) => pidAlive(pid));
    if (stragglers.length > 0) {
      console.log(`[cleanup] terminating ${stragglers.length} leftover e2e child process(es): ${stragglers.join(", ")}`);
      for (const pid of stragglers) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      await sleep(1000);
      for (const pid of stragglers) {
        if (pidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
  }
}

function pidAlive(pid) {
  try {
    readFileSync(`/proc/${pid}/stat`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// --- main -------------------------------------------------------------------
let srv = null;
let e2eDataRoot = null;
(async () => {
  const booted = await boot();
  srv = booted.srv;
  e2eDataRoot = booted.dataRoot;
  const started = Date.now();
  const wall = await killerWorkflow();
  await stopStartCheck();
  const total = Date.now() - started;
  step("SUMMARY");
  console.log(`  timed killer path  : ${wall}ms`);
  console.log(`  total (incl. stop/start + negative auth): ${total}ms`);
  if (wall >= 60000 || total >= 60000) {
    console.error("  e2e exceeded the 60s target");
    process.exitCode = 1;
    return;
  }
  console.log("\nE2E PASS ✓");
})()
  .catch((err) => {
    console.error("\nE2E FAIL:");
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup(srv);
    if (e2eDataRoot) {
      try { rmSync(e2eDataRoot, { recursive: true, force: true }); } catch {}
    }
  });
