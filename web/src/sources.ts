// The source set the static checks read.
//
// It is a module rather than three copies of the same walk, because the labels
// check, the field check and the verified-region check all have to agree on
// exactly which files are "the client": a file that slipped out of one of those
// lists would be a hole in all three.
//
// Nothing here is shipped: `main.tsx` never imports it, so it is not in the
// bundle, and it exists only for `vitest`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const SRC_DIR = dirname(new URL(import.meta.url).pathname);
export const WEB_DIR = resolve(SRC_DIR, "..");
export const REPO_DIR = resolve(WEB_DIR, "..");

export interface Source {
  path: string;
  rel: string;
  text: string;
}

function isClientSource(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  if (path.endsWith(".generated.ts")) return false;
  if (path.endsWith("/sources.ts")) return false;
  return true;
}

/** Every authored client module. */
export function clientSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (isClientSource(p)) out.push({ path: p, rel: relative(REPO_DIR, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(SRC_DIR);
  return out;
}

/** The modules reachable from one entry, following relative imports only. */
export function reachableFrom(entry: string): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  const visit = (path: string): void => {
    const candidates = [path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")];
    const found = candidates.find((c) => {
      try {
        return statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (!found || seen.has(found)) return;
    seen.add(found);
    const text = readFileSync(found, "utf8");
    out.push({ path: found, rel: relative(REPO_DIR, found), text });
    const importRe = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
      visit(resolve(dirname(found), m[1] as string));
    }
  };
  visit(resolve(SRC_DIR, entry));
  return out;
}
