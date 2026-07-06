# agent-cc

Local-first agent command centre. One browser tab where you watch every coding
agent running across every project, take over any of them mid-run, and inject
curated context into a fresh agent session with one click.

This is a monorepo of services fronted by a single public API on the supervisor.
Everything runs on your machine — see [Security & privacy](#security--privacy).

## Layout

```
services/
  supervisor/    # port 7711 — public API, tmux control mode, worktrees
  dashboard/     # port 3000 — Next.js 3-panel UI
  memory/        # port 7715 — the memory harness (the value prop)
  gateway/       # port 7712 — LLM gateway        (Slice 3)
  oauth-broker/  # port 7713 — OAuth broker        (Slice 3)
  persona/       # port 7714 — persona service     (Slice 3)
packages/
  shared/        # SQLite schema, error types, env parsing
tests/
  integration/   # cross-service integration tests
```

## Requirements

- Node 20.19+ (pinned; see `engines`)
- pnpm 10+
- tmux 3.x (the supervisor drives it in control mode)
- A C/C++ toolchain (native modules: better-sqlite3, node-pty, sodium-native)

## Quick start

```bash
pnpm setup     # prereq check, create .env, install deps, ensure ~/.agent_cc
pnpm start     # start all services + dashboard, then open http://localhost:3000
```

`pnpm start` waits for every service's health check and prints the URL; Ctrl-C
stops everything. `pnpm stop` / `pnpm status` manage a running stack. (Once the
package is installed/linked these are also `agent-cc setup|start|stop|status`.)

Zero-config by design: the SQLite DBs auto-create and self-migrate on first start,
and the encrypted vault auto-creates its master key. `.env` (copied from
`.env.example`) is only for overriding ports/paths.

`pnpm` 10 blocks native build scripts by default; the root `package.json` lists
`better-sqlite3`, `node-pty`, and `sodium-native` under `pnpm.onlyBuiltDependencies`
so they compile on install. If a fresh clone fails to load a native module, run
`pnpm rebuild`.

## Configure

Operational config (LLM providers + API keys, personas, OAuth connections) is set
from the dashboard via **⌘K → Config**, or the service APIs. Secrets go to the
encrypted vault (`~/.agent_cc/secrets.db`), never a file or the repo.

## Test

```bash
pnpm --filter @agent-cc/integration test   # cross-service integration suite
pnpm --filter @agent-cc/secrets test       # vault unit tests
pnpm --filter @agent-cc/e2e test           # Playwright (needs default ports free)
```

## Storage

All under `~/.agent_cc/` (override with `AGENT_CC_HOME` or the per-path env vars):
`agent-cc.db` (main), `audit.db` (audit log), `secrets.db` (encrypted secrets).

## Security & privacy

- **Local-first.** Every service binds to `localhost` and all data lives on your
  machine under `~/.agent_cc/`. There is no cloud backend and **no telemetry** —
  agent-cc phones home to nothing.
- **Agent sessions run on your own auth.** By default a workspace launches
  `claude` (Claude Code), which uses your existing login/subscription; agent-cc
  makes no LLM API calls to run sessions. Per-token API billing is strictly
  opt-in (`ANTHROPIC_API_KEY`).
- **Secrets are encrypted at rest.** LLM provider keys, OAuth tokens, and other
  credentials go to an encrypted vault (`~/.agent_cc/secrets.db`, libsodium) whose
  master key lives in your OS keychain — never in a file or the repo.
- **Secret redaction at the memory boundary.** Anything persisted to the memory
  harness is scrubbed of secret-shaped material before it is stored or re-injected
  into an agent session (`packages/shared/src/redaction.ts`).
- **Every proxied action is audited.** The OAuth broker is default-deny and
  rate-limited; proxied operations are recorded in `~/.agent_cc/audit.db`.

Found a security issue? Please report it privately to the maintainer rather than
opening a public issue.

## License

MIT — see [LICENSE](LICENSE).
