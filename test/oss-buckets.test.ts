import { describe, expect, it } from "vitest";
import { ossBuckets as buckets } from "./oss-under-test";

/**
 * Shape contract for the OSS build's `list_buckets` store directory — the public counterpart of
 * bucket-directory.test.ts (which pins the private registry and never ships). The OSS registry
 * must expose exactly ONE generic store: instance topology is private-deployment config and
 * never leaves the private repo (design decision: "instance topology never ships").
 */

describe("OSS bucket registry — the one-bucket public directory", () => {
  it("exposes exactly one store, and it is the default", () => {
    const dir = buckets.bucketDirectory();
    expect(dir).toHaveLength(1);
    expect(dir[0]?.name).toBe("storage");
    expect(dir[0]?.default).toBe(true);
    expect((dir[0]?.description ?? "").length).toBeGreaterThan(0);
  });

  it("resolves the default and the explicit name to the BUCKET binding", () => {
    const marker = { marker: true } as unknown as R2Bucket;
    const env = { BUCKET: marker } as Parameters<typeof buckets.resolveBucket>[0];
    expect(buckets.resolveBucket(env, undefined)).toBe(marker);
    expect(buckets.resolveBucket(env, "storage")).toBe(marker);
    expect(buckets.resolveBucketName(undefined)).toBe("storage");
  });

  it("rejects an unknown bucket name for direct callers (zod rejects it at the tool layer)", () => {
    const env = { BUCKET: {} as R2Bucket } as Parameters<typeof buckets.resolveBucket>[0];
    expect(() => buckets.resolveBucket(env, "nope")).toThrow(/unknown bucket/);
  });
});
