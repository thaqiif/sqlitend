import { useEffect, useState } from "react";
import { Button, Card, Table } from "@heroui/react";
import type { AuditEntry } from "@sqlitend/shared";
import { api } from "../api/client";
import { ErrorAlert } from "../components/ErrorAlert";
import { StatusChip } from "../components/StatusChip";
import { auditTone } from "../components/status-tones";

const PAGE = 100;

/** Audit log: logins (incl. failures) and every change, newest first. */
export function ActivityPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: number) {
    try {
      const page = await api.listAudit(PAGE, before);
      setRows((prev) => (before ? [...prev, ...page] : page));
      setDone(page.length < PAGE);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <h2 className="text-xl font-semibold">Activity</h2>
      {error && <ErrorAlert>{error}</ErrorAlert>}
      <Card className="min-w-0 gap-3 p-0 sm:p-2">
        {rows.length === 0 ? (
          <p className="m-0 p-4 text-muted">No activity yet.</p>
        ) : (
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label="Audit log" className="min-w-[44rem]">
                <Table.Header>
                  <Table.Column isRowHeader id="when">When</Table.Column>
                  <Table.Column id="action">Action</Table.Column>
                  <Table.Column id="outcome">Outcome</Table.Column>
                  <Table.Column id="who">Who</Table.Column>
                  <Table.Column id="ip">IP</Table.Column>
                  <Table.Column id="target">Target</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((r) => (
                    <Table.Row key={r.id} id={String(r.id)}>
                      <Table.Cell className="whitespace-nowrap">{new Date(r.at).toLocaleString()}</Table.Cell>
                      <Table.Cell>{r.action}</Table.Cell>
                      <Table.Cell>
                        <StatusChip tone={auditTone(r.outcome)} title={r.detail ?? undefined}>
                          {r.outcome}
                          {r.detail ? ` · ${r.detail}` : ""}
                        </StatusChip>
                      </Table.Cell>
                      <Table.Cell>{r.actor}</Table.Cell>
                      <Table.Cell>{r.ip ?? "—"}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.target ?? "—"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table.Root>
        )}
        {!done && rows.length > 0 && (
          <div className="p-3">
            <Button variant="secondary" className="min-h-11" onPress={() => void load(rows.at(-1)!.id)}>
              Load older
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}
