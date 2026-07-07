# lemurkit

**Your own private file store for Claude** — an R2/KV/D1 storage connector running in _your_
Cloudflare account, gated to _your_ GitHub account. One click deploys it; nothing is shared
with anyone.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lemur47/lemurkit)

Claude (web, desktop, and Claude Code) talks to it as a [custom connector](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
over the [Model Context Protocol](https://modelcontextprotocol.io). You get a Box/Drive-style
file store that is yours end to end: your bucket, your identity, your OAuth gate.

## What you get

| Tools                                                                                                      | What they do                                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `list_files` `read_file` `write_file` `copy_file` `move_file` `delete_file` `get_file_info` `list_buckets` | Full file management on your R2 bucket                                                 |
| `query_files`                                                                                              | Find objects by **attributes** — type, size, date, prefix (D1-backed index)            |
| `search_files`                                                                                             | Find objects by **words** — full-text search over names _and_ content (BM25, snippets) |
| `semantic_search`                                                                                          | Find objects by **meaning** — vector search (optional tier, see below)                 |
| `index_bucket`                                                                                             | Rebuild the indexes from the bucket (for files uploaded outside the connector)         |
| `write_memory` `read_memory` `list_memory` `forget_memory`                                                 | A small shared-memory layer (KV) for cross-conversation notes                          |

Every write keeps the search indexes current automatically (write-through). The connector is
**single-user by design**: an OAuth 2.1 + PKCE gate delegates login to GitHub and admits exactly
one allowlisted account — yours.

## Deploy (one click)

1. Click **Deploy to Cloudflare** above. A free Cloudflare account works, but enabling R2 asks
   for **billing verification** (a payment card) even on the free tier — do that first if your
   account is brand new.
2. On the setup page, **give the two KV namespaces distinct names** — e.g. `lemurkit-oauth` and
   `lemurkit-memory`. Both default to the Worker's name, and KV names are unique per account, so
   the second one fails to provision if you leave the defaults. Everything else can stay as
   suggested.
3. Cloudflare clones this repo into your GitHub account, **auto-provisions** the R2 bucket, the
   two KV namespaces, and the D1 database (its migrations apply automatically as part of every
   deploy), deploys the Worker, and wires up CI (every push to your new repo redeploys).
4. Note your Worker URL: `https://<worker-name>.<your-subdomain>.workers.dev` (the Worker is
   named after the project name you chose on the setup page). If the URL isn't live, the initial
   deploy sometimes leaves the workers.dev route disabled: open the Worker in the dashboard →
   **Settings → Domains & Routes** → enable **workers.dev**. Any later push re-enables it too.

The deploy finishes in a **"not configured yet"** state — that's expected. Visiting the URL
shows a checklist of the secrets you're about to set. The Worker deploys _before_ the OAuth app
can exist because GitHub needs your live URL as the callback. Finish the setup below (~5
minutes).

## Setup

### 1. Register a GitHub OAuth app

Go to <https://github.com/settings/developers> (that's your **account** settings → Developer
settings — not a repository's settings) → **OAuth Apps → New OAuth App**:

- **Application name**: anything (e.g. `my lemurkit`)
- **Homepage URL**: `https://<worker-name>.<your-subdomain>.workers.dev`
- **Authorization callback URL**: `https://<worker-name>.<your-subdomain>.workers.dev/callback`
  — exactly this path; GitHub OAuth apps accept a single callback URL.

Create it, then generate a **client secret**. Keep the client ID and secret handy.

### 2. Set the five secrets

Clone your new repo, then from its root (`npx wrangler login` first if needed):

```sh
npx wrangler secret put GITHUB_CLIENT_ID        # from step 1
npx wrangler secret put GITHUB_CLIENT_SECRET    # from step 1
npx wrangler secret put GITHUB_ALLOWED_USERNAME # your GitHub login, e.g. octocat
npx wrangler secret put GITHUB_ALLOWED_USER_ID  # your numeric id — see below
npx wrangler secret put STATE_SIGNING_KEY       # any long random string, e.g. `openssl rand -hex 32`
```

Your **numeric id** is at `https://api.github.com/users/<your-login>` (the `id` field). The
allowlist pins both values: the id is immutable (logins can be renamed and re-registered by
someone else; ids can't), the login is defence-in-depth.

Secrets take effect immediately — no redeploy needed. (The database migrations already applied
during the deploy — the `deploy` script runs them every time, so there's nothing to migrate by
hand.)

### 3. Connect Claude

In Claude: **Settings → Connectors → Add custom connector**, URL:

```
https://<worker-name>.<your-subdomain>.workers.dev/mcp
```

Authorize — you'll see the consent page, sign in with GitHub, and land back in Claude. Ask
Claude to write a file and read it back. Done.

## Optional: semantic search

`semantic_search` finds files by _meaning_ (vector similarity) rather than keywords. It's off by
default because Vectorize isn't auto-provisioned and embedding has a small per-write cost
(**every text file you write is embedded via Workers AI** once enabled — typically well within
the free tier for personal use, but it's your account: know it's there).

To enable:

```sh
npx wrangler vectorize create lemurkit-objects --dimensions=1024 --metric=cosine
```

The CLI (or API) is the **only** way to create a Vectorize index — the Cloudflare dashboard has
no create UI. `npx wrangler login` opens a browser; on a headless machine use a scoped API token
instead: `CLOUDFLARE_API_TOKEN=<token> npx wrangler vectorize create …`.

Then uncomment the `ai` and `vectorize` bindings in `wrangler.jsonc`, push (CI redeploys), and
run the `index_bucket` tool once from Claude to embed your existing files. New writes become
semantically searchable within a few minutes (embedding is write-through, but visibility on a
fresh index is asynchronous) — run `index_bucket` to force immediate visibility.

## Adding more buckets

The connector addresses stores through a small registry. To add one:

1. `wrangler.jsonc`: add a binding, e.g. `{ "binding": "BUCKET_ARCHIVE" }` under `r2_buckets`.
2. `src/env.ts`: add `BUCKET_ARCHIVE: R2Bucket;`.
3. `src/buckets.ts`: add an entry, e.g.
   `archive: { get: (env) => env.BUCKET_ARCHIVE, description: "Cold archive." }`.

Push; the new store auto-provisions on deploy and shows up in `list_buckets`. Every tool takes
it via the `bucket` argument.

## Local development

```sh
pnpm install
pnpm test          # offline: in-memory fakes + node:sqlite against the real migrations
pnpm typecheck
pnpm dev           # wrangler dev; put secrets for local runs in .dev.vars (gitignored)
```

`core/` is the framework-agnostic logic (storage, indexes, memory), consumed as TypeScript
source via a `tsconfig` path alias — there's no build step for it. `src/` is the Worker: entry
point, OAuth, and the MCP tool surface.

## Security posture

- **Single-account allowlist** on an OAuth 2.1 + PKCE gate; login delegated to GitHub. The
  authorized identity lives in Worker **secrets**, never in the repo.
- **Everything private by default**: no public bucket URLs; all access goes through the
  OAuth-gated Worker. Data at rest uses R2's default encryption (AES-256).
- **Supply-chain**: `.npmrc` pins the npm registry, disables install scripts entirely
  (`ignore-scripts=true` — the Worker is bundled, nothing needs native builds), and refuses
  packages published less than 3 days ago. Dependencies are exact-pinned.
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom                                                                      | Cause / fix                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `503 not_configured` (or the checklist page)                                 | One or more secrets missing — the response names which. Set them (Setup step 2).                                                                                                     |
| **You** get _"This GitHub account is not authorized"_ (403) after signing in | The allowlist secrets don't match your account — re-put `GITHUB_ALLOWED_USER_ID` (numeric, from `api.github.com/users/<login>`) and `GITHUB_ALLOWED_USERNAME` (your exact login).    |
| Someone else gets 403                                                        | Working as intended — single-user by design.                                                                                                                                         |
| GitHub login fails with a redirect error                                     | The OAuth app's callback URL isn't exactly `https://<your-worker-host>/callback`.                                                                                                    |
| `query_files` / `search_files` return a D1 error                             | Migrations not applied — they run with every deploy, so push any commit (or run `npm run deploy`), or apply directly: `npx wrangler d1 migrations apply lemurkit-metadata --remote`. |
| Files uploaded via the Cloudflare dashboard don't show in search             | Out-of-band writes aren't indexed automatically — run the `index_bucket` tool.                                                                                                       |
| `semantic_search` missing from the tool list                                 | The semantic tier is off — that's the default; see "Optional: semantic search".                                                                                                      |

## License

[Apache-2.0](LICENSE)
