import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { signState, verifyState } from "./state.js";
import { buildAuthorizeUrl, exchangeCode, fetchGitHubUser, isAllowedUser } from "./github.js";
import type { GitHubAuthEnv } from "./github.js";

/**
 * The env slice the handler reads: the GitHub secrets plus the state-signing key and the OAuth
 * provider's helper API. Structural (no deployment `Env` import) so the handler wires into any
 * entry point whose env carries these fields.
 */
export interface GitHubHandlerEnv extends GitHubAuthEnv {
  /** HMAC key used to sign the OAuth `state` carried across the GitHub round-trip (secret). */
  STATE_SIGNING_KEY: string;
  /** Callback API into the OAuth provider (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Minimal HTML-escape for values interpolated into the consent page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The GitHub callback path, derived from the incoming request origin. NOTE: a GitHub OAuth app
 * accepts a SINGLE callback URL — the setup guide must have the user register exactly
 * `https://<their-worker-host>/callback`.
 */
function callbackUri(url: URL): string {
  return `${url.origin}/callback`;
}

/**
 * Step 1 — consent. Parse the MCP client's OAuth request, show which client is asking, and carry
 * the request forward in a signed hidden field. Showing the client name before bouncing the user
 * to GitHub is the confused-deputy mitigation (RFC 9700 / Cloudflare securing-mcp guidance).
 */
async function renderConsent(request: Request, env: GitHubHandlerEnv): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  const carrier = await signState(oauthReq, env.STATE_SIGNING_KEY);
  const clientName = escapeHtml(client?.clientName ?? oauthReq.clientId);

  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>lemurkit — authorize</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
.card{border:1px solid #ddd;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer}
code{background:#f3f3f3;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><div class="card">
<h1>Authorize access</h1>
<p><strong>${clientName}</strong> is requesting access to this <code>lemurkit</code> storage connector.</p>
<p>You will sign in with GitHub. Access is granted only to the allowlisted account.</p>
<form method="post" action="/authorize">
<input type="hidden" name="carrier" value="${escapeHtml(carrier)}">
<button type="submit">Continue with GitHub</button>
</form>
</div></body></html>`);
}

/**
 * Step 2 — begin GitHub login. Verify the carried request, then redirect the browser to GitHub
 * with a signed `state` so the callback can recover the request tamper-proof.
 */
async function startGitHubLogin(
  request: Request,
  env: GitHubHandlerEnv,
  url: URL,
): Promise<Response> {
  const form = await request.formData();
  const carrier = form.get("carrier");
  if (typeof carrier !== "string") {
    return html("<p>Missing authorization context.</p>", 400);
  }
  const oauthReq = await verifyState<AuthRequest>(carrier, env.STATE_SIGNING_KEY);
  if (!oauthReq) {
    return html("<p>Invalid or tampered authorization context.</p>", 400);
  }
  const state = await signState(oauthReq, env.STATE_SIGNING_KEY);
  return Response.redirect(buildAuthorizeUrl(env, callbackUri(url), state), 302);
}

/**
 * Step 3 — GitHub callback. Recover the request, exchange the code, identify the user, enforce the
 * allowlist, and (only then) issue our own grant via the OAuth provider.
 */
async function handleCallback(env: GitHubHandlerEnv, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return html("<p>Missing code or state.</p>", 400);
  }
  const oauthReq = await verifyState<AuthRequest>(state, env.STATE_SIGNING_KEY);
  if (!oauthReq) {
    return html("<p>Invalid or tampered state.</p>", 400);
  }

  const githubToken = await exchangeCode(env, code, callbackUri(url));
  const user = await fetchGitHubUser(githubToken);

  if (!isAllowedUser(user, env)) {
    return html("<p>This GitHub account is not authorized for this connector.</p>", 403);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: String(user.id),
    metadata: { username: user.login },
    scope: oauthReq.scope,
    props: { userId: user.id, username: user.login, name: user.name ?? user.login },
  });
  return Response.redirect(redirectTo, 302);
}

/**
 * The OAuthProvider `defaultHandler`: serves the authorization UI and the GitHub callback. The
 * provider itself owns `/token`, `/register`, and the `.well-known` metadata endpoints.
 */
export const GitHubHandler = {
  async fetch(request: Request, env: GitHubHandlerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") {
      return renderConsent(request, env);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      return startGitHubLogin(request, env, url);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(env, url);
    }
    return new Response("Not found", { status: 404 });
  },
};
