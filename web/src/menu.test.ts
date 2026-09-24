// The ⋯ menu: a `<details>` that opens without scripts; the mount only closes
// it — on a click outside it, on Escape, and when another one opens.

import { beforeEach, describe, expect, it } from "vitest";
import { mountMenus } from "./record";

function menu(id: string): string {
  return `<details class="mth-more" id="${id}"><summary class="mth-more__button"></summary>
    <div class="mth-more__menu"><a class="mth-more__item" href="/a/MTH.C-2026-0001">x</a></div></details>`;
}

describe("the ⋯ menu", () => {
  beforeEach(() => {
    document.body.innerHTML = `${menu("a")}${menu("b")}<p id="outside"></p>`;
  });

  const el = (id: string): HTMLDetailsElement => document.getElementById(id) as HTMLDetailsElement;

  it("closes on a click outside it and stays open on a click inside it", () => {
    mountMenus(document);
    el("a").open = true;
    el("a").querySelector(".mth-more__menu")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el("a").open).toBe(true);
    document.getElementById("outside")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el("a").open).toBe(false);
  });

  it("closes the open one when another is clicked", () => {
    mountMenus(document);
    el("a").open = true;
    el("b").querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el("a").open).toBe(false);
  });

  it("closes on Escape and returns focus to its button", () => {
    mountMenus(document);
    el("b").open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(el("b").open).toBe(false);
    expect(document.activeElement).toBe(el("b").querySelector("summary"));
  });
});
