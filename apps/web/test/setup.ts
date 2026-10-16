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
