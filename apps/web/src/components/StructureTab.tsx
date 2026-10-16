import { useState } from "react";
import type { TableSchemaItem } from "@sqlitend/shared";

interface Props {
  tables: TableSchemaItem[];
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
  onRefresh: () => void;
}

export function StructureTab({ tables, selectedTable, onSelectTable, onRefresh }: Props) {
  const [copiedSql, setCopiedSql] = useState<string | null>(null);

  if (tables.length === 0) {
    return (
      <section className="panel empty-state">
        <p>This database has no user tables or views yet.</p>
        <p className="muted small">Switch to the SQL tab to run a CREATE TABLE statement.</p>
      </section>
    );
  }

  const active = tables.find((t) => t.name === selectedTable) ?? tables[0]!;

  const copyCreateSql = (sqlText: string) => {
    void navigator.clipboard?.writeText(sqlText);
    setCopiedSql(active.name);
    setTimeout(() => setCopiedSql(null), 1500);
  };

  return (
    <div className="structure-layout">
      <div className="structure-selector-bar">
        <div className="structure-pills" role="tablist" aria-label="Tables and views">
          {tables.map((t) => (
            <button
              key={t.name}
              type="button"
              role="tab"
              aria-selected={t.name === active.name}
              className={`structure-pill ${t.name === active.name ? "active" : ""}`}
              onClick={() => onSelectTable(t.name)}
            >
              <span className="type-tag">{t.type === "view" ? "VIEW" : "TBL"}</span>
              <span>{t.name}</span>
              {t.rowCountEstimate !== null && (
                <span className="muted small">({t.rowCountEstimate.toLocaleString()})</span>
              )}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost small" onClick={onRefresh}>
          Refresh Schema
        </button>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>
            <code>{active.name}</code>{" "}
            <span className="muted small">
              ({active.type}{active.withoutRowid ? ", WITHOUT ROWID" : ""})
            </span>
          </h2>
          {active.rowCountEstimate !== null && (
            <span className="muted small">{active.rowCountEstimate.toLocaleString()} rows</span>
          )}
        </div>

        <h3 className="subhead">Columns ({active.columns.length})</h3>
        <div className="table-scroll">
          <table className="token-table structure-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Column</th>
                <th>Type</th>
                <th>Constraints</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {active.columns.map((c) => {
                const fk = active.foreignKeys.find((f) => f.from === c.name);
                return (
                  <tr key={c.name}>
                    <td className="muted">{c.cid}</td>
                    <td>
                      <code>{c.name}</code>
                    </td>
                    <td>
                      <span className="type-badge">{c.type || "ANY"}</span>
                    </td>
                    <td>
                      <div className="constraint-badges">
                        {c.pk > 0 && <span className="pk-badge">PK{active.primaryKey.length > 1 ? ` #${c.pk}` : ""}</span>}
                        {c.notnull && <span className="nn-badge">NOT NULL</span>}
                        {fk && (
                          <span className="fk-badge" title={`ON UPDATE ${fk.onUpdate}, ON DELETE ${fk.onDelete}`}>
                            FK → {fk.table}.{fk.to}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {c.defaultValue !== null ? <code>{c.defaultValue}</code> : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {active.indexes.length > 0 && (
          <>
            <h3 className="subhead" style={{ marginTop: "1.25rem" }}>
              Indexes ({active.indexes.length})
            </h3>
            <div className="table-scroll">
              <table className="token-table structure-table">
                <thead>
                  <tr>
                    <th>Index Name</th>
                    <th>Columns</th>
                    <th>Unique</th>
                    <th>Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {active.indexes.map((idx) => (
                    <tr key={idx.name}>
                      <td>
                        <code>{idx.name}</code>
                      </td>
                      <td>
                        <code>{idx.columns.join(", ") || "—"}</code>
                      </td>
                      <td>{idx.unique ? <span className="pk-badge">UNIQUE</span> : "No"}</td>
                      <td className="muted">
                        {idx.origin === "pk" ? "Primary key" : idx.origin === "u" ? "Unique constraint" : "CREATE INDEX"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {active.foreignKeys.length > 0 && (
          <>
            <h3 className="subhead" style={{ marginTop: "1.25rem" }}>
              Foreign Keys ({active.foreignKeys.length})
            </h3>
            <div className="table-scroll">
              <table className="token-table structure-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>References</th>
                    <th>On Update</th>
                    <th>On Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {active.foreignKeys.map((fk, i) => (
                    <tr key={`${fk.id}-${i}`}>
                      <td>
                        <code>{fk.from}</code>
                      </td>
                      <td>
                        <code>
                          {fk.table}({fk.to})
                        </code>
                      </td>
                      <td className="muted">{fk.onUpdate}</td>
                      <td className="muted">{fk.onDelete}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {active.sql && (
          <div style={{ marginTop: "1.25rem" }}>
            <div className="panel-head">
              <h3 className="subhead" style={{ margin: 0 }}>CREATE Statement</h3>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => copyCreateSql(active.sql!)}
              >
                {copiedSql === active.name ? "Copied" : "Copy DDL"}
              </button>
            </div>
            <pre className="code-block">{active.sql}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
