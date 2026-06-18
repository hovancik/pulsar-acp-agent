# Agent instructions

Guidance for AI agents and contributors working on this package.

## Principles

- **Discuss before coding.** Never start writing code before discussing the
  approach and getting the developer's agreement. When more than one option is
  possible, lay out the trade-offs and agree on a direction first.
- **Be minimalistic.** Prefer the smallest change that fully solves the problem.
  Avoid new dependencies, abstractions, and configuration unless clearly needed.
- **Follow Pulsar standards and practices.** Match the conventions used by Pulsar
  core and its packages (Octicons, commands, config schema, dock items, keymaps,
  menus, `atom`/Pulsar APIs). When unsure, look at how existing Pulsar packages do it.
- **Support every platform.** The package runs on Windows, macOS, and Linux, and
  the ACP agent may be launched from any of them. Prefer platform-agnostic APIs
  (use `path` for separators, never hardcode `/` or `\`), spawn child processes
  with `cross-spawn` so Windows `.cmd`/`.ps1`/`.bat` shims resolve correctly
  without an injectable `shell: true`, and account for OS differences in line
  endings.
- **Namespace public identifiers.** Prefix commands, URIs, deserializers, CSS
  classes, and log labels with `pulsar-acp-agent` / `PulsarAcpAgent` to avoid
  collisions with Pulsar core or other packages.
- **Understand the SDK before using it.** Check how `@agentclientprotocol/sdk`
  actually works (its types and exports in `node_modules`) rather than guessing.
- **Consult the ACP documentation.** Verify protocol behavior against the Agent
  Client Protocol docs and schema: https://agentclientprotocol.com
- **Learn from existing ACP clients.** When designing client behavior, study how
  Zed and other ACP-capable editors solve the same problem, alongside the ACP
  docs and the `@agentclientprotocol/sdk` source. Prefer proven patterns from
  these references over inventing your own.
- **Think about security.** When making any change, consider the security
  implications — don't introduce code that leaks secrets, weakens sandboxing,
  trusts unvalidated input, or expands attack surface unnecessarily.

## Review checklist

When reviewing changes, explicitly check:

- **Dead code and stale surface** — no unused imports, variables, methods,
  branches, CSS, commands, config, docs, or generated artifacts left behind.
- **Minimalism** — smallest complete change; no unrelated rewrites, unnecessary
  abstractions, dependencies, or configuration.
- **Pulsar fit** — UI and behavior follow existing Pulsar packages: Octicons,
  theme/Less variables, commands, config schema, dock items, keymaps, menus, and
  `atom`/Pulsar APIs.
- **ACP correctness** — protocol behavior matches ACP docs/schema and the actual
  `@agentclientprotocol/sdk` types/source; do not infer fields or capabilities.
- **Reference behavior** — for protocol-sensitive client UI or lifecycle choices,
  compare with Zed or another ACP-capable client and explain deliberate divergences.
- **Completeness and lifecycle** — all relevant surfaces are wired; edge cases,
  disposables, DOM nodes, sessions, terminals, child processes, timers, and
  listeners are handled and cleaned up.
- **Platform safety** — Windows/macOS/Linux paths, process spawning, and line
  endings are safe; use `path` and `cross-spawn`; do not hardcode separators.
- **Security** — no secret leaks, trusted rendering of agent-controlled content,
  unsafe process spawning, sandbox weakening, or unvalidated agent input.
- **Validation and errors** — run or update the relevant existing checks/tests;
  failures are surfaced clearly with no silent returns, broad catches, or
  success-shaped fallbacks.
- **UX, performance, and compatibility** — keyboard/focus behavior, theme fit,
  overflow, bounded output/DOM growth, config/state compatibility, and older
  agent capabilities are considered.
- **Generated output and docs** — `lib/main.js` matches the build, and relevant
  README, changelog, feature docs, and notices are updated.

## Workflow

- Edit `src/`, then rebuild: `npm run build` (or `npm run watch`).
- Keep the build green: `npm run typecheck` must pass.
- The committed bundle `lib/main.js` must match the build (CI enforces this).
- When feasible, manually verify UI changes by reloading Pulsar
  (`Window: Reload`) and opening the ACP panel.
- **Before finishing any change, check whether these files (or any others) need
  updating:**
  - `CHANGELOG.md` — user-visible behaviour added, changed, or removed
  - `README.md` — feature descriptions, config options, usage instructions
  - `THIRD-PARTY-NOTICES.md` — new bundled dependency added
  - `AGENTS.md` — contributor or agent guidance affected by the change
- **Never commit unless explicitly asked.** Make code changes, run checks, and
  report back — but do not run `git commit` (or `git push`) without an explicit
  instruction from the developer.
