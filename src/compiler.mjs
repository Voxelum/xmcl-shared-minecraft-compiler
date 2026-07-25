import { createHash } from "node:crypto";
import { CompilerFailure, MAX_BUNDLE_BYTES, validateBundle } from "./bundle.mjs";

const failureCodes = new Set([
  "unsupported_compatibility",
  "compiler_unavailable",
  "compiler_failed",
]);

/**
 * Control-plane interface. Its implementation uses a workload identity (mTLS
 * or equivalent) outside this repository; it must never accept an object-store
 * master credential, node grant, or browser credential.
 */
export class CompilerWorker {
  constructor({ controlPlane, builder = new FailClosedRuntimeBuilder(), fetchImpl = fetch }) {
    this.controlPlane = controlPlane;
    this.builder = builder;
    this.fetch = fetchImpl;
  }

  async run(job) {
    try {
      validateJob(job);
      const grants = await this.controlPlane.getGrants(job.deploymentId);
      const { input, output } = verifyGrantSet(grants, job);
      const archive = await downloadExact(this.fetch, input, job.frozenManifest.archive);
      const bundle = await validateBundle(archive, job.frozenManifest);
      const built = await this.builder.build({
        bundle,
        frozenManifest: job.frozenManifest,
        expectedContentKey: job.expectedContentKey,
      });
      verifyBuiltContent(built, job);
      await uploadExact(this.fetch, output, built.archive);
      await this.controlPlane.publish({
        deploymentId: job.deploymentId,
        manifestSha256: job.manifestSha256,
        content: built.content,
        descriptor: built.descriptor,
      });
      return { status: "published", deploymentId: job.deploymentId };
    } catch (error) {
      const code = classifyFailure(error);
      await this.controlPlane.failed({
        deploymentId: job?.deploymentId,
        manifestSha256: job?.manifestSha256,
        code,
      }).catch(() => undefined);
      return { status: "failed", code };
    }
  }
}

/**
 * Explicitly prevents a deployment from pretending that local Java, a Docker
 * daemon, or arbitrary Internet downloads can build a customer runtime.
 */
export class FailClosedRuntimeBuilder {
  async build() {
    throw new CompilerFailure("compiler_unavailable");
  }
}

export function verifyGrantSet(grants, job) {
  if (!grants || grants.accountId !== job.accountId ||
    grants.serviceId !== job.serviceId || grants.deploymentId !== job.deploymentId ||
    grants.manifestSha256 !== job.manifestSha256 || !Array.isArray(grants.grants)) {
    throw new CompilerFailure("invalid_grants");
  }
  const input = grants.grants.find((grant) => grant.method === "GET");
  const output = grants.grants.find((grant) => grant.method === "PUT");
  if (
    grants.grants.length !== 2 || !input || !output ||
    input.key !== job.frozenManifest.archive.key ||
    output.key !== job.expectedContentKey ||
    !isExactSignedGrant(input, "GET") || !isExactSignedGrant(output, "PUT") ||
    output.headers?.["if-none-match"] !== "*" ||
    Object.keys(output.headers ?? {}).length !== 1
  ) throw new CompilerFailure("invalid_grants");
  return { input, output };
}

export async function downloadExact(fetchImpl, grant, expected) {
  const response = await fetchImpl(grant.url, {
    method: "GET",
    headers: grant.headers,
    redirect: "error",
  });
  if (!response.ok) throw new CompilerFailure("input_download_failed");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BUNDLE_BYTES ||
    length !== expected.sizeBytes) {
    throw new CompilerFailure("input_size_mismatch");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expected.sizeBytes || sha256(bytes) !== expected.sha256) {
    throw new CompilerFailure("input_hash_mismatch");
  }
  return bytes;
}

async function uploadExact(fetchImpl, grant, archive) {
  const response = await fetchImpl(grant.url, {
    method: "PUT",
    headers: grant.headers,
    body: archive,
    redirect: "error",
  });
  if (!response.ok) throw new CompilerFailure("content_upload_failed");
}

function validateJob(job) {
  if (!job || typeof job !== "object" ||
    !validId(job.accountId) || !validId(job.serviceId) || !validId(job.deploymentId) ||
    !validSha256(job.manifestSha256) || !validId(job.compilerRequestId) ||
    typeof job.expectedContentKey !== "string" ||
    job.frozenManifest?.sourceFormat !== "xmcl_server_bundle") {
    throw new CompilerFailure("invalid_job");
  }
  const archive = job.frozenManifest?.archive;
  if (!archive || !validSha256(archive.sha256) ||
    !Number.isSafeInteger(archive.sizeBytes) || archive.sizeBytes < 1 ||
    archive.sizeBytes > MAX_BUNDLE_BYTES || typeof archive.key !== "string") {
    throw new CompilerFailure("invalid_job");
  }
  const prefix = `shared-hosting/${job.accountId}/${job.serviceId}/`;
  if (
    archive.key !== `${prefix}compiler-inputs/${job.frozenManifest.importId}.xmcl-server-bundle` ||
    job.expectedContentKey !== `${prefix}compiler-content/${job.manifestSha256}.tar.zst`
  ) {
    throw new CompilerFailure("invalid_job");
  }
}

function verifyBuiltContent(built, job) {
  if (!built || !(built.archive instanceof Uint8Array) ||
    !built.content || built.content.key !== job.expectedContentKey ||
    built.descriptor?.launch?.path !== ".xmcl/launch.sh" ||
    built.descriptor?.launch?.kind !== "generated-server-launcher" ||
    !Array.isArray(built.descriptor?.launch?.arguments) ||
    built.descriptor.launch.arguments.length !== 0) {
    throw new CompilerFailure("invalid_builder_output");
  }
}

function isExactSignedGrant(grant, method) {
  return grant && grant.method === method && typeof grant.key === "string" &&
    typeof grant.url === "string" && /^https:\/\//.test(grant.url) &&
    typeof grant.expiresAt === "string";
}

function classifyFailure(error) {
  if (error instanceof CompilerFailure && error.code === "unsupported_compatibility") {
    return "unsupported_compatibility";
  }
  if (error instanceof CompilerFailure && error.code === "compiler_unavailable") {
    return "compiler_unavailable";
  }
  return failureCodes.has(error?.code) ? error.code : "compiler_failed";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    !/[\x00-\x1f\x7f]/.test(value);
}
