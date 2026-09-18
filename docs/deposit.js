// Mathesis deposit form → GitHub pull request.
//
// The bank is a static site with no backend. To "raise a PR" without a server or
// a stored token, the form assembles ONE self-contained deposit file and opens
// GitHub's create-new-file flow with the content pre-filled. On GitHub the user
// clicks "Propose new file"; GitHub forks the repo (if they lack write access)
// and opens the pull request. The gate runs on that PR.
(function () {
  "use strict";
  var form = document.getElementById("depositForm");
  if (!form) return;

  var REPO = "noumenal-ai/mathesis-bank";
  var PIN = "leanprover/lean4:v4.31.0";

  function $(id) { return document.getElementById(id); }

  function slugify(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "deposit";
  }

  function collect() {
    return {
      kind: $("d-kind").value,
      title: $("d-title").value.trim(),
      module: ($("d-module").value.trim() || "Submission"),
      decls: $("d-decls").value.trim(),
      // Without this a form deposit that imports Mathlib resolves to a Lean-core environment,
      // where Mathlib is not on LEAN_PATH, and the build fails with "unknown module prefix
      // 'Mathlib'". Hoisting imports without offering the pin would just move the trap.
      mathlib: $("d-mathlib").value.trim(),
      discharges: $("d-discharges").value.trim(),
      source: $("d-source").value.replace(/\s+$/, ""),
      gloss: $("d-gloss").value.trim()
    };
  }

  function pathFor(v) { return "deposits/" + slugify(v.title) + "/submission.lean"; }

  // The single-file deposit format: a Mathesis metadata header (parsed by the gate)
  // followed by the Lean source. Keeps the whole deposit in one file so the
  // create-new-file URL can carry it and one click opens one PR.
  // Mirrors ci/parse_deposit.py:split_leading_imports — that parser is the authority, and a
  // shape it rejects is a deposit this form should never have produced.
  //
  // `/-!` is a Lean module docstring, which is declaration-level syntax, and Lean requires every
  // import to precede all declarations. So "header first, then source" cannot import anything,
  // which shut form-raised deposits out of Mathlib entirely — the vocabulary the whole banked
  // corpus is written in. Leading imports are therefore hoisted above the header.
  function splitLeadingImports(source) {
    var lines = source.split("\n");
    var imports = [];
    var i = 0;
    while (i < lines.length) {
      if (lines[i].trim() === "") { i++; continue; }
      var m = /^\s*import\s+(\S+)\s*$/.exec(lines[i]);
      if (!m) break;
      imports.push(m[1]);
      i++;
    }
    // Nothing to hoist: return the source untouched, so a deposit without imports is assembled
    // byte for byte as it was before this existed.
    if (imports.length === 0) return { imports: [], body: source };
    return { imports: imports, body: lines.slice(i).join("\n") };
  }

  function buildFile(v) {
    var split = splitLeadingImports(v.source);
    var lines = [];
    if (split.imports.length) {
      split.imports.forEach(function (m) { lines.push("import " + m); });
      lines.push("");
    }
    lines = lines.concat(["/-!", "# Mathesis deposit", "",
      "@kind: " + v.kind,
      "@title: " + v.title,
      "@module: " + v.module,
      "@decls: " + v.decls,
      "@pin: " + PIN]);
    if (v.mathlib) lines.push("@mathlib: " + v.mathlib);
    if (v.discharges) lines.push("@discharges: " + v.discharges);
    lines.push("", "@gloss:");
    v.gloss.split("\n").forEach(function (g) { lines.push("  " + g); });
    lines.push("-/", "", split.body, "");
    return lines.join("\n");
  }

  function missing(v) {
    var m = [];
    if (!v.title) m.push("title");
    if (!v.decls) m.push("declaration name");
    if (!v.source) m.push("Lean source");
    if (!v.gloss) m.push("description");
    return m;
  }

  function showPreview(v, content) {
    $("d-path").textContent = pathFor(v);
    $("d-preview-content").textContent = content;
    $("d-preview").hidden = false;
  }

  $("d-preview-btn").addEventListener("click", function () {
    var v = collect();
    showPreview(v, buildFile(v));
  });

  $("d-copy").addEventListener("click", function () {
    var btn = this;
    navigator.clipboard.writeText($("d-preview-content").textContent).then(function () {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy file content"; }, 1500);
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = collect();
    var miss = missing(v);
    var note = $("d-note");
    if (miss.length) {
      note.textContent = "Please fill in: " + miss.join(", ") + ".";
      note.hidden = false;
      return;
    }
    var content = buildFile(v);
    showPreview(v, content);
    var url = "https://github.com/" + REPO + "/new/main?filename=" +
      encodeURIComponent(pathFor(v)) + "&value=" + encodeURIComponent(content);
    // GitHub caps the prefill URL length; for a large proof the redirect may be
    // rejected. The preview + copy button below is the guaranteed fallback.
    if (url.length > 7000) {
      note.textContent = "This deposit is large. Use “Copy file content” below and paste it into a new file at " +
        pathFor(v) + " in a pull request.";
      note.hidden = false;
      return;
    }
    note.hidden = true;
    window.open(url, "_blank", "noopener");
  });
})();
