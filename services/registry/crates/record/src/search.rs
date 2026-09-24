//! The one Tantivy index over both banks, and the query that reads it.
//!
//! The bank is a field, not a database: claims and arguments are indexed alike
//! so text search works in both, and the Postgres `tsvector` path is gone
//! (SPEC.md R15). Because the index lives on the record volume rather than in
//! the registry, `GET /api/v1/search` keeps answering while Postgres is down
//! (§12 row 22).
//!
//! Paging is **value-based**. A Tantivy `DocAddress` is a segment ordinal plus a
//! doc id and is not stable across a rebuilt index, and this index is rebuilt on
//! every admission, on every profile-identity write, at startup and hourly — so
//! a cursor is the opaque base64 of `(sort key, accession)` and the next page
//! seeks past that value (R47).


#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Malformed(String),
    #[error("the parameter {parameter} does not apply to the {bank} bank")]
    InvalidFilter { parameter: String, bank: String },
    #[error("the cursor is not one this index minted")]
    BadCursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bank {
    Claims,
    Arguments,
}

impl Bank {
    pub fn as_str(self) -> &'static str {
        match self {
            Bank::Claims => "claims",
            Bank::Arguments => "arguments",
        }
    }

    pub fn parse(s: &str) -> Option<Bank> {
        match s {
            "claims" => Some(Bank::Claims),
            "arguments" => Some(Bank::Arguments),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Newest,
    Oldest,
}

impl Sort {
    pub fn parse(s: &str) -> Option<Sort> {
        match s {
            "newest" | "" => Some(Sort::Newest),
            "oldest" => Some(Sort::Oldest),
            _ => None,
        }
    }
}

/// One row of a bank, as the generator writes it into `collection/*.json` and as
/// the indexer reads it back. A claim's three searched fields are `claim.pretty`,
/// `claim.decl_name` and `claim.module`; an argument's are the denormalized
/// projection of its DAG's single root (SPEC.md §8.3).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct BankRow {
    pub accession: String,
    pub bank: String,
    pub decl_name: String,
    pub pretty: String,
    pub module: String,
    pub libraries: Vec<String>,
    pub author: String,
    pub author_login: String,
    pub created_at: String,
    pub arguments: i64,
    pub axioms: Vec<String>,
    pub axiom_free: bool,
    pub nodes: i64,
    pub constants: i64,
    pub claim_accession: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub q: String,
    pub bank: Option<Bank>,
    pub library: Option<String>,
    pub author: Option<String>,
    pub axioms: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub min_arguments: Option<u32>,
    pub doi: Option<String>,
    pub sort: Option<Sort>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Facets {
    pub library: Vec<(String, u64)>,
    pub author: Vec<(String, u64)>,
    pub axioms: Vec<(String, u64)>,
}

/// The triple the contract names — rows, facets, total — plus the cursor §9
/// requires the same call to mint.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchPage {
    pub bank: String,
    pub rows: Vec<BankRow>,
    pub facets: Facets,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
fn seconds(rfc3339: &str) -> Result<i64, SearchError> {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|t| t.timestamp())
        .map_err(|_| SearchError::Malformed(format!("`{rfc3339}` is not an RFC 3339 timestamp")))
}

/// A filter bound: a date (`2026-09-23`) or a full timestamp.
#[cfg(test)]
fn bound_seconds(s: &str, end_of_day: bool) -> Result<i64, SearchError> {
    if let Ok(t) = seconds(s) {
        return Ok(t);
    }
    let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| SearchError::Malformed(format!("`{s}` is not a date")))?;
    let t = if end_of_day { d.and_hms_opt(23, 59, 59) } else { d.and_hms_opt(0, 0, 0) };
    Ok(t.expect("a valid civil time").and_utc().timestamp())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct BankPage {
    pub bank: String,
    pub page: usize,
    pub rows: Vec<BankRow>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

// ------------------------------------------------------------------- cursors

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn unb64(input: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut n = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for c in input.bytes() {
        let v = B64.iter().position(|x| *x == c)? as u32;
        n = (n << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
        }
    }
    Some(out)
}

pub fn encode_cursor(sort_key: i64, accession: &str) -> String {
    b64(format!("{sort_key}:{accession}").as_bytes())
}

pub fn decode_cursor(c: &str) -> Result<(i64, String), SearchError> {
    let raw = unb64(c).ok_or(SearchError::BadCursor)?;
    let s = String::from_utf8(raw).map_err(|_| SearchError::BadCursor)?;
    let (k, acc) = s.split_once(':').ok_or(SearchError::BadCursor)?;
    Ok((k.parse().map_err(|_| SearchError::BadCursor)?, acc.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_is_opaque_base64() {
        let c = encode_cursor(1_790_000_000, "MTH.R-2026-5007");
        assert!(c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert!(!c.contains("MTH"));
        assert_eq!(decode_cursor(&c).unwrap(), (1_790_000_000, "MTH.R-2026-5007".to_string()));
        assert!(matches!(decode_cursor("!!"), Err(SearchError::BadCursor)));
    }

    #[test]
    fn a_date_bound_covers_the_whole_day() {
        assert_eq!(bound_seconds("2026-09-23", false).unwrap(), 1_790_121_600);
        assert_eq!(bound_seconds("2026-09-23", true).unwrap(), 1_790_207_999);
    }
}
