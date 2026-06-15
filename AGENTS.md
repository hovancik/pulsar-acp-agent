# Agent instructions

Guidance for AI agents and contributors working on this package.

## Principles

- **Be minimalistic.** Prefer the smallest change that fully solves the problem.
  Avoid new dependencies, abstractions, and configuration unless clearly needed.
- **Follow Pulsar standards and practices.** Match the conventions used by Pulsar
  core and its packages (commands, config schema, dock items, keymaps, menus,
  `atom`/Pulsar APIs). When unsure, look at how existing Pulsar packages do it.
- **Namespace public identifiers.** Prefix commands, URIs, deserializers, CSS
  classes, and log labels with `pulsar-acp-agent` / `PulsarAcpAgent` to avoid
  collisions with Pulsar core or other packages.
- **Understand the SDK before using it.** Check how `@agentclientprotocol/sdk`
  actually works (its types and exports in `node_modules`) rather than guessing.
- **Consult the ACP documentation.** Verify protocol behavior against the Agent
  Client Protocol docs and schema: https://agentclientprotocol.com
- **Think about security.** When making any change, consider the security
  implications — don't introduce code that leaks secrets, weakens sandboxing,
  trusts unvalidated input, or expands attack surface unnecessarily.

## Workflow

- Edit `src/`, then rebuild: `npm run build` (or `npm run watch`).
- Keep the build green: `npm run typecheck` must pass.
- The committed bundle `lib/main.js` must match the build (CI enforces this).
