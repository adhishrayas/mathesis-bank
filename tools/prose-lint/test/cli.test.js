// The command line the release gate calls: exit 0 clean, 1 violations, and a
// `.prose-lint.json` written either way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtures, here } from "./helpers.js";

const cli = join(here, "..", "src", "cli.js");

function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), "prose-lint-cli-"));
  const report = join(dir, ".prose-lint.json");
  const p = spawnSync(process.execPath, [cli, ...args, "--report", report], { encoding: "utf8" });
  return { ...p, report, json: existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null };
}

test("a clean tree exits 0 and writes the report", () => {
  const r = runCli([join(fixtures, "tree-clean")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /4 documents, \d+ labels, \d+ fields, 0 violations/);
  assert.deepEqual(r.json.violations, []);
});

test("a violation exits 1 and names file, offset and kind", () => {
  const r = runCli([join(fixtures, "dirty", "this-page-shows")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.html:\d+: unknown_string:/);
  assert.equal(r.json.violations.length, 1);
});

test("no input is a usage error", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: prose-lint/);
});

test("an unknown option is a usage error", () => {
  const r = runCli(["--dom-snapshots", "x"]);
  assert.equal(r.status, 2);
});

test("a missing input directory exits 1 and says so", () => {
  const r = runCli(["--dom", join(fixtures, "no-such-dir")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});

test("the two inputs can be given in one invocation", () => {
  const r = runCli([join(fixtures, "tree-clean"), "--dom", join(fixtures, "dom-coverage")]);
  // The real catalogue is wider than these two fixtures, so the run is not
  // clean; what it proves is that both inputs are read and coverage is unioned.
  assert.equal(r.json.roots.length, 2);
  assert.ok(r.json.rendered.includes("Frozen export"));
  assert.ok(r.json.rendered.includes("Reload"));
});
