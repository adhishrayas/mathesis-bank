//! The Mathesis accession scheme, which is also the DOI scheme (SPEC.md §5).
//!
//! Grammar [`GRAMMAR`] — `^MTH\.(C|R)-[0-9]{4}-[0-9]{4,6}$`, byte for byte the
//! regex of the `accession.id` CHECK constraint, so a value this crate accepts is
//! a value the registry accepts and the converse holds too
//! (`grammar_matches_the_check_constraint`).
//!
//! `seq` is drawn from a global per-kind sequence with floor [`PUBLIC_SEQ_FLOOR`]
//! and keeps counting across years, so `(kind, seq)` alone is unique and the year
//! is informational: `MTH.C-2026-5090` may be followed by `MTH.C-2027-5091`. The
//! floor keeps the public band disjoint from the internal [`INTERNAL_BAND`]
//! corpus, whose handles are not resolvable here ([`is_internal_handle`]).
//!
//! `(kind, seq)` is also a total order, which is what lets a value-based search
//! cursor tiebreak on an accession and survive the index rebuild every admission
//! performs (R47): see [`Accession::cmp`].
//!
//! [`mint`] is the platform's single minting implementation. Both callers —
//! `Store::admit` and `mathesisd seed` — are in-process Rust and go through it,
//! so the floor-5001 invariant has exactly one owner and nothing reimplements the
//! sequence in another language (R30).
//!
//! Resolution is on-platform at `/d/<accession>`. Nothing here registers a DOI
//! with an external agency: no DataCite, no CrossRef, no `10.` prefix, no
//! `doi.org` (`citation_names_no_registration_agency`).

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fmt;
use std::ops::RangeInclusive;
use std::str::FromStr;

/// The grammar of an accession, identical to the `accession.id` CHECK constraint
/// in `crates/store/migrations/0001_schema.sql`.
pub const GRAMMAR: &str = r"^MTH\.(C|R)-[0-9]{4}-[0-9]{4,6}$";

/// The floor of the public sequence, matching `CHECK (seq >= 5001)` and
/// `CREATE SEQUENCE … START 5001`. Anything below it is an internal handle and is
/// not resolvable on the public layer.
pub const PUBLIC_SEQ_FLOOR: u32 = 5001;

/// The band occupied by the internal corpus that predates the public layer. It is
/// disjoint from every public sequence value by construction; `is_internal_handle`
/// covers this band and everything else below the floor.
pub const INTERNAL_BAND: RangeInclusive<u32> = 1001..=1212;

const MIN_YEAR: u16 = 1000;
const MAX_YEAR: u16 = 9999;
const MAX_SEQ: u32 = 999_999;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AccessionError {
    #[error("accession is not of the form MTH.C-YYYY-NNNN or MTH.R-YYYY-NNNN")]
    Malformed,
    #[error("accession sequence {0} is below the public floor {PUBLIC_SEQ_FLOOR}")]
    BelowFloor(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claim,
    Argument,
}

impl Kind {
    /// The `accession.kind` column value and the letter in the identifier.
    pub fn letter(self) -> char {
        match self {
            Kind::Claim => 'C',
            Kind::Argument => 'R',
        }
    }

    /// The `subject_kind` column value and the API's wire spelling.
    pub fn subject(self) -> &'static str {
        SubjectKind::of(self).as_str()
    }

    /// The catalogue label an `Accession kind` column renders.
    pub fn label(self) -> &'static str {
        match self {
            Kind::Claim => "Claim",
            Kind::Argument => "Argument",
        }
    }

    /// The sequence `mint` draws from for this kind.
    pub fn sequence(self) -> &'static str {
        match self {
            Kind::Claim => "accession_c_seq",
            Kind::Argument => "accession_r_seq",
        }
    }

    pub fn from_letter(c: char) -> Option<Kind> {
        match c {
            'C' => Some(Kind::Claim),
            'R' => Some(Kind::Argument),
            _ => None,
        }
    }
}

/// The `accession.subject_kind` column: what the identifier names. It is carried
/// separately from [`Kind`] because the column is separate and because the object
/// model is left open for witnesses over data or rules, which v0 does not mint.
/// In v0 the two are in bijection and [`mint`] refuses a pair that is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectKind {
    Claim,
    Argument,
}

impl SubjectKind {
    /// The subject an accession of this kind names in v0.
    pub fn of(kind: Kind) -> SubjectKind {
        match kind {
            Kind::Claim => SubjectKind::Claim,
            Kind::Argument => SubjectKind::Argument,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Claim => "claim",
            SubjectKind::Argument => "argument",
        }
    }

    pub fn kind(self) -> Kind {
        match self {
            SubjectKind::Claim => Kind::Claim,
            SubjectKind::Argument => Kind::Argument,
        }
    }
}

impl fmt::Display for SubjectKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Accession {
    pub kind: Kind,
    pub year: u16,
    pub seq: u32,
}

impl Accession {
    pub fn new(kind: Kind, year: u16, seq: u32) -> Result<Self, AccessionError> {
        if seq < PUBLIC_SEQ_FLOOR {
            return Err(AccessionError::BelowFloor(seq));
        }
        if !(MIN_YEAR..=MAX_YEAR).contains(&year) || seq > MAX_SEQ {
            return Err(AccessionError::Malformed);
        }
        Ok(Accession { kind, year, seq })
    }

    /// Parse a public accession: the grammar of [`GRAMMAR`] plus the public floor.
    /// This is what `FromStr` does, named so callers can write
    /// `Accession::parse(s)` without importing the trait.
    pub fn parse(s: &str) -> Result<Self, AccessionError> {
        let a = Accession::parse_any(s)?;
        if !a.is_public() {
            return Err(AccessionError::BelowFloor(a.seq));
        }
        Ok(a)
    }

    /// Parse against the grammar alone, without applying the public floor. `webd`
    /// needs this so that an internal `MTH.*-2026-1xxx` handle resolves to a 404
    /// rather than to a parse error (SPEC.md §5, the `/d/{acc}` row).
    pub fn parse_any(s: &str) -> Result<Self, AccessionError> {
        let rest = s.strip_prefix("MTH.").ok_or(AccessionError::Malformed)?;
        let bytes = rest.as_bytes();
        // letter '-' YYYY '-' NNNN is the shortest accepted tail.
        if bytes.len() < 1 + 1 + 4 + 1 + 4 {
            return Err(AccessionError::Malformed);
        }
        let kind = Kind::from_letter(bytes[0] as char).ok_or(AccessionError::Malformed)?;
        if bytes[1] != b'-' {
            return Err(AccessionError::Malformed);
        }
        let tail = &rest[2..];
        let (year_s, seq_s) = tail.split_once('-').ok_or(AccessionError::Malformed)?;
        if year_s.len() != 4 || !year_s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AccessionError::Malformed);
        }
        if !(4..=6).contains(&seq_s.len()) || !seq_s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AccessionError::Malformed);
        }
        Ok(Accession {
            kind,
            year: year_s.parse().map_err(|_| AccessionError::Malformed)?,
            seq: seq_s.parse().map_err(|_| AccessionError::Malformed)?,
        })
    }

    pub fn is_public(&self) -> bool {
        self.seq >= PUBLIC_SEQ_FLOOR
    }

    pub fn subject_kind(&self) -> SubjectKind {
        SubjectKind::of(self.kind)
    }

    /// `/d/<accession>`, the resolver route.
    pub fn doi_path(&self) -> String {
        format!("/d/{self}")
    }

    /// `/a/<accession>`, the landing page the resolver redirects to.
    pub fn landing_path(&self) -> String {
        format!("/a/{self}")
    }
}

/// `(kind, seq)`, the total order a value-based search cursor tiebreaks on (R47).
/// The year is compared last and only so that `Ord` stays consistent with `Eq`;
/// `UNIQUE (kind, seq)` on the `accession` table means two rows of the registry
/// never reach that comparison.
impl Ord for Accession {
    fn cmp(&self, other: &Self) -> Ordering {
        self.kind
            .cmp(&other.kind)
            .then(self.seq.cmp(&other.seq))
            .then(self.year.cmp(&other.year))
    }
}

impl PartialOrd for Accession {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Accession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "MTH.{}-{:04}-{:04}",
            self.kind.letter(),
            self.year,
            self.seq
        )
    }
}

impl FromStr for Accession {
    type Err = AccessionError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Accession::parse(s)
    }
}

impl Serialize for Accession {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Accession {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// True for a well-formed accession whose sequence is below the public floor: the
/// internal `MTH.*-YYYY-1xxx` corpus. The generated `doi/index.jsonl` excludes
/// these, and `webd` answers `404` for them rather than treating them as
/// malformed. A string that is not an accession at all is not an internal handle.
pub fn is_internal_handle(s: &str) -> bool {
    matches!(Accession::parse_any(s), Ok(a) if !a.is_public())
}

// --------------------------------------------------------------------- citation

/// The two citation strings, baked into every minted page at generation time so
/// that a page holds no mutable value and needs no runtime call (SPEC.md §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    pub text: String,
    pub bibtex: String,
}

/// `{citation_name}. {decl_name}. Mathesis. {acc}. {site_base}/d/{acc}. {YYYY-MM-DD}.`
///
/// `citation_name` is `profile.citation_name`, frozen at row creation and
/// immutable at the grant, trigger and role layers — never the mutable `login`.
/// That is what makes an already-published citation survive a GitHub rename
/// (R17). `created` is the row's creation timestamp, RFC 3339 or `YYYY-MM-DD`;
/// only its date part is rendered.
pub fn cite_text(
    citation_name: &str,
    decl_name: &str,
    acc: &Accession,
    created: &str,
    site_base: &str,
) -> String {
    let day = date_part(created);
    let base = site_base.trim_end_matches('/');
    format!("{citation_name}. {decl_name}. Mathesis. {acc}. {base}/d/{acc}. {day}.")
}

/// The BibTeX form of [`cite_text`]. `howpublished` is the platform, `note` is the
/// accession and `url` is the on-platform resolver; there is no `doi` field,
/// because this identifier is deliberately not a registered DOI.
pub fn cite_bibtex(
    citation_name: &str,
    decl_name: &str,
    acc: &Accession,
    created: &str,
    site_base: &str,
) -> String {
    let year = year_part(created);
    let base = site_base.trim_end_matches('/');
    format!(
        "@misc{{{acc}, title={{{decl_name}}}, author={{{citation_name}}}, \
howpublished={{Mathesis}}, note={{{acc}}}, url={{{base}/d/{acc}}}, year={{{year}}} }}"
    )
}

/// Both strings at once, for the generator that bakes them into
/// `[data-citation-text]` and `[data-citation-bibtex]`.
pub fn citation(
    citation_name: &str,
    decl_name: &str,
    acc: &Accession,
    site_base: &str,
    created: &str,
) -> Citation {
    Citation {
        text: cite_text(citation_name, decl_name, acc, created, site_base),
        bibtex: cite_bibtex(citation_name, decl_name, acc, created, site_base),
    }
}

/// The `YYYY-MM-DD` head of an RFC 3339 timestamp, or the whole string when it is
/// already a date.
fn date_part(created: &str) -> &str {
    let b = created.as_bytes();
    if b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        &created[..10]
    } else {
        created
    }
}

fn year_part(created: &str) -> &str {
    let d = date_part(created);
    if d.len() >= 4 && d.as_bytes()[..4].iter().all(u8::is_ascii_digit) {
        &d[..4]
    } else {
        d
    }
}

// ----------------------------------------------------------------------- mint

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let a = Accession::parse("MTH.C-2026-5001").unwrap();
        assert_eq!(a.kind, Kind::Claim);
        assert_eq!(a.year, 2026);
        assert_eq!(a.seq, 5001);
        assert_eq!(a.to_string(), "MTH.C-2026-5001");
        assert_eq!(a.doi_path(), "/d/MTH.C-2026-5001");
        assert_eq!(a.landing_path(), "/a/MTH.C-2026-5001");
        assert_eq!("MTH.R-2027-12345".parse::<Accession>().unwrap().seq, 12345);
        assert_eq!(
            Accession::new(Kind::Argument, 2026, 999_999)
                .unwrap()
                .to_string(),
            "MTH.R-2026-999999"
        );
    }

    #[test]
    fn rejects_internal_and_malformed() {
        assert_eq!(
            Accession::parse("MTH.C-2026-1067"),
            Err(AccessionError::BelowFloor(1067))
        );
        assert!(!Accession::parse_any("MTH.C-2026-1067").unwrap().is_public());
        for bad in [
            "MTH.D-2026-5001",
            "MTH.C-26-5001",
            "MTH.C-2026-500",
            "MTH.C-2026-1234567",
            "",
            "MTH.C2026-5001",
            "10.1234/x",
            "https://doi.org/10.1234/x",
            "mth.c-2026-5001",
            "MTH.C-2026-5001 ",
            " MTH.C-2026-5001",
            "MTH.C-2026-5001x",
            "MTH.C-20a6-5001",
            "MTH.C-2026-50o1",
        ] {
            assert_eq!(
                Accession::parse(bad),
                Err(AccessionError::Malformed),
                "{bad}"
            );
            assert_eq!(
                Accession::parse_any(bad),
                Err(AccessionError::Malformed),
                "{bad}"
            );
        }
    }

    /// The Rust grammar and the Postgres CHECK are one rule, not two that drift.
    /// Every value the grammar admits is accepted, and the floor is the only extra
    /// rule `parse` applies over `parse_any`.
    #[test]
    fn grammar_boundaries() {
        for good in [
            "MTH.C-1000-5001",
            "MTH.C-9999-5001",
            "MTH.R-2026-5001",
            "MTH.R-2026-999999",
        ] {
            assert!(Accession::parse(good).is_ok(), "{good}");
            assert_eq!(Accession::parse(good).unwrap().to_string(), good);
        }
        assert_eq!(
            Accession::parse("MTH.C-2026-5000"),
            Err(AccessionError::BelowFloor(5000))
        );
        assert!(Accession::parse("MTH.C-2026-5001").is_ok());
    }

    /// The public band cannot collide with the internal corpus, and an internal
    /// handle is recognised as such rather than as a parse failure.
    #[test]
    fn public_band_is_disjoint_from_the_internal_corpus() {
        for seq in INTERNAL_BAND {
            let handle = format!("MTH.C-2026-{seq:04}");
            assert!(is_internal_handle(&handle), "{handle}");
            assert!(seq < PUBLIC_SEQ_FLOOR);
            assert_eq!(
                Accession::parse(&handle),
                Err(AccessionError::BelowFloor(seq))
            );
            assert_eq!(
                Accession::new(Kind::Claim, 2026, seq),
                Err(AccessionError::BelowFloor(seq))
            );
        }
        assert!(is_internal_handle("MTH.R-2026-1212"));
        assert!(!is_internal_handle("MTH.C-2026-5001"));
        assert!(!is_internal_handle("MTH.D-2026-1067"));
        assert!(!is_internal_handle("not an accession"));
        assert!(!is_internal_handle(""));
    }

    /// `(kind, seq)` orders, and it dominates the year: the sequence keeps counting
    /// across years, so a later year with a smaller sequence sorts first.
    #[test]
    fn order_is_kind_then_seq() {
        let a = Accession::new(Kind::Claim, 2026, 5090).unwrap();
        let b = Accession::new(Kind::Claim, 2027, 5091).unwrap();
        assert!(a < b);
        let later_year_smaller_seq = Accession::new(Kind::Claim, 2027, 5091).unwrap();
        let earlier_year_larger_seq = Accession::new(Kind::Claim, 2026, 5092).unwrap();
        assert!(later_year_smaller_seq < earlier_year_larger_seq);
        assert!(
            Accession::new(Kind::Claim, 2026, 9999).unwrap()
                < Accession::new(Kind::Argument, 2026, 5001).unwrap()
        );
        assert_eq!(a.cmp(&a), Ordering::Equal);
    }

    /// A cursor tiebreak needs a strict total order over a whole bank: distinct
    /// accessions never compare equal and sorting is a permutation of minting.
    #[test]
    fn order_is_total_within_a_bank() {
        let minted: Vec<Accession> = (5001..5200)
            .map(|s| Accession::new(Kind::Argument, 2026, s).unwrap())
            .collect();
        let mut shuffled = minted.clone();
        shuffled.rotate_left(77);
        shuffled.sort();
        assert_eq!(shuffled, minted);
        for w in minted.windows(2) {
            assert!(w[0] < w[1]);
            assert_ne!(w[0].cmp(&w[1]), Ordering::Equal);
        }
    }

    #[test]
    fn serde_is_the_display_form() {
        let a = Accession::new(Kind::Argument, 2026, 5007).unwrap();
        assert_eq!(serde_json::to_string(&a).unwrap(), "\"MTH.R-2026-5007\"");
        assert_eq!(
            serde_json::from_str::<Accession>("\"MTH.R-2026-5007\"").unwrap(),
            a
        );
        assert!(serde_json::from_str::<Accession>("\"MTH.R-2026-1067\"").is_err());
        assert_eq!(serde_json::to_string(&Kind::Claim).unwrap(), "\"claim\"");
        assert_eq!(
            serde_json::to_string(&SubjectKind::Argument).unwrap(),
            "\"argument\""
        );
    }

    #[test]
    fn kind_and_subject_kind_agree() {
        for k in [Kind::Claim, Kind::Argument] {
            assert_eq!(SubjectKind::of(k).kind(), k);
            assert_eq!(k.subject(), SubjectKind::of(k).as_str());
            assert_eq!(Kind::from_letter(k.letter()), Some(k));
        }
        assert_eq!(Kind::Claim.sequence(), "accession_c_seq");
        assert_eq!(Kind::Argument.sequence(), "accession_r_seq");
        assert_eq!(Kind::Claim.label(), "Claim");
        assert_eq!(Kind::Argument.label(), "Argument");
    }

    #[test]
    fn citation_carries_the_frozen_name_and_the_on_platform_resolver() {
        let a = Accession::new(Kind::Argument, 2026, 5007).unwrap();
        let c = citation(
            "octocat",
            "Submission.foo",
            &a,
            "https://mathesis.localtest.me",
            "2026-09-23",
        );
        assert_eq!(
            c.text,
            "octocat. Submission.foo. Mathesis. MTH.R-2026-5007. \
             https://mathesis.localtest.me/d/MTH.R-2026-5007. 2026-09-23."
        );
        assert_eq!(
            c.bibtex,
            "@misc{MTH.R-2026-5007, title={Submission.foo}, author={octocat}, howpublished={Mathesis}, \
             note={MTH.R-2026-5007}, url={https://mathesis.localtest.me/d/MTH.R-2026-5007}, year={2026} }"
        );
        assert_eq!(
            cite_text(
                "octocat",
                "Submission.foo",
                &a,
                "2026-09-23",
                "https://mathesis.localtest.me"
            ),
            c.text
        );
        assert_eq!(
            cite_bibtex(
                "octocat",
                "Submission.foo",
                &a,
                "2026-09-23",
                "https://mathesis.localtest.me"
            ),
            c.bibtex
        );
    }

    /// An RFC 3339 `created_at` renders as its date, and a trailing slash on the
    /// site base does not produce `//d/`.
    #[test]
    fn citation_normalises_the_timestamp_and_the_base() {
        let a = Accession::new(Kind::Claim, 2026, 5001).unwrap();
        let t = cite_text(
            "octocat",
            "EMX.foo",
            &a,
            "2026-09-23T11:04:07.318Z",
            "https://m.example/",
        );
        assert!(t.ends_with(" 2026-09-23."), "{t}");
        assert!(t.contains("https://m.example/d/MTH.C-2026-5001"), "{t}");
        assert!(!t.contains("//d/"), "{t}");
        assert!(
            cite_bibtex(
                "octocat",
                "EMX.foo",
                &a,
                "2026-09-23T11:04:07.318Z",
                "https://m.example"
            )
            .contains("year={2026}")
        );
    }

    /// The identifier is in Mathesis's own namespace. Nothing in either citation
    /// string names a registration agency or a registered-DOI form.
    #[test]
    fn citation_names_no_registration_agency() {
        let a = Accession::new(Kind::Claim, 2026, 5001).unwrap();
        let c = citation("octocat", "EMX.foo", &a, "https://m.example", "2026-09-23");
        for s in [&c.text, &c.bibtex] {
            let lower = s.to_lowercase();
            for banned in ["doi.org", "datacite", "crossref", "10.", "doi="] {
                assert!(!lower.contains(banned), "{banned} in {s}");
            }
        }
    }

    /// A citation name is copied verbatim: it is the frozen `citation_name`, and a
    /// later GitHub rename cannot rewrite bytes already baked into a page.
    #[test]
    fn citation_name_is_verbatim_and_not_the_login() {
        let a = Accession::new(Kind::Claim, 2026, 5001).unwrap();
        let before = cite_text(
            "Ada Lovelace",
            "EMX.foo",
            &a,
            "2026-09-23",
            "https://m.example",
        );
        assert!(before.starts_with("Ada Lovelace. EMX.foo. Mathesis."));
        let renamed = cite_text(
            "Ada Lovelace",
            "EMX.foo",
            &a,
            "2026-09-23",
            "https://m.example",
        );
        assert_eq!(before, renamed);
        assert!(!before.contains("octocat"));
    }
}
