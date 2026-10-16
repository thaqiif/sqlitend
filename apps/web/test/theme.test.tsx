import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { initTheme, useTheme } from "../src/theme";

const html = () => document.documentElement;

function stubSystemDark(dark: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: dark && q.includes("dark"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;

describe("theme", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  });

  test("follows the OS preference when nothing is stored", () => {
    stubSystemDark(true);
    initTheme();
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(html().classList.contains("dark")).toBe(true);
    stubSystemDark(false);
    initTheme();
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(html().classList.contains("dark")).toBe(false);
  });

  test("a stored choice beats the OS preference", () => {
    stubSystemDark(true);
    localStorage.setItem("sqlitend:theme", "light");
    initTheme();
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  test("toggle flips the theme, applies it to <html> and persists it", () => {
    stubSystemDark(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("sqlitend:theme")).toBe("dark");
    act(() => result.current.toggle());
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  test("still works when localStorage throws on read and write", () => {
    stubSystemDark(false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(() => initTheme()).not.toThrow();
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(() => act(() => result.current.toggle())).not.toThrow();
    expect(result.current.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
  });
});
