// The Collection's filter state, and the one place it is turned into a query
// string and read back out of one.
//
// The bank is a PATH, never a filter (SPEC.md §8.3): `/collection/claims` and
// `/collection/arguments` are two documents, and `bank` enters the search query
// because the API needs it, never because the surface toggles it.
//
// `min_arguments` applies to the claims bank alone. The client does not silently
// drop an inapplicable parameter — it never sends one, and the API refuses one
// with `422 invalid_filter` if anything else does (SPEC.md §9).

export type Bank = "claims" | "arguments";

export const FILTER_PARAMETERS = [
  "q",
  "doi",
  "library",
  "author",
  "axioms",
  "from",
  "to",
  "min_arguments",
  "sort",
] as const;

export type FilterParameter = (typeof FILTER_PARAMETERS)[number];

/** §8.3's validity matrix, written once. */
export const APPLIES_TO: Record<FilterParameter, Bank[]> = {
  q: ["claims", "arguments"],
  doi: ["claims", "arguments"],
  library: ["claims", "arguments"],
  author: ["claims", "arguments"],
  axioms: ["claims", "arguments"],
  from: ["claims", "arguments"],
  to: ["claims", "arguments"],
  min_arguments: ["claims"],
  sort: ["claims", "arguments"],
};

export type Filters = Partial<Record<FilterParameter, string>>;

export function applies(parameter: FilterParameter, bank: Bank): boolean {
  return APPLIES_TO[parameter].includes(bank);
}

/** Read the filter state out of a location's query string, dropping anything
 * that does not apply to the bank and anything empty. */
export function parseFilters(search: string, bank: Bank): Filters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: Filters = {};
  for (const p of FILTER_PARAMETERS) {
    if (!applies(p, bank)) continue;
    const v = params.get(p);
    if (v === null || v.trim() === "") continue;
    out[p] = v;
  }
  return out;
}

/** The query string the surface round-trips through, in catalogue order so the
 * same state always produces the same URL. */
export function toQuery(filters: Filters, bank: Bank): string {
  const params = new URLSearchParams();
  for (const p of FILTER_PARAMETERS) {
    if (!applies(p, bank)) continue;
    const v = filters[p];
    if (v === undefined || v.trim() === "") continue;
    params.set(p, v);
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

/** A filter state applied to the bank's rows, in the browser. Text search
 * matches every whitespace-separated term, case-insensitively, against the
 * decl name, the statement and the module; `axioms=free` keeps axiom-free rows;
 * dates bound `created_at` inclusively by calendar day. */
export function localSearch<R extends BankRowLike>(rows: R[], filters: Filters, bank: Bank): R[] {
  const terms = (filters.q ?? "").toLowerCase().split(/\s+/).filter((t) => t !== "");
  const day = (ts: string): string => ts.slice(0, 10);
  const out = rows.filter((r) => {
    const hay = `${r.decl_name}\n${r.pretty}\n${r.module}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
    if (filters.library && !(r.libraries.includes(filters.library) || r.module === filters.library)) return false;
    if (filters.author && r.author_login !== filters.author && r.author !== filters.author) return false;
    if (filters.axioms) {
      if (filters.axioms === "free") {
        if (!r.axiom_free) return false;
      } else if (!r.axioms.includes(filters.axioms)) {
        return false;
      }
    }
    if (filters.from && day(r.created_at) < filters.from) return false;
    if (filters.to && day(r.created_at) > filters.to) return false;
    if (bank === "claims" && filters.min_arguments) {
      const min = Number.parseInt(filters.min_arguments, 10);
      if (Number.isFinite(min) && r.arguments < min) return false;
    }
    return true;
  });
  const dir = filters.sort === "oldest" ? 1 : -1;
  out.sort((x, y) => (x.created_at < y.created_at ? -dir : x.created_at > y.created_at ? dir : x.accession < y.accession ? -1 : 1));
  return out;
}

export interface BankRowLike {
  accession: string;
  decl_name: string;
  pretty: string;
  module: string;
  libraries: string[];
  author: string;
  author_login: string;
  axioms: string[];
  axiom_free: boolean;
  arguments: number;
  created_at: string;
}

/** The generated bank page for an unfiltered listing. Page 0 is the document
 * itself; later pages are these files (SPEC.md §10). */
export function bankPage(bank: Bank, page: number): string {
  return `/collection/${bank}-${String(page).padStart(4, "0")}.json`;
}

/** The accession scheme's compiled-in prefix, and the default when the site
 * manifest has not been read yet. The prefix is a property of the record, not
 * of the client, which is why `isAccession` takes it. */
export const DEFAULT_DOI_PREFIX = "MTH";

/**
 * Whether a string is a well-formed accession of either kind — the DOI scheme
 * of SPEC.md §5, `<prefix>.C-YYYY-NNNN` and `<prefix>.R-YYYY-NNNN`.
 *
 * `prefix` comes from the generated `site.json`'s `doi_prefix`, so a record
 * minted under a different namespace is recognised by the `DOI` + `Go` control
 * without a client change. An unknown but well-formed accession is the `404`
 * page; a malformed one never leaves the field.
 */
export function isAccession(s: string, prefix: string = DEFAULT_DOI_PREFIX): boolean {
  const p = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${p}\\.(C|R)-[0-9]{4}-[0-9]{4,6}$`).test(s.trim());
}
