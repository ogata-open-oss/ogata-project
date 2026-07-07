import { describe, expect, it } from "vitest";
import { ossEntry } from "./oss-under-test";

/**
 * Smoke test for the OSS entry point: proves the config guard is actually WIRED into the
 * exported handler (config-guard.test.ts proves the guard works; this proves the OSS entry uses
 * it). An unconfigured env — exactly what a fresh Deploy-button deploy looks like before the
 * user registers the GitHub OAuth app — must answer `/mcp` with the structured not-configured
 * response, not an opaque error. (The MCP handler inside is imported lazily, which is what makes
 * the entry loadable here, outside the Workers runtime.)
 */

describe("OSS entry — first-run (secretless) behavior", () => {
  it("answers /mcp with 503 not_configured naming every missing GitHub secret", async () => {
    const res = await ossEntry.fetch(
      new Request("https://lemurkit.example.workers.dev/mcp"),
      {} as Parameters<typeof ossEntry.fetch>[1],
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.error).toBe("not_configured");
    expect(body.missing).toEqual([
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_ALLOWED_USERNAME",
      "GITHUB_ALLOWED_USER_ID",
      "STATE_SIGNING_KEY",
    ]);
  });

  it("answers the browser-facing /authorize with the HTML checklist", async () => {
    const res = await ossEntry.fetch(
      new Request("https://lemurkit.example.workers.dev/authorize"),
      {} as Parameters<typeof ossEntry.fetch>[1],
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("GITHUB_CLIENT_ID");
  });
});
