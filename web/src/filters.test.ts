// The Collection filter state, round-tripped.
//
// The surface's whole memory of what the viewer asked for is the query string,
// so `parse(render(f)) === f` is the property the page's back button, its facet
// chips and its `Reset` all rest on. The second property is the validity matrix
// of SPEC.md §8.3: the client reads and sends only the parameters it declares.

import { describe, expect, it } from "vitest";
import {
  applies,
  bankPage,
  FILTER_PARAMETERS,
  isAccession,
  parseFilters,
  localSearch,
  accessionPath,
  toQuery,
  type Filters,
} from "./filters";

const FULL: Filters = {
  q: "monoComp",
  doi: "MTH.C-2026-5001",
  library: "FLT_Proofs.Foundations.EMX",
  author: "zetetic-dhruv",
  axioms: "free",
  from: "2026-01-01",
  to: "2026-12-31",
  sort: "oldest",
};

describe("the filter query string", () => {
  it("round-trips every claims-bank parameter", () => {
    expect(parseFilters(toQuery(FULL, "claims"), "claims")).toEqual(FULL);
  });

  it("round-trips every arguments-bank parameter", () => {
    expect(parseFilters(toQuery(FULL, "arguments"), "arguments")).toEqual(FULL);
  });

  it("ignores a parameter it does not declare, such as the retired count filter", () => {
    expect(parseFilters("?min_arguments=3", "claims")).toEqual({});
    expect(parseFilters("?min_arguments=3&q=x", "arguments")).toEqual({ q: "x" });
  });

  it("renders the empty state as an empty query", () => {
    expect(toQuery({}, "claims")).toBe("");
    expect(toQuery({ q: "   " }, "claims")).toBe("");
    expect(parseFilters("", "claims")).toEqual({});
    expect(parseFilters("?q=", "claims")).toEqual({});
  });

  it("orders the parameters by the catalogue, so one state is one URL", () => {
    const a = toQuery({ sort: "newest", q: "x" }, "claims");
    const b = toQuery({ q: "x", sort: "newest" }, "claims");
    expect(a).toBe(b);
    expect(a).toBe("?q=x&sort=newest");
  });

  it("declares a bank for every parameter", () => {
    for (const p of FILTER_PARAMETERS) {
      expect(applies(p, "claims") || applies(p, "arguments"), p).toBe(true);
    }
  });
});

const ROWS = [
  { accession: "MTH.C-2026-6001", decl_name: "encard_image_inter_le_encard_shatters", pretty: "(A ∩ ·) '' 𝒜", module: "FLT_Proofs.VCDimGeneralized.VCDim", libraries: ["FLT_Proofs"], author: "Dhruv Gupta", author_login: "Zetetic-Dhruv", axioms: ["Classical.choice", "Quot.sound", "propext"], axiom_free: false, arguments: 1, created_at: "2026-09-24T00:00:00Z" },
  { accession: "MTH.C-2026-6018", decl_name: "MeasureTheory.AnalyticSet.cap_eq_iSup_isCompact", pretty: "cap s = ⨆ K", module: "ZPM.MeasureTheory.ChoquetCapacity.Capacitability", libraries: ["ZPM"], author: "Dhruv Gupta", author_login: "Zetetic-Dhruv", axioms: [], axiom_free: true, arguments: 0, created_at: "2026-09-20T00:00:00Z" },
];

describe("the in-browser search over the generated bank", () => {
  it("matches every term, case-insensitively, against decl, statement and module", () => {
    expect(localSearch(ROWS, { q: "SHATTERS encard" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6001"]);
    expect(localSearch(ROWS, { q: "choquet" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6018"]);
    expect(localSearch(ROWS, { q: "shatters choquet" })).toEqual([]);
  });
  it("filters by library, author, axioms and calendar day", () => {
    expect(localSearch(ROWS, { library: "ZPM" })).toHaveLength(1);
    expect(localSearch(ROWS, { author: "Zetetic-Dhruv" })).toHaveLength(2);
    expect(localSearch(ROWS, { axioms: "free" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6018"]);
    expect(localSearch(ROWS, { axioms: "Quot.sound" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6001"]);
    expect(localSearch(ROWS, { from: "2026-09-21" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6001"]);
    expect(localSearch(ROWS, { to: "2026-09-20" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6018"]);
  });
  it("sorts newest first by default and oldest first on request", () => {
    expect(localSearch(ROWS, {}).map((r) => r.accession)).toEqual(["MTH.C-2026-6001", "MTH.C-2026-6018"]);
    expect(localSearch(ROWS, { sort: "oldest" }).map((r) => r.accession)).toEqual(["MTH.C-2026-6018", "MTH.C-2026-6001"]);
  });
});

describe("the generated pages the collection reads", () => {
  it("names a bank page the way the generator writes it", () => {
    expect(bankPage("claims", 0)).toBe("/collection/claims-0000.json");
    expect(bankPage("arguments", 12)).toBe("/collection/arguments-0012.json");
  });
});

describe("the DOI box's destination", () => {
  it("is rebuilt from a well-formed accession", () => {
    expect(accessionPath("MTH.C-2026-6001")).toBe("/a/MTH.C-2026-6001/");
    expect(accessionPath("  MTH.R-2026-006032 ")).toBe("/a/MTH.R-2026-006032/");
    // the prefix as the generated site.json writes it, separator included
    expect(accessionPath("MTH.C-2026-6010", "MTH.")).toBe("/a/MTH.C-2026-6010/");
  });
  it("is null for anything else, so nothing typed is ever navigated to", () => {
    for (const bad of ["javascript:alert(1)", "MTH.C-2026-6001/../x", "MTH.X-2026-6001", "//evil.example/MTH.C-2026-6001", "OTH.C-2026-6001", ""]) {
      expect(accessionPath(bad)).toBeNull();
    }
  });
});

describe("accession recognition", () => {
  it("accepts both kinds in the public band and refuses everything else", () => {
    expect(isAccession("MTH.C-2026-5001")).toBe(true);
    expect(isAccession("MTH.R-2026-500123")).toBe(true);
    expect(isAccession(" MTH.R-2026-5007 ")).toBe(true);
    expect(isAccession("MTH.D-2026-5001")).toBe(false);
    expect(isAccession("MTH.C-2026-501")).toBe(false);
    expect(isAccession("10.1000/182")).toBe(false);
  });
});
