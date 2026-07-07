import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { buildServer } from "./server.js";
import { buckets } from "./buckets.js";
import { withConfigGuard } from "./config-guard.js";
import { GitHubHandler } from "./auth/github-handler.js";
import type { Env } from "./env.js";

/**
 * The OSS deployment's entry point: the shared lemurkit MCP server (see `server.ts`) over the
 * one-bucket registry (`buckets.ts`), gated by GitHub-delegated OAuth 2.1 + PKCE and a
 * single-account allowlist.
 *
 * First-run flow (the README setup guide walks through it): deploy → register a GitHub OAuth app
 * with callback `https://<your-worker-host>/callback` → set the secrets below → apply the D1
 * migrations → add `https://<your-worker-host>/mcp` as a custom connector in Claude. Until the
 * secrets exist, every route answers with a clear "not configured" checklist (see
 * `config-guard.ts`) instead of erroring.
 */

/** The secrets this deployment needs before any route can work — checked by the config guard. */
const REQUIRED_SECRETS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_ALLOWED_USERNAME",
  "GITHUB_ALLOWED_USER_ID",
  "STATE_SIGNING_KEY",
] as const;

/**
 * The MCP API handler — only reached for requests bearing a valid access token (the
 * OAuthProvider returns 401 otherwise). The tools are unchanged by auth: identity is enforced at
 * the gate, so by the time a request lands here the caller is the allowlisted user. The MCP HTTP
 * handler is imported lazily so this entry stays loadable outside the Workers runtime (that's
 * what lets the not-configured path be unit-tested); the bundler still resolves it statically.
 */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { createMcpHandler } = await import("agents/mcp");
    return createMcpHandler(buildServer(env, buckets))(request, env, ctx);
  },
};

/**
 * OAuth 2.1 + PKCE gate. The provider owns `/token`, `/register`, and the `.well-known`
 * metadata; `GitHubHandler` serves the `/authorize` consent UI and the GitHub `/callback`.
 * Authentication is delegated to GitHub and gated to a single allowlisted identity — see
 * `auth/github.ts`.
 */
const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: GitHubHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});

/**
 * Wrapped in the config guard: the Worker necessarily deploys BEFORE its OAuth app can exist
 * (the app registration needs the deployed URL as its callback), so the first-run window answers
 * every route with the missing-secrets checklist instead of opaque 500s.
 */
export default withConfigGuard<Env>(REQUIRED_SECRETS, provider);
