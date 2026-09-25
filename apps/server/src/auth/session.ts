// ---------------------------------------------------------------------------
// AuthService — single-operator login, sessions and login throttling.
//
// • Password: argon2id via Bun.password; bootstrapped from the CLI only
//   (`sqlitend set-password`) — there is no "first visitor sets it" web flow.
// • Optional TOTP second factor (`sqlitend enable-totp`).
// • Session id: 32 random bytes in an HttpOnly SameSite=Strict cookie; only
//   sha256(id) is stored. Idle and absolute limits; password/TOTP changes and
//   logout end sessions.
// • Throttling: a failure is reserved BEFORE the (slow) password verify and
//   refunded on success, so parallel bursts cannot outrun it. Per-IP: hard
//   lock after N failures in the window. Global: no lockout (that would let
//   anyone lock the operator out) — past the threshold, verifies are
//   serialized and delayed. A verify always runs (even with no admin row) so
//   timing does not reveal whether setup happened.
// • TOTP codes are single-use: the accepted time step is claimed atomically.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import type { AuthRepo, SessionRow } from "../db/repos/auth.ts";
import { matchTotp } from "./totp.ts";

export const SESSION_COOKIE = "sqlitend_session";
export const MIN_PASSWORD_LENGTH = 12;

export interface AuthOptions {
  idleMs?: number;
  absoluteMs?: number;
  perIpFailures?: number;
  /** Past this many failures in the window (all IPs), logins are slowed. */
  globalFailures?: number;
  /** Delay added to each login while globally slowed, ms. */
  slowDelayMs?: number;
  /** Max concurrent password verifies (1 while slowed). */
  maxInFlight?: number;
  windowMs?: number;
  now?: () => number;
}

export type LoginResult =
  | { ok: true; sessionId: string; session: SessionRow }
  | { ok: false; reason: "setup_required" | "invalid" | "totp_required" | "throttled"; retryAfterSec?: number };

// A real argon2id hash of a random string, verified when no admin exists so the
// no-admin path costs the same as a wrong password.
const DUMMY_HASH = Bun.password.hashSync(randomBytes(16).toString("hex"));

export const hashSessionId = (id: string) => createHash("sha256").update(id).digest("hex");

export class AuthService {
  readonly idleMs: number;
  readonly absoluteMs: number;
  private readonly perIp: number;
  private readonly global: number;
  private readonly windowMs: number;
  private readonly slowDelayMs: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private inFlight = 0;

  constructor(private readonly repo: AuthRepo, o: AuthOptions = {}) {
    this.idleMs = o.idleMs ?? 12 * 3_600_000;
    this.absoluteMs = o.absoluteMs ?? 7 * 86_400_000;
    this.perIp = o.perIpFailures ?? 5;
    this.global = o.globalFailures ?? 50;
    this.windowMs = o.windowMs ?? 15 * 60_000;
    this.slowDelayMs = o.slowDelayMs ?? 2_000;
    this.maxInFlight = o.maxInFlight ?? 4;
    this.now = o.now ?? Date.now;
  }

  get setupDone(): boolean {
    return this.repo.getAdmin() !== null;
  }

  get totpEnabled(): boolean {
    return !!this.repo.getAdmin()?.totp_secret;
  }

  private recent(list: number[], now: number): number[] {
    return list.filter((t) => t > now - this.windowMs);
  }

  /** Seconds until this IP may try again, or null. (Per-IP only: a global
   *  lock would let anyone lock the operator out.) */
  private throttled(ip: string, now: number): number | null {
    const mine = this.recent(this.failures.get(ip) ?? [], now);
    if (mine.length < this.perIp) return null;
    return Math.max(1, Math.ceil((mine[0]! + this.windowMs - now) / 1000));
  }

  private get globallySlowed(): boolean {
    return this.recent(this.globalFailures, this.now()).length >= this.global;
  }

  /** Reserve a failure up front; returns a refund for the success path. */
  private reserveFailure(ip: string, now: number): () => void {
    const mine = this.recent(this.failures.get(ip) ?? [], now);
    mine.push(now);
    this.failures.delete(ip); // re-insert → Map order = least recently failed first
    this.failures.set(ip, mine);
    this.globalFailures = this.recent(this.globalFailures, now);
    this.globalFailures.push(now);
    // Bounded memory without wiping everyone's counters: evict the oldest IPs.
    while (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
    return () => {
      const arr = this.failures.get(ip);
      const k = arr?.lastIndexOf(now) ?? -1;
      if (arr && k !== -1) arr.splice(k, 1);
      if (arr && arr.length === 0) this.failures.delete(ip);
      const g = this.globalFailures.lastIndexOf(now);
      if (g !== -1) this.globalFailures.splice(g, 1);
    };
  }

  async login(input: { password: string; totp?: string; ip: string; userAgent?: string | null }): Promise<LoginResult> {
    const now = this.now();
    const wait = this.throttled(input.ip, now);
    if (wait !== null) return { ok: false, reason: "throttled", retryAfterSec: wait };
    const slowed = this.globallySlowed;
    if (this.inFlight >= (slowed ? 1 : this.maxInFlight)) return { ok: false, reason: "throttled", retryAfterSec: 2 };

    const refund = this.reserveFailure(input.ip, now);
    this.inFlight++;
    let passwordOk: boolean;
    const admin = this.repo.getAdmin();
    try {
      if (slowed) await Bun.sleep(this.slowDelayMs);
      passwordOk = await Bun.password.verify(input.password, admin?.password_hash ?? DUMMY_HASH);
    } finally {
      this.inFlight--;
    }
    if (!admin) {
      refund();
      return { ok: false, reason: "setup_required" };
    }
    if (!passwordOk) return { ok: false, reason: "invalid" };
    if (admin.totp_secret) {
      // A missing code is not counted (the UI asks for it next); it does reveal
      // the password was right, but the reserved failure below still applies.
      if (!input.totp) {
        refund();
        return { ok: false, reason: "totp_required" };
      }
      const step = matchTotp(admin.totp_secret, input.totp, now);
      if (step === null || !this.repo.claimTotpStep(step)) return { ok: false, reason: "invalid" };
    }
    refund();
    this.failures.delete(input.ip);

    const sessionId = randomBytes(32).toString("base64url");
    const session: SessionRow = {
      id_hash: hashSessionId(sessionId),
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.absoluteMs,
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 256) ?? null,
    };
    this.repo.pruneSessions(now, this.idleMs);
    this.repo.createSession(session);
    return { ok: true, sessionId, session };
  }

  /** Validate a cookie value; slides the idle window (written at most once a minute). */
  validate(sessionId: string | undefined | null): SessionRow | null {
    if (!sessionId || sessionId.length > 128) return null;
    const now = this.now();
    const idHash = hashSessionId(sessionId);
    const s = this.repo.getSession(idHash);
    if (!s) return null;
    if (s.expires_at <= now || s.last_seen_at <= now - this.idleMs) {
      this.repo.deleteSession(idHash);
      return null;
    }
    if (now - s.last_seen_at > 60_000) this.repo.touchSession(idHash, now);
    return s;
  }

  logout(sessionId: string | undefined | null): void {
    if (sessionId) this.repo.deleteSession(hashSessionId(sessionId));
  }
}
