#!/usr/bin/env node
// reason-lint — the gate on `shared/reasons.v1.json` (SPEC.md §6.3, §13).
//
//   reason-lint shared/reasons.v1.json [--terms .firewall-terms]
//
// Exit 0 clean, 1 violations.

import { readFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalTerms } from "./scan.js";
import { lintReasons } from "./reasons.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const USAGE = "usage: reason-lint <reasons.v1.json> [--terms <file>]";

export function main(argv) {
  let file = null;
  let terms = join(repo, ".firewall-terms");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--terms") {
      terms = argv[i + 1];
      i += 1;
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(USAGE);
      return 0;
    } else if (argv[i].startsWith("-")) {
      console.error(`reason-lint: unknown option ${argv[i]}`);
      return 2;
    } else {
      file = argv[i];
    }
  }
  if (!file) {
    console.error(USAGE);
    return 2;
  }

  let findings;
  let count = 0;
  try {
    const raw = readFileSync(file, "utf8");
    count = (JSON.parse(raw).reasons ?? []).length;
    const name = relative(process.cwd(), file).startsWith("..") ? file : relative(process.cwd(), file);
    findings = lintReasons(name, raw, loadLocalTerms(terms));
  } catch (e) {
    console.error(`reason-lint: ${e.message}`);
    return 1;
  }

  for (const v of findings) console.error(`${v.file}:${v.offset}: ${v.kind}: ${v.selector}: ${v.value}`);
  console.log(`reason-lint: ${count} reasons, ${findings.length} violations`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
