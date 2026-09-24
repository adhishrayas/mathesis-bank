#!/usr/bin/env node
// prose-lint — mechanical enforcement of the no-non-functional-prose rule and
// the internal-corpus firewall (SPEC.md §13 Rule 1).
//
//   prose-lint <record-dir> [--labels …] [--fields …] [--about …]
//                           [--allowlist …] [--terms …]
//   prose-lint --dom <snapshot-dir> [...]
//
// The first input is the generated tree, where each page's data values are
// checked against its sibling `values.json` positionally, by field, byte for
// byte. The second is the committed Playwright capture of every dynamic
// surface (`document.documentElement.outerHTML`), where a value is checked
// against its field's declared shape instead. Both may be given in one
// invocation.
//
// Exit 0 clean, 1 violations. The findings are also written to
// `.prose-lint.json`.
//
// Dead-label coverage — a catalogue entry no captured surface renders — is
// asserted when a `--dom` input is present, over the union of this invocation's
// inputs and the coverage a previous run recorded in the same report file
// against the same catalogue. That union is what makes the release gate's two
// separate invocations (`prose-lint dist` then `prose-lint --dom …`) assert the
// rule over the whole shipped surface rather than over half of it.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCatalogue, loadFields, checkCatalogue, checkFields } from "./catalogue.js";
import { loadAllowlist, checkAgreement, checkRegion, effectiveSets } from "./allowlist.js";
import { loadLocalTerms, scanBanned, scanFirewall } from "./scan.js";
import { lintDocument, reasonMatchers } from "./lint.js";
import { parseFragment } from "parse5";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

const DEFAULTS = {
  labels: join(repo, "services/registry/crates/record/labels.json"),
  fields: join(repo, "services/registry/crates/record/fields.json"),
  about: join(repo, "about/body.html"),
  allowlist: join(repo, "shared/html-allowlist.v1.json"),
  terms: join(repo, ".firewall-terms"),
  reasons: join(repo, "shared/reasons.v1.json"),
  report: join(process.cwd(), ".prose-lint.json"),
};

const USAGE = "usage: prose-lint <record-dir> [--dom <snapshot-dir>] [--labels p] [--fields p] [--about p] [--allowlist p] [--terms p] [--reasons p] [--report p] [--fresh]";

export function parseArgs(argv) {
  const opt = { trees: [], doms: [], fresh: false, printAllowlist: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--dom": opt.doms.push(take()); break;
      case "--labels": opt.labels = take(); break;
      case "--fields": opt.fields = take(); break;
      case "--about": opt.about = take(); break;
      case "--allowlist": opt.allowlist = take(); break;
      case "--terms": opt.terms = take(); break;
      case "--reasons": opt.reasons = take(); break;
      case "--report": opt.report = take(); break;
      case "--fresh": opt.fresh = true; break;
      case "--print-allowlist": opt.printAllowlist = true; break;
      case "-h":
      case "--help": opt.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        opt.trees.push(a);
    }
  }
  return opt;
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** The whole run, as data. Exported so the tests drive it directly. */
export function run(opt) {
  const catalogue = loadCatalogue(opt.labels);
  const fields = loadFields(opt.fields);
  const allowlist = loadAllowlist(opt.allowlist);
  const terms = loadLocalTerms(opt.terms);
  const reasons = JSON.parse(readFileSync(opt.reasons, "utf8"));
  const aboutBody = existsSync(opt.about) ? readFileSync(opt.about, "utf8") : "";
  const ctx = { catalogue, fields, allowlist, terms, matchers: reasonMatchers(reasons), aboutBody };

  const violations = [];
  violations.push(...checkCatalogue(catalogue, terms));
  violations.push(...checkFields(fields));
  violations.push(...checkAgreement(allowlist));
  violations.push(...lintAboutSource(opt.about, aboutBody, allowlist, terms));

  let checked = aboutBody.trim() === "" ? 0 : 1;
  const rendered = new Set();

  const inputs = [
    ...opt.trees.map((d) => ({ root: d, mode: "tree" })),
    ...opt.doms.map((d) => ({ root: d, mode: "dom" })),
  ];
  for (const { root, mode } of inputs) {
    if (!existsSync(root)) throw new Error(`${root} does not exist`);
    const files = htmlFiles(root);
    if (files.length === 0) throw new Error(`${root} holds no HTML`);
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      let values = null;
      // The generator names an `index.html` page's values `values.json` and any
      // other page's `<page>.values.json`, beside it.
      const sibling = basename(file) === "index.html"
        ? join(dirname(file), "values.json")
        : join(dirname(file), `${basename(file, ".html")}.values.json`);
      if (mode === "tree" && existsSync(sibling)) values = JSON.parse(readFileSync(sibling, "utf8"));
      const r = lintDocument({ file: rel(file), html, values, mode, ctx });
      violations.push(...r.violations);
      // Every page that renders a value is checked against its own manifest.
      // The two by-path copies `webd` serves (`404.html`, `503.html`) render
      // none, so they need none; a page that renders one and has no manifest is
      // a page nothing checks.
      if (mode === "tree" && !values && r.valueCount > 0) {
        violations.push({
          file: rel(file),
          selector: "",
          kind: "value_mismatch",
          value: `${r.valueCount} value elements and no sibling values.json`,
          offset: 0,
        });
      }
      for (const label of r.rendered) rendered.add(label);
      checked += 1;
    }
  }

  // Coverage carried from an earlier invocation against the same catalogue.
  const prior = opt.fresh ? null : readPrior(opt.report, catalogue.sha256);
  const roots = inputs.map((i) => rel(i.root));
  if (prior) for (const label of prior.rendered ?? []) rendered.add(label);

  if (opt.doms.length > 0) {
    for (const [key, text] of catalogue.labels) {
      if (rendered.has(text)) continue;
      violations.push({
        file: rel(catalogue.path),
        selector: `labels.${key}`,
        kind: "dead_label",
        value: text,
        offset: Math.max(catalogue.raw.indexOf(`"${key}"`), 0),
      });
    }
  }

  const report = {
    violations,
    checked_files: checked,
    labels: catalogue.labels.length,
    fields: fields.list.length,
    rendered: [...rendered].sort(),
    roots: [...new Set([...(prior?.roots ?? []), ...roots])].sort(),
    labels_sha256: catalogue.sha256,
  };
  writeFileSync(opt.report, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function readPrior(path, sha) {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j.labels_sha256 === sha ? j : null;
  } catch {
    return null;
  }
}

/**
 * `about/body.html` is an input to generation, so the banned-token scan, the
 * firewall scan and the `about` allowlist profile run over the committed file
 * itself and not only over the page it lands on (SPEC §8.4).
 */
function lintAboutSource(path, body, allowlist, terms) {
  if (body.trim() === "") return [];
  const out = [];
  const fragment = parseFragment(body, { sourceCodeLocationInfo: true });
  out.push(
    ...checkRegion({ ...allowlist.profiles.about }, fragment, {
      file: rel(path),
      selector: (n) => n.tagName,
      offset: (n) => n.sourceCodeLocation?.startOffset ?? 0,
    }),
  );
  for (const hit of scanBanned(body)) {
    out.push({ file: rel(path), selector: "", kind: "banned_token", value: hit.value, offset: hit.offset });
  }
  for (const hit of scanFirewall(body, terms)) {
    out.push({ file: rel(path), selector: "", kind: "firewall", value: hit.value, offset: hit.offset });
  }
  return out;
}

function rel(p) {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
}

function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    console.error(`prose-lint: ${e.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opt.help) {
    console.log(USAGE);
    return 0;
  }
  if (opt.printAllowlist) {
    console.log(JSON.stringify(effectiveSets(loadAllowlist(opt.allowlist)), null, 2));
    return 0;
  }
  if (opt.trees.length === 0 && opt.doms.length === 0) {
    console.error(USAGE);
    return 2;
  }

  let report;
  try {
    report = run(opt);
  } catch (e) {
    console.error(`prose-lint: ${e.message}`);
    return 1;
  }

  for (const v of report.violations) {
    console.error(`${v.file}:${v.offset}: ${v.kind}: ${v.selector ? `${v.selector}: ` : ""}${v.value}`);
  }
  console.log(
    `prose-lint: ${report.checked_files} documents, ${report.labels} labels, ${report.fields} fields, ${report.violations.length} violations`,
  );
  return report.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
