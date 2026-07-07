import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubHandler } from "../../src/auth/github-handler";
import type { GitHubHandlerEnv } from "../../src/auth/github-handler";
import { signState } from "../../src/auth/state";
import type { GitHubUser } from "../../src/auth/github";

/**
 * The OSS allowlist gate's ENFORCEMENT, end-to-end through the callback handler — mirror of
 * gitlab-handler.test.ts (403 must return BEFORE completeAuthorization mints a grant), plus the
 * GitHub-specific protocol pins a faithful GitLab port would silently miss:
 *
 *  - GitHub's token endpoint returns HTTP **200 on failure** (`{"error":"bad_verification_code"}`)
 *    — a `res.ok` check alone lets the failure through; the flow must still stop.
 *  - The token exchange must send `Accept: application/json` (the endpoint's default response is
 *    form-encoded, which would break `res.json()`).
 *  - api.github.com rejects requests without a `User-Agent` (403) — Workers' fetch doesn't add
 *    one, so the user lookup must set it explicitly.
 *  - The user object's handle field is `login`, not `username`.
 *
 * Only the real network boundary is mocked (`globalThis.fetch`) and the OAuth provider; the code
 * exchange, user fetch, allowlist predicate, and HMAC `state` round-trip all run for real.
 * Fixtures use a DELIBERATE stand-in identity, never a real account.
 */

const SIGNING_KEY = "test-state-signing-key-0123456789";
const ALLOWED_ID = "12345";
const ALLOWED_LOGIN = "fixture-user";

/** A GitHubUser matching the allowlist by default; pass overrides to probe a mismatch. */
function makeUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return { id: Number(ALLOWED_ID), login: ALLOWED_LOGIN, name: "Fixture User", ...overrides };
}

/**
 * A minimal env: the allowlist + signing secrets the callback path reads, plus an OAUTH_PROVIDER
 * whose `completeAuthorization` is a spy — the call we assert never happens on denial.
 */
function makeEnv() {
  const completeAuthorization = vi.fn(async (_opts: Record<string, unknown>) => ({
    redirectTo: "https://client.example/cb?code=granted",
  }));
  const env = {
    STATE_SIGNING_KEY: SIGNING_KEY,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_ALLOWED_USER_ID: ALLOWED_ID,
    GITHUB_ALLOWED_USERNAME: ALLOWED_LOGIN,
    OAUTH_PROVIDER: { completeAuthorization },
  } as unknown as GitHubHandlerEnv;
  return { env, completeAuthorization };
}

interface StubOptions {
  /** Body the token endpoint answers with — ALWAYS HTTP 200, like GitHub. */
  tokenBody?: Record<string, unknown>;
}

/**
 * Stub the GitHub HTTP boundary: the token endpoint answers HTTP 200 with `tokenBody` (success
 * or failure — that's GitHub's contract), the user endpoint returns `user`. Captures the request
 * headers so the protocol pins can be asserted.
 */
function stubGitHub(user: GitHubUser, options: StubOptions = {}) {
  const captured: { tokenAccept?: string | null; userAgent?: string | null } = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const headers = new Headers(init?.headers);
      if (target.endsWith("/login/oauth/access_token")) {
        captured.tokenAccept = headers.get("accept");
        return new Response(
          JSON.stringify(options.tokenBody ?? { access_token: "fake-github-token" }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.endsWith("api.github.com/user")) {
        captured.userAgent = headers.get("user-agent");
        return new Response(JSON.stringify(user), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in test: ${target}`);
    }),
  );
  return captured;
}

/** Drive a GET /callback through the public handler with a validly-signed state. */
async function callback(env: GitHubHandlerEnv): Promise<Response> {
  const state = await signState({ clientId: "test-client", scope: ["mcp"] }, SIGNING_KEY);
  const url = `https://connector.example/callback?code=auth-code&state=${encodeURIComponent(state)}`;
  return GitHubHandler.fetch(new Request(url), env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubHandler /callback — allowlist enforcement", () => {
  it("DENIES a non-allowlisted user with 403 and never mints a token", async () => {
    stubGitHub(makeUser({ id: 99999, login: "someone-else" }));
    const { env, completeAuthorization } = makeEnv();

    const res = await callback(env);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not authorized");
    // The load-bearing assertion: the gate short-circuits BEFORE the grant is issued.
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("(control) ADMITS the allowlisted user — proving the test reaches the gate", async () => {
    stubGitHub(makeUser());
    const { env, completeAuthorization } = makeEnv();

    const res = await callback(env);

    expect(res.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    // `login` (GitHub's field) must land in the grant's username slot.
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ALLOWED_ID, metadata: { username: ALLOWED_LOGIN } }),
    );
  });
});

describe("GitHubHandler /callback — GitHub protocol pins", () => {
  it("STOPS on the 200-with-error token response (GitHub's failure shape), minting nothing", async () => {
    stubGitHub(makeUser(), { tokenBody: { error: "bad_verification_code" } });
    const { env, completeAuthorization } = makeEnv();

    await expect(callback(env)).rejects.toThrow(/token exchange failed/);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("STOPS when the 200 token response simply lacks an access_token", async () => {
    stubGitHub(makeUser(), { tokenBody: {} });
    const { env, completeAuthorization } = makeEnv();

    await expect(callback(env)).rejects.toThrow(/no access_token/);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("sends Accept: application/json to the token endpoint (default is form-encoded)", async () => {
    const captured = stubGitHub(makeUser());
    const { env } = makeEnv();

    await callback(env);

    expect(captured.tokenAccept).toBe("application/json");
  });

  it("sends a User-Agent to api.github.com (which 403s without one)", async () => {
    const captured = stubGitHub(makeUser());
    const { env } = makeEnv();

    await callback(env);

    expect(captured.userAgent).toBeTruthy();
  });
});
