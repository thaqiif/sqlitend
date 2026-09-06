import { describe, expect, test } from "bun:test";
import { createPortAllocator, PortExhaustedError } from "../../src/supervisor/ports.ts";
import { loadConfig } from "../../src/config.ts";

// High, unlikely-occupied local ports so the live TCP probes see them free.
function alloc(range: [number, number], persisted: () => Set<number> = () => new Set()) {
  return createPortAllocator(loadConfig({}, { portRange: { start: range[0], end: range[1] } }), { persistedInUse: persisted });
}

describe("port allocator", () => {
  test("allocatePair returns the two lowest free ports as http<grpc and reserves them", async () => {
    const a = alloc([23001, 23100]);
    const p = await a.allocatePair();
    expect(p.http).toBeLessThan(p.grpc);
    expect(p.http).toBe(23001);
    expect(p.grpc).toBe(23002);
    // second allocation must not reuse the first pair (they are reserved)
    const q = await a.allocatePair();
    expect([q.http, q.grpc]).not.toContain(p.http);
    expect([q.http, q.grpc]).not.toContain(p.grpc);
    expect(q.http).toBe(23003);
  });

  test("skips persisted ports (from either database port column)", async () => {
    const a = alloc([23100, 23199], () => new Set([23100, 23101, 23102])); // both cols persisted
    const p = await a.allocatePair();
    expect(p.http).toBe(23103);
    expect(p.grpc).toBe(23104);
  });

  test("freed ports are reused lowest-first", async () => {
    const a = alloc([23200, 23299]);
    const p = await a.allocatePair();
    a.release(p);
    const again = await a.allocatePair();
    expect(again.http).toBe(p.http);
    expect(again.grpc).toBe(p.grpc);
  });

  test("concurrent allocatePair calls never return the same port (serialized)", async () => {
    const a = alloc([23300, 23399]);
    const pairs = await Promise.all([a.allocatePair(), a.allocatePair(), a.allocatePair()]);
    const ports = pairs.flatMap((p) => [p.http, p.grpc]);
    expect(new Set(ports).size).toBe(6); // 6 distinct ports across 3 pairs
  });

  test("throws PortExhaustedError when the range has fewer than two free ports", async () => {
    const a = alloc([23400, 23400], () => new Set([23400]));
    await expect(a.allocatePair()).rejects.toBeInstanceOf(PortExhaustedError);
  });
});
