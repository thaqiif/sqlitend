import { afterEach, beforeEach } from "bun:test";

/**
 * happy-dom does no layout: every element measures 0x0, so @tanstack/react-virtual would render no
 * rows. Call once at the top of a test file to give elements a 1000x600 box.
 */
export function installFakeLayout(): void {
  const proto = HTMLElement.prototype;
  const saved = {
    w: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
    h: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
    r: proto.getBoundingClientRect,
  };
  beforeEach(() => {
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 600 });
    proto.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON() {} });
  });
  afterEach(() => {
    if (saved.w) Object.defineProperty(proto, "offsetWidth", saved.w);
    if (saved.h) Object.defineProperty(proto, "offsetHeight", saved.h);
    proto.getBoundingClientRect = saved.r;
  });
}

/** Makes `(max-width: 599px)` match (phone) or not. Restored after each test. */
export function installMatchMedia(isPhone: boolean): void {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 599px") ? isPhone : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });
}
