/** GitHub as the upstream identity provider (github.com). */
const GITHUB_ORIGIN = "https://github.com";
const GITHUB_API = "https://api.github.com";

/**
 * GitHub's REST API rejects requests without a User-Agent (403) — and Workers' outbound `fetch`
 * does not add one, so it must be set explicitly on every api.github.com call.
 */
const USER_AGENT = "lemurkit-connector";

/**
 * The env slice the GitHub provider reads — structural on purpose (no import of a deployment's
 * `Env`), so these files typecheck against any entry point's env that carries the four secrets.
 */
export interface GitHubAuthEnv {
  /** GitHub OAuth app client id (secret — kept out of the repo to reduce disclosure). */
  GITHUB_CLIENT_ID: string;
  /** GitHub OAuth app client secret (secret). */
  GITHUB_CLIENT_SECRET: string;
  /** Allowlisted GitHub login — defence-in-depth half of the gate (secret). */
  GITHUB_ALLOWED_USERNAME: string;
  /** Allowlisted GitHub immutable numeric id, as a string — primary half of the gate (secret). */
  GITHUB_ALLOWED_USER_ID: string;
}

/** Subset of GitHub's `GET /user` response we rely on. */
export interface GitHubUser {
  /** Immutable numeric account id — never reassigned, unlike `login`. */
  id: number;
  /** Handle (GitHub calls it `login`, not `username`). User-changeable, and reusable after rename. */
  login: string;
  /** Display name — nullable on GitHub. */
  name: string | null;
}

/**
 * Build the GitHub authorization URL the user's browser is redirected to.
 *
 * No `scope` parameter on purpose: the allowlist gate needs only `id` + `login`, which are
 * public-profile fields readable with an empty scope — least privilege. (GitHub silently ignores
 * unknown scopes rather than erroring, so a copy-pasted non-GitHub scope would mask itself;
 * requesting none removes the trap.)
 */
export function buildAuthorizeUrl(env: GitHubAuthEnv, redirectUri: string, state: string): string {
  const url = new URL(`${GITHUB_ORIGIN}/login/oauth/authorize`);
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange an authorization code for a GitHub access token (confidential client).
 *
 * Two GitHub-specific traps a generic OAuth port falls into: the token endpoint answers
 * form-encoded unless `Accept: application/json` is sent, and it returns HTTP 200 on FAILURE
 * (e.g. `{"error":"bad_verification_code"}`) — so `res.ok` alone proves nothing and the parsed
 * body must be checked for an `error` / missing `access_token`.
 */
export async function exchangeCode(
  env: GitHubAuthEnv,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_ORIGIN}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error ?? "no access_token in response"}`);
  }
  return data.access_token;
}

/** Fetch the authenticated GitHub user with a GitHub access token. */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub user lookup failed: ${res.status}`);
  }
  return (await res.json()) as GitHubUser;
}

/**
 * The allowlist gate — the boundary that keeps a deployment single-user.
 *
 * It decides which authenticated GitHub identity may obtain a token for the store. Everyone who
 * logs in via GitHub reaches this check; only the single allowlisted account is approved.
 *
 * The gate pins BOTH the immutable numeric `id` and the `login`: the id is the primary check
 * (a GitHub id is never reassigned, so it closes the login-reuse-after-rename hole), and the
 * login is defence-in-depth. Both values are provisioned as Worker secrets (set via `wrangler
 * secret put`), so the authorized identity never appears in the committed repo. The id arrives
 * from GitHub as a number and the secret as a string, so compare as strings.
 */
export function isAllowedUser(user: GitHubUser, env: GitHubAuthEnv): boolean {
  return (
    String(user.id) === env.GITHUB_ALLOWED_USER_ID && user.login === env.GITHUB_ALLOWED_USERNAME
  );
}
