import { useState, type ReactNode } from "react";
import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { ErrorAlert } from "../components/ErrorAlert";
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
    <AuthShell>
      <form
        className="w-full"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Card className="gap-4 p-5">
          <Card.Header>
            <Card.Title>Sign in</Card.Title>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            <TextField fullWidth type="password" autoComplete="current-password" value={password} onChange={setPassword} isDisabled={busy || needTotp} isRequired autoFocus>
              <Label>Password or Admin Token</Label>
              <Input className="min-h-11" />
            </TextField>
            {needTotp && (
              <TextField
                fullWidth
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={totp}
                onChange={(v) => setTotp(v.replace(/\D/g, ""))}
                isDisabled={busy}
                isRequired
                autoFocus
              >
                <Label>Authenticator code</Label>
                <Input className="min-h-11" />
              </TextField>
            )}
            {error && <ErrorAlert>{error}</ErrorAlert>}
          </Card.Content>
          <Card.Footer>
            <Button type="submit" variant="primary" fullWidth className="min-h-11" isPending={busy}>
              {needTotp ? "Verify" : "Sign in"}
            </Button>
          </Card.Footer>
        </Card>
      </form>
    </AuthShell>
  );
}

export function SetupRequired({ onRetry }: { onRetry: () => void }) {
  return (
    <AuthShell>
      <Card className="w-full gap-4 p-5">
        <Card.Header>
          <Card.Title>Set an admin password</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3 text-sm">
          <p className="m-0">The dashboard is locked until an admin password is set. On the server, run:</p>
          <pre className="m-0 overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">sqlitend set-password</pre>
          <p className="m-0 text-muted">
            Optional second factor: <code>sqlitend enable-totp</code>. Passwords are set only from the server, so
            nobody who can merely reach this page can claim it.
          </p>
        </Card.Content>
        <Card.Footer>
          <Button variant="primary" fullWidth className="min-h-11" onPress={onRetry}>
            I've set it
          </Button>
        </Card.Footer>
      </Card>
    </AuthShell>
  );
}

/** Centered, phone-first column shared by every pre-login screen. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 bg-background px-4 py-8 text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">sqlitend</h1>
      {children}
    </main>
  );
}
