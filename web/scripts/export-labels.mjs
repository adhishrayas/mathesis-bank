// Writes the authored label catalogue to the path the Rust templates and
// prose-lint read. `--check` fails when the two disagree, so a label can only
// change through web/src/labels.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../services/registry/crates/record/labels.json");
const { LABELS, VALUE_LIST: VALUES } = await import(resolve(here, "../src/labels.ts"));
const body = JSON.stringify({ labels: LABELS, values: VALUES }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch {}
  if (current !== body) {
    console.error(`labels: ${out} differs from web/src/labels.ts`);
    process.exit(1);
  }
  console.log(`labels: ${Object.keys(LABELS).length} entries, ${VALUES.length} values, in sync`);
} else {
  writeFileSync(out, body);
  console.log(`labels: wrote ${out}`);
}
