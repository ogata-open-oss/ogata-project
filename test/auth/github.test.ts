import { describe, expect, it } from "vitest";
import { isAllowedUser } from "../../src/auth/github";
import type { GitHubAuthEnv, GitHubUser } from "../../src/auth/github";

/**
 * The security-critical gate for the OSS build: only the single allowlisted GitHub identity may
 * obtain a token. Mirror of gitlab.test.ts — same double-pin contract, GitHub field names.
 *
 * Fixtures use a DELIBERATE stand-in identity, never a real account — the allowlist is held as
 * secrets precisely to keep the authorized identity out of the repo, and a committed test must
 * not undo that. These prove the gate's *logic*, not *who* it admits.
 *
 * The gate pins BOTH the immutable numeric `id` (primary — GitHub logins are reusable after a
 * rename, ids are not) and the `login` (defence-in-depth). The id arrives from GitHub as a
 * number; the allowlist secret is a string — so the comparison must hold across that
 * number/string boundary.
 */

const ALLOWED_ID = "12345";
const ALLOWED_LOGIN = "fixture-user";

/** A GitHubUser matching the allowlist by default; pass overrides to probe a mismatch. */
function makeUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: Number(ALLOWED_ID),
    login: ALLOWED_LOGIN,
    name: "Fixture User",
    ...overrides,
  };
}

/** A GitHubAuthEnv carrying the two allowlist values isAllowedUser reads. */
function makeEnv(overrides: Partial<GitHubAuthEnv> = {}): GitHubAuthEnv {
  return {
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_ALLOWED_USER_ID: ALLOWED_ID,
    GITHUB_ALLOWED_USERNAME: ALLOWED_LOGIN,
    ...overrides,
  };
}

describe("isAllowedUser — the OSS allowlist gate", () => {
  it("ALLOWS the exact id + login pair", () => {
    expect(isAllowedUser(makeUser(), makeEnv())).toBe(true);
  });

  it("REJECTS a matching login with the wrong id (the login-reuse attack)", () => {
    expect(isAllowedUser(makeUser({ id: 99999 }), makeEnv())).toBe(false);
  });

  it("REJECTS a matching id with the wrong login", () => {
    expect(isAllowedUser(makeUser({ login: "impostor" }), makeEnv())).toBe(false);
  });

  it("REJECTS everyone when the allowlist secrets are unprovisioned (empty)", () => {
    const env = makeEnv({ GITHUB_ALLOWED_USER_ID: "", GITHUB_ALLOWED_USERNAME: "" });
    expect(isAllowedUser(makeUser(), env)).toBe(false);
    expect(isAllowedUser(makeUser({ id: 0, login: "" }), env)).toBe(false);
  });

  it("compares the numeric id across the number/string boundary", () => {
    // GitHub sends a JSON number; the secret is a string. The gate must treat 12345 === "12345".
    expect(isAllowedUser(makeUser({ id: 12345 }), makeEnv())).toBe(true);
    expect(isAllowedUser(makeUser({ id: 123450 }), makeEnv())).toBe(false);
  });
});
