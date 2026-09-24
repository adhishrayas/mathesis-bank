//! The internal-corpus firewall and the About-body gate.
//!
//! Five independent mechanisms keep the internal corpus out of the public layer
//! (SPEC.md §10); two of them live here. The leak scan walks every generated
//! byte for the internal vocabulary, the legacy accession band and the local
//! terms of `.firewall-terms`, and a hit fails the build naming the file and the
//! byte offset. The About gate runs the same scan, the banned-token scan and the
//! `about` profile of `shared/html-allowlist.v1.json` over the one committed
//! file the generator splices verbatim into a page.

use std::collections::BTreeSet;
use std::path::Path;

/// The internal vocabulary, identical to `prose-lint`'s `INTERNAL_CORPUS` plus
/// the module roots the dictionary can never carry.
pub const INTERNAL_TERMS: &[&str] = &["WMSpec", "Eidometry", "TLT_Proofs", "TLT.", "MTH.D-"];

/// `lorem`, `TODO`, `FIXME`, `coming soon`, `placeholder` — matched case-insensitively.
pub const BANNED_TOKENS: &[&str] = &["lorem", "todo", "fixme", "coming soon", "placeholder"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub offset: usize,
    pub term: String,
}

/// The legacy band `MTH.[CRD]-20NN-1NNN`: the internal corpus numbers
/// `1001…1212`, the public sequence starts at 5001, and the two handle sets are
/// disjoint by construction. A four-digit sequence beginning with `1` is
/// therefore always an internal handle.
fn legacy_band(text: &str) -> Option<Hit> {
    let b = text.as_bytes();
    let mut i = 0usize;
    while let Some(p) = text[i..].find("MTH.") {
        let s = i + p;
        // MTH . K - Y Y Y Y - 1 N N N
        let rest = &b[s..];
        if rest.len() >= 15
            && matches!(rest[4], b'C' | b'R' | b'D')
            && rest[5] == b'-'
            && rest[6..10].iter().all(u8::is_ascii_digit)
            && &rest[6..8] == b"20"
            && rest[10] == b'-'
            && rest[11] == b'1'
            && rest[12..15].iter().all(u8::is_ascii_digit)
            && rest.get(15).is_none_or(|c| !c.is_ascii_digit())
        {
            return Some(Hit { offset: s, term: String::from_utf8_lossy(&rest[..15]).into_owned() });
        }
        i = s + 4;
    }
    None
}

/// The local terms: one per line in `$REPO/.firewall-terms`, comments with `#`.
/// They carry the documented carve-out — an occurrence inside a `<pre>` or
/// `<code>` element is not a hit, because a kernel-pretty-printed statement may
/// legitimately contain any character a Lean identifier may contain.
pub fn local_terms(repo: &Path) -> Vec<String> {
    let p = repo.join(".firewall-terms");
    let Ok(text) = std::fs::read_to_string(p) else { return Vec::new() };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// The byte ranges covered by a `<pre …>…</pre>` or `<code …>…</code>` element.
fn verbatim_spans(html: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for tag in ["pre", "code"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let mut i = 0usize;
        while let Some(p) = html[i..].find(&open) {
            let s = i + p;
            let end = match html[s..].find(&close) {
                Some(e) => s + e + close.len(),
                None => html.len(),
            };
            spans.push((s, end));
            i = end;
        }
    }
    spans
}

fn inside(spans: &[(usize, usize)], at: usize) -> bool {
    spans.iter().any(|(s, e)| at >= *s && at < *e)
}

/// Scan one file's bytes. `html` selects the carve-out: the local terms are
/// checked outside `<pre>`/`<code>` in a document, and not at all in a data file
/// whose values are the statements those elements render.
pub fn scan(text: &str, local: &[String], html: bool) -> Option<Hit> {
    for term in INTERNAL_TERMS {
        if let Some(p) = text.find(term) {
            return Some(Hit { offset: p, term: (*term).to_string() });
        }
    }
    if let Some(h) = legacy_band(text) {
        return Some(h);
    }
    if html {
        let spans = verbatim_spans(text);
        for term in local {
            let mut i = 0usize;
            while let Some(p) = text[i..].find(term.as_str()) {
                let at = i + p;
                if !inside(&spans, at) {
                    return Some(Hit { offset: at, term: term.clone() });
                }
                i = at + term.len();
            }
        }
    }
    None
}

/// The banned-token scan, case-insensitive, reporting an offset into the
/// **original** bytes. `str::to_lowercase` is not length-preserving, so a match
/// found in a lowercased copy would name a byte of a string the author never
/// wrote; the offsets are therefore carried alongside the folded text.
pub fn scan_banned(text: &str) -> Option<Hit> {
    let mut folded = String::with_capacity(text.len());
    // `offsets[i]` is the byte offset in `text` of the character that produced
    // `folded[i]`, so a hit maps back to the file the build failure names.
    let mut offsets: Vec<usize> = Vec::with_capacity(text.len());
    for (at, c) in text.char_indices() {
        for l in c.to_lowercase() {
            let before = folded.len();
            folded.push(l);
            offsets.resize(folded.len(), at);
            debug_assert!(offsets.len() > before);
        }
    }
    let mut best: Option<Hit> = None;
    for t in BANNED_TOKENS {
        if let Some(p) = folded.find(t) {
            let offset = offsets.get(p).copied().unwrap_or(p);
            if best.as_ref().is_none_or(|h| offset < h.offset) {
                best = Some(Hit { offset, term: (*t).to_string() });
            }
        }
    }
    best
}

// ------------------------------------------------------------- the About gate

#[derive(Debug, serde::Deserialize)]
struct Allowlist {
    base: Base,
    profiles: std::collections::BTreeMap<String, Profile>,
}

#[derive(Debug, serde::Deserialize)]
struct Base {
    elements: Vec<String>,
    attributes: std::collections::BTreeMap<String, Vec<String>>,
    url_schemes: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct Profile {
    #[serde(default)]
    adds: Vec<String>,
    #[serde(default)]
    removes: Vec<String>,
}

/// One profile's effective element set, resolved from the one shared table so
/// the Go consumer and this one cannot drift (`html_allowlist_agreement`).
pub struct Allowed {
    pub elements: BTreeSet<String>,
    pub attributes: std::collections::BTreeMap<String, BTreeSet<String>>,
    pub schemes: BTreeSet<String>,
}

pub fn allowed(allowlist_json: &str, profile: &str) -> Result<Allowed, String> {
    let a: Allowlist = serde_json::from_str(allowlist_json).map_err(|e| e.to_string())?;
    let p = a.profiles.get(profile).ok_or_else(|| format!("no allowlist profile `{profile}`"))?;
    let mut elements: BTreeSet<String> = a.base.elements.iter().cloned().collect();
    for e in &p.adds {
        elements.insert(e.clone());
    }
    for e in &p.removes {
        elements.remove(e);
    }
    Ok(Allowed {
        elements,
        attributes: a
            .base
            .attributes
            .iter()
            .map(|(k, v)| (k.clone(), v.iter().cloned().collect()))
            .collect(),
        schemes: a.base.url_schemes.iter().cloned().collect(),
    })
}

/// Check the committed About body against a profile. The body is a reviewed
/// commit and is therefore checked rather than rewritten: a violation fails the
/// build at a byte offset instead of being silently sanitized away.
pub fn check_fragment(html: &str, a: &Allowed) -> Result<(), (usize, String)> {
    let b = html.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        if b.get(i) == Some(&b'!') {
            if html[start..].starts_with("<!--") {
                match html[start..].find("-->") {
                    Some(e) => {
                        i = start + e + 3;
                        continue;
                    }
                    None => return Err((start, "unterminated comment".into())),
                }
            }
            return Err((start, "a declaration is not an allowed element".into()));
        }
        let closing = b.get(i) == Some(&b'/');
        if closing {
            i += 1;
        }
        let name_start = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
            i += 1;
        }
        let name = html[name_start..i].to_ascii_lowercase();
        if name.is_empty() {
            return Err((start, "a `<` that opens no element".into()));
        }
        if !a.elements.contains(&name) {
            return Err((start, format!("<{name}> is not in the allowlist")));
        }
        if closing {
            while i < b.len() && b[i] != b'>' {
                i += 1;
            }
            i += 1;
            continue;
        }
        // Attributes.
        loop {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= b.len() {
                return Err((start, format!("<{name}> is unterminated")));
            }
            if b[i] == b'>' {
                i += 1;
                break;
            }
            if b[i] == b'/' && b.get(i + 1) == Some(&b'>') {
                i += 2;
                break;
            }
            let a_start = i;
            while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'>' {
                i += 1;
            }
            let attr = html[a_start..i].to_ascii_lowercase();
            let mut value = String::new();
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if b.get(i) == Some(&b'=') {
                i += 1;
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let quote = b.get(i).copied();
                if quote == Some(b'"') || quote == Some(b'\'') {
                    let q = quote.unwrap();
                    i += 1;
                    let v_start = i;
                    while i < b.len() && b[i] != q {
                        i += 1;
                    }
                    value = html[v_start..i].to_string();
                    i += 1;
                } else {
                    let v_start = i;
                    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                        i += 1;
                    }
                    value = html[v_start..i].to_string();
                }
            }
            let empty = BTreeSet::new();
            let allowed_attrs = a.attributes.get(&name).unwrap_or(&empty);
            if !allowed_attrs.contains(&attr) {
                return Err((a_start, format!("{attr} is not allowed on <{name}>")));
            }
            if attr == "href" {
                let scheme = value.split(':').next().unwrap_or("").to_ascii_lowercase();
                if !a.schemes.contains(&scheme) {
                    return Err((a_start, format!("href scheme `{scheme}` is not allowed")));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOWLIST: &str = include_str!("../../../../../shared/html-allowlist.v1.json");

    #[test]
    fn the_about_profile_is_note_plus_h2() {
        let note = allowed(ALLOWLIST, "note").unwrap();
        let about = allowed(ALLOWLIST, "about").unwrap();
        let delta: Vec<_> = about.elements.difference(&note.elements).cloned().collect();
        assert_eq!(delta, vec!["h2".to_string()]);
        assert!(note.elements.difference(&about.elements).next().is_none());
    }

    #[test]
    fn a_body_of_allowed_elements_passes_and_a_script_does_not() {
        let about = allowed(ALLOWLIST, "about").unwrap();
        assert!(check_fragment("<h2>Curation</h2><p>One <code>x</code> and <a href=\"https://e.org\">a link</a>.</p>", &about).is_ok());
        let e = check_fragment("<p>ok</p><script>alert(1)</script>", &about).unwrap_err();
        assert_eq!(e.0, 9);
        assert!(e.1.contains("script"));
        assert!(check_fragment("<img src=\"x.png\">", &about).is_err());
        assert!(check_fragment("<a href=\"javascript:1\">x</a>", &about).is_err());
        assert!(check_fragment("<p onclick=\"x\">x</p>", &about).is_err());
    }

    #[test]
    fn the_scan_finds_the_internal_vocabulary_and_the_legacy_band() {
        assert_eq!(scan("ok WMSpec.fiber_saturated", &[], true).unwrap().term, "WMSpec");
        assert_eq!(scan("see MTH.C-2026-1067 there", &[], true).unwrap().term, "MTH.C-2026-1067");
        assert!(scan("MTH.C-2026-5007", &[], true).is_none());
        assert!(scan("MTH.R-2026-51067", &[], true).is_none());
    }

    #[test]
    fn a_local_term_inside_a_pre_is_the_documented_carve_out() {
        let local = vec!["γ".to_string()];
        assert!(scan("<pre data-role=\"lean-statement\">∀ γ, γ = γ</pre>", &local, true).is_none());
        assert_eq!(scan("<p>γ</p>", &local, true).unwrap().term, "γ");
        assert!(scan("{\"value\":\"γ\"}", &local, false).is_none());
    }

    #[test]
    fn banned_tokens_are_case_insensitive() {
        assert_eq!(scan_banned("A TODO remains").unwrap().term, "todo");
        assert!(scan_banned("the curated subset").is_none());
    }

    #[test]
    fn a_banned_token_offset_indexes_the_original_bytes() {
        // `İ` folds to two chars, so a match located in a lowercased copy is
        // one byte past the text the build failure has to name.
        let text = "İ TODO";
        let hit = scan_banned(text).unwrap();
        assert_eq!(&text[hit.offset..hit.offset + 4], "TODO");
        // The earliest banned token wins, whichever entry of the list it is.
        let two = scan_banned("placeholder and a TODO").unwrap();
        assert_eq!(two.term, "placeholder");
        assert_eq!(two.offset, 0);
    }
}
