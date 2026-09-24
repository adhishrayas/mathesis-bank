import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "../src/cli.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, "..", "..", "..");
export const fixtures = join(here, "fixtures");

/** A run with a private report file, so no test sees another's coverage. */
export function lint(args, { report } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prose-lint-"));
  const path = report ?? join(dir, ".prose-lint.json");
  try {
    return run(parseArgs([...args, "--report", path]));
  } finally {
    if (!report) rmSync(dir, { recursive: true, force: true });
  }
}

/** The small catalogue the coverage fixtures are written against. */
export const SMALL = [
  "--labels",
  join(fixtures, "catalogue/labels.json"),
  "--fields",
  join(fixtures, "catalogue/fields.json"),
];

export const kinds = (report) => report.violations.map((v) => v.kind);
export const of = (report, kind) => report.violations.filter((v) => v.kind === kind);
