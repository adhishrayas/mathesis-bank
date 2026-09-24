//! The About body: the one committed file the generator splices verbatim.
//!
//! "The owner writes it" is a real mechanism rather than an endpoint with no
//! client (SPEC.md §8.4, R29): the owner edits `about/body.html`, opens a pull
//! request, and the next generation carries it. Because it is an input to
//! generation rather than a row, it is scanned at build time and a hit fails the
//! build — the body is never sanitized behind the author's back.

use crate::{GenError, GenOpts};

const ALLOWLIST: &str = include_str!("../../../../../shared/html-allowlist.v1.json");

pub fn read_and_check(opts: &GenOpts) -> Result<String, GenError> {
    let Some(path) = opts.about_body.as_ref() else {
        return Ok(String::new());
    };
    let body = std::fs::read_to_string(path)?;
    if body.is_empty() {
        return Ok(body);
    }
    let repo = path
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(std::path::Path::new("."));
    let local = crate::leak::local_terms(repo);

    if let Some(h) = crate::leak::scan_banned(&body) {
        return Err(GenError::AboutBodyRejected {
            offset: h.offset,
            reason: format!("banned token `{}`", h.term),
        });
    }
    if let Some(h) = crate::leak::scan(&body, &local, true) {
        return Err(GenError::AboutBodyRejected {
            offset: h.offset,
            reason: format!("internal corpus `{}`", h.term),
        });
    }
    let allowed =
        crate::leak::allowed(ALLOWLIST, "about").map_err(|e| GenError::AboutBodyRejected {
            offset: 0,
            reason: e,
        })?;
    if let Err((offset, reason)) = crate::leak::check_fragment(&body, &allowed) {
        return Err(GenError::AboutBodyRejected { offset, reason });
    }
    Ok(body)
}
