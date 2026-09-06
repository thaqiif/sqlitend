import { useEffect, useRef, useState } from "react";
import type { Connection, Database, Metrics, Token, TokenIssued } from "@sqlitend/shared";
import { api } from "../api/client";
import { MetricTiles } from "../components/MetricTiles";
import { Modal } from "../components/Modal";
import { TokenReveal } from "../components/TokenReveal";

const POLL_MS = 5000;
const DEFAULT_EXPIRY_HOURS = 24;
/** Consecutive metrics-poll failures before we surface "metrics unavailable". */
const METRIC_ERROR_THRESHOLD = 2;

interface Props {
  databaseId: string;
  onBack: () => void;
}

function fmtTime(epochMs: number): string {
  // API timestamps (createdAt/expiresAt) are epoch milliseconds (Date.now()).
  return new Date(epochMs).toLocaleString();
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="conn-row">
      <span className="conn-label">{label}</span>
      <code className="conn-value">{value}</code>
      <button
        type="button"
        className="btn ghost small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard unavailable; leave it editable for manual copy.
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function DatabaseDetail({ databaseId, onBack }: Props) {
  const [db, setDb] = useState<Database | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Consecutive metrics failures — lets us distinguish "no sample yet" from "metrics broken". */
  const [metricErrors, setMetricErrors] = useState(0);
  /** In-flight metrics request — drives the "refreshing" pulse AND prevents
   *  interleaved 5s polls from overlapping. */
  const [metricsPolling, setMetricsPolling] = useState(false);
  /** Overlap guard: a slow poll never overlaps the next 5s tick. */
  const metricsBusy = useRef(false);

  const [showTokenForm, setShowTokenForm] = useState(false);
  const [revealed, setRevealed] = useState<TokenIssued | null>(null);

  // Initial load. The database row is required; connection + token metadata are
  // fetched independently so one failed sub-request (e.g. 409 not_ready on a
  // failed-start DB) never bricks the page and hides the recovery path.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const d = await api.getDatabase(databaseId);
        if (!alive) return;
        setDb(d);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load database");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    api
      .getConnection(databaseId)
      .then((c) => alive && setConnection(c))
      .catch(() => {}); // degrade: "No connection details yet."
    api
      .listTokens(databaseId)
      .then((t) => alive && setTokens(t))
      .catch(() => {}); // degrade: token table stays empty.
    return () => {
      alive = false;
    };
  }, [databaseId]);

  // Live metrics poll every 5s.
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
        // metrics may be unavailable while a database stops; count consecutive
        // failures so a sustained outage is surfaced rather than shown as stale.
        if (alive) setMetricErrors((n) => n + 1);
      } finally {
        metricsBusy.current = false;
        if (alive) setMetricsPolling(false);
      }
    }
    load();
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
      // Start/stop changes whether a connection is available (a stopped or
      // failed-start DB has no endpoints) — refresh the panel in place.
      const c = await api.getConnection(databaseId).catch(() => null);
      setConnection(c);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  }

  async function handleStart() {
    await runAction(() => api.startDatabase(databaseId));
  }

  async function handleStop() {
    await runAction(() => api.stopDatabase(databaseId));
  }

  async function handleTokenIssued(issued: TokenIssued) {
    setRevealed(issued);
    setTokens(await api.listTokens(databaseId).catch(() => tokens));
  }

  async function handleRevoke(jti: string) {
    setActionError(null);
    try {
      // The backend always answers 501 with `revocation_unsupported` — surface that.
      await api.revokeToken(databaseId, jti);
      setTokens(await api.listTokens(databaseId));
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `Token revocation isn't supported by this server yet (HTTP 501): ${err.message}`
          : "Token revocation failed",
      );
    }
  }

  if (error && !db) {
    return (
      <main className="content standalone">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <p className="error" role="alert">{error}</p>
      </main>
    );
  }

  if (loading && !db) {
    return (
      <main className="content standalone">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <p className="muted">Loading database…</p>
      </main>
    );
  }

  if (!db) return null;

  const metricsDegraded = metricErrors >= METRIC_ERROR_THRESHOLD;

  return (
    <main className="content standalone">
      <div className="detail-nav">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <div className="detail-title">
          <h2>{db.name}</h2>
          <span className="db-slug">{db.slug}</span>
          <span className={`status-badge status-${db.status}`}>{db.status}</span>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="btn"
            onClick={handleStart}
            disabled={db.status !== "stopped" && db.status !== "failed" && db.status !== "crashed"}
          >
            Start
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleStop}
            disabled={db.status !== "running" && db.status !== "starting"}
          >
            Stop
          </button>
        </div>
      </div>

      {actionError && <p className="error inline" role="alert">{actionError}</p>}

      {/* A failed start carries sqld's captured stderr tail — show it so the
          operator can diagnose without SSHing to the box. */}
      {db.status === "failed" && db.failedReason && (
        <p className="error-detail" role="alert">Start failed: {db.failedReason}</p>
      )}

      <section className="panel">
        <h3 className="panel-title">Connection</h3>
        {connection ? (
          <div className="conn-list">
            <CopyRow label="HTTP" value={connection.httpUrl} />
            <CopyRow label="HRANA" value={connection.hranaUrl} />
            <CopyRow label="gRPC" value={connection.grpcUrl} />
          </div>
        ) : (
          <p className="muted">No connection details yet.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Tokens</h3>
          <button type="button" className="btn primary small" onClick={() => setShowTokenForm(true)}>
            + Generate token
          </button>
        </div>
        {tokens.length === 0 ? (
          <p className="muted">No tokens issued.</p>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Created</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.jti}>
                  <td>
                    <span className={`scope-badge scope-${t.scope}`}>{t.scope}</span>
                  </td>
                  <td>{fmtTime(t.createdAt)}</td>
                  <td>{fmtTime(t.expiresAt)}</td>
                  <td className="cell-end">
                    <button
                      type="button"
                      className="btn ghost small danger-text"
                      onClick={() => handleRevoke(t.jti)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3 className="panel-title">Live metrics</h3>
        <MetricTiles metrics={metrics} />
        <p className={`muted sampled${metricsPolling ? " sampling" : ""}`}>
          {metricsDegraded
            ? `Metrics unavailable — last sampled ${metrics ? fmtTime(metrics.sampledAt) : "never"}`
            : metrics
              ? `Sampled ${fmtTime(metrics.sampledAt)}`
              : "Awaiting sample…"}
        </p>
      </section>

      {showTokenForm && (
        <TokenForm
          databaseId={databaseId}
          onClose={() => setShowTokenForm(false)}
          onIssued={handleTokenIssued}
        />
      )}
      {revealed && <TokenReveal token={revealed} onDismiss={() => setRevealed(null)} />}
    </main>
  );
}

function TokenForm({
  databaseId,
  onClose,
  onIssued,
}: {
  databaseId: string;
  onClose: () => void;
  onIssued: (t: TokenIssued) => Promise<void>;
}) {
  const [expiresInHours, setExpiresInHours] = useState<number>(DEFAULT_EXPIRY_HOURS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const hours =
        Number.isFinite(expiresInHours) && expiresInHours > 0 ? expiresInHours : undefined;
      // v1 mints full-access tokens only (sqld cannot enforce per-request scopes),
      // so the scope is fixed and omitted from the request body.
      const issued = await api.generateToken(databaseId, {
        ...(hours ? { expiresInHours: hours } : {}),
      });
      onClose();
      await onIssued(issued);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate token");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Generate token" className="token-form" onClose={onClose}>
      <h2 className="modal-title">Generate token</h2>
      <p className="hint">Tokens grant full read + write access for this database.</p>
      {/* Form so Enter in the lifetime field submits, matching the other dialogs. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <label className="field">
          <span className="field-label">Lifetime (hours)</span>
          <input
            type="number"
            min={1}
            max={24 * 365}
            value={Number.isFinite(expiresInHours) ? expiresInHours : ""}
            onChange={(e) => setExpiresInHours(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <p className="hint">Blank defaults to {DEFAULT_EXPIRY_HOURS} hours.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Generate
          </button>
        </div>
      </form>
    </Modal>
  );
}