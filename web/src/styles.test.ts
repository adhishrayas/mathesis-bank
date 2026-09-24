// The stylesheet is the renderer contract (DESIGN.md §1 rule 3), so it is
// checked like one.
//
// Two failures had already happened here and neither showed up in a build, a
// typecheck or a browser console, because CSS fails silently:
//
//   1. a class a renderer emits with no rule behind it. `.mth-status--ok`,
//      `.mth-panel`, `.mth-degraded`, `.mth-pre-log` and thirty others were
//      emitted by the client and by the Rust generator alike and defined
//      nowhere, so the whole status ramp, the verdict panels, the degraded
//      surface and the log panes rendered as unstyled text;
//   2. a `var()` naming a token the theme never defines. Every `--spacing-N`
//      in the component layer was undefined, which makes each declaration
//      INVALID — the browser drops it, and the layout silently loses every
//      padding and gap it was written with.
//
// The second check reads the BUILT stylesheet, not the source, because the
// question is what the `webd` image ships: Tailwind emits only the theme
// variables it can account for, so a token can be authored and still not exist
// at runtime. `css_covers_templates` (SPEC.md §13) holds that artifact to the
// template set; this holds it to the class and token sets.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clientSources, REPO_DIR, WEB_DIR } from "./sources";

const BUILT = join(WEB_DIR, "dist-assets", "assets", "record.css");
const COMPONENTS = join(WEB_DIR, "src", "styles", "components.css");
const THEME = join(WEB_DIR, "tailwind.css");
const GENERATOR = join(REPO_DIR, "services", "registry", "crates", "record", "src");

const CLASS = /\bmth-[a-z0-9]+(?:[-_][a-z0-9]+)*/g;

/** The class names the two renderers emit. The Rust generator is read as well
 * as the client: one stylesheet serves both, and a component defined for only
 * one of them is exactly the drift the shared layer exists to prevent. */
function emitted(): Set<string> {
  const out = new Set<string>();
  const take = (text: string): void => {
    for (const m of text.matchAll(CLASS)) out.add(m[0]);
  };
  for (const s of clientSources()) take(s.text);
  if (existsSync(GENERATOR)) {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".rs") || p.endsWith(".html")) take(readFileSync(p, "utf8"));
      }
    };
    walk(GENERATOR);
  }
  return out;
}

describe("the component layer covers what the renderers emit", () => {
  it("has a rule for every class either renderer writes", () => {
    const css = readFileSync(COMPONENTS, "utf8");
    const rules = new Set([...css.matchAll(/\.(mth-[a-z0-9]+(?:[-_][a-z0-9]+)*)/g)].map((m) => m[1] as string));
    const missing = [...emitted()].filter((c) => !rules.has(c)).sort();
    expect(missing).toEqual([]);
  });

  it("ships every one of them in the built stylesheet", () => {
    if (!existsSync(BUILT)) return;
    const built = readFileSync(BUILT, "utf8");
    const missing = [...emitted()].filter((c) => !built.includes(`.${c}`)).sort();
    expect(missing).toEqual([]);
  });
});

describe("every token a rule reads is a token the theme ships", () => {
  it("leaves no var() unresolved in the built stylesheet", () => {
    if (!existsSync(BUILT)) return;
    const built = readFileSync(BUILT, "utf8");
    const defined = new Set([...built.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
    // A `var(--x, fallback)` is lawful with no `--x`; a bare `var(--x)` is not,
    // and that is the whole of the rule.
    const source = readFileSync(COMPONENTS, "utf8") + readFileSync(THEME, "utf8");
    const wanted = new Set([...source.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map((m) => m[1] as string));
    const unresolved = [...wanted].filter((v) => !defined.has(v)).sort();
    expect(unresolved).toEqual([]);
  });
});

// The dark theme overrides the semantic ALIASES and not the ink ramp, which is
// the whole reason the aliases exist. A component that reaches past one of them
// for a raw ramp entry keeps its light value on a dark ground, and the base
// heading rule did exactly that: every `<h1>`/`<h2>`/`<h3>` rendered `ink-800`
// on `#0D0F13`. It looks fine in a light screenshot and is unreadable in a dark
// one, so it is checked rather than looked at.
describe("the dark theme covers every alias", () => {
  it("redefines each aliased colour in both dark blocks", () => {
    const theme = readFileSync(THEME, "utf8");
    const block = theme.slice(theme.indexOf("@theme static"), theme.indexOf("@theme inline"));
    // An alias is a theme colour whose value is a reference to another token.
    const aliases = [...block.matchAll(/(--color-[a-z0-9-]+):\s*var\(--color-[a-z0-9-]+\)/g)].map(
      (m) => m[1] as string,
    );
    expect(aliases.length).toBeGreaterThan(8);

    const media = theme.slice(theme.indexOf("@media (prefers-color-scheme: dark)"), theme.indexOf(':root[data-theme="dark"]'));
    const attr = theme.slice(theme.indexOf(':root[data-theme="dark"]'));
    for (const name of aliases) {
      expect(media.includes(`${name}:`), `${name} has no prefers-color-scheme override`).toBe(true);
      expect(attr.includes(`${name}:`), `${name} has no [data-theme=dark] override`).toBe(true);
    }
  });
});
