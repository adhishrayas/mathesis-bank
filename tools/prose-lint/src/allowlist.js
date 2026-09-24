// `shared/html-allowlist.v1.json`: one element/attribute table and two profiles
// over it (SPEC.md §9). `note` is the runtime profile the Go sanitizer reads;
// `about` is the build-time profile this linter reads. The two differ in
// exactly `h2`, and `html_allowlist_agreement` is the assertion that they do.

import { readFileSync } from "node:fs";

export function loadAllowlist(path) {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  const profiles = {};
  for (const [name, p] of Object.entries(json.profiles ?? {})) {
    profiles[name] = resolveProfile(json, p, name);
  }
  return { path, raw, json, profiles };
}

function resolveProfile(json, profile, name) {
  const elements = new Set(json.base.elements);
  for (const e of profile.adds ?? []) elements.add(e);
  for (const e of profile.removes ?? []) elements.delete(e);

  const attributes = {};
  for (const [tag, attrs] of Object.entries(json.base.attributes ?? {})) attributes[tag] = [...attrs];
  for (const [tag, attrs] of Object.entries(profile.attributes_add ?? {})) {
    attributes[tag] = [...new Set([...(attributes[tag] ?? []), ...attrs])];
  }
  for (const [tag, attrs] of Object.entries(profile.attributes_remove ?? {})) {
    attributes[tag] = (attributes[tag] ?? []).filter((a) => !attrs.includes(a));
  }
  return {
    name,
    consumer: profile.consumer,
    elements: [...elements].sort(),
    attributes: Object.fromEntries(Object.entries(attributes).map(([t, a]) => [t, [...a].sort()])),
    url_schemes: [...(json.base.url_schemes ?? [])].sort(),
    forced_rel: json.base.forced_rel ?? "",
  };
}

/** The effective sets, in the form both consumers print for the agreement test. */
export function effectiveSets(allowlist) {
  const out = {};
  for (const [name, p] of Object.entries(allowlist.profiles)) {
    out[name] = {
      elements: p.elements,
      attributes: p.attributes,
      url_schemes: p.url_schemes,
      forced_rel: p.forced_rel,
    };
  }
  return out;
}

/**
 * `html_allowlist_agreement`, Node half: `about` is `note` plus `h2` and
 * nothing else, the attribute tables are identical, and the two profiles name
 * the two consumers the spec names. The Go half prints the same JSON and the
 * two are compared byte for byte by the cross-language test.
 */
export function checkAgreement(allowlist) {
  const out = [];
  const fail = (value) =>
    out.push({
      file: allowlist.path,
      selector: "profiles",
      kind: "about_shell",
      value,
      offset: allowlist.raw.indexOf("\"profiles\"") === -1 ? 0 : allowlist.raw.indexOf("\"profiles\""),
    });

  const note = allowlist.profiles.note;
  const about = allowlist.profiles.about;
  if (!note) return fail("no `note` profile"), out;
  if (!about) return fail("no `about` profile"), out;

  const added = about.elements.filter((e) => !note.elements.includes(e));
  const removed = note.elements.filter((e) => !about.elements.includes(e));
  if (added.length !== 1 || added[0] !== "h2" || removed.length !== 0) {
    fail(`about − note = [${added.join(",")}], note − about = [${removed.join(",")}]`);
  }
  if (JSON.stringify(note.attributes) !== JSON.stringify(about.attributes)) {
    fail("the two profiles disagree on the attribute table");
  }
  if (JSON.stringify(note.url_schemes) !== JSON.stringify(about.url_schemes)) {
    fail("the two profiles disagree on the URL schemes");
  }
  if (note.consumer !== "gateway" || about.consumer !== "prose-lint") {
    fail(`consumers are ${note.consumer} and ${about.consumer}`);
  }
  return out;
}

/**
 * The element/attribute check over one authored region: `#about-body` under the
 * `about` profile, a note body under `note`. A disallowed element is reported
 * as `unknown_role` (an element whose role in an authored region is not
 * declared) and a disallowed attribute as `attribute`.
 */
export function checkRegion(profile, node, ctx) {
  const out = [];
  const walk = (n) => {
    if (n.tagName) {
      const tag = n.tagName;
      if (!profile.elements.includes(tag)) {
        out.push({
          file: ctx.file,
          selector: ctx.selector(n),
          kind: "unknown_role",
          value: `<${tag}> outside the ${profile.name} allowlist`,
          offset: ctx.offset(n),
        });
      } else {
        const allowed = profile.attributes[tag] ?? [];
        for (const a of n.attrs ?? []) {
          if (allowed.includes(a.name)) {
            if (a.name === "href" && !schemeAllowed(profile, a.value)) {
              out.push({
                file: ctx.file,
                selector: ctx.selector(n),
                kind: "attribute",
                value: `href="${a.value}"`,
                offset: ctx.offset(n),
              });
            }
            continue;
          }
          if (a.name === "rel" && tag === "a") continue; // the sanitizer forces it
          out.push({
            file: ctx.file,
            selector: ctx.selector(n),
            kind: "attribute",
            value: `${a.name} on <${tag}> outside the ${profile.name} allowlist`,
            offset: ctx.offset(n),
          });
        }
      }
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  for (const c of node.childNodes ?? []) walk(c);
  return out;
}

function schemeAllowed(profile, href) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href.trim());
  if (!m) return true; // relative
  return profile.url_schemes.includes(m[1].toLowerCase());
}
