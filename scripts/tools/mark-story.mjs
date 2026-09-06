import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Helper to keep PRD edits simple: mark a story passes=true and bump its
// completionCriteriaRevision. Loads/writes the session PRD JSON.
const here = path.dirname(fileURLToPath(import.meta.url));
const prdPath = path.join(
  here,
  "..",
  "state",
  "sessions",
  "97173b4e-6917-4a5a-83f1-936316834081",
  "prd.json",
);

const prd = JSON.parse(readFileSync(prdPath, "utf8"));
const id = process.argv[2];
const story = prd.stories.find((s: { id: string }) => s.id === id);
if (!story) {
  console.error(`story ${id} not found`);
  process.exit(1);
}
story.passes = true;
story.completionCriteriaRevision = story.governingCriteriaRevision;
story.notes = (story.notes || "") + " [passed " + new Date().toISOString() + "]";
process.stdout.write(JSON.stringify(prd, null, 2));
process.stdout.write("\n");
