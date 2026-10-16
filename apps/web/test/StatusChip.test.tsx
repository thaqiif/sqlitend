import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { StatusChip } from "../src/components/StatusChip";
import { auditTone, backupTone, dbStatusTone, stabilityTone, verifyTone } from "../src/components/status-tones";

describe("status tones", () => {
  test("database status maps healthy/transitional/faulted/inert states", () => {
    expect(dbStatusTone("running")).toBe("success");
    expect(dbStatusTone("starting")).toBe("warning");
    expect(dbStatusTone("crashed")).toBe("danger");
    expect(dbStatusTone("failed")).toBe("danger");
    expect(dbStatusTone("stopped")).toBe("default");
  });
  test("stability, backup, verify and audit outcomes", () => {
    expect(stabilityTone("healthy")).toBe("success");
    expect(stabilityTone("warning")).toBe("warning");
    expect(stabilityTone("degraded")).toBe("danger");
    expect(stabilityTone("stopped")).toBe("default");
    expect(backupTone("ok")).toBe("success");
    expect(backupTone("lagging")).toBe("warning");
    expect(backupTone("error")).toBe("danger");
    expect(verifyTone("ok")).toBe("success");
    expect(verifyTone("stale")).toBe("warning");
    expect(verifyTone("failed")).toBe("danger");
    expect(verifyTone("pending")).toBe("default");
    expect(auditTone("ok")).toBe("success");
    expect(auditTone("denied")).toBe("warning");
    expect(auditTone("error")).toBe("danger");
  });
  test("StatusChip renders its label and tooltip", () => {
    render(<StatusChip tone="danger" title="why">faulted</StatusChip>);
    expect(screen.getByTitle("why").textContent).toContain("faulted");
  });
});
