# XMCL shared Minecraft compiler

This repository owns the egress-isolated compiler worker boundary. It accepts a
deployment identity, obtains exactly one compiler input GET grant and one
immutable content PUT grant from the control plane, then revalidates the
`.xmcl-server-bundle` before any builder can see it.

The bundle is a content-and-metadata handoff from an already-working modded
client instance, not a local dedicated-server export. It carries selected
instance artifacts and their hashes plus loader/version metadata; a reviewed
builder must assemble the dedicated-server runtime independently.

`FailClosedRuntimeBuilder` remains the default. A deployment can explicitly
compose `ReviewedRuntimeBuilder` (or `createReviewedCompilerWorker`) only with:

- a versioned `ReviewedToolchainCatalog` bound to the exact raw runtime-catalog
  SHA, exact loader coordinate, approved HTTPS host, artifact URL, size, and
  SHA-256;
- a verified, read-only JRE registry whose selected root matches the catalog's
  component, major, digest, and runtime-catalog revision;
- a sandbox adapter that attests to an ephemeral non-root workspace, read-only
  base filesystem, no secrets or Docker socket, bounded resources, and disabled
  installer network; and
- an exact-artifact downloader. `StrictArtifactDownloader` rejects non-HTTPS or
  unapproved hosts, redirects, absent/wrong sizes, timeout, and hash mismatch.

The catalog supports deterministic Forge, Fabric, NeoForge, and Quilt assembly
plans. The compiler owns the plan and launcher arguments; it never executes
`server.sh`, local Java paths, Docker options, launcher-provided JVM arguments,
or a catalog-provided command.

Successful reviewed builds copy only revalidated server-relevant local content,
generate `.xmcl/runtime.json` and `.xmcl/launch.sh`, and emit a deterministic
USTAR stream in a valid raw Zstandard frame (`.tar.zst`). Before the immutable
PUT, the worker rechecks every packaged output path, mode, size, SHA-256,
runtime descriptor, and generated launcher.

`DeterministicFakeArtifactDownloader`, `DeterministicFakeJreRegistry`, and
`DeterministicFakeSandboxRunner` are test doubles only. No production sandbox,
JRE root, reviewed catalog, or artifact mirror is bundled here; missing or
invalid injected dependencies return `compiler_unavailable`.

Local-world migration is a separate `.xmcl-world-seed` path. `WorldSeedWorker`
accepts exactly one control-plane-issued GET grant bound to an account, service,
seed ID, archive key, size, and SHA-256; it has no list/delete grant and the
default `FailClosedWorldSeedHandler` cannot unpack or restore anything. A
production handler must validate the archive again, restore only the selected
initial world supplied on a first-start command, and atomically refuse existing
or completed runtime worlds.

## Deployment prerequisites

- Run the image as the non-root user already declared in the Dockerfile with a
  read-only root filesystem, an ephemeral writable workspace, no Docker socket,
  no host mounts, and PID/CPU/memory limits.
- Use mTLS or an equivalent workload identity for the three internal control
  plane callbacks: grant retrieval, immutable publish, and durable failure
  reporting. Do not inject browser, node, billing, or object-store master
  credentials.
- Permit HTTPS egress only to reviewed artifact origins while a future reviewed
  builder acquires exact catalog artifacts; disable egress before server-loader
  assembly.
- The API owns durable deployment state. Retries use the same deployment ID,
  manifest SHA, exact input key, and immutable `If-None-Match: *` output grant.
- Install real reviewed Forge/Fabric/NeoForge/Quilt artifacts, approved mirror
  allowlists, matching verified JRE roots, and a sandbox adapter that enforces
  the requested attestations before composing the reviewed builder. Until then,
  retain the default fail-closed worker.

Run `npm test` and `npm run check` locally. This package intentionally does not
claim live loader compilation until those external reviewed adapters exist.

## Reviewed toolchain catalog

`toolchain-catalog.lock.json` is generated only from the reviewed
`xmcl-shared-minecraft-runtime/runtime-catalog.lock.json` and official loader
metadata. The catalog revision is the SHA-256 of its canonical JSON projection
with `catalogRevision` zeroed, avoiding a self-referential digest while keeping
the tracked lock deterministic and reviewable.

```text
node scripts/update_toolchain_catalog.mjs \
  --runtime-catalog-lock ..\xmcl-shared-minecraft-runtime\runtime-catalog.lock.json
node scripts/validate_toolchain_catalog.mjs \
  --runtime-catalog-lock ..\xmcl-shared-minecraft-runtime\runtime-catalog.lock.json
```

Generation permits only the explicit compatibility candidates in
`src/toolchain-catalog.mjs`. It downloads official metadata and the exact
approved artifacts with HTTPS-only, no-redirect, bounded-size requests; it
verifies published SHA-1 checksums where available, then records each artifact's
computed SHA-256 and byte size. Validation rejects an unbound runtime revision,
unselected Java component/major, unsupported URL/host/path, duplicate tuple,
incorrect template, or missing primary/Mojang server artifact.

The weekly workflow only validates and refreshes this lock, then opens a review
PR if it changed. It does not compose a compiler worker, run installers, build
or publish an image, upload content, or provision infrastructure.
