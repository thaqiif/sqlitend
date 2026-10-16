import { useEffect, useState } from "react";
import { Button, Card, Chip, Input, Label, Modal as HeroModal, Switch, TextField } from "@heroui/react";
import type { BackupStatus, Connection, Database, DeletePreview, Token, TokenIssued, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { copyText } from "../csv";
import { fullTime, relTime } from "../format";
import { DangerConfirmDialog } from "./DangerConfirmDialog";
import { ErrorAlert } from "./ErrorAlert";
import { LockIcon, UnlockIcon } from "./icons";
import { Modal } from "./Modal";
import { RestoreDialog } from "./RestoreDialog";
import { backupTone, verifyTone, type ChipTone } from "./status-tones";
import { TokenReveal } from "./TokenReveal";

const MAX_EXPIRY_HOURS = 24 * 365;
const EXPIRING_SOON_MS = 14 * 86_400_000;

type TokenState = "active" | "expiring" | "expired" | "revoked";
function tokenState(t: Token, now = Date.now()): TokenState {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt <= now) return "expired";
  if (t.expiresAt - now < EXPIRING_SOON_MS) return "expiring";
  return "active";
}
const TOKEN_STATE_LABEL: Record<TokenState, string> = { active: "active", expiring: "expires soon", expired: "expired", revoked: "revoked" };
const TOKEN_STATE_TONE: Record<TokenState, ChipTone> = { active: "success", expiring: "warning", expired: "danger", revoked: "default" };

const fmtTime = (ms: number) => new Date(ms).toLocaleString();
const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

interface Props {
  db: Database;
  workspaces: Workspace[];
  onDbChange: (db: Database) => void;
  onOpenDatabase?: (id: string) => void;
  onBack: () => void;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-xs font-semibold text-muted">{label}</span>
      <code className="min-w-0 flex-1 basis-48 whitespace-pre-wrap break-all rounded-lg bg-surface-secondary px-2 py-1 text-xs">{value}</code>
      <Button
        size="sm"
        variant="secondary"
        className="min-h-11"
        aria-label={`Copy ${label}`}
        onPress={async () => {
          if (await copyText(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function SettingsTab({ db, workspaces, onDbChange, onOpenDatabase, onBack }: Props) {
  const databaseId = db.id;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedJti, setCopiedJti] = useState<string | null>(null);
  const [showRestore, setShowRestore] = useState(false);
  const [tokenForm, setTokenForm] = useState<{ name: string; hours: number } | null>(null);
  const [revealed, setRevealed] = useState<TokenIssued | null>(null);
  const [protectionBusy, setProtectionBusy] = useState(false);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [showTrashConfirm, setShowTrashConfirm] = useState(false);

  // Ports change when the database (re)starts, so connection details reload on a status change.
  useEffect(() => {
    let alive = true;
    api
      .getConnection(databaseId)
      .then((c) => alive && setConnection(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [databaseId, db.status]);

  useEffect(() => {
    let alive = true;
    api
      .listTokens(databaseId)
      .then((t) => alive && setTokens(t))
      .catch(() => {});
    const loadBackup = () =>
      api
        .getBackup(databaseId)
        .then((b) => alive && setBackup(b))
        .catch(() => {});
    void loadBackup();
    const timer = setInterval(loadBackup, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [databaseId]);

  async function toggleProtection(next: boolean) {
    setProtectionBusy(true);
    setActionError(null);
    try {
      onDbChange(await api.setDatabaseProtection(databaseId, next));
    } catch (err) {
      setActionError(errMsg(err, "Failed to update protection"));
    } finally {
      setProtectionBusy(false);
    }
  }

  async function openTrashConfirm() {
    setActionError(null);
    try {
      setDeletePreview(await api.getDeletePreview(databaseId));
      setShowTrashConfirm(true);
    } catch (err) {
      setActionError(errMsg(err, "Failed to load delete preview"));
    }
  }

  async function verifyNow() {
    setVerifying(true);
    setActionError(null);
    try {
      setBackup(await api.verifyBackup(databaseId));
    } catch (err) {
      setActionError(errMsg(err, "Verify failed"));
    } finally {
      setVerifying(false);
    }
  }

  async function retryDns() {
    setActionError(null);
    try {
      onDbChange(await api.syncDns(databaseId));
      setConnection(await api.getConnection(databaseId).catch(() => null));
    } catch (err) {
      setActionError(errMsg(err, "Action failed"));
    }
  }

  async function copyToken(t: Token) {
    setActionError(null);
    try {
      const { token } = await api.revealToken(databaseId, t.jti);
      if (await copyText(token)) {
        setCopiedJti(t.jti);
        setTimeout(() => setCopiedJti((j) => (j === t.jti ? null : j)), 1500);
      } else {
        window.prompt("Copy the token:", token);
      }
    } catch (err) {
      setActionError(errMsg(err, "Could not load the token"));
    }
  }

  async function revokeToken(t: Token) {
    const label = t.name ? `"${t.name}"` : "this token";
    if (!window.confirm(`Revoke ${label}? Clients using it are refused by the gateway immediately.`)) return;
    setActionError(null);
    try {
      await api.revokeToken(databaseId, t.jti);
      setTokens(await api.listTokens(databaseId));
    } catch (err) {
      setActionError(errMsg(err, "Token revocation failed"));
    }
  }

  const url = connection?.publicUrl ?? connection?.httpUrl;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {actionError && <ErrorAlert>{actionError}</ErrorAlert>}

      <Card className="gap-3 p-4" aria-label="Connection">
        <h3 className="m-0 text-base font-semibold">Connection</h3>
        {connection && url ? (
          <>
            <CopyRow label={connection.publicUrl ? "URL" : "HTTP"} value={url} />
            <CopyRow label=".ENV" value={`LIBSQL_URL=${url}\nLIBSQL_AUTH_TOKEN=<token from "Generate token">`} />
            <p className="m-0 text-xs text-muted">
              {connection.publicUrl
                ? "Use the URL with @libsql/client (https://, also from Cloudflare Workers). Tokens are shown once, when generated."
                : "No public hostname: enable the gateway (docs/gateway.md) to reach this database from outside the server."}
            </p>
            {db.dns.status && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Chip size="sm" variant="soft" color={db.dns.status === "active" ? "success" : "danger"}>
                  DNS {db.dns.status}
                </Chip>
                <span className="min-w-0 break-all text-muted">
                  {db.dns.hostname}
                  {db.dns.error ? `: ${db.dns.error}` : ""}
                </span>
                {db.dns.status !== "active" && (
                  <Button size="sm" variant="secondary" className="min-h-11" onPress={() => void retryDns()}>
                    Retry DNS
                  </Button>
                )}
              </div>
            )}
            <details className="flex flex-col gap-2">
              <summary className="min-h-11 cursor-pointer py-2.5 text-sm">Server-local endpoints (reachable only on this machine)</summary>
              <div className="flex flex-col gap-2">
                <CopyRow label="HTTP" value={connection.httpUrl} />
                <CopyRow label="HRANA" value={connection.hranaUrl} />
                <CopyRow label="gRPC" value={connection.grpcUrl} />
              </div>
            </details>
          </>
        ) : (
          <p className="m-0 text-sm text-muted">No connection details yet.</p>
        )}
      </Card>

      <Card className="gap-3 p-4" aria-label="Tokens">
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 text-base font-semibold">Tokens</h3>
          <Button variant="primary" className="min-h-11" onPress={() => setTokenForm({ name: "", hours: NaN })}>
            Generate token
          </Button>
        </div>
        {tokens.length === 0 ? (
          <p className="m-0 text-sm text-muted">No tokens issued.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {tokens.map((t) => {
              const state = tokenState(t);
              return (
                <li key={t.jti} className={`flex flex-col gap-2 rounded-xl border border-separator p-3 ${state === "revoked" ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="min-w-0 truncate text-sm">{t.name ?? <span className="font-normal text-muted">unnamed</span>}</strong>
                    <Chip size="sm" variant="soft" color={TOKEN_STATE_TONE[state]}>
                      {TOKEN_STATE_LABEL[state]}
                    </Chip>
                  </div>
                  <p className="m-0 text-xs text-muted">
                    Created <span title={fullTime(t.createdAt)}>{relTime(t.createdAt)}</span> - expires{" "}
                    <span title={fullTime(t.expiresAt)}>{relTime(t.expiresAt)}</span> - last used{" "}
                    {t.lastUsedAt ? <span title={fullTime(t.lastUsedAt)}>{relTime(t.lastUsedAt)}</span> : "never"}
                  </p>
                  {state !== "revoked" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {t.copyable ? (
                        <Button size="sm" variant="secondary" className="min-h-11" onPress={() => void copyToken(t)}>
                          {copiedJti === t.jti ? "Copied" : "Copy"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted" title="Issued before tokens were stored. Rotate to get one you can copy.">
                          not copyable
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        className="min-h-11"
                        onPress={() =>
                          setTokenForm({ name: t.name ?? "", hours: Math.max(1, Math.round((t.expiresAt - t.createdAt) / 3_600_000)) })
                        }
                      >
                        Rotate
                      </Button>
                      <Button size="sm" variant="danger-soft" className="min-h-11" onPress={() => void revokeToken(t)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="gap-3 p-4" aria-label="Backup">
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 text-base font-semibold">Backup</h3>
          {backup?.enabled && (
            <Button variant="secondary" className="min-h-11" onPress={() => setShowRestore(true)}>
              Restore as new database
            </Button>
          )}
        </div>
        {!backup ? (
          <p className="m-0 text-sm text-muted">Loading...</p>
        ) : !backup.enabled ? (
          <ErrorAlert>Not backed up: configure SQLITEND_BACKUP_S3_* on the server.</ErrorAlert>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <Chip size="sm" variant="soft" color={backupTone(backup.state)}>
                {backup.state}
              </Chip>
              <span className="min-w-0 break-all font-mono text-xs text-muted">{backup.replicaUrl}</span>
            </p>
            <p className="m-0 text-muted">
              Last sync {backup.lastSyncAt ? fmtTime(backup.lastSyncAt) : "never"} - last snapshot {backup.lastSnapshotAt ? fmtTime(backup.lastSnapshotAt) : "never"} -
              txid {backup.txidReplica ?? "n/a"} / {backup.txidDb ?? "n/a"}
              {backup.restarts > 0 ? ` - ${backup.restarts} restart(s)` : ""}
            </p>
            {backup.verify && (
              <div className="flex flex-wrap items-center gap-2">
                <Chip size="sm" variant="soft" color={verifyTone(backup.verify.health)}>
                  restore-verify {backup.verify.health}
                </Chip>
                <span className="text-muted">
                  {backup.verify.lastAt
                    ? `last ${fmtTime(backup.verify.lastAt)} (${backup.verify.lastOutcome}${backup.verify.lastDetail ? `: ${backup.verify.lastDetail}` : ""})`
                    : "never run, first run tonight"}
                  {backup.verify.lastOkAt && backup.verify.lastOutcome !== "ok" ? ` - last success ${fmtTime(backup.verify.lastOkAt)}` : ""}
                </span>
                <Button size="sm" variant="secondary" className="min-h-11" isDisabled={verifying || db.status !== "running"} onPress={() => void verifyNow()}>
                  {verifying ? "Verifying..." : "Verify now"}
                </Button>
              </div>
            )}
            {backup.lastError && backup.state !== "ok" && (
              <ErrorAlert>{`${backup.lastErrorAt ? `${fmtTime(backup.lastErrorAt)}: ` : ""}${backup.lastError}`}</ErrorAlert>
            )}
          </div>
        )}
      </Card>

      <Card role="region" aria-label="Danger zone" className="gap-4 border border-danger/50 p-4">
        <h3 className="m-0 text-base font-semibold text-danger">Danger zone</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <strong className="inline-flex items-center gap-1 text-sm">
              {db.protected ? <LockIcon size={16} /> : <UnlockIcon size={16} />}
              Delete protection
            </strong>
            <p className="m-0 mt-1 text-xs text-muted">
              Protected by default. While enabled, <code>DELETE /api/databases/{db.id}</code> is rejected with HTTP 423.
            </p>
          </div>
          <Switch
            isSelected={db.protected}
            isDisabled={protectionBusy}
            onChange={(next) => void toggleProtection(next)}
            aria-label="Delete protection"
            className="min-h-11"
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              {db.protected ? "Protected" : "Unprotected"}
            </Switch.Content>
          </Switch>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <strong className="text-sm">Move database to Trash</strong>
            <p className="m-0 mt-1 text-xs text-muted">
              {db.protected
                ? "Turn off delete protection above before moving this database to Trash."
                : "Stops the sqld process, releases ports, and moves the data directory to Trash (recoverable for SQLITEND_TRASH_DAYS)."}
            </p>
          </div>
          <Button variant="danger" className="min-h-11" isDisabled={db.protected} onPress={() => void openTrashConfirm()}>
            Move to Trash
          </Button>
        </div>
      </Card>

      {showTrashConfirm && (
        <DangerConfirmDialog
          title={`Move "${db.name}" to Trash`}
          actionLabel="Move to Trash"
          slug={db.slug}
          description="The database process will be stopped immediately and its files moved to Trash. You can restore it from the Trash view before retention expires."
          stats={deletePreview}
          onCancel={() => setShowTrashConfirm(false)}
          onConfirm={async (typedSlug) => {
            await api.deleteDatabase(db.id, typedSlug);
            setShowTrashConfirm(false);
            onBack();
          }}
        />
      )}
      {tokenForm && (
        <TokenForm
          initialName={tokenForm.name}
          initialHours={tokenForm.hours}
          databaseId={databaseId}
          onClose={() => setTokenForm(null)}
          onIssued={async (issued) => {
            setRevealed(issued);
            setTokens(await api.listTokens(databaseId).catch(() => tokens));
          }}
        />
      )}
      {showRestore && (
        <RestoreDialog
          sourceId={db.id}
          sourceLabel={db.slug}
          workspaces={workspaces}
          defaultWorkspaceId={db.workspaceId}
          onClose={() => setShowRestore(false)}
          onStarted={(created) => {
            setShowRestore(false);
            onOpenDatabase?.(created.id);
          }}
        />
      )}
      {revealed && <TokenReveal token={revealed} onDismiss={() => setRevealed(null)} />}
    </div>
  );
}

function TokenForm({
  databaseId,
  initialName,
  initialHours,
  onClose,
  onIssued,
}: {
  databaseId: string;
  initialName: string;
  initialHours: number;
  onClose: () => void;
  onIssued: (t: TokenIssued) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [hours, setHours] = useState(Number.isFinite(initialHours) ? String(initialHours) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const h = Number(hours);
      const trimmed = name.trim();
      const issued = await api.generateToken(databaseId, {
        ...(trimmed ? { name: trimmed } : {}),
        ...(hours.trim() !== "" && Number.isFinite(h) && h > 0 ? { expiresInHours: h } : {}),
      });
      onClose();
      await onIssued(issued);
    } catch (err) {
      setError(errMsg(err, "Failed to generate token"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Generate token" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <HeroModal.Header>
          <HeroModal.Heading>Generate token</HeroModal.Heading>
        </HeroModal.Header>
        <HeroModal.Body className="flex flex-col gap-3 p-1">
          <p className="m-0 text-sm text-muted">Tokens grant full read + write access for this database.</p>
          <TextField fullWidth value={name} onChange={setName} isDisabled={busy} autoFocus>
            <Label>Name</Label>
            <Input maxLength={64} placeholder="e.g. worker-prod" className="min-h-11" />
          </TextField>
          <TextField fullWidth value={hours} onChange={setHours} isDisabled={busy}>
            <Label>Lifetime (hours)</Label>
            <Input type="number" min={1} max={MAX_EXPIRY_HOURS} placeholder="server default" className="min-h-11" />
          </TextField>
          <p className="m-0 text-xs text-muted">
            Blank uses the server default (SQLITEND_TOKEN_TTL_HOURS); maximum {MAX_EXPIRY_HOURS} (1 year). To rotate: issue the replacement, deploy it,
            then revoke the old token. Both work in between.
          </p>
          {error && <ErrorAlert>{error}</ErrorAlert>}
        </HeroModal.Body>
        <HeroModal.Footer>
          <Button variant="ghost" className="min-h-11" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="min-h-11" isDisabled={busy}>
            Generate
          </Button>
        </HeroModal.Footer>
      </form>
    </Modal>
  );
}
