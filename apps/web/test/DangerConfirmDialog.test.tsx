import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DangerConfirmDialog } from "../src/components/DangerConfirmDialog";

function setup(onConfirm = jest.fn(async (_s: string) => {})) {
  const onCancel = jest.fn();
  render(
    <DangerConfirmDialog
      title='Delete "Prod"'
      actionLabel="Delete"
      slug="prod-db"
      description="Gone for good."
      stats={{ diskBytes: 2048, tableCount: 3, totalRows: 12345, lastWriteAt: null }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  const input = screen.getByPlaceholderText("prod-db") as HTMLInputElement;
  const button = () => screen.getByRole("button", { name: /^Delete/ }) as HTMLButtonElement;
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
  return { input, button, type, wait, onConfirm, onCancel };
}

describe("DangerConfirmDialog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("shows size, rows and last write before the user confirms", () => {
    setup();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText(/3 table\(s\), 12,345 row\(s\)/)).toBeTruthy();
    expect(screen.getByText("none recorded")).toBeTruthy();
  });

  test("disabled with a countdown label until 5 s pass, even with the exact slug", () => {
    const t = setup();
    t.type("prod-db");
    expect(t.button().disabled).toBe(true);
    expect(t.button().textContent).toBe("Delete (5s)");
    t.wait(4000);
    expect(t.button().disabled).toBe(true);
    expect(t.button().textContent).toBe("Delete (1s)");
    t.wait(1000);
    expect(t.button().disabled).toBe(false);
    expect(t.button().textContent).toBe("Delete");
  });

  test("a wrong or partial slug never enables the button, however long we wait", () => {
    const t = setup();
    t.wait(60_000);
    for (const wrong of ["", "prod", "prod-db ", "PROD-DB", "prod-dbx"]) {
      t.type(wrong);
      expect(t.button().disabled).toBe(true);
    }
    t.type("prod-db");
    expect(t.button().disabled).toBe(false);
    t.type("prod-d");
    expect(t.button().disabled).toBe(true);
  });

  test("confirming passes the typed slug to onConfirm exactly once", async () => {
    const t = setup();
    t.type("prod-db");
    t.wait(5000);
    await act(async () => {
      fireEvent.submit(t.input.closest("form")!);
    });
    expect(t.onConfirm).toHaveBeenCalledTimes(1);
    expect(t.onConfirm).toHaveBeenCalledWith("prod-db");
  });

  test("submitting early (Enter key) does nothing", async () => {
    const t = setup();
    t.type("prod-db");
    await act(async () => {
      fireEvent.submit(t.input.closest("form")!);
    });
    expect(t.onConfirm).not.toHaveBeenCalled();
  });

  test("a failing onConfirm (e.g. 423 protected) surfaces the message and re-enables the form", async () => {
    const t = setup(jest.fn(async () => {
      throw new Error("Delete protection is on");
    }));
    t.type("prod-db");
    t.wait(5000);
    await act(async () => {
      fireEvent.submit(t.input.closest("form")!);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Delete protection is on");
    expect(t.button().disabled).toBe(false);
  });
});
