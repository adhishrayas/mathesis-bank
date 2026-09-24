// The document linter (SPEC.md §13 Rule 1).
//
// Every string a viewer can see is one of exactly four things: a catalogue
// label, a data value carried by `[data-value="true"]`, a reason message inside
// `[data-role="error"]`, or author-written text inside one of the two carved-out
// regions. Nothing else renders, and this file is where that is decided.
//
// Three holes the earlier design left open are closed here:
//   1. There is no blanket `pre`/`code` exemption. Only `<pre>` carrying one of
//      the three declared roles is skipped, together with `<code>` inside a
//      carved-out author region. A `pre` with an unknown or absent role is
//      itself `unknown_role`, and an ordinary `<code>` is linted like any other
//      element.
//   2. On the generated tree the value check reads the sibling `values.json`
//      that every generated page has — positionally, by field, byte for byte.
//   3. The attribute rule has a closed scope: placeholder, title, aria-label,
//      aria-description, alt. Every structural attribute (href, class, id,
//      data-*) is out of scope by name.

import { parse, parseFragment, serialize } from "parse5";
import { EXEMPT_SHAPES, PROSE_WORDS, shapeViolation } from "./catalogue.js";
import { checkRegion } from "./allowlist.js";
import { scanBanned, scanFirewall } from "./scan.js";

/** The three declared `pre` roles. Anything else on a `pre` is a violation. */
export const PRE_ROLES = new Set(["lean-statement", "log", "report"]);

/** The whole of the attribute rule's scope. */
export const READER_ATTRS = ["placeholder", "title", "aria-label", "aria-description", "alt"];

/**
 * The three attributes a value may be carried in (DESIGN.md §6, "exactly three
 * elements carry a value inside an attribute"): the avatar's `alt`, and the two
 * citation attributes. A `data-attr-value` naming anything else is an attribute
 * nothing declared, which is how a string would otherwise leave the catalogue.
 */
export const ATTR_VALUE_ATTRS = new Set(["alt", "data-citation-text", "data-citation-bibtex"]);

/** Elements whose text content is never a visible string. */
const NON_VISIBLE = new Set(["script", "style", "template"]);

const isElement = (n) => typeof n.tagName === "string";
const isText = (n) => n.nodeName === "#text";
const isComment = (n) => n.nodeName === "#comment";

export function attr(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function textOf(node) {
  let out = "";
  const walk = (n) => {
    if (isText(n)) out += n.value;
    for (const c of n.childNodes ?? []) walk(c);
  };
  for (const c of node.childNodes ?? []) walk(c);
  return out;
}

function startOffset(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return 0;
  return loc.startOffset ?? 0;
}

function attrOffset(node, name) {
  const loc = node.sourceCodeLocation;
  const a = loc?.attrs?.[name];
  return a ? a.startOffset : startOffset(node);
}

/** A CSS-ish path, enough to find the element in the file. */
export function selectorOf(node) {
  const parts = [];
  let cur = node;
  while (cur && isElement(cur)) {
    let seg = cur.tagName;
    const id = attr(cur, "id");
    const cls = attr(cur, "class");
    const field = attr(cur, "data-field");
    if (id) seg += `#${id}`;
    else if (field) seg += `[data-field="${field}"]`;
    else if (cls) seg += `.${cls.split(/\s+/)[0]}`;
    const parent = cur.parentNode;
    if (parent && !id) {
      const same = (parent.childNodes ?? []).filter((n) => isElement(n) && n.tagName === cur.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
    if (id) break;
    cur = parent;
  }
  return parts.join(" > ");
}

/** Reason templates, compiled so a rendered message can be recognised. */
export function reasonMatchers(reasons) {
  return reasons.reasons.map((r) => {
    const parts = r.message_template.split(/\{\w+\}/g).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return { code: r.code, re: new RegExp(`^${parts.join("[\\s\\S]+?")}$`) };
  });
}

/**
 * Lint one document.
 *
 * @param {object} o
 * @param {string} o.file      path, for the report
 * @param {string} o.html      the document's bytes
 * @param {Array|null} o.values the sibling `values.json`, tree mode only
 * @param {"tree"|"dom"} o.mode
 * @param {object} o.ctx       {catalogue, fields, allowlist, terms, matchers, aboutBody}
 */
export function lintDocument({ file, html, values, mode, ctx }) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const out = [];
  const rendered = new Set();
  const seen = [];
  const push = (node, kind, value, offset) =>
    out.push({
      file,
      selector: node ? selectorOf(node) : "",
      kind,
      value,
      offset: offset ?? (node ? startOffset(node) : 0),
    });

  const { catalogue, fields, allowlist, terms, matchers } = ctx;

  const isLabelText = (t) => catalogue.labelText.has(t);
  const isValueText = (t) => catalogue.values.has(t);

  // A presentational duplicate (`[aria-hidden="true"]`, the DAG's SVG layer)
  // may restate a string the document already carries as a value or a label,
  // and may say nothing else. Statements and citations are excluded from the
  // set, so a sentence cannot enter by being a substring of one.
  const restatable = [];
  {
    const walk = (n) => {
      if (isElement(n) && attr(n, "data-value") === "true") {
        const f = attr(n, "data-field");
        const def = f ? fields.byField.get(f) : undefined;
        if (def && !EXEMPT_SHAPES.has(def.shape)) restatable.push(textOf(n).trim());
      }
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(doc);
  }
  const isRestatement = (t) => {
    const core = t.replace(/…+$/, "").trim();
    if (!core) return true;
    if (isLabelText(core) || isValueText(core)) return true;
    return restatable.some((v) => v.includes(core));
  };

  const regionCtx = {
    file,
    selector: (n) => selectorOf(n),
    offset: (n) => startOffset(n),
  };

  // ---- the walk ---------------------------------------------------------
  const visit = (node, st) => {
    if (isComment(node)) {
      for (const hit of scanBanned(node.data ?? "")) {
        push(node.parentNode, "banned_token", hit.value, startOffset(node) + hit.offset);
      }
      return;
    }
    if (!isElement(node)) return;

    const tag = node.tagName;
    const role = attr(node, "data-role");
    const field = attr(node, "data-field");
    const isValue = attr(node, "data-value") === "true";
    const entersAuthor = attr(node, "data-region") === "author" || attr(node, "id") === "about-body";
    const inAuthor = st.inAuthor || entersAuthor;

    // An authored region is checked against its allowlist profile, once, at the
    // element that carries it.
    if (attr(node, "id") === "about-body") {
      out.push(...checkRegion(allowlist.profiles.about, node, regionCtx));
    } else if (attr(node, "data-note-body") === "true") {
      out.push(...checkRegion(allowlist.profiles.note, node, regionCtx));
    }

    checkAttributes(node);

    if (tag === "pre" && !PRE_ROLES.has(role ?? "")) {
      push(node, "unknown_role", `<pre data-role="${role ?? ""}">`);
    }

    // SPEC §8.3/§13 (R45): the `lean-statement` role and the `lean-statement`
    // shape are bound to each other in both directions. The role is what makes
    // the element's text skip the catalogue rule, and the shape is what makes
    // it skip the four-word and vocabulary rules; either one alone is a region
    // of unchecked text.
    if (tag === "pre" && role === "lean-statement") {
      const f = fields.byField.get(field ?? "");
      if (!isValue || !f || f.shape !== "lean-statement") {
        push(node, "unknown_role", '<pre data-role="lean-statement"> is not a lean-statement value');
      }
    }

    const exemptPre = tag === "pre" && PRE_ROLES.has(role ?? "");
    const exemptCode = tag === "code" && inAuthor;

    if (isValue) checkValue(node, field, st);

    if (!NON_VISIBLE.has(tag) && !st.inValue && !isValue) {
      for (const child of node.childNodes ?? []) {
        if (!isText(child)) continue;
        const text = child.value.trim();
        if (!text) continue;
        if (exemptPre || exemptCode || st.inExemptPre) continue;
        if (isLabelText(text)) {
          rendered.add(text);
          continue;
        }
        if (inAuthor) continue; // carved out of the catalogue rule and of nothing else
        if (isValueText(text)) continue;
        if (st.inAriaHidden && isRestatement(text)) continue;
        if (role === "error") {
          if (!matchers.some((m) => m.re.test(text))) {
            push(node, "unknown_string", text.slice(0, 120), startOffset(child));
          }
          continue;
        }
        push(node, "unknown_string", text.slice(0, 120), startOffset(child));
      }
    }

    const next = {
      inAuthor,
      inAriaHidden: st.inAriaHidden || attr(node, "aria-hidden") === "true",
      inValue: st.inValue || isValue,
      inExemptPre: st.inExemptPre || exemptPre,
    };
    for (const child of node.childNodes ?? []) visit(child, next);
  };

  // ---- attributes, over a closed set ------------------------------------
  function checkAttributes(node) {
    const declared = attr(node, "data-attr-value");
    const field = attr(node, "data-field");

    if (declared !== undefined) {
      // The declaration may sit on the control that copies the value as well as
      // on the element that carries it (the citation region declares the text,
      // its BibTeX button declares the region's second attribute), so the
      // attribute is looked for on this element and then on its ancestors.
      const carried = carriedAttr(node, declared);
      if (!ATTR_VALUE_ATTRS.has(declared)) {
        push(node, "attribute", `data-attr-value="${declared}" is not one of ${[...ATTR_VALUE_ATTRS].join(", ")}`);
      }
      if (!carried) {
        push(node, "attribute", `data-attr-value="${declared}" names an attribute no ancestor carries`);
      }
      if (field === undefined) {
        push(node, "missing_data_field", `data-attr-value="${declared}"`);
      } else if (!fields.byField.has(field)) {
        push(node, "unknown_field", field, attrOffset(node, "data-field"));
      } else if (carried) {
        // An attribute-carried value has no entry in `values.json`, so its
        // shape is checked in both modes rather than in snapshots alone.
        const def = fields.byField.get(field);
        checkValueText(node, def, carried.value, startOffset(node), true);
      }
    }

    for (const a of node.attrs ?? []) {
      if (a.name === "placeholder") {
        push(node, "placeholder_present", a.value, attrOffset(node, a.name));
        continue;
      }
      if (!READER_ATTRS.includes(a.name)) continue;
      if (declared === a.name) continue; // classified as a value above
      if (a.value === "") continue; // an empty alt carries no string
      if (isLabelText(a.value) || isValueText(a.value)) continue;
      push(node, "attribute", `${a.name}="${a.value}"`, attrOffset(node, a.name));
    }
  }

  // ---- `[data-value="true"]` --------------------------------------------
  function checkValue(node, field, st) {
    const raw = textOf(node);
    const text = raw.trim();
    if (field === undefined) {
      push(node, "missing_data_field", text.slice(0, 120));
      seen.push({ field: null, value: raw, node });
      return;
    }
    if (!fields.byField.has(field)) {
      push(node, "unknown_field", field, attrOffset(node, "data-field"));
      seen.push({ field, value: raw, node });
      return;
    }
    const def = fields.byField.get(field);

    // The laundering guard: a label wearing a value's clothes.
    for (const d of findAll(node, isElement)) {
      if (d === node) continue;
      const dt = textOf(d).trim();
      if (dt && isLabelText(dt)) {
        push(node, "value_laundering", `${field} wraps the catalogue entry ${dt}`);
      }
    }
    if (isLabelText(text) && !isValueText(text)) {
      push(node, "value_laundering", `${field} renders the catalogue entry ${text}`);
    }

    if (def.shape === "lean-statement" && attr(node, "data-role") !== "lean-statement") {
      push(node, "unknown_role", `${field} is a lean-statement value without data-role="lean-statement"`);
    }

    if (!st.inAuthor) checkValueText(node, def, raw, startOffset(node), mode === "dom");
    seen.push({ field, value: raw, node });
  }

  /** The prose rules and the shape rule, over one value's text. */
  function checkValueText(node, def, raw, offset, shapeCheck) {
    const text = raw.trim();
    if (!EXEMPT_SHAPES.has(def.shape)) {
      if (text.split(/\s+/).filter(Boolean).length > 4) {
        push(node, "value_is_prose", `${def.field}: ${text.slice(0, 120)}`, offset);
      } else if (PROSE_WORDS.test(text)) {
        push(node, "value_is_prose", `${def.field}: ${text.slice(0, 120)}`, offset);
      }
      if (shapeCheck) {
        const bad = shapeViolation(def.shape, text);
        if (bad) push(node, "value_mismatch", `${def.field}: ${text}`, offset);
      }
    }
  }

  /** Coverage bookkeeping is not suppressed by a carve-out or by a role. */
  function collectRendered(node) {
    const walk = (n) => {
      if (isText(n)) {
        const t = n.value.trim();
        if (t && isLabelText(t)) rendered.add(t);
      }
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(node);
  }

  visit(documentElement(doc) ?? doc, {
    inAuthor: false,
    inValue: false,
    inExemptPre: false,
    inAriaHidden: false,
  });
  collectRendered(doc);

  // ---- the scans, over the document's own bytes -------------------------
  for (const hit of scanFirewall(html, terms)) {
    out.push({ file, selector: "", kind: "firewall", value: hit.value, offset: hit.offset });
  }
  for (const hit of visibleBanned(doc)) {
    out.push({ file, selector: hit.selector, kind: "banned_token", value: hit.value, offset: hit.offset });
  }

  // ---- the generated tree's value manifest ------------------------------
  if (mode === "tree" && values) {
    if (seen.length !== values.length) {
      out.push({
        file,
        selector: "",
        kind: "value_mismatch",
        value: `${seen.length} value elements, ${values.length} entries in values.json`,
        offset: 0,
      });
    } else {
      for (let i = 0; i < seen.length; i += 1) {
        if (seen[i].field !== values[i].field) {
          push(seen[i].node, "value_mismatch", `#${i} is ${seen[i].field}, values.json says ${values[i].field}`);
        } else if (seen[i].value !== values[i].value) {
          push(
            seen[i].node,
            "value_mismatch",
            `${seen[i].field}: ${JSON.stringify(seen[i].value.slice(0, 60))} ≠ ${JSON.stringify(
              String(values[i].value).slice(0, 60),
            )}`,
          );
        }
      }
    }
  }

  // ---- the About shell --------------------------------------------------
  if (looksLikeAbout(doc, file)) out.push(...aboutShell(doc, file, ctx));

  return { violations: out, rendered, valueCount: seen.length };

  function visibleBanned(root) {
    const hits = [];
    const walk = (n, hidden) => {
      const hide = hidden || (isElement(n) && NON_VISIBLE.has(n.tagName));
      if (isText(n) && !hide) {
        for (const h of scanBanned(n.value)) {
          hits.push({
            selector: n.parentNode ? selectorOf(n.parentNode) : "",
            value: h.value,
            offset: startOffset(n) + h.offset,
          });
        }
      }
      if (isElement(n)) {
        for (const a of n.attrs ?? []) {
          if (!READER_ATTRS.includes(a.name)) continue;
          for (const h of scanBanned(a.value)) {
            hits.push({ selector: selectorOf(n), value: h.value, offset: attrOffset(n, a.name) + h.offset });
          }
        }
      }
      for (const c of n.childNodes ?? []) walk(c, hide);
    };
    walk(root, false);
    return hits;
  }
}

function carriedAttr(node, name) {
  for (let cur = node; cur && isElement(cur); cur = cur.parentNode) {
    const a = cur.attrs?.find((x) => x.name === name);
    if (a) return a;
  }
  return null;
}

function documentElement(doc) {
  return (doc.childNodes ?? []).find((n) => n.tagName === "html") ?? null;
}

function findAll(root, pred) {
  const out = [];
  const walk = (n) => {
    if (isElement(n) && pred(n)) out.push(n);
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(root);
  return out;
}

function looksLikeAbout(doc, file) {
  if (/(^|\/)about(\/index)?\.html$/.test(file)) return true;
  return findAll(doc, (n) => attr(n, "id") === "about-body" || attr(n, "id") === "dictionary-slot").length > 0;
}

/**
 * §8.4: the page's one `<main>` holds exactly three element children — the
 * `About` heading, the dictionary slot, and the author body whose children are
 * exactly the parse of `about/body.html`. The rule is written against that one
 * `<main>`, so the unconditional nav satisfies it; the body region is a `<div>`,
 * never a nested `<main>`.
 */
function aboutShell(doc, file, ctx) {
  const out = [];
  const fail = (node, value) =>
    out.push({
      file,
      selector: node ? selectorOf(node) : "",
      kind: "about_shell",
      value,
      offset: node ? startOffset(node) : 0,
    });

  const mains = findAll(doc, (n) => n.tagName === "main");
  if (mains.length !== 1) {
    fail(null, `${mains.length} <main> elements`);
    return out;
  }
  const main = mains[0];
  const children = (main.childNodes ?? []).filter(isElement);
  if (children.length !== 3) {
    fail(main, `<main> has ${children.length} element children`);
    return out;
  }
  const [h1, slot, body] = children;

  const aboutLabel = Object.fromEntries(ctx.catalogue.labels).about;
  if (h1.tagName !== "h1" || textOf(h1).trim() !== aboutLabel) {
    fail(h1, `the first child is not <h1>${aboutLabel}</h1>`);
  }

  if (attr(slot, "id") !== "dictionary-slot") {
    fail(slot, "the second child is not #dictionary-slot");
  } else {
    const dictLabel = Object.fromEntries(ctx.catalogue.labels).dictionary;
    const link = findAll(slot, (n) => attr(n, "id") === "dictionary-link");
    if (link.length !== 1) fail(slot, `${link.length} #dictionary-link elements`);
    else if (textOf(link[0]).trim() !== dictLabel) fail(link[0], `#dictionary-link is not ${dictLabel}`);
    const pin = findAll(slot, (n) => attr(n, "data-field") === "dictionary.label");
    if (pin.length !== 1) fail(slot, `${pin.length} dictionary.label values in the slot`);
  }

  if (attr(body, "id") !== "about-body") {
    fail(body, "the third child is not #about-body");
  } else {
    const expected = serialize(parseFragment(ctx.aboutBody ?? ""));
    const got = serialize(body);
    if (normalise(expected) !== normalise(got)) {
      fail(body, "#about-body is not the parse of about/body.html");
    }
  }
  return out;
}

const normalise = (s) => s.replace(/\s+/g, " ").trim();
