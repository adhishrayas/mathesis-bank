// The DOIs table's column sort (DESIGN.md §12.2, §7.9).
//
// Three properties, and the third is the one that makes the feature worth
// having: the sort key's type comes from the field catalogue, so an integer
// column sorts numerically rather than as text, which is the difference between
// `9 < 10` and `10 < 9`.

import { afterEach, describe, expect, it } from "vitest";
import { mountTableSort } from "./table";

function doisDom(): HTMLTableElement {
  document.body.setAttribute("data-page", "profile");
  document.body.innerHTML = `
    <main class="mth-profile" data-profile-id="p-1">
      <section class="mth-profile__dois">
        <h2>DOIs</h2>
        <table class="mth-table">
          <thead><tr><th>DOI</th><th>Arguments</th><th>Verified</th></tr></thead>
          <tbody>
            <tr>
              <td><a data-value="true" data-field="argument.accession" href="/a/MTH.R-2026-5007">MTH.R-2026-5007</a></td>
              <td><span data-value="true" data-field="claim.arguments_count">9</span></td>
              <td><span data-value="true" data-field="argument.created_at">2026-09-22T08:00:00Z</span></td>
            </tr>
            <tr>
              <td><a data-value="true" data-field="argument.accession" href="/a/MTH.R-2026-5008">MTH.R-2026-5008</a></td>
              <td><span data-value="true" data-field="claim.arguments_count">10</span></td>
              <td><span data-value="true" data-field="argument.created_at">2026-09-21T08:00:00Z</span></td>
            </tr>
            <tr>
              <td><a data-value="true" data-field="argument.accession" href="/a/MTH.R-2026-5009">MTH.R-2026-5009</a></td>
              <td><span data-value="true" data-field="claim.arguments_count">2</span></td>
              <td><span data-value="true" data-field="argument.created_at">2026-09-23T08:00:00Z</span></td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>`;
  const table = document.querySelector("table");
  if (!table) throw new Error("no table");
  return table as HTMLTableElement;
}

function column(table: HTMLTableElement, index: number): string[] {
  return Array.from(table.tBodies[0]?.rows ?? []).map((r) => (r.cells[index]?.textContent ?? "").trim());
}

function sortButton(table: HTMLTableElement, index: number): HTMLButtonElement {
  const th = table.tHead?.rows[0]?.cells[index];
  const button = th?.querySelector("button.mth-th-sort");
  if (!button) throw new Error("no sort control");
  return button as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the DOIs table sorts", () => {
  it("promotes each column's own heading into the control and writes no string", () => {
    const table = doisDom();
    mountTableSort(document);
    const heads = Array.from(table.tHead?.rows[0]?.cells ?? []).map((th) => th.textContent);
    expect(heads).toEqual(["DOI", "Arguments", "Verified"]);
    for (let i = 0; i < 3; i += 1) expect(sortButton(table, i).textContent).toBe(heads[i]);
  });

  it("marks the column the generator already sorted on", () => {
    const table = doisDom();
    mountTableSort(document);
    expect(table.tHead?.rows[0]?.cells[2]?.getAttribute("aria-sort")).toBe("descending");
    expect(table.tHead?.rows[0]?.cells[0]?.getAttribute("aria-sort")).toBeNull();
  });

  it("sorts an integer column numerically, not as text", () => {
    const table = doisDom();
    mountTableSort(document);
    sortButton(table, 1).click();
    // Descending first for a number: 10 before 9, which a byte comparison
    // would have reversed.
    expect(column(table, 1)).toEqual(["10", "9", "2"]);
    sortButton(table, 1).click();
    expect(column(table, 1)).toEqual(["2", "9", "10"]);
    expect(table.tHead?.rows[0]?.cells[1]?.getAttribute("aria-sort")).toBe("ascending");
    expect(table.tHead?.rows[0]?.cells[2]?.getAttribute("aria-sort")).toBeNull();
  });

  it("sorts a timestamp column chronologically and an accession column by name", () => {
    const table = doisDom();
    mountTableSort(document);
    sortButton(table, 2).click();
    expect(column(table, 2)).toEqual([
      "2026-09-21T08:00:00Z",
      "2026-09-22T08:00:00Z",
      "2026-09-23T08:00:00Z",
    ]);
    sortButton(table, 0).click();
    expect(column(table, 0)).toEqual(["MTH.R-2026-5007", "MTH.R-2026-5008", "MTH.R-2026-5009"]);
  });

  it("keeps every generated row: sorting reorders, it never filters", () => {
    const table = doisDom();
    mountTableSort(document);
    for (const index of [0, 1, 2, 2, 1, 0]) sortButton(table, index).click();
    expect(column(table, 0).sort()).toEqual(["MTH.R-2026-5007", "MTH.R-2026-5008", "MTH.R-2026-5009"]);
  });
});
