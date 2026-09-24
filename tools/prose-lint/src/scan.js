// The two text scans that run over everything: the banned-token scan and the
// internal-corpus firewall (SPEC.md §8, §9 "keeping the internal corpus out",
// §13 Rule 1). Neither is suppressed by a carve-out.

import { existsSync, readFileSync } from "node:fs";

/** SPEC §13: `lorem`, `TODO`, `FIXME`, `coming soon`, `placeholder`. */
export const BANNED_TOKENS = ["lorem", "todo", "fixme", "coming soon", "placeholder"];

/**
 * The firewall terms. The public layer is a curated FLT subset; the internal
 * corpus (WMSpec / Eidometry / TLT), the legacy accession band and the legacy
 * export blobs must not appear in it, and neither must a path off this machine.
 *
 * The three sha256 prefixes are the legacy `registry/_shared/exports` blobs,
 * truncated to the 12 characters the record renders (`export_sha256[..12]`,
 * `statement_digest[..12]`), so a rendered prefix is caught as well as a full
 * digest.
 */
export const FIREWALL_TERMS = [
  { name: "WMSpec", re: /WMSpec/g },
  { name: "Eidometry", re: /Eidometry/g },
  { name: "TLT_Proofs", re: /TLT_Proofs/g },
  { name: "legacy-accession", re: /MTH\.[CRD]-20[0-9]{2}-1[0-9]{3}\b/g },
  { name: "legacy-blob", re: /040a6e477554/g },
  { name: "legacy-blob", re: /18e64d712e25/g },
  { name: "legacy-blob", re: /6f334bc4a8ae/g },
  { name: "absolute-path", re: /\/Users\//g },
];

/**
 * Extra terms, one per line, from a gitignored `.firewall-terms`. Lines
 * beginning `#` are comments; a line beginning `/` and ending `/` is a regular
 * expression, anything else is a literal.
 */
export function loadLocalTerms(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length > 2 && line.startsWith("/") && line.endsWith("/")) {
      out.push({ name: line, re: new RegExp(line.slice(1, -1), "g") });
    } else {
      out.push({ name: line, re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") });
    }
  }
  return out;
}

/** Every banned token in `text`, with the byte offset of each hit. */
export function scanBanned(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const token of BANNED_TOKENS) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at === -1) break;
      hits.push({ kind: "banned_token", value: text.slice(at, at + token.length), offset: at });
      from = at + token.length;
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

/** Every firewall hit in `text`, with the byte offset of each. */
export function scanFirewall(text, terms) {
  const hits = [];
  for (const term of [...FIREWALL_TERMS, ...terms]) {
    const re = new RegExp(term.re.source, term.re.flags.includes("g") ? term.re.flags : `${term.re.flags}g`);
    for (const m of text.matchAll(re)) {
      hits.push({ kind: "firewall", value: m[0], offset: m.index });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}
