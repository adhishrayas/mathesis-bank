// The two segregated banks (SPEC.md §8.3, DESIGN.md §12.5).
//
// The bank is a path, so this module never switches between them: it reads the
// bank off the generated `<main data-bank>` and drives one document. Search is
// served by `mathesisd` through `webd`, never through the gateway, so a registry
// outage does not reach this page.
//
// An empty result is an empty `<tbody>` and `Rows 0` — no empty-state sentence
// and no illustration. A parameter that does not apply to the bank is refused by
// the API with `422 invalid_filter` and is rendered as that refusal, never
// silently ignored.

import { LABELS, VALUES } from "./labels";
import { clear, el, label, qs, qsa, staticJson, value, withBase } from "./dom";
import { mountExpanders } from "./record";
import {
  bankPage,
  DEFAULT_DOI_PREFIX,
  accessionPath,
  parseFilters,
  localSearch,
  toQuery,
  type Bank,
  type Filters,
  type FilterParameter,
} from "./filters";
import type { SearchPage, SearchRow, SiteInfo } from "./types";

function chip(accession: string, field: string): HTMLElement {
  return value("a", field, accession, { class: "mth-doi", href: withBase(`/a/${accession}/`) });
}

function statementCell(row: SearchRow): HTMLElement {
  const td = el("td");
  const wrap = el("div", { class: "mth-lean-clamp mth-lean-clamp--3", "data-clamped": "true" });
  const pre = el("pre", {
    class: "mth-lean",
    "data-role": "lean-statement",
    "data-value": "true",
    "data-field": "claim.pretty",
  });
  pre.textContent = row.pretty;
  wrap.append(pre);
  const toggle = label("button", "expand", {
    class: "mth-btn mth-btn--xs",
    type: "button",
    "data-expand": "row",
  });
  td.append(wrap, toggle);
  return td;
}

function axiomCell(row: SearchRow, isOpenClaim: boolean): HTMLElement {
  const td = el("td");
  if (isOpenClaim) {
    td.append(value("span", "null", VALUES.emDash, { class: "mth-value--em" }));
  } else if (row.axioms.length === 0) {
    td.append(value("span", "axiom_manifest", VALUES.free, { class: "mth-status mth-status--ok" }));
  } else {
    for (const a of row.axioms) {
      td.append(value("span", "axiom_manifest", a, { class: "mth-mono" }));
    }
  }
  return td;
}

function cell(field: string, text: string, className?: string): HTMLElement {
  const td = el("td");
  td.append(className ? value("span", field, text, { class: className }) : value("span", field, text));
  return td;
}

function claimRow(row: SearchRow): HTMLElement {
  const tr = el("tr");
  tr.append(el("td", {}, [chip(row.accession, "claim.accession")]));
  tr.append(statementCell(row));
  tr.append(cell("claim.decl_name", row.decl_name, "mth-td-mono"));
  tr.append(cell("claim.module", row.module));
  tr.append(axiomCell(row, row.arguments === 0));
  tr.append(cell("claim.arguments_count", String(row.arguments), "mth-td-num"));
  tr.append(cell("claim.first_verified", row.created_at));
  return tr;
}

function argumentRow(row: SearchRow): HTMLElement {
  const tr = el("tr");
  tr.append(el("td", {}, [chip(row.accession, "argument.accession")]));
  tr.append(el("td", {}, [chip(row.claim_accession ?? "", "claim.accession")]));
  tr.append(cell("argument.root_decl_name", row.decl_name, "mth-td-mono"));
  tr.append(cell("profile.citation_name", row.author));
  tr.append(axiomCell(row, false));
  tr.append(cell("argument.export_constants", String(row.constants), "mth-td-num"));
  tr.append(cell("argument.node_count", String(row.nodes), "mth-td-num"));
  tr.append(cell("argument.created_at", row.created_at));
  return tr;
}

/** The active filters, as removable chips. The remove button's `aria-label` is
 * the catalogue entry `Clear`, which is the one icon-only control the design
 * admits besides the sort carets. */
function renderFacets(host: HTMLElement, filters: Filters, onRemove: (p: FilterParameter) => void): void {
  clear(host);
  for (const [parameter, v] of Object.entries(filters) as [FilterParameter, string][]) {
    const facetChip = el("span", { class: "mth-chip-facet", "data-facet": parameter });
    facetChip.append(value("span", "facet.value", v));
    const remove = el("button", {
      class: "mth-btn mth-btn--xs",
      type: "button",
      "aria-label": LABELS.clear,
      "data-facet-remove": parameter,
    });
    remove.addEventListener("click", () => onRemove(parameter));
    facetChip.append(remove);
    host.append(facetChip);
  }
}

export function mountCollection(root: ParentNode): void {
  const main = qs<HTMLElement>(".mth-bank", root);
  if (!main) return;
  // The accession scheme's prefix is a property of the record, so the `DOI` +
  // `Go` control reads it from the generated `site.json` rather than carrying a
  // copy. `site.json` is a static file `webd` serves from the record tree, so
  // it is readable exactly when this page is; until it arrives the compiled-in
  // default stands, which is the same string it carries today.
  let doiPrefix = DEFAULT_DOI_PREFIX;
  void staticJson<SiteInfo>("/site.json").then((res) => {
    if (res.body && typeof res.body.doi_prefix === "string" && res.body.doi_prefix !== "") {
      doiPrefix = res.body.doi_prefix;
    }
  });
  const bank = (main.getAttribute("data-bank") ?? "claims") as Bank;
  const form = qs<HTMLFormElement>("form[data-facets]", main);
  const tbody = qs<HTMLElement>("tbody[data-rows]", main);
  const rowsCount = qs<HTMLElement>("[data-field='rows.count']", main);
  if (!form || !tbody || !rowsCount) return;

  rowsCount.setAttribute("aria-live", "polite");
  const table = tbody.closest("table");
  const facets = el("div", { class: "mth-facets" });
  table?.parentElement?.insertBefore(facets, table);

  const readForm = (): Filters => {
    const out: Filters = {};
    for (const input of qsa<HTMLInputElement | HTMLSelectElement>("input[name], select[name]", form)) {
      if (input.value.trim() === "") continue;
      out[input.name as FilterParameter] = input.value;
    }
    return out;
  };

  const writeForm = (filters: Filters): void => {
    for (const input of qsa<HTMLInputElement | HTMLSelectElement>("input[name], select[name]", form)) {
      input.value = filters[input.name as FilterParameter] ?? "";
    }
  };


  let all: SearchRow[] | null = null;
  const loadAll = async (): Promise<SearchRow[]> => {
    if (all) return all;
    const rows: SearchRow[] = [];
    for (let i = 0; ; i++) {
      const res = await staticJson<SearchPage>(bankPage(bank, i));
      if (!res.body) break;
      rows.push(...res.body.rows);
      if (res.body.next_cursor === null) break;
    }
    all = rows;
    return rows;
  };
  const run = async (filters: Filters): Promise<void> => {
    const target = filters.doi ? accessionPath(filters.doi, doiPrefix) : null;
    if (target) {
      window.location.assign(withBase(target));
      return;
    }
    const found = localSearch(await loadAll(), filters, bank);
    clear(tbody);
    for (const row of found) {
      tbody.append(bank === "claims" ? claimRow(row) : argumentRow(row));
    }
    rowsCount.textContent = String(found.length);
    mountExpanders(tbody);
  };
  const apply = (filters: Filters, push: boolean): void => {
    renderFacets(facets, filters, (parameter) => {
      const next = { ...filters };
      delete next[parameter];
      writeForm(next);
      apply(next, true);
    });
    if (push) {
      const url = `${window.location.pathname}${toQuery(filters, bank)}`;
      window.history.replaceState(null, "", url);
    }
    void run(filters);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply(readForm(), true);
  });
  form.addEventListener("reset", () => {
    window.setTimeout(() => apply({}, true), 0);
  });

  const initial = parseFilters(window.location.search, bank);
  writeForm(initial);
  // Page 0 of an unfiltered bank is the document itself; re-fetching it would
  // replace the generator's own rows with identical ones for no reason.
  if (Object.keys(initial).length > 0) apply(initial, false);
  else renderFacets(facets, initial, () => undefined);
}
