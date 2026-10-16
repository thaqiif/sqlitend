import { CloseButton, Drawer, Label, ListBox, Select } from "@heroui/react";
import type { Database, TableSchemaItem, Workspace } from "@sqlitend/shared";
import { StatusChip } from "./StatusChip";
import { dbStatusTone } from "./status-tones";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  databases: Database[];
  activeDatabaseId: string | null;
  tables: TableSchemaItem[];
  activeTable: string | null | undefined;
  onOpenDatabase: (id: string) => void;
  onOpenTable: (databaseId: string, table: string) => void;
  onClose: () => void;
}

/** Slide-over: workspace → databases → tables/views of the open database. */
export function ExplorerDrawer({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  databases,
  activeDatabaseId,
  tables,
  activeTable,
  onOpenDatabase,
  onOpenTable,
  onClose,
}: Props) {
  return (
    <Drawer.Root isOpen onOpenChange={(open) => !open && onClose()}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label="Database & Table Explorer" className="w-full max-w-[22rem]">
            <Drawer.Header>
              <Drawer.Heading>Schema Explorer</Drawer.Heading>
              <CloseButton onPress={onClose} aria-label="Close explorer" className="min-h-11 min-w-11" />
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-5">
              <Select
                aria-label="Workspace"
                value={selectedWorkspaceId}
                onChange={(key) => key && onSelectWorkspace(String(key))}
                fullWidth
              >
                <Label>Workspace</Label>
                <Select.Trigger className="min-h-11">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {workspaces.map((w) => (
                      <ListBox.Item key={w.id} id={w.id} textValue={w.name}>
                        {w.name} ({w.slug})
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Databases</h3>
                {databases.length === 0 ? (
                  <p className="text-sm text-muted">No databases in this workspace.</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {databases.map((d) => {
                      const isActive = d.id === activeDatabaseId;
                      return (
                        <li key={d.id}>
                          <button
                            type="button"
                            aria-current={isActive ? "true" : undefined}
                            onClick={() => onOpenDatabase(d.id)}
                            className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm ${
                              isActive ? "bg-accent-soft text-accent-soft-foreground" : "hover:bg-default"
                            }`}
                          >
                            <strong className="min-w-0 flex-1 truncate">{d.name}</strong>
                            <StatusChip tone={dbStatusTone(d.status)}>{d.status}</StatusChip>
                          </button>
                          {isActive && tables.length > 0 && (
                            <ul className="m-0 mt-1 mb-2 ml-3 flex list-none flex-col gap-0.5 border-l border-separator p-0 pl-2">
                              {tables.map((t) => (
                                <li key={t.name}>
                                  <button
                                    type="button"
                                    aria-current={activeTable === t.name ? "true" : undefined}
                                    onClick={() => onOpenTable(d.id, t.name)}
                                    className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm ${
                                      activeTable === t.name ? "bg-accent-soft text-accent-soft-foreground" : "hover:bg-default"
                                    }`}
                                  >
                                    <span className="rounded bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
                                      {t.type === "view" ? "VIEW" : "TBL"}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                                    {t.rowCountEstimate !== null && (
                                      <span className="text-xs text-muted">{t.rowCountEstimate}</span>
                                    )}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
}
