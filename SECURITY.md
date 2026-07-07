# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub's security advisories:
**Security → Report a vulnerability** on this repository (or
`https://github.com/lemur47/lemurkit/security/advisories/new`).

Do not open a public issue for a security report. You should receive an acknowledgement within
a week. Coordinated disclosure is appreciated; you'll be credited in the advisory unless you
prefer otherwise.

## Scope

This project is a self-hosted, single-user MCP connector. Reports of particular interest:

- **Auth-gate bypass**: any way to reach `/mcp` tool calls, or obtain a grant, without being the
  allowlisted GitHub account (OAuth flow, state/CSRF handling, token issuance).
- **Cross-deployment impact**: anything that lets one deployment affect another.
- **Secret disclosure**: any response path that reflects secret _values_ (the not-configured
  guard intentionally names missing secret _names_ — that is by design).
- **Injection through stored content**: object keys/bodies or memory fragments breaking out of
  their role in tool results.

Out of scope: vulnerabilities requiring the deployer's own Cloudflare or GitHub account to
already be compromised; the security of Cloudflare R2/KV/D1/Workers themselves.

## Deployment security notes

- The authorized identity and all OAuth material live in **Worker secrets** — never commit them.
- The allowlist pins the immutable numeric GitHub id as the primary check; the login is
  defence-in-depth. If you rename your GitHub account, update `GITHUB_ALLOWED_USERNAME`.
- Install-time supply-chain defenses live in `.npmrc` (registry pin, `ignore-scripts=true`,
  3-day release cooldown). Keep them when modifying the project.

## Supported versions

The `main` branch. There are no maintained release lines; redeploy from current `main` to pick
up fixes (pushes to your clone's production branch auto-deploy via Workers Builds).
