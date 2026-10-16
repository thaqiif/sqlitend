import { useState } from "react";
import { Button, Card, Chip } from "@heroui/react";
import type { TableSchemaItem } from "@sqlitend/shared";
import { copyText } from "../csv";
import { PlainTable, TD } from "./PlainTable";
import { SimpleSelect } from "./SimpleSelect";

interface Props {
  tables: TableSchemaItem[];
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
  onRefresh: () => void;
}

export function StructureTab({ tables, selectedTable, onSelectTable, onRefresh }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  if (tables.length === 0) {
    return (
      <Card className="items-center gap-1 p-6 text-center">
        <p className="m-0 font-medium">This database has no user tables or views yet.</p>
        <p className="m-0 text-sm text-muted">Switch to the SQL tab to run a CREATE TABLE statement.</p>
      </Card>
    );
  }

  const active = tables.find((t) => t.name === selectedTable) ?? tables[0]!;
  const ddl = active.sql;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <SimpleSelect
          label="Table or view"
          value={active.name}
          onChange={onSelectTable}
          options={tables.map((t) => ({
            id: t.name,
            label: `${t.type === "view" ? "VIEW" : "TABLE"} ${t.name}${t.rowCountEstimate !== null ? ` (${t.rowCountEstimate.toLocaleString("en-US")})` : ""}`,
          }))}
          className="w-full sm:w-80"
        />
        <Button variant="secondary" className="min-h-11" onPress={onRefresh}>
          Refresh schema
        </Button>
      </div>

      <Card className="min-w-0 gap-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">
            <code>{active.name}</code>{" "}
            <span className="text-sm font-normal text-muted">
              ({active.type}
              {active.withoutRowid ? ", WITHOUT ROWID" : ""})
            </span>
          </h2>
          {active.rowCountEstimate !== null && <span className="text-sm text-muted">{active.rowCountEstimate.toLocaleString("en-US")} rows</span>}
        </div>

        <section aria-label="Columns" className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Columns ({active.columns.length})</h3>
          <PlainTable label="Columns" head={["#", "Column", "Type", "Constraints", "Default"]}>
            {active.columns.map((c) => {
              const fk = active.foreignKeys.find((f) => f.from === c.name);
              return (
                <tr key={c.name}>
                  <td className={`${TD} text-muted`}>{c.cid}</td>
                  <td className={TD}>
                    <code>{c.name}</code>
                  </td>
                  <td className={TD}>
                    <Chip size="sm" variant="soft">
                      {c.type || "ANY"}
                    </Chip>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-wrap gap-1">
                      {c.pk > 0 && (
                        <Chip size="sm" variant="soft" color="accent">
                          PK{active.primaryKey.length > 1 ? ` #${c.pk}` : ""}
                        </Chip>
                      )}
                      {c.notnull && (
                        <Chip size="sm" variant="soft" color="warning">
                          NOT NULL
                        </Chip>
                      )}
                      {fk && (
                        <Chip size="sm" variant="soft" title={`ON UPDATE ${fk.onUpdate}, ON DELETE ${fk.onDelete}`}>
                          FK to {fk.table}.{fk.to}
                        </Chip>
                      )}
                    </div>
                  </td>
                  <td className={TD}>{c.defaultValue !== null ? <code>{c.defaultValue}</code> : <span className="text-muted">none</span>}</td>
                </tr>
              );
            })}
          </PlainTable>
        </section>

        {active.indexes.length > 0 && (
          <section aria-label="Indexes" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Indexes ({active.indexes.length})</h3>
            <PlainTable label="Indexes" head={["Index", "Columns", "Unique", "Origin"]}>
              {active.indexes.map((idx) => (
                <tr key={idx.name}>
                  <td className={TD}>
                    <code>{idx.name}</code>
                  </td>
                  <td className={TD}>
                    <code>{idx.columns.join(", ") || "none"}</code>
                  </td>
                  <td className={TD}>
                    {idx.unique ? (
                      <Chip size="sm" variant="soft" color="accent">
                        UNIQUE
                      </Chip>
                    ) : (
                      "No"
                    )}
                  </td>
                  <td className={`${TD} text-muted`}>{idx.origin === "pk" ? "Primary key" : idx.origin === "u" ? "Unique constraint" : "CREATE INDEX"}</td>
                </tr>
              ))}
            </PlainTable>
          </section>
        )}

        {active.foreignKeys.length > 0 && (
          <section aria-label="Foreign keys" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Foreign keys ({active.foreignKeys.length})</h3>
            <PlainTable label="Foreign keys" head={["Column", "References", "On update", "On delete"]}>
              {active.foreignKeys.map((fk, i) => (
                <tr key={`${fk.id}-${i}`}>
                  <td className={TD}>
                    <code>{fk.from}</code>
                  </td>
                  <td className={TD}>
                    <code>
                      {fk.table}({fk.to})
                    </code>
                  </td>
                  <td className={`${TD} text-muted`}>{fk.onUpdate}</td>
                  <td className={`${TD} text-muted`}>{fk.onDelete}</td>
                </tr>
              ))}
            </PlainTable>
          </section>
        )}

        {ddl && (
          <section aria-label="CREATE statement" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold">CREATE statement</h3>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  void copyText(ddl);
                  setCopied(active.name);
                  setTimeout(() => setCopied(null), 1500);
                }}
              >
                {copied === active.name ? "Copied" : "Copy DDL"}
              </Button>
            </div>
            <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-3 font-mono text-xs">{ddl}</pre>
          </section>
        )}
      </Card>
    </div>
  );
}
