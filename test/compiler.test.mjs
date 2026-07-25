import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CompilerWorker, verifyGrantSet } from "../src/compiler.mjs";

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function zip(entries) {
  const out = [];
  const central = [];
  for (const entry of entries) {
    const path = new TextEncoder().encode(entry.path);
    const bytes = entry.bytes;
    const crc = crc32(bytes);
    const offset = out.length;
    u32(out, 0x04034b50); u16(out, 20); u16(out, 0x800); u16(out, 0);
    u16(out, 0); u16(out, 0); u32(out, crc); u32(out, bytes.length);
    u32(out, bytes.length); u16(out, path.length); u16(out, 0);
    out.push(...path, ...bytes);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0x800);
    u16(central, 0); u16(central, 0); u16(central, 0); u32(central, crc);
    u32(central, bytes.length); u32(central, bytes.length); u16(central, path.length);
    u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0);
    u32(central, offset); central.push(...path);
  }
  const centralOffset = out.length;
  out.push(...central);
  u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, entries.length);
  u16(out, entries.length); u32(out, central.length); u32(out, centralOffset); u16(out, 0);
  return Uint8Array.from(out);
}

function fixture() {
  const catalog = "a".repeat(64);
  const manifestSha256 = "b".repeat(64);
  const mod = { path: "instance/mods/example.jar", bytes: Uint8Array.from([1, 2, 3]) };
  const files = [
    mod,
    { path: "resolved/loader.json", bytes: json({
      minecraftVersion: "1.21.1",
      loader: { kind: "fabric", version: "0.16.10" },
      javaRequirement: { component: "java-runtime-delta", major: 21 },
      runtimeCatalog: { sha256: catalog },
    }) },
    { path: "resolved/mods.json", bytes: json([]) },
    { path: "resolved/artifacts.json", bytes: json({
      schemaVersion: 1,
      artifacts: [{
        intent: "mod",
        path: mod.path,
        sha256: sha(mod.bytes),
        sizeBytes: mod.bytes.length,
      }],
    }) },
    { path: "resolved/version.json", bytes: json({
      minecraftVersion: "1.21.1",
      javaVersion: { component: "java-runtime-delta", majorVersion: 21 },
    }) },
  ];
  const manifest = {
    schemaVersion: 1,
    instanceName: "pack",
    minecraftVersion: "1.21.1",
    loader: { kind: "fabric", version: "0.16.10" },
    javaRequirement: { component: "java-runtime-delta", major: 21 },
    runtimeCatalog: { sha256: catalog },
    files: files.map((file) => ({
      path: file.path,
      sha256: sha(file.bytes),
      sizeBytes: file.bytes.length,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const archive = zip([{ path: "bundle.json", bytes: json(manifest) }, ...files]);
  const job = {
    accountId: "account_1",
    serviceId: "service_1",
    deploymentId: "deployment_1",
    compilerRequestId: "request_1",
    manifestSha256,
    expectedContentKey: `shared-hosting/account_1/service_1/compiler-content/${manifestSha256}.tar.zst`,
    frozenManifest: {
      schemaVersion: 1,
      sourceFormat: "xmcl_server_bundle",
      importId: "import_1",
      archive: {
        key: "shared-hosting/account_1/service_1/compiler-inputs/import_1.xmcl-server-bundle",
        sha256: sha(archive),
        sizeBytes: archive.length,
      },
      compatibility: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        loaderVersion: "0.16.10",
        java: { component: "java-runtime-delta", major: 21 },
        runtimeCatalog: { sha256: catalog },
      },
    },
  };
  const grants = {
    accountId: job.accountId,
    serviceId: job.serviceId,
    deploymentId: job.deploymentId,
    manifestSha256: job.manifestSha256,
    grants: [
      {
        key: job.frozenManifest.archive.key,
        method: "GET",
        url: "https://object.example/input",
        expiresAt: "2026-07-25T00:10:00.000Z",
      },
      {
        key: job.expectedContentKey,
        method: "PUT",
        url: "https://object.example/output",
        expiresAt: "2026-07-25T00:10:00.000Z",
        headers: { "if-none-match": "*" },
      },
    ],
  };
  return { archive, job, grants };
}

test("grant verification rejects substituted node or output grants", () => {
  const { job, grants } = fixture();
  assert.equal(verifyGrantSet(grants, job).output.key, job.expectedContentKey);
  assert.throws(
    () => verifyGrantSet({ ...grants, grants: [{ ...grants.grants[0], key: "world/revision" }, grants.grants[1]] }, job),
    /invalid_grants/,
  );
});

test("the unavailable builder reports a durable failure and never executes the bundle launcher", async () => {
  const { archive, job, grants } = fixture();
  const failures = [];
  let requestedUrl;
  const worker = new CompilerWorker({
    controlPlane: {
      getGrants: async () => grants,
      publish: async () => assert.fail("publish must not run without reviewed builder assets"),
      failed: async (failure) => failures.push(failure),
    },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(archive, {
        headers: { "content-length": String(archive.length) },
      });
    },
  });
  const result = await worker.run(job);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "compiler_unavailable");
  assert.equal(requestedUrl, grants.grants[0].url);
  assert.deepEqual(failures, [{
    deploymentId: job.deploymentId,
    manifestSha256: job.manifestSha256,
    code: "compiler_unavailable",
  }]);
});

function u16(out, value) {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

function u32(out, value) {
  u16(out, value & 0xffff);
  u16(out, value >>> 16);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
