import { describe, expect, it, vi } from "vitest";
import { missingConfig, notConfigured, withConfigGuard } from "../src/config-guard";

/**
 * The "deployed but not yet configured" guard. Contract: while any required secret is absent,
 * EVERY route answers 503 naming the missing secret NAMES (never values) — JSON for `/mcp` /
 * API callers, an HTML checklist for browsers — and once all secrets exist, requests pass
 * through to the wrapped handler untouched.
 */

const REQUIRED = ["CLIENT_ID", "CLIENT_SECRET", "SIGNING_KEY"] as const;

describe("missingConfig", () => {
  it("reports absent and empty-string secrets, in required order", () => {
    expect(missingConfig({}, REQUIRED)).toEqual(["CLIENT_ID", "CLIENT_SECRET", "SIGNING_KEY"]);
    expect(missingConfig({ CLIENT_ID: "x", CLIENT_SECRET: "" }, REQUIRED)).toEqual([
      "CLIENT_SECRET",
      "SIGNING_KEY",
    ]);
  });

  it("reports nothing when every secret is a non-empty string", () => {
    expect(
      missingConfig({ CLIENT_ID: "a", CLIENT_SECRET: "b", SIGNING_KEY: "c" }, REQUIRED),
    ).toEqual([]);
  });

  it("treats non-string values (a binding, an object) as missing", () => {
    expect(missingConfig({ CLIENT_ID: {}, CLIENT_SECRET: 42, SIGNING_KEY: "c" }, REQUIRED)).toEqual(
      ["CLIENT_ID", "CLIENT_SECRET"],
    );
  });
});

describe("notConfigured", () => {
  it("answers /mcp with 503 JSON naming the missing secrets", async () => {
    const res = notConfigured(new Request("https://w.example/mcp"), ["CLIENT_ID"]);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string; missing: string[]; hint: string };
    expect(body.error).toBe("not_configured");
    expect(body.missing).toEqual(["CLIENT_ID"]);
    expect(body.hint).toContain("wrangler secret put");
  });

  it("answers JSON to any path when the caller Accepts json", async () => {
    const res = notConfigured(
      new Request("https://w.example/token", { headers: { accept: "application/json" } }),
      ["SIGNING_KEY"],
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { missing: string[] }).missing).toEqual(["SIGNING_KEY"]);
  });

  it("answers browsers with a 503 HTML checklist of the missing secret names", async () => {
    const res = notConfigured(new Request("https://w.example/authorize"), [
      "CLIENT_ID",
      "SIGNING_KEY",
    ]);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("CLIENT_ID");
    expect(body).toContain("SIGNING_KEY");
    expect(body).toContain("setup guide");
  });

  it("escapes the hint's `<NAME>` placeholder so browsers render it instead of eating it", async () => {
    const res = notConfigured(new Request("https://w.example/authorize"), ["CLIENT_ID"]);
    const body = await res.text();
    expect(body).toContain("wrangler secret put &lt;NAME&gt;");
    expect(body).not.toContain("wrangler secret put <NAME>");
  });

  it("never echoes secret VALUES, only names", async () => {
    // The guard only ever receives names; this pins the response shape so a refactor can't
    // start reflecting env content.
    const res = notConfigured(new Request("https://w.example/mcp"), ["CLIENT_ID"]);
    const body = await res.text();
    expect(body).not.toContain("super-secret-value");
  });
});

describe("withConfigGuard", () => {
  const ctx = {} as ExecutionContext;

  it("short-circuits every route while a secret is missing — the inner handler never runs", async () => {
    const inner = { fetch: vi.fn(async () => new Response("inner")) };
    const guarded = withConfigGuard(REQUIRED, inner);

    for (const path of ["/mcp", "/authorize", "/token", "/register", "/.well-known/x"]) {
      const res = await guarded.fetch(
        new Request(`https://w.example${path}`),
        { CLIENT_ID: "x" },
        ctx,
      );
      expect(res.status).toBe(503);
    }
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("delegates untouched once every secret is present", async () => {
    const inner = { fetch: vi.fn(async () => new Response("inner")) };
    const guarded = withConfigGuard(REQUIRED, inner);
    const env = { CLIENT_ID: "a", CLIENT_SECRET: "b", SIGNING_KEY: "c" };
    const request = new Request("https://w.example/mcp");

    const res = await guarded.fetch(request, env, ctx);

    expect(await res.text()).toBe("inner");
    expect(inner.fetch).toHaveBeenCalledWith(request, env, ctx);
  });
});
