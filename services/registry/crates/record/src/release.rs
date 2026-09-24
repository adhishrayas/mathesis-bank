//! Releases and the atomic swap.
//!
//! A generation is written to `<out>.tmp.<n>` and published by renaming a
//! symlink over `<out>`, so `webd` never serves a half-written tree. A release
//! is pruned only when it is outside the newest five **and** older than five
//! minutes — strictly greater than the 60 s grace `mathesisd serve` gives a
//! retired Tantivy reader, so no reader ever holds an unlinked directory
//! (SPEC.md §10).

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const KEEP: usize = 5;
pub const MIN_AGE: Duration = Duration::from_secs(300);

fn prefix(out: &Path) -> io::Result<(PathBuf, String)> {
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let name = out
        .file_name()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the record path has no file name",
            )
        })?
        .to_string_lossy()
        .into_owned();
    Ok((parent, name))
}

/// Every release directory beside `out`, newest serial first.
pub fn releases(out: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let (parent, name) = prefix(out)?;
    let marker = format!("{name}.tmp.");
    let mut v = Vec::new();
    let dir = match std::fs::read_dir(&parent) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(v),
        Err(e) => return Err(e),
    };
    for e in dir {
        let e = e?;
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(tail) = n.strip_prefix(&marker) {
            if let Ok(serial) = tail.parse::<u64>() {
                v.push((serial, e.path()));
            }
        }
    }
    v.sort_by_key(|(serial, _)| std::cmp::Reverse(*serial));
    Ok(v)
}

/// The next serial. Serials are a counter, never a clock, so a release name is
/// as reproducible as its contents.
pub fn next(out: &Path) -> io::Result<PathBuf> {
    let (parent, name) = prefix(out)?;
    std::fs::create_dir_all(&parent)?;
    let n = releases(out)?.first().map(|(n, _)| n + 1).unwrap_or(1);
    let mut serial = n;
    loop {
        let p = parent.join(format!("{name}.tmp.{serial}"));
        if !p.exists() {
            std::fs::create_dir_all(&p)?;
            return Ok(p);
        }
        serial += 1;
    }
}

/// The directory `out` currently resolves to, if it is a published symlink.
pub fn live(out: &Path) -> Option<PathBuf> {
    let target = std::fs::read_link(out).ok()?;
    Some(if target.is_absolute() {
        target
    } else {
        out.parent().unwrap_or(Path::new(".")).join(target)
    })
}

/// Publish a release: create the new link beside the old one and rename it over
/// it, which is atomic on a POSIX filesystem.
pub fn swap(out: &Path, release: &Path) -> io::Result<()> {
    let (parent, name) = prefix(out)?;
    let target = release
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| release.to_path_buf());
    let staged = parent.join(format!(".{name}.swap"));
    let _ = std::fs::remove_file(&staged);
    std::os::unix::fs::symlink(&target, &staged)?;
    if out.exists() && std::fs::read_link(out).is_err() {
        let _ = std::fs::remove_file(&staged);
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} is a directory, not the published symlink",
                out.display()
            ),
        ));
    }
    std::fs::rename(&staged, out)
}

/// Remove the releases that are both outside the newest `KEEP` and older than
/// `MIN_AGE`, never the one the symlink points at.
pub fn prune(out: &Path) -> io::Result<Vec<PathBuf>> {
    let current = live(out);
    let now = SystemTime::now();
    let mut removed = Vec::new();
    for (i, (_, path)) in releases(out)?.into_iter().enumerate() {
        if i < KEEP {
            continue;
        }
        if current.as_deref() == Some(path.as_path()) {
            continue;
        }
        let age = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok());
        if age.is_none_or(|a| a < MIN_AGE) {
            continue;
        }
        std::fs::remove_dir_all(&path)?;
        removed.push(path);
    }
    Ok(removed)
}
