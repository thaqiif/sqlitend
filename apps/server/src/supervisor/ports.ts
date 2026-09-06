// ---------------------------------------------------------------------------
// Port allocator — reserves an explicit http+grpc port PAIR per database.
//
// Allocation policy (D7):
//   - range: config.SQLITEND_PORT_RANGE (default 6101-6300)
//   - a candidate port is free iff it is NOT persisted in `port` or `grpc_port`
//     of any database row, NOT already reserved in-memory this run, AND a live
//     TCP connect probe to 127.0.0.1:<port> fails (guards foreign listeners and
//     stale state after unclean shutdown).
//   - the pair is the two lowest free ports (http = lower, grpc = higher).
//   - releases return ports to the pool (metadata delete also drops them).
// ---------------------------------------------------------------------------

import { createConnection } from "node:net";
import type { Config } from "../config.ts";

export class PortExhaustedError extends Error {
  constructor(range: string) {
    super(`no free port available in range ${range}`);
    this.name = "PortExhaustedError";
  }
}

export interface PortAllocator {
  /** Allocate the lowest-free http+grpc pair, recording them as reserved. */
  allocatePair(): Promise<{ http: number; grpc: number }>;
  /** Release a previously allocated pair back into the pool. */
  release(pair: { http: number; grpc: number }): void;
  /** Mark specific ports as reserved in-memory (used at boot reconcile). */
  reserve(ports: number[]): void;
  /** The candidate set a port must not be. Allows the API layer to exclude
   *  currently-persisted ports explicitly. */
  isFree(port: number, persistedInUse: Set<number>): Promise<boolean>;
}

function probePort(port: number, timeoutMs = 300): Promise<boolean> {
  // Returns true if the port is BOUND (someone listening) -> not free.
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    let done = false;
    const finish = (bound: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(bound);
    };
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/** True iff something is already listening on 127.0.0.1:<port>. Exported for
 *  the boot reconcile double-bind guard (never spawn a second sqld onto a
 *  port an untracked process still holds). */
export function portBound(port: number): Promise<boolean> {
  return probePort(port);
}

export function createPortAllocator(
  config: Config,
  opts: { persistedInUse: () => Set<number>; probe?: (port: number) => Promise<boolean> },
) {
  const { start, end } = config.portRange;
  const reserved = new Set<number>();
  // The TCP probe is injectable (test seam): it returns true when the port is
  // BOUND (someone listening) -> not free. Defaults to the live probe; tests
  // substitute a deterministic stub so allocation is host-probe-independent.
  const probe = opts.probe ?? ((port: number) => probePort(port));

  const isFree = async (port: number, persisted: Set<number>): Promise<boolean> => {
    if (reserved.has(port)) return false;
    if (persisted.has(port)) return false;
    // False positive = already bound (foreign or stale) -> not free.
    return !(await probe(port));
  };

  // Serialize allocations: `allocatePair` is async (TCP probes), so two
  // concurrent creates could both pick the same pair during the probe window.
  // Chaining every allocation through one promise keeps the in-memory `reserved`
  // set authoritative. Allocations are rare (DB create), so the lock is free.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  return {
    isFree: (port: number, persisted: Set<number>) => isFree(port, persisted),

    allocatePair: (): Promise<{ http: number; grpc: number }> =>
      serialize(async () => {
        const persisted = opts.persistedInUse();
        const free: number[] = [];
        for (let p = start; p <= end; p++) {
          if (await isFree(p, persisted)) free.push(p);
          if (free.length >= 2) break;
        }
        if (free.length < 2) throw new PortExhaustedError(`${start}-${end}`);
        const [http, grpc] = free as [number, number];
        reserved.add(http);
        reserved.add(grpc);
        return { http, grpc };
      }),

    release(pair: { http: number; grpc: number }) {
      reserved.delete(pair.http);
      reserved.delete(pair.grpc);
    },

    reserve(ports: number[]) {
      for (const p of ports) reserved.add(p);
    },
  } as PortAllocator & { isFree: (p: number, s: Set<number>) => Promise<boolean> };
}
