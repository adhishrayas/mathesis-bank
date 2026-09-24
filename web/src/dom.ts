// The DOM and transport helpers every surface goes through.
//
// Two rules are enforced here rather than reviewed: a visible string enters the
// document only as a catalogue label, a data value or a reason message, and a
// data value always carries both `data-value` and `data-field`.
//
// The record is static: every file the client reads is a document of the
// generated tree, fetched under the path the record is served at.

import { LABELS, type LabelKey } from "./labels";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

/** A catalogue label. The key is the only way a label reaches the DOM. */
export function label(
  tag: keyof HTMLElementTagNameMap,
  key: LabelKey,
  attrs: Record<string, string> = {},
): HTMLElement {
  const node = el(tag as "span", attrs);
  node.textContent = LABELS[key];
  return node;
}

/** A data value, wrapped so the lint can classify it. */
export function value(
  tag: keyof HTMLElementTagNameMap,
  field: string,
  text: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const node = el(tag as "span", { ...attrs, "data-value": "true", "data-field": field });
  node.textContent = text;
  return node;
}

/** A reason message: an error message, and the one visible string outside the
 * catalogue. */
export function errorLine(message: string): HTMLElement {
  const p = el("p", { "data-role": "error", class: "mth-error" });
  p.textContent = message;
  return p;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function qs<T extends Element = Element>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

export function qsa<T extends Element = Element>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  etag: string | null;
}

/** The path the record is served under: the build's `--base`, a constant
 * compiled into the bundle, so no URL the client composes reads the DOM. */
export function basePath(): string {
  const b = import.meta.env.BASE_URL;
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

/** A root-relative record path, under the path the record is served at. */
export function withBase(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? `${basePath()}${path}` : path;
}

/**
 * A file of the generated static record: the stream pages, the collection
 * pages, `profiles.json` and `site.json`. These are plain documents under the
 * record root, not API calls — they carry no credential and no CSRF header.
 *
 * `dictionary.index.json` is deliberately NOT among them: it is a build input
 * in `$REPO/dictionary/`, is in no generated tree and is served by no route
 * (SPEC.md §10). The pin comes from `GET /api/v1/dictionary/current` and every
 * chip anchor is baked at generation time.
 */
export async function staticJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(withBase(path), { credentials: "same-origin" });
    if (!res.ok) return { ok: false, status: res.status, body: null, etag: null };
    return { ok: true, status: res.status, body: (await res.json()) as T, etag: null };
  } catch {
    return { ok: false, status: 0, body: null, etag: null };
  }
}
