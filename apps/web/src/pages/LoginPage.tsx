import { useState } from "react";
import { api, ApiError } from "../api/client";

/** Password (+ authenticator code when the server asks for one). */
export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password, needTotp ? totp.trim() : undefined);
      setPassword("");
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        setNeedTotp(true);
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
        if (needTotp) setTotp("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <h1 className="brand-title">sqlitend</h1>
      <form
        className="panel auth-panel"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="panel-title">Sign in</h2>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || needTotp}
            autoFocus
            required
          />
        </label>
        {needTotp && (
          <label className="field">
            <span className="field-label">Authenticator code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
              disabled={busy}
              autoFocus
              required
            />
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {needTotp ? "Verify" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}

export function SetupRequired({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="shell auth-shell">
      <h1 className="brand-title">sqlitend</h1>
      <section className="panel auth-panel">
        <h2 className="panel-title">Set an admin password</h2>
        <p>The dashboard is locked until an admin password is set. On the server, run:</p>
        <pre className="code-block">sqlitend set-password</pre>
        <p className="hint">
          Optional second factor: <code>sqlitend enable-totp</code>. Passwords are set only from the server, so
          nobody who can merely reach this page can claim it.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onRetry}>
            I've set it
          </button>
        </div>
      </section>
    </main>
  );
}
