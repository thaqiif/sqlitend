import { describe, expect, test } from "bun:test";
import { fullTime, relTime, shortSqldVersion } from "../src/format";

describe("shortSqldVersion", () => {
  test("extracts x.y.z from the long sqld banner", () => {
    expect(shortSqldVersion("sqld sqld 0.24.32 (40c272de 2025-02-14)")).toBe("0.24.32");
  });
  test("returns null for missing or version-less input", () => {
    expect(shortSqldVersion(null)).toBeNull();
    expect(shortSqldVersion(undefined)).toBeNull();
    expect(shortSqldVersion("unknown")).toBeNull();
  });
});

describe("relTime", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const MIN = 60_000;
  const DAY = 86_400_000;

  test("under a minute is 'just now'", () => {
    expect(relTime(now - 20_000, now)).toBe("just now");
    expect(relTime(now + 20_000, now)).toBe("just now");
  });
  test("past times read as ago", () => {
    expect(relTime(now - 5 * MIN, now)).toMatch(/5 minutes ago/);
    expect(relTime(now - 3 * 3_600_000, now)).toMatch(/3 hours ago/);
    expect(relTime(now - DAY, now)).toMatch(/yesterday/);
  });
  test("future times read as in …", () => {
    expect(relTime(now + 2 * DAY, now)).toMatch(/in 2 days/);
  });
  test("rounding up to the next unit prefers the larger unit (350 days is about a year or 12 months)", () => {
    expect(relTime(now + 350 * DAY, now)).not.toMatch(/week/);
  });
});

test("fullTime renders a local timestamp string for the epoch", () => {
  const t = Date.UTC(2026, 5, 1, 8, 30, 0);
  expect(fullTime(t)).toBe(new Date(t).toLocaleString());
});
