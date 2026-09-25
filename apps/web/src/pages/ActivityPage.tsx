import { useEffect, useState } from "react";
import type { AuditEntry } from "@sqlitend/shared";
import { api } from "../api/client";

const PAGE = 100;

/** Audit log: logins (incl. failures) and every change, newest first. */
export function ActivityPage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: number) {
    try {
      const page = await api.listAudit(PAGE, before);
      setRows((prev) => (before ? [...prev, ...page] : page));
      setDone(page.length < PAGE);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="shell">
      <div className="panel-header">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <h2 className="panel-title">Activity</h2>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="panel">
        {rows.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Who</th>
                <th>IP</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td>{r.action}</td>
                  <td>
                    <span className={`scope-badge audit-${r.outcome}`} title={r.detail ?? undefined}>
                      {r.outcome}
                      {r.detail ? ` · ${r.detail}` : ""}
                    </span>
                  </td>
                  <td>{r.actor}</td>
                  <td>{r.ip ?? "—"}</td>
                  <td className="mono">{r.target ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!done && rows.length > 0 && (
          <button type="button" className="btn ghost small" onClick={() => void load(rows.at(-1)!.id)}>
            Load older
          </button>
        )}
      </section>
    </main>
  );
}
