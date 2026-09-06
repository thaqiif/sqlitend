// ---------------------------------------------------------------------------
// Path-containment helpers — every destructive or recursive filesystem use of
// a metadata-derived path (data_dir) MUST be bounded to the data root first.
// A corrupted/edited metadata row (absolute path, "..", symlink) must never
// turn `rm -rf` or a recursive read into an arbitrary-path operation.
// ---------------------------------------------------------------------------

import path from "node:path";

/**
 * True iff `target` resolves to a path strictly INSIDE `root` (i.e. root
 * itself does not count — a dir equal to the root is rejected).
 */
export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** isInside with a loud failure naming both paths. */
export function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) {
    throw new Error(`path ${target} escapes the data root ${root} — refusing`);
  }
}
