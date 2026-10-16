import { mock } from "bun:test";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response | { status?: number; json?: unknown } | undefined;

/** Replaces global fetch with a recorder. Unmatched requests get a 404 JSON error. */
export function mockFetch(responder: Responder): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const out = responder(call);
    if (out instanceof Response) return out;
    if (out === undefined) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no mock" } }), { status: 404 });
    }
    const status = out.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(out.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls };
}
