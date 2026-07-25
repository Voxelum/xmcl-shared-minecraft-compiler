# XMCL shared Minecraft compiler

This repository owns the egress-isolated compiler worker boundary. It accepts a
deployment identity, obtains exactly one compiler input GET grant and one
immutable content PUT grant from the control plane, then revalidates the
`.xmcl-server-bundle` before any builder can see it.

`FailClosedRuntimeBuilder` is intentional: it always reports
`compiler_unavailable`. Production must not enable a builder until reviewed
loader/server toolchains, approved artifact origins, constrained egress,
workload identity, resource limits, and the matching runtime-catalog revision
are deployed. It never executes `server.sh`, local Java paths, Docker options,
or launcher-supplied JVM arguments.

## Deployment prerequisites

- Run the image as the non-root user already declared in the Dockerfile with a
  read-only root filesystem, an ephemeral writable workspace, no Docker socket,
  no host mounts, and PID/CPU/memory limits.
- Use mTLS or an equivalent workload identity for the three internal control
  plane callbacks: grant retrieval, immutable publish, and durable failure
  reporting. Do not inject browser, node, billing, or object-store master
  credentials.
- Permit HTTPS egress only to reviewed artifact origins while a future reviewed
  builder acquires artifacts; disable egress before server-loader assembly.
- The API owns durable deployment state. Retries use the same deployment ID,
  manifest SHA, exact input key, and immutable `If-None-Match: *` output grant.

Run `npm test` and `npm run check` locally. This skeleton is intentionally not
a deployable loader installer.
