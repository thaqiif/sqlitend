import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React only ships `act` in its development build; a CI/shell NODE_ENV=production would break RTL.
process.env.NODE_ENV = "test";

GlobalRegistrator.register({ url: "http://localhost/", width: 1024, height: 768 });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
});

// TanStack Query delivers results through a zero-delay timer, i.e. outside any act() scope, which makes
// React warn "not wrapped in act(...)" for every query that resolves. Flush those notifications
// through RTL's act so state updates from fetches are processed the way React expects in tests.
const { act } = await import("@testing-library/react");
const { notifyManager } = await import("@tanstack/react-query");
notifyManager.setScheduler((cb) => setTimeout(() => act(cb), 0));
