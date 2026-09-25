// ---------------------------------------------------------------------------
// Minimal Cloudflare DNS client (API v4) for the records sqlitend manages.
//
// Token needs only Zone → DNS → Edit on the one zone. Every record sqlitend
// creates carries the comment `managed-by:sqlitend db:<id>`. Ownership is an
// EXACT comment match: any other record on the name — hand-made, or created
// by another sqlitend instance for another database — is never modified or
// deleted (DnsConflictError instead).
// ---------------------------------------------------------------------------

export const MANAGED_COMMENT_PREFIX = "managed-by:sqlitend";

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

export class DnsConflictError extends Error {}
export class DnsApiError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly codes: number[] = []) {
    super(message);
  }
  /** Record-level 404 (81044), not a wrong zone or route. */
  get isRecordNotFound(): boolean {
    return this.status === 404 && this.codes.includes(81044);
  }
  /** "An identical/conflicting record already exists" (concurrent create). */
  get isAlreadyExists(): boolean {
    return this.codes.some((c) => c === 81053 || c === 81057 || c === 81058);
  }
}

export function managedComment(dbId: string): string {
  return `${MANAGED_COMMENT_PREFIX} db:${dbId}`;
}

export interface CloudflareDnsOptions {
  apiToken: string;
  zoneId: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type CfEnvelope<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

export class CloudflareDns {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: CloudflareDnsOptions) {
    this.base = (o.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.doFetch = o.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/zones/${encodeURIComponent(this.o.zoneId)}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.o.apiToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new DnsApiError(`cloudflare unreachable: ${(err as Error).message}`);
    }
    let env: CfEnvelope<T> | null = null;
    try {
      env = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !env?.success) {
      const msg = env?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new DnsApiError(
        `cloudflare ${method} ${path.split("?")[0]} failed: ${msg}`,
        res.status,
        env?.errors?.map((e) => e.code) ?? [],
      );
    }
    return env.result;
  }

  async findByName(name: string): Promise<DnsRecord[]> {
    return this.call<DnsRecord[]>("GET", `/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
  }

  /** Records on `name` whose comment is exactly `comment`. */
  async findOwned(name: string, comment: string): Promise<DnsRecord[]> {
    return (await this.findByName(name)).filter((r) => r.comment === comment);
  }

  /**
   * Make `name` a proxied CNAME to `target`, idempotently. Creates it, repairs
   * drift on OUR record (exact comment), and refuses anything else on the name.
   */
  async ensureCname(name: string, target: string, comment: string, retried = false): Promise<DnsRecord> {
    const existing = await this.findByName(name);
    const foreign = existing.find((r) => r.comment !== comment);
    if (foreign) {
      throw new DnsConflictError(`${name} already has a ${foreign.type} record not owned by this database; remove it or pick another database name`);
    }
    const desired = { type: "CNAME", name, content: target, proxied: true, ttl: 1, comment };
    const mine = existing[0];
    if (!mine) {
      try {
        return await this.call<DnsRecord>("POST", "/dns_records", desired);
      } catch (err) {
        // A concurrent create won the race: re-read once and converge.
        if (!retried && err instanceof DnsApiError && err.isAlreadyExists) return this.ensureCname(name, target, comment, true);
        throw err;
      }
    }
    if (mine.type === "CNAME" && mine.content === target && mine.proxied) return mine;
    return this.call<DnsRecord>("PATCH", `/dns_records/${encodeURIComponent(mine.id)}`, desired);
  }

  /** Delete a record only if its comment is exactly `comment`. Missing → no-op. */
  async deleteOwned(recordId: string, comment: string): Promise<void> {
    let rec: DnsRecord;
    try {
      rec = await this.call<DnsRecord>("GET", `/dns_records/${encodeURIComponent(recordId)}`);
    } catch (err) {
      if (err instanceof DnsApiError && err.isRecordNotFound) return;
      throw err;
    }
    if (rec.comment !== comment) throw new DnsConflictError(`record ${recordId} is not owned by this database; left in place`);
    await this.call("DELETE", `/dns_records/${encodeURIComponent(recordId)}`);
  }
}
