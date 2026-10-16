import type { ReactNode } from "react";

export const TD = "border-t border-separator px-3 py-2 align-top text-sm";

/** Small static table; scrolls horizontally inside its own box so the page never does. */
export function PlainTable({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border border-separator">
      <table aria-label={label} className="w-full border-collapse text-left">
        <thead className="bg-surface-secondary">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-xs font-semibold text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
