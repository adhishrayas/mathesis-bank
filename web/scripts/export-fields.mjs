// Writes the authored field catalogue to the path the Rust templates and
// prose-lint read, and asserts every leaf of the public v3 manifest schema has
// a `source: "manifest"` entry in it. `--check` fails on either.
//
// There is no Go→TS codegen and no OpenAPI document, because there is no second
// origin: a gateway response field or a client-only UI state is declared in
// `web/src/fields.ts` like every other entry (SPEC.md §8).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(repo, "services/registry/crates/record/fields.json");
const schemaPath = resolve(repo, "schema/public-unit-manifest.v3.schema.json");
const { FIELDS, manifestGaps, manifestLeaves } = await import(resolve(here, "../src/fields.ts"));
const body = JSON.stringify(FIELDS, null, 2) + "\n";

const names = new Set(FIELDS.map((f) => f.field));
if (names.size !== FIELDS.length) {
  console.error("fields: duplicate field name");
  process.exit(1);
}

// The manifest half. The schema is written by the `record` component; when it
// is not in the tree yet the check says so rather than reporting a pass it did
// not make.
let leaves = null;
if (existsSync(schemaPath)) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  leaves = manifestLeaves(schema);
  if (leaves.length === 0) {
    console.error(
      `fields: ${relative(repo, schemaPath)} annotates no leaf with "x-field", so no leaf can be ` +
        `checked against the catalogue; every scalar leaf needs one naming its catalogue field`,
    );
    process.exit(1);
  }
  const gaps = manifestGaps(schema, FIELDS);
  if (gaps.length) {
    for (const g of gaps) {
      console.error(
        g.reason === "absent"
          ? `fields: manifest leaf "${g.field}" has no catalogue entry`
          : `fields: manifest leaf "${g.field}" is declared source:"${g.reason}", not "manifest"`,
      );
    }
    process.exit(1);
  }
}

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current !== body) {
    console.error(`fields: ${relative(repo, out)} differs from web/src/fields.ts`);
    process.exit(1);
  }
  console.log(
    leaves === null
      ? `fields: ${FIELDS.length} entries, in sync; ${relative(repo, schemaPath)} absent, no manifest leaf checked`
      : `fields: ${FIELDS.length} entries, in sync; ${leaves.length} manifest leaves covered`,
  );
} else {
  writeFileSync(out, body);
  console.log(`fields: wrote ${relative(repo, out)}`);
}
