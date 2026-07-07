/**
 * The "deployed but not yet configured" guard.
 *
 * The Worker necessarily deploys BEFORE its OAuth secrets can exist: the identity provider's
 * app registration needs the deployed URL as its callback, so a fresh deploy always runs
 * secretless for a while. Without a guard that window is hostile — `/authorize` 500s deep inside
 * the HMAC state signer, and a missing client id produces a broken IdP redirect rather than an
 * error. The guard wraps the WHOLE entry point (the OAuth provider owns `/token`, `/register`,
 * and `.well-known` too, and MCP clients hit those first), so every route degrades to one clear
 * answer: which secret names are missing and where the setup guide is.
 *
 * Names only, never values — the response must not become a secret oracle.
 */

/** The secret names that are unset or empty on this env. Pure and unit-testable. */
export function missingConfig(env: unknown, required: readonly string[]): string[] {
  const record = env as Record<string, unknown>;
  return required.filter((name) => {
    const value = record[name];
    return typeof value !== "string" || value.length === 0;
  });
}

const SETUP_HINT =
  "Set each missing secret with `wrangler secret put <NAME>` (or the Cloudflare dashboard), " +
  "then retry. The README setup guide walks through registering the OAuth app and every secret.";

/** Escape text for HTML interpolation — the hint carries `<NAME>`, which browsers eat as a tag. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The not-configured response: JSON for `/mcp` / API callers, an HTML checklist for browsers. */
export function notConfigured(request: Request, missing: readonly string[]): Response {
  const url = new URL(request.url);
  const wantsJson =
    url.pathname === "/mcp" || (request.headers.get("accept") ?? "").includes("application/json");
  if (wantsJson) {
    return new Response(
      JSON.stringify({ error: "not_configured", missing: [...missing], hint: SETUP_HINT }, null, 2),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  const items = missing.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("\n");
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not configured yet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
.card{border:1px solid #ddd;border-radius:12px;padding:1.5rem}code{background:#f3f3f3;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><div class="card">
<h1>Deployed, but not configured yet</h1>
<p>This connector is running, but ${missing.length === 1 ? "a required secret is" : `${missing.length} required secrets are`} missing:</p>
<ul>
${items}
</ul>
<p>${escapeHtml(SETUP_HINT)}</p>
</div></body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** A fetch-shaped handler, structurally — the OAuth provider instance satisfies this. */
interface FetchHandler<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}

/**
 * Wrap an entry point so EVERY route answers clearly while required secrets are absent, and
 * behaves exactly as before once they're set. Checking per-request (not at module scope) means
 * `wrangler secret put` takes effect without a redeploy.
 */
export function withConfigGuard<E>(
  required: readonly string[],
  inner: FetchHandler<E>,
): FetchHandler<E> {
  return {
    fetch(request, env, ctx) {
      const missing = missingConfig(env, required);
      if (missing.length > 0) return notConfigured(request, missing);
      return inner.fetch(request, env, ctx);
    },
  };
}
