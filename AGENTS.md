# Agent instructions

Guidance for AI agents and contributors working on this package.

## Principles

- **Discuss before coding.** Never start writing code before discussing the
  approach and getting the developer's agreement. When more than one option is
  possible, lay out the trade-offs and agree on a direction first.
- **Be minimalistic.** Prefer the smallest change that fully solves the problem.
  Avoid new dependencies, abstractions, and configuration unless clearly needed.
- **Follow Pulsar standards and practices.** Match the conventions used by Pulsar
  core and its packages (commands, config schema, dock items, keymaps, menus,
  `atom`/Pulsar APIs). When unsure, look at how existing Pulsar packages do it.
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

## Workflow

- Edit `src/`, then rebuild: `npm run build` (or `npm run watch`).
- Keep the build green: `npm run typecheck` must pass.
- The committed bundle `lib/main.js` must match the build (CI enforces this).
- **Never commit unless explicitly asked.** Make code changes, run checks, and
  report back — but do not run `git commit` (or `git push`) without an explicit
  instruction from the developer.
