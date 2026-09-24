// Column sorting over a generated table (DESIGN.md §12.2, §7.9).
//
// The profile's `DOIs` table is generated complete — every accession the
// profile holds, in `Verified` descending order — so sorting is a reordering of
// rows already in the document and needs no request. That is also why it works
// during a registry outage and why it cannot show a row the record does not
// carry.
//
// It introduces NO string. The control is the column's own catalogue heading
// promoted into a button, the direction is carried by `aria-sort` (a structural
// attribute, out of the linter's scope by name) and the caret is drawn by CSS
// `content:` on that attribute, so no text node is ever written.
//
// The sort key's TYPE comes from the field catalogue rather than from the
// text: a timestamp, an integer and a decl compare three different ways, and
// guessing from the characters is how `10` sorts before `9`.
//
// The selector is `.mth-profile__dois table` and deliberately not `table`. A
// landing page's arguments table sits inside the immutable region, and
// reordering its rows would be the client writing into the verified record —
// the one thing the landing page's whole immutability story denies. Scoping by
// the profile section's own class keeps this module off that page entirely,
// without naming the region in a selector (which `verified.test.ts` forbids in
// any client module, so that the rule cannot be satisfied by an exception).

import { FIELDS, type Shape } from "./fields";
import { byteOrder } from "./dag";
import { qsa } from "./dom";

const SHAPE_OF = new Map<string, Shape>(FIELDS.map((f) => [f.field, f.shape] as const));

/** The column the generator already sorted on, descending: the DOIs table is
 * emitted newest first. Marking it is what makes the initial `aria-sort` true
 * rather than decorative. */
const GENERATED_DESC_FIELD = "argument.created_at";

type Direction = "ascending" | "descending";

function cellText(row: HTMLTableRowElement, index: number): string {
  const cell = row.cells[index];
  if (!cell) return "";
  return (cell.textContent ?? "").trim();
}

function cellField(row: HTMLTableRowElement, index: number): string | null {
  const cell = row.cells[index];
  if (!cell) return null;
  const valued = cell.querySelector("[data-field]");
  return valued?.getAttribute("data-field") ?? null;
}

/** The comparator a shape implies. `timestamp` is RFC 3339 UTC at second
 * precision, so its lexicographic order IS its chronological order. */
function compareBy(shape: Shape | undefined): (a: string, b: string) => number {
  if (shape === "integer") {
    return (a, b) => (Number(a) || 0) - (Number(b) || 0);
  }
  return byteOrder;
}

/** A column with no value in any row sorts as text and is still sortable; a
 * column whose rows all carry the same field takes that field's shape. */
function shapeOfColumn(rows: HTMLTableRowElement[], index: number): Shape | undefined {
  for (const row of rows) {
    const field = cellField(row, index);
    if (field) return SHAPE_OF.get(field);
  }
  return undefined;
}

export function mountTableSort(root: ParentNode = document): void {
  for (const table of qsa<HTMLTableElement>(".mth-profile__dois table.mth-table", root)) {
    if (table.getAttribute("data-sort-bound") === "true") continue;
    table.setAttribute("data-sort-bound", "true");

    const head = table.tHead;
    const body = table.tBodies[0];
    if (!head || !body) continue;
    const headRow = head.rows[0];
    if (!headRow) continue;

    const rows = (): HTMLTableRowElement[] => Array.from(body.rows);
    if (rows().length === 0) continue;

    const state: { column: number; direction: Direction } = { column: -1, direction: "descending" };

    Array.from(headRow.cells).forEach((th, index) => {
      const shape = shapeOfColumn(rows(), index);
      // The button takes over the heading's existing nodes; no text is created.
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mth-th-sort";
      while (th.firstChild) button.append(th.firstChild);
      th.append(button);

      if (shape !== undefined && cellFieldOfColumn(rows(), index) === GENERATED_DESC_FIELD) {
        th.setAttribute("aria-sort", "descending");
        state.column = index;
        state.direction = "descending";
      }

      button.addEventListener("click", () => {
        const next: Direction =
          state.column === index
            ? state.direction === "ascending"
              ? "descending"
              : "ascending"
            : shape === "timestamp" || shape === "integer"
              ? "descending"
              : "ascending";
        state.column = index;
        state.direction = next;

        for (const other of Array.from(headRow.cells)) other.removeAttribute("aria-sort");
        th.setAttribute("aria-sort", next);

        const compare = compareBy(shape);
        const sign = next === "ascending" ? 1 : -1;
        const ordered = rows()
          .map((row, position) => ({ row, position }))
          .sort((x, y) => {
            const by = compare(cellText(x.row, index), cellText(y.row, index)) * sign;
            // A stable tie-break on the generated order, so the same click
            // always produces the same table.
            return by !== 0 ? by : x.position - y.position;
          });
        for (const { row } of ordered) body.append(row);
      });
    });
  }
}

function cellFieldOfColumn(rows: HTMLTableRowElement[], index: number): string | null {
  for (const row of rows) {
    const field = cellField(row, index);
    if (field) return field;
  }
  return null;
}
