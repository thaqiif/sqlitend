// ---------------------------------------------------------------------------
// Client IP for throttling + audit. Behind a local proxy/tunnel every socket
// peer is loopback, which would put all clients in one throttle bucket; with
// SQLITEND_TRUST_PROXY the forwarded address is used — but only when the peer
// really is loopback, so remote clients cannot spoof the header.
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

export function clientIp(req: Request, peer: string | null, trust: "off" | "cloudflare" | "xff"): string {
  const socket = peer ?? "unknown";
  if (trust === "off" || !LOOPBACK.has(socket)) return socket;
  const raw =
    trust === "cloudflare"
      ? req.headers.get("cf-connecting-ip")
      : req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).at(-1);
  return raw && IP_RE.test(raw) ? raw : socket;
}
