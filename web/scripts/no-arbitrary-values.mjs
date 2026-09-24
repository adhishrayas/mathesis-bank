// Every magnitude is a token. An arbitrary value like `class="w-[220px]"` puts a
// number in a class attribute where a token belongs, and it is a build failure.
//
// The check runs over the BUILT stylesheet as well as the two source trees,
// because Tailwind's automatic source detection is additive: a class written in
// a comment, in a Markdown file or in this script itself once reached the
// shipped CSS while a lint scoped to two directories reported zero.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..");

const SOURCE_TREES = [
  { root: join(web, "src"), exts: [".ts", ".tsx", ".css"] },
  { root: join(repo, "services/registry/crates/record/src"), exts: [".rs"] },
];
const BUILT_CSS = join(web, "dist-assets/assets/record.css");

// A Tailwind arbitrary value: `prefix-[…]`, including the escaped form the
// compiler emits in a selector.
const IN_SOURCE = /\b[a-z-]+-\[[^\]\s]+\]/g;
const IN_CSS = /\.[a-z-]+-\\\[[^\]\s]+\\\]/g;

function walk(root, exts) {
  if (!existsSync(root)) {
    console.error(`no-arbitrary-values: ${relative(repo, root)} does not exist`);
    process.exit(1);
  }
  const out = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    // Test files are excluded from the Tailwind `@source` set for the same
    // reason they are excluded here: they ship nowhere, so a class-shaped
    // string in an assertion is not a class.
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let files = 0;
let violations = 0;

for (const { root, exts } of SOURCE_TREES) {
  for (const file of walk(root, exts)) {
    files += 1;
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(IN_SOURCE)) {
      // A CSS custom property or a media feature is not a class.
      if (m[0].startsWith("--")) continue;
      console.error(`${relative(repo, file)}: ${m[0]}`);
      violations += 1;
    }
  }
}

if (!existsSync(BUILT_CSS)) {
  console.error(`no-arbitrary-values: ${relative(repo, BUILT_CSS)} is absent; run the build first`);
  process.exit(1);
}
files += 1;
const css = readFileSync(BUILT_CSS, "utf8");
for (const m of css.matchAll(IN_CSS)) {
  console.error(`${relative(repo, BUILT_CSS)}: ${m[0]}`);
  violations += 1;
}

console.log(`no-arbitrary-values: ${files} files, ${violations} violations`);
process.exit(violations === 0 ? 0 : 1);
