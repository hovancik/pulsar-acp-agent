# Agent instructions

Guidance for AI agents and contributors working on this package.

## Architecture

Five `src/` modules, bundled to `lib/` by `build.mjs` (esbuild):

- `main.ts` — Pulsar entry point: `activate`/`deactivate`, the
  `pulsar-acp-agent:toggle`/`focus`/`edit-agents` commands, the workspace opener
  for `atom://pulsar-acp-agent`, the `deserializePulsarAcpAgentView` deserializer,
  the one-time agent-registry migration on activate, and the status-bar
  `StatusIndicator`. No agent logic.
- `agent-session.ts` — ACP transport. Spawns the agent with `cross-spawn` from a
  resolved `LaunchTarget` (`{ id, name, command }`; never reads launch config),
  speaks JSON-RPC over stdio, implements the ACP client side (file/terminal/
  permission capabilities), and emits a discriminated `AgentEvent` union. No DOM.
- `agent-view.ts` — the dock panel UI (`PulsarAcpAgentView`). Consumes
  `AgentEvent`s, renders markdown via `marked` + `DOMPurify`, handles
  prompts/images/sessions/tool calls, owns the header agent picker
  (select/switch), and holds the thin `atom.config` glue for the agent registry.
- `agent-config.ts` — pure agent-registry logic (`normalizeAgentsConfig`,
  `migrateAgentsConfig`, `resolveActiveAgent`, `isLaunchedAgentStale`), no `atom`
  import, bundled separately so it's unit-testable like `util.ts`.
- `util.ts` — pure helpers (`parseCommandLine`, `flattenInfoRows`,
  `TerminalRecord`), bundled separately so it's unit-testable without `atom`.

Flow: `main` opens a `PulsarAcpAgentView` → view owns an `AgentSession` → session
drives the agent process and emits events → view renders them.

## Principles

- **Discuss before coding.** Never start writing code before discussing the
  approach and getting the developer's agreement. When more than one option is
  possible, lay out the trade-offs and agree on a direction first. Before
  recommending an approach, check it's the current protocol mechanism and how
  Zed does it.
- **Be a thinking colleague, not a yes-person.** Do not blindly agree with the
  developer's suggestion. If an idea seems wrong, risky, overbuilt, inconsistent
  with ACP/Pulsar, or not the smallest good fix, say so plainly and explain why.
  Offer the better minimal path. Agree when the suggestion is sound; push back
  only when there is a concrete reason.
- **Be minimalistic.** Prefer the smallest change that fully solves the problem.
  Avoid new dependencies, abstractions, and configuration unless clearly needed.
  Keep commit messages, changelog entries, and doc updates short and direct — no filler words.
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
- **Prefer the current protocol mechanism.** ACP sometimes has more than one way
  to do the same thing (session modes vs. a `mode` config option). The schema
  marks superseded and UNSTABLE surface — check it and build on the current
  mechanism, not the old one. If you end up building two overlapping mechanisms
  and hiding one, stop and rethink the approach.
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
- `npm test` runs `node --test` over `test/*.mjs`. Tests import the built
  `lib/util.js`, not `src/`, so build first. Single test:
  `node --test test/util.test.mjs` (add `--test-name-pattern="..."` to narrow).
- `npm run smoke -- <command...>` does a live ACP handshake against a real agent
  (`scripts/smoke.mjs`); defaults to `copilot --acp --stdio`.
- The committed bundle `lib/main.js` must match the build (CI enforces this).
- When feasible, manually verify UI changes by reloading Pulsar
  (`Window: Reload`) and opening the ACP panel.
- **Before finishing any change, check whether these files (or any others) need
  updating:**
  - `CHANGELOG.md` — user-visible behaviour added, changed, or removed
  - `README.md` — feature descriptions, config options, usage instructions
  - `THIRD-PARTY-NOTICES.md` — new bundled dependency added
  - `AGENTS.md` — contributor or agent guidance affected by the change
- **When the task is done, run a critical review of the uncommitted changes**
  (`git diff` / `git status`) against the review checklist above before reporting
  back. Verify each finding against the code; report real issues, not noise.
- **Never commit unless explicitly asked.** Make code changes, run checks, and
  report back — but do not run `git commit` (or `git push`) without an explicit
  instruction from the developer.
- **Never commit on `trunk`.** If a commit is requested while on `trunk`, stop and
  ask the developer to create or switch to a feature branch first.
