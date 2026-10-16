import { useCallback, useEffect, useState } from "react";
import { api, UNAUTHENTICATED_EVENT } from "./api/client";
import { Spinner } from "@heroui/react";
import { AuthShell, LoginPage, SetupRequired } from "./pages/LoginPage";
import { ErrorAlert } from "./components/ErrorAlert";
import { App } from "./App";

type State = "loading" | "setup" | "login" | "in" | "open";

/** Session check before the dashboard renders; drops back to login on any 401. */
export function AuthGate() {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const s = await api.getSession();
      setState(s.setupRequired ? "setup" : s.authenticated ? "in" : "login");
      setError(null);
    } catch (err) {
      // 404 = server running with SQLITEND_AUTH=off (no auth routes).
      if (err instanceof Error && "status" in err && (err as { status: number }).status === 404) setState("open");
      else setError(err instanceof Error ? err.message : "Server unreachable");
    }
  }, []);

  useEffect(() => {
    void check();
    const onLost = () => setState((s) => (s === "open" ? s : "login"));
    window.addEventListener(UNAUTHENTICATED_EVENT, onLost);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onLost);
  }, [check]);

  async function logout() {
    await api.logout().catch(() => {});
    setState("login");
  }

  if (error) {
    return (
      <AuthShell>
        <ErrorAlert>{error}</ErrorAlert>
      </AuthShell>
    );
  }
  if (state === "loading") {
    return (
      <AuthShell>
        <Spinner aria-label="Loading" />
      </AuthShell>
    );
  }
  if (state === "setup") return <SetupRequired onRetry={() => void check()} />;
  if (state === "login") return <LoginPage onLoggedIn={() => setState("in")} />;
  return <App onLogout={state === "in" ? logout : undefined} />;
}
