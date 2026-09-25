// ---------------------------------------------------------------------------
// DnsManager — keeps each database's public hostname record in Cloudflare in
// step with metadata. DNS never blocks database lifecycle: failures are
// recorded on the row (dns_status/dns_error) and retried on boot or via
// POST /api/databases/:id/dns/sync.
// ---------------------------------------------------------------------------

import type { DatabaseRow, DatabasesRepo } from "../db/repos/databases.ts";
import { publicKeyFor, renderHost, type HostTemplate } from "../gateway/gateway.ts";
import { CloudflareDns, DnsConflictError, managedComment } from "./cloudflare.ts";

export interface DnsManagerDeps {
  cf: CloudflareDns;
  template: HostTemplate;
  /** CNAME target, e.g. "<tunnel-uuid>.cfargotunnel.com". */
  target: string;
  databases: DatabasesRepo;
}

// DNS work for one database is serialized (create/sync/delete/reconcile), so a
// delete always observes the record id a concurrent sync wrote, and each
// operation re-reads the row inside the lock.
export class DnsManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: DnsManagerDeps) {}

  private withLock<T>(dbId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(dbId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(dbId, tail);
    void tail.then(() => {
      if (this.locks.get(dbId) === tail) this.locks.delete(dbId);
    });
    return next;
  }

  hostnameFor(row: DatabaseRow): string {
    return renderHost(this.d.template, publicKeyFor(this.d.template, row));
  }

  sync(row: DatabaseRow): Promise<void> {
    return this.withLock(row.id, () => this.syncLocked(row.id));
  }

  private async syncLocked(dbId: string): Promise<void> {
    const row = this.d.databases.getById(dbId);
    if (!row || row.status === "deleting") return;
    const hostname = this.hostnameFor(row);
    const comment = managedComment(row.id);
    try {
      const rec = await this.d.cf.ensureCname(hostname, this.d.target, comment);
      if (!this.d.databases.getById(row.id)) {
        // Row vanished while we were talking to Cloudflare: do not leak the record.
        await this.d.cf.deleteOwned(rec.id, comment);
        return;
      }
      this.d.databases.setDns(row.id, { hostname, recordId: rec.id, status: "active", error: null });
    } catch (err) {
      const status = err instanceof DnsConflictError ? "conflict" : "error";
      console.warn(`[dns] ${hostname}: ${status}: ${(err as Error).message}`);
      this.d.databases.setDns(row.id, { hostname, recordId: row.dns_record_id, status, error: (err as Error).message });
    }
  }

  /**
   * Best-effort removal before a database row is deleted. Never throws. If the
   * record id was never saved (lost response), falls back to the records on
   * the hostname that carry this database's exact comment.
   */
  remove(row: DatabaseRow): Promise<void> {
    return this.withLock(row.id, async () => {
      const cur = this.d.databases.getById(row.id) ?? row;
      const hostname = cur.dns_hostname ?? this.hostnameFor(cur);
      const comment = managedComment(cur.id);
      try {
        const ids = cur.dns_record_id
          ? [cur.dns_record_id]
          : (await this.d.cf.findOwned(hostname, comment)).map((r) => r.id);
        for (const id of ids) await this.d.cf.deleteOwned(id, comment);
      } catch (err) {
        console.warn(`[dns] could not remove ${hostname}: ${(err as Error).message}`);
      }
    });
  }

  /** Boot pass: sync every database whose record is missing or not active. */
  async reconcileAll(): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    for (const { id } of this.d.databases.list()) {
      const row = this.d.databases.getById(id);
      if (!row || (row.dns_status === "active" && row.dns_hostname === this.hostnameFor(row))) continue;
      await this.sync(row);
      const fresh = this.d.databases.getById(id);
      if (!fresh) continue;
      if (fresh.dns_status === "active") synced++;
      else failed++;
    }
    return { synced, failed };
  }
}
