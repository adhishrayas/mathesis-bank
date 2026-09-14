# The untrusted-deposit build image.
#
#   docker build -t mathesis/lean-builder:v4.31.0 deploy/builder
#   MATHESIS_BUILDER_IMAGE=mathesis/lean-builder:v4.31.0 bash ci/gate_deposit.sh deposits/<slug>
#
# This image runs code submitted by strangers. Lean elaboration performs arbitrary IO at build
# time (`#eval`, `initialize`, elaboration macros), so the submission is arbitrary code
# execution by design — not a hypothetical.
#
# The image therefore carries the toolchain and NOTHING else. It is run by `gate_deposit.sh`
# with `--network none --read-only`, one writable mount, no inherited environment, and cpu /
# memory / pids limits. The confinement lives in those run flags; this file's job is to give
# them nothing extra to reach:
#
#   * no git, no curl, no gh, no cloud SDK — nothing that turns egress into exfiltration if a
#     future caller forgets `--network none`;
#   * no repository content, so the adjudicator binary, `init.export`, the exports directory and
#     the claim manifests are simply not present to be tampered with;
#   * a non-root user, so a container escape does not start as root on the host kernel.
#
# `ci/test_gate_isolation.sh` asserts those properties against the real `gate_deposit.sh`
# invocation using a hostile stand-in for `lean`, so the sandbox is tested without needing the
# toolchain.
FROM debian:bookworm-slim

# The pinned toolchain. Must match backend-gate/lean-toolchain and the deposit header's @pin,
# which ci/parse_deposit.py enforces byte-for-byte.
ARG LEAN_VERSION=v4.31.0

ENV DEBIAN_FRONTEND=noninteractive \
    ELAN_HOME=/opt/elan \
    PATH=/opt/elan/bin:$PATH

# curl and git are needed to INSTALL the toolchain and are removed afterwards: the running
# container must not carry tools that turn a networking mistake into exfiltration.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      -o /tmp/elan-init.sh; \
    sh /tmp/elan-init.sh -y --default-toolchain "leanprover/lean4:${LEAN_VERSION}" \
      --no-modify-path; \
    rm -f /tmp/elan-init.sh; \
    apt-get purge -y curl git; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /opt/elan/tmp/*; \
    lean --version

# Phase 2b adds the Mathlib olean cache here, keyed by (toolchain, mathlib_rev) so the image tag
# names the environment a deposit pins with @mathlib. Until then, deposits are Lean-core only.

# Non-root. The scratch mount is bind-mounted with the host's ownership, so the uid must be able
# to write it; gate_deposit.sh sets HOME=/work for the same reason.
RUN useradd --create-home --uid 10001 builder
USER builder
WORKDIR /work

# No ENTRYPOINT: gate_deposit.sh supplies the full command, including its own `timeout`, so the
# invocation stays visible in one place rather than split between here and the caller.
