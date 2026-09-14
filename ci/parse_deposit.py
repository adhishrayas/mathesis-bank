#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Mathesis — parse a form-raised deposit's metadata header.
#
# A deposit is a SINGLE file `deposits/<slug>/submission.lean` whose FIRST
# block is a Lean doc-comment `/-! ... -/` carrying an @-header (see
# site/deposit.js `buildFile`). Because the header is a valid Lean doc
# comment, the file BUILDS directly at the pinned toolchain — the gate builds
# the very same file the human sees.
#
# This script parses ONLY that header (it does not read the Lean body) and
# prints one JSON object:
#   {kind, title, module, decls:[...], pin, mathlib|null, discharges|null,
#    imports:[...], gloss}
#
# It FAILS CLOSED (nonzero exit, error on stderr) when:
#   * the file has no leading /-! ... -/ block (leading `import` lines may precede it),
#   * an `import` appears BELOW the header, where Lean cannot accept it,
#   * an import names something that is not a dotted Lean module name,
#   * a required field is missing (@kind, @title, @decls, @pin),
#   * @kind is not one of result|definition|claim,
#   * @pin is not exactly leanprover/lean4:v4.31.0,
#   * @decls is empty after splitting, or any decl is not a plausible name,
#   * @discharges is present but is not a claims handle MTH.C-YYYY-NNNN.
# A malformed deposit therefore never yields a parse the gate could act on.
# ---------------------------------------------------------------------------
import json
import re
import sys

PIN_REQUIRED = "leanprover/lean4:v4.31.0"
VALID_KINDS = ("result", "definition", "claim")

# The @-fields the header may carry. Everything the gate keys on is here; an
# unknown @-line is ignored (forward-compatible) rather than fatal.
SCALAR_FIELDS = ("kind", "title", "module", "decls", "pin", "discharges", "mathlib")

# A @decls entry is passed to the kernel gate as an argv item AND echoed into
# the PR-comment markdown. Lean declaration names use ASCII letters/digits and
# `_ . ' ! ?`, plus a wide range of non-ASCII (greek, subscripts, unicode
# letters). We ALLOW exactly those and reject everything else — in particular
# whitespace/controls, path separators, and shell/markdown metacharacters —
# so a hostile decl cannot break out of the gate's argv or the report markdown.
DECL_ASCII_OK = set(
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "_.'!?"
)


def decl_char_ok(c):
    # Non-ASCII (>= 0x80) is allowed: Lean identifiers may contain unicode
    # letters/subscripts. ASCII must be in the identifier allow-set.
    return ord(c) >= 0x80 or c in DECL_ASCII_OK


# An `import` line, and the module-name grammar it may name.
#
# WHY IMPORTS LIVE ABOVE THE HEADER
# ---------------------------------
# `/-! ... -/` is a Lean *module docstring*, which is declaration-level syntax, and Lean requires
# every `import` to precede all declarations. So a file shaped "header first, then source" can
# never import anything:
#
#     /-! @kind: result ... -/
#     import Mathlib.Logic.Basic     -> error: invalid 'import' command, it must be used in
#                                       the beginning of the file
#
# That made the entire banked corpus's vocabulary unreachable to a form-raised deposit: Mathlib
# is what the 512 accessions are built on, and no deposit could import it. The deposit form and
# `backend/deposits.py:build_submission` therefore HOIST a leading run of `import` lines above
# the header, and this parser accepts that shape. A deposit with no imports is assembled exactly
# as before, byte for byte.
IMPORT_RE = re.compile(r"^\s*import\s+(\S+)\s*$")

# Conservative: dotted ASCII identifiers, which covers Init/Std/Lean and every `Mathlib.*`.
# Lean permits more (guillemet-quoted and unicode module names), and this deliberately does not:
# the module name is interpolated verbatim into the file the gate builds, so a name that cannot
# be a module is a malformed deposit rather than something to pass through and find out later.
MODULE_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*\Z")


def split_leading_imports(text):
    """(module names, the rest of the file).

    Only a LEADING run of `import` lines counts, blank lines allowed between them. The first line
    that is neither blank nor an import ends the run — normally the `/-!` that opens the header.
    """
    lines = text.splitlines(keepends=True)
    imports = []
    i = 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        m = IMPORT_RE.match(lines[i])
        if m is None:
            break
        imports.append(m.group(1))
        i += 1
    if not imports:
        # Return the text untouched when there is nothing to hoist, so the no-import path is
        # provably identical to the pre-existing one.
        return [], text
    return imports, "".join(lines[i:])


def die(msg):
    sys.stderr.write("parse_deposit: " + msg + "\n")
    sys.exit(1)


def extract_header_block(text):
    """Return the inner text of the LEADING `/-! ... -/` doc-comment block.

    Only a block that opens the file (ignoring leading blank lines) counts —
    a `/-! -/` further down the source is body, not header. Returns None if
    the file does not start with such a block.
    """
    # Skip a UTF-8 BOM and leading whitespace/blank lines.
    stripped = text.lstrip("﻿")
    lead = stripped.lstrip()
    if not lead.startswith("/-!"):
        return None
    # Find the matching close of THIS opening block. Lean block comments can
    # nest, but the form never emits a nested comment inside the header, and
    # the @gloss body is plain indented text; the first `-/` closes it.
    start = stripped.find("/-!")
    end = stripped.find("-/", start + 3)
    if end == -1:
        return None
    return stripped[start + 3:end]


def parse_header(block):
    """Parse the @-header lines out of the doc-comment inner text.

    Scalar @fields (@kind:, @title:, ...) are `@name: value`. @gloss: is a
    block field: everything after it (to the end of the header block) is the
    gloss body, dedented by the form's two-space indent.
    """
    lines = block.splitlines()
    fields = {}
    gloss_lines = []
    in_gloss = False

    for raw in lines:
        line = raw.rstrip("\n")
        # A new @field line ends any in-progress @gloss block.
        m = re.match(r"^\s*@([A-Za-z_]+)\s*:(.*)$", line)
        if m and not (in_gloss and not line.lstrip().startswith("@")):
            name = m.group(1).strip().lower()
            value = m.group(2).strip()
            if name == "gloss":
                in_gloss = True
                # Anything on the same line after `@gloss:` is unusual (the
                # form puts the body on following indented lines) but keep it.
                if value:
                    gloss_lines.append(value)
                continue
            in_gloss = False
            if name in SCALAR_FIELDS:
                fields[name] = value
            # unknown @field: ignore (forward-compatible)
            continue
        if in_gloss:
            # Gloss body line. The form indents each gloss line by two spaces;
            # strip up to two leading spaces so the JSON gloss is undented.
            gloss_lines.append(re.sub(r"^ {1,2}", "", line))

    fields["gloss"] = "\n".join(gloss_lines).strip("\n")
    return fields


def main(argv):
    if len(argv) != 2:
        die("usage: parse_deposit.py <submission.lean>")
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        die("cannot read %s: %s" % (path, e))

    imports, rest = split_leading_imports(text)
    for mod in imports:
        if not MODULE_RE.match(mod) or ".." in mod:
            die("illegal import %r (must be a dotted Lean module name)" % mod)

    block = extract_header_block(rest)
    if block is None:
        die("no leading /-! ... -/ metadata header block in %s" % path)

    # An import BELOW the header is not a style problem, it is a file that cannot build. Saying
    # so here costs nothing; letting it through spends a full container build to reach the same
    # conclusion with a worse message.
    close = rest.find("-/", rest.find("/-!") + 3)
    for ln in rest[close + 2:].splitlines():
        if re.match(r"^\s*import\b", ln):
            die("import below the metadata header in %s: %r\n"
                "  Lean requires every import to precede all declarations, and the `/-!` header "
                "is a declaration.\n"
                "  Put imports at the very top of your source and the form will hoist them above "
                "the header." % (path, ln.strip()))

    fields = parse_header(block)

    # Required scalar fields.
    for req in ("kind", "title", "decls", "pin"):
        if not fields.get(req):
            die("missing required @%s in header of %s" % (req, path))

    kind = fields["kind"]
    if kind not in VALID_KINDS:
        die("invalid @kind %r (must be one of %s)" % (kind, "|".join(VALID_KINDS)))

    pin = fields["pin"]
    if pin != PIN_REQUIRED:
        die("pin %r != required %r" % (pin, PIN_REQUIRED))

    decls = [d.strip() for d in fields["decls"].split(",") if d.strip()]
    if not decls:
        die("@decls resolved to an empty list in %s" % path)

    # Reject any decl containing a forbidden byte (whitespace, control, path or
    # shell/markdown-dangerous character) or a `..` sequence. Keeps a hostile
    # decl from breaking out of the gate's argv or the PR-comment markdown.
    for dn in decls:
        if ".." in dn or not all(decl_char_ok(c) for c in dn):
            die("illegal @decls entry %r (not a plausible Lean declaration name)" % dn)

    # @discharges (when present) names a CLAIM this deposit discharges. It is
    # interpolated by the gate into a registry path
    # (registry/claims/<discharges>/manifest.json) to select the FROZEN
    # reference R. Validate it to the exact claims-handle grammar
    # MTH.C-YYYY-NNNN, fail-closed: this forecloses path traversal (`../`,
    # absolute paths, embedded `/`) that would let a deposit point R at a file
    # it controls and pass statement-identity against its own forged reference.
    discharges = fields.get("discharges") or None
    if discharges is not None and not re.fullmatch(r"MTH\.C-[0-9]{4}-[0-9]{4,}", discharges):
        die("invalid @discharges %r (must be a claims handle MTH.C-YYYY-NNNN)" % discharges)

    # @mathlib (when present) pins the Mathlib revision the deposit is built against. Only the
    # GRAMMAR is checked here: this parser is deliberately database-free because the gate runs
    # it too, so whether a revision is one the bank actually has a cache and a trusted reference
    # for is decided by the caller (the API at intake, and the gate before it builds). Absent
    # means Lean-core only, which is every deposit before Phase 2b.
    mathlib = fields.get("mathlib") or None
    if mathlib is not None and not re.fullmatch(r"[0-9a-f]{40}", mathlib):
        die("invalid @mathlib %r (must be a 40-character lowercase git sha)" % mathlib)

    # Importing Mathlib without pinning a revision is a deposit that cannot build, and this is
    # decidable from the header alone — no database needed, so it belongs here. `@mathlib` is what
    # selects a Mathlib environment; without it the deposit resolves to Lean core, where Mathlib
    # is not on LEAN_PATH and the build dies with Lean's own "unknown module prefix 'Mathlib'"
    # after a full container build. Saying it now is the same verdict, minutes earlier, with a
    # message the depositor can act on.
    if mathlib is None:
        unpinned = [m for m in imports if m == "Mathlib" or m.startswith("Mathlib.")]
        if unpinned:
            die("imports %s but sets no @mathlib in %s\n"
                "  A Mathlib import needs @mathlib: <40-char revision> to select the build\n"
                "  environment that carries it. Without one the deposit is built against Lean\n"
                "  core, where Mathlib is not importable."
                % (", ".join(repr(m) for m in unpinned[:3]), path))

    # Title is human-facing and flows into the PR-comment markdown. Collapse all
    # whitespace (including newlines) to single spaces and cap length, so a
    # title cannot forge a report line (e.g. a fake "verdict: admit").
    title = re.sub(r"\s+", " ", fields["title"]).strip()[:200]

    out = {
        "kind": kind,
        "title": title,
        "module": fields.get("module") or "Submission",
        "decls": decls,
        "pin": pin,
        "mathlib": mathlib,
        "discharges": discharges,
        # The hoisted imports, so a caller can see what the deposit asked for without
        # re-parsing the file. What is actually IMPORTABLE is decided by LEAN_PATH, i.e. by the
        # environment the deposit pinned — a core environment offers Init/Std/Lean and nothing
        # more, so an unavailable import fails the build with Lean's own message.
        "imports": imports,
        "gloss": fields.get("gloss", ""),
    }
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
