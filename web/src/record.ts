// The behaviour the immutable record carries: the clipboard, the DAG layout
// toggle, the statement clamp and the keyboard layer.
//
// None of it writes into `section[data-region="verified"]`. `Copy` reads a baked
// attribute or an already-rendered value and writes to the clipboard; the layout
// toggle and the clamp set attributes on the DAG's and the statement's own
// wrappers, which are presentation state rather than record content; the
// keyboard layer moves focus and activates controls that already exist.
//
// Every one of these is an enhancement: with scripts disabled the List layout is
// server-rendered, every `<details>` toggles natively, and every statement is
// shown unclamped by the `@supports not selector(:has(*))` fallback.

import { LABELS, VALUES } from "./labels";
import { qs, qsa } from "./dom";

// ------------------------------------------------------------------ clipboard

function copySource(button: Element): string {
  const key = button.getAttribute("data-copy") ?? "";
  const card = button.closest("article, section, body") ?? document.body;
  if (key === "citation.text" || key === "citation.bibtex") {
    const cite = qs<HTMLElement>("[data-citation-text]", card);
    if (!cite) return "";
    return (
      (key === "citation.text"
        ? cite.getAttribute("data-citation-text")
        : cite.getAttribute("data-citation-bibtex")) ?? ""
    );
  }
  const source = qs<HTMLElement>(`[data-field="${key}"]`, card);
  return source?.textContent ?? "";
}

/** `Copied` is a state of the surface, so it is a VALUE and it carries a field
 * (`clipboard.state`, `source: "ui"`). It reverts after two seconds; a clipboard
 * the browser refuses leaves the value unset and shows no error string. */
export function mountClipboard(root: ParentNode = document): void {
  for (const button of qsa("[data-copy]", root)) {
    if (button.getAttribute("data-copy-bound") === "true") continue;
    button.setAttribute("data-copy-bound", "true");
    button.addEventListener("click", async () => {
      const text = copySource(button);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      const card = button.closest("article, section, body") ?? document.body;
      const flag = qs<HTMLElement>("[data-field='clipboard.state']", card);
      if (!flag) return;
      flag.setAttribute("aria-live", "polite");
      flag.textContent = VALUES.copied;
      flag.hidden = false;
      window.setTimeout(() => {
        flag.textContent = "";
        flag.hidden = true;
      }, 2000);
    });
  }
}

// ------------------------------------------------------------------- the DAG

/** `Graph` and `List` over one record. The `Graph` option is rendered
 * `disabled` by the generator when the DAG is oversized (`nodes > 400 ||
 * edges > 4000`) with its label unchanged (R46), so this never re-enables it,
 * and below `lg` `List` is forced by the stylesheet rather than by script. */
export function mountDag(root: ParentNode = document): void {
  for (const dag of qsa<HTMLElement>(".mth-dag", root)) {
    if (dag.getAttribute("data-dag-bound") === "true") continue;
    dag.setAttribute("data-dag-bound", "true");

    const buttons = qsa<HTMLButtonElement>("button[data-layout]", dag);
    const graph = qs(".mth-dag__graph", dag);
    // `List` below the large breakpoint, where a scrolled graph is unusable.
    const wide = window.matchMedia("(min-width: 1024px)").matches;
    const offered = graph !== null && !buttons.find((b) => b.dataset.layout === "graph")?.disabled;
    const initial = offered && wide ? "graph" : "list";
    const setLayout = (next: string): void => {
      dag.setAttribute("data-layout", next);
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.layout === next));
    };
    setLayout(initial);
    for (const button of buttons) {
      button.addEventListener("click", () => {
        if (button.disabled) return;
        setLayout(button.dataset.layout ?? "list");
      });
    }

    for (const button of qsa<HTMLButtonElement>("button[data-dag]", dag)) {
      button.addEventListener("click", () => {
        const open = button.dataset.dag === "expand-all";
        for (const d of qsa<HTMLDetailsElement>("details", dag)) d.open = open;
        for (const wrap of qsa<HTMLElement>(".mth-lean-clamp", dag)) {
          wrap.setAttribute("data-clamped", String(!open));
        }
        for (const pre of qsa<HTMLElement>("pre.mth-lean", dag)) {
          pre.setAttribute("data-expanded", String(open));
        }
      });
    }
  }
}

// ------------------------------------------------------------- the ⋯ menu

/** A post's ⋯ menu is a `<details>`, so it opens without this. Here, opening
 * one closes the others, and a click outside it or Escape closes it. */
export function mountMenus(root: Document = document): void {
  const menus = (): HTMLDetailsElement[] => qsa<HTMLDetailsElement>("details.mth-more", root);
  root.addEventListener("click", (ev) => {
    const target = ev.target instanceof Node ? ev.target : null;
    for (const menu of menus()) {
      if (menu.open && !(target && menu.contains(target))) menu.open = false;
    }
  });
  root.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    for (const menu of menus()) {
      if (!menu.open) continue;
      menu.open = false;
      qs<HTMLElement>("summary", menu)?.focus();
    }
  });
}

// ---------------------------------------------------------------- the clamp

/** The per-row `Expand`/`Collapse` of a clamped statement. The label swaps
 * between two catalogue entries and nothing else changes; the clamp itself is
 * CSS, so the text of the value is never altered (G10). */
export function mountExpanders(root: ParentNode = document): void {
  for (const button of qsa("[data-expand='row']", root)) {
    if (button.getAttribute("data-expand-bound") === "true") continue;
    button.setAttribute("data-expand-bound", "true");
    button.addEventListener("click", () => {
      const cell = button.closest("td") ?? button.parentElement;
      if (!cell) return;
      const wrap = qs<HTMLElement>(".mth-lean-clamp", cell);
      const pre = qs<HTMLElement>("pre.mth-lean", cell);
      const clamped = wrap
        ? wrap.getAttribute("data-clamped") !== "false"
        : pre?.getAttribute("data-expanded") !== "true";
      if (wrap) wrap.setAttribute("data-clamped", String(!clamped));
      if (pre) pre.setAttribute("data-expanded", String(clamped));
      button.textContent = clamped ? LABELS.collapse : LABELS.expand;
    });
  }
}

// --------------------------------------------------------------- the keyboard

const GOTO: Record<string, string> = {
  p: "/posts",
  c: "/collection/claims",
  u: "/profile",
  a: "/about",
};

function focusables(root: ParentNode): HTMLElement[] {
  return qsa<HTMLElement>(
    "article.mth-post, tbody[data-rows] tr, .mth-profile__dois tbody tr, .mth-dag__node",
    root,
  );
}

function isTyping(target: EventTarget | null): boolean {
  const e = target as HTMLElement | null;
  if (!e) return false;
  const tag = e.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable;
}

/**
 * The keyboard layer (DESIGN.md §13). It is a capability, not a feature with
 * copy: there is no shortcuts overlay, no help affordance and no `?` key,
 * because every string such a surface would need is outside the catalogue.
 */
export function mountKeyboard(root: ParentNode = document): void {
  let pendingG = false;
  let index = -1;

  const move = (delta: number): void => {
    const items = focusables(root);
    if (items.length === 0) return;
    index = Math.min(Math.max(index + delta, 0), items.length - 1);
    const item = items[index];
    if (!item) return;
    for (const other of items) other.removeAttribute("data-focused");
    item.setAttribute("data-focused", "true");
    item.setAttribute("tabindex", "-1");
    item.focus({ preventScroll: false });
  };

  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (isTyping(ev.target)) {
      if (ev.key === "Escape") (ev.target as HTMLElement).blur();
      return;
    }

    if (pendingG) {
      pendingG = false;
      const to = GOTO[ev.key];
      if (to) {
        ev.preventDefault();
        window.location.assign(to);
      }
      return;
    }
    switch (ev.key) {
      case "g":
        pendingG = true;
        return;
      case "/": {
        const search = qs<HTMLInputElement>("input[name='q']", root);
        if (search) {
          ev.preventDefault();
          search.focus();
        }
        return;
      }
      case "j":
        ev.preventDefault();
        move(1);
        return;
      case "k":
        ev.preventDefault();
        move(-1);
        return;
      case "e": {
        const open = qs<HTMLDetailsElement>("[data-focused] details", root);
        if (open) {
          ev.preventDefault();
          open.open = !open.open;
        }
        return;
      }
      case "E":
      case "C": {
        const card = qs<HTMLElement>("[data-focused]", root)?.closest("article, section") ?? root;
        const button = qs<HTMLButtonElement>(
          `button[data-dag="${ev.key === "E" ? "expand-all" : "collapse-all"}"]`,
          card as ParentNode,
        );
        if (button) {
          ev.preventDefault();
          button.click();
        }
        return;
      }
      case "c": {
        const card = qs<HTMLElement>("[data-focused]", root) ?? qs<HTMLElement>("article.mth-post", root);
        const button = card ? qs<HTMLButtonElement>("button[data-copy='claim.pretty']", card) : null;
        if (button) {
          ev.preventDefault();
          button.click();
        }
        return;
      }
      case "Enter": {
        const card = qs<HTMLElement>("[data-focused]", root);
        const link = card ? qs<HTMLAnchorElement>("a[href^='/a/']", card) : null;
        if (link) {
          ev.preventDefault();
          window.location.assign(link.getAttribute("href") ?? "/posts");
        }
        return;
      }
      case "Escape": {
        for (const item of focusables(root)) item.removeAttribute("data-focused");
        index = -1;
        return;
      }
      default:
        return;
    }
  });
}
