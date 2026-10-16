import type { ReactNode } from "react";
import { Chip } from "@heroui/react";
import type { ChipTone } from "./status-tones";

/** Small pill with a native tooltip (title) for the longer explanation. */
export function StatusChip({ tone, title, children }: { tone: ChipTone; title?: string; children: ReactNode }) {
  return (
    <Chip size="sm" variant="soft" color={tone} title={title} className="whitespace-nowrap">
      {children}
    </Chip>
  );
}
