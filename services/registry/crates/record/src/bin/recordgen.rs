//! `recordgen --bank <dir> --out <dir> [--site-base URL] [--base-path /p] [--about FILE] [--check]`
//!
//! Renders the verified record from the committed bank manifests. The output is
//! a pure function of the bank, the About body and the generator version.

use record::{generate_snapshot, GenOpts, Snapshot};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut bank: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut opts = GenOpts { leak_scan: true, ..GenOpts::default() };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut next = |name: &str| args.next().unwrap_or_else(|| panic!("{name} needs a value"));
        match a.as_str() {
            "--bank" => bank = Some(next("--bank").into()),
            "--out" => out = Some(next("--out").into()),
            "--site-base" => opts.site_base = next("--site-base"),
            "--base-path" => opts.base_path = next("--base-path"),
            "--about" => opts.about_body = Some(next("--about").into()),
            "--check" => opts.check = true,
            "--no-leak-scan" => opts.leak_scan = false,
            other => {
                eprintln!("recordgen: unknown argument `{other}`");
                return ExitCode::from(2);
            }
        }
    }
    let (Some(bank), Some(out)) = (bank, out) else {
        eprintln!("usage: recordgen --bank <dir> --out <dir> [--site-base URL] [--base-path /p] [--about FILE] [--check]");
        return ExitCode::from(2);
    };
    let snapshot = match Snapshot::from_dir(&bank, &opts) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("recordgen: {e}");
            return ExitCode::from(1);
        }
    };
    match generate_snapshot(&snapshot, &out, &opts) {
        Ok(m) => {
            println!(
                "recordgen: {} pages, {} claims, {} arguments, {} posts -> {}",
                m.counts.pages,
                m.counts.claims,
                m.counts.arguments,
                m.counts.posts,
                out.display()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("recordgen: {e}");
            ExitCode::from(1)
        }
    }
}
