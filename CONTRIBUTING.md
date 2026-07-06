# Contributing to agent-cc

Thanks for your interest. agent-cc is a local-first monorepo — everything runs on
your machine, so getting a dev loop going is quick.

## Prerequisites

- **Node 20.19+** (pinned to `<21`; see `engines` in `package.json`)
- **pnpm 10+**
- **tmux 3.x** — the supervisor drives it in control mode
- A **C/C++ toolchain** — native modules (`better-sqlite3`, `node-pty`,
  `sodium-native`) compile on install

## Getting started

```bash
pnpm install          # installs deps and compiles native modules
pnpm setup            # prereq check, create .env, ensure ~/.agent_cc
pnpm start            # start all services + dashboard, open http://localhost:3000
```

`pnpm stop` / `pnpm status` manage a running stack. If a fresh clone fails to load
a native module, run `pnpm rebuild`.

## Repo layout

Each service is its own Node process under `services/`, with shared primitives in
`packages/`. See the [README](README.md#layout) for the full map. Internally each
service follows the same shape: `src/index.ts` (entrypoint), `src/api.ts` (HTTP
routes), `src/db.ts` (SQLite), `src/types.ts`, and colocated `*.test.ts`.

## Running tests

```bash
pnpm build                                   # native + TS build (tests depend on it)
pnpm typecheck                               # strict TS across the workspace
pnpm test                                    # all vitest suites via turbo
pnpm --filter @agent-cc/integration test     # cross-service integration suite
pnpm --filter @agent-cc/secrets test         # vault unit tests
pnpm --filter @agent-cc/e2e test             # Playwright (needs default ports free)
```

CI runs build + typecheck + the vitest suites. The Playwright e2e suite runs
locally (it needs a browser and the default ports free), so run it yourself before
opening a PR that touches the dashboard.

> Note: the first integration-test run after an idle period can hit the health-check
> timeout while native modules cold-start under `tsx`. Just re-run — the second run
> is fast.

## Code conventions

These are enforced by convention and review; please match the surrounding code.

- **TypeScript strict, ESM only.** No CommonJS.
- **Errors as values, not exceptions** at service boundaries — return
  `{ ok: true, value }` / `{ ok: false, error }`. Exceptions are for programmer
  errors only.
- **No service-to-service imports.** Services talk over HTTP; only the supervisor
  fans out to the others.
- **All env access goes through `packages/shared/src/env.ts`** — no scattered
  `process.env.X`.
- **All times in UTC** (`new Date().toISOString()`); local time is display-only.
- **All money in microcents** (`100_000_000` = $1). No floats in money code.
- **Secrets never touch a file or the repo** — they live in the encrypted vault
  (`~/.agent_cc/secrets.db`). Anything persisted to the memory harness is scrubbed
  by `packages/shared/src/redaction.ts` first.
- **No emoji in code comments.** Keep comments plain and specific.

## Pull requests

1. Branch off the default branch.
2. Keep changes scoped; add or update tests for behaviour you change.
3. Make sure `pnpm build`, `pnpm typecheck`, and `pnpm test` pass.
4. Describe what changed and why in the PR body.

## Security

Found a security issue? Please report it **privately** to the maintainer rather
than opening a public issue. See [README](README.md#security--privacy) for how
secrets and data are handled.
