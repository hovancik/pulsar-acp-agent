# ACP features

[Pulsar ACP Agent](README.md) is an [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) **client**. It launches an external ACP **agent** (a CLI such as GitHub
Copilot CLI or Mistral Vibe) as a subprocess and bridges it to the Pulsar UI.

This document maps the ACP surface to what the package implements today and what
it could grow into. It is a contributor reference and roadmap — see the
[README](README.md) for usage. It is intentionally not part of the published
package (`files` in `package.json`).

ACP splits responsibilities between two peers (see the
[protocol overview](https://agentclientprotocol.com/protocol/v1/overview)):

- The **agent** does the work — runs the model and executes its own tools — and
  calls back into the client for editor-integrated capabilities.
- The **client** (this package) hosts the conversation UI and *offers*
  capabilities (file access, permission prompts, terminals) that a cooperating
  agent may use. These are integration points, not a sandbox — see
  [Security](README.md#security).

## Status legend

- ✅ **Implemented** — works today.
- 🟡 **Partial** — minimal or display-only support.
- ⬜ **Not yet** — candidate future work.

## What we advertise

At `initialize` the client sends (`src/agent-session.ts`):

```jsonc
clientCapabilities: {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
}
```

So today an agent may read and write files through Pulsar, and run commands in a
terminal whose output is shown in the panel.

## Conversation & sessions

| ACP feature | Status | Notes |
| --- | --- | --- |
| `initialize` + capability/version negotiation | ✅ | Sends client implementation info (name/title/version); rejects mismatched protocol versions. |
| `authenticate` | 🟡 | Auto-runs the **first** auth method the agent advertises; no method picker. Surfaces a login hint on failure. |
| `logout` | ⬜ | `agentCapabilities.auth.logout`. Would let users switch accounts without restarting. |
| `session/new` | ✅ | Created with the working directory; no MCP servers passed. |
| `session/load` | ⬜ | Requires the `loadSession` capability. Restores a prior conversation. The dock deserializer is already wired (`deserializePulsarAcpAgentView`), so this is the natural next step. |
| `session/list` | ⬜ | Enumerate past sessions — the basis for a "reopen previous agent sessions" picker. |
| `session/resume` / `session/delete` / `session/close` | ⬜ | Newer stabilized lifecycle methods for managing session history. |
| `session/cancel` | ✅ | Stop button; also drains pending permission prompts. |
| Stop reasons (`end_turn`, …) | ✅ | Surfaced on turn end. |

## Prompting & content

| ACP feature | Status | Notes |
| --- | --- | --- |
| Text prompts (`session/prompt`) | ✅ | We send a single `text` content block per turn. |
| Rich prompt content — `image`, `audio`, `resource`, `resource_link` | ⬜ | Outgoing prompts are text-only. Agents advertise `promptCapabilities`; we could attach the active file/selection or images. |
| `@`-mention / embedded context | ⬜ | Reference files or symbols in a prompt as resource blocks. |
| Incoming content rendering | 🟡 | `text` and `resource_link` render fully; `image` / `audio` / `resource` show as placeholders (`[image]`, …). |

## Streaming updates (`session/update`)

| Update | Status | Notes |
| --- | --- | --- |
| `agent_message_chunk` | ✅ | Streamed assistant text. |
| `agent_thought_chunk` | ✅ | Reasoning, rendered distinctly. |
| `user_message_chunk` | ✅ | Echoed user content. |
| `tool_call` / `tool_call_update` | ✅ | Rendered with title, status, and content. |
| `plan` | ✅ | Execution plan list. |
| `current_mode_update` | 🟡 | Shown in the status line (display only — see modes below). |
| `usage_update` | ✅ | Context-token usage shown in the status line. |
| `available_commands_update` | ⬜ | Slash commands the agent exposes (e.g. `/login`, `/compact`). Not surfaced yet. |

## Client capabilities (what the agent can ask of us)

| Capability | Status | Notes |
| --- | --- | --- |
| `session/request_permission` | ✅ | Allow/Reject prompt rendered in the panel; auto-cancels on restart/exit. |
| `fs/read_text_file` | ✅ | Served only inside the working directory; prefers unsaved editor-buffer contents. |
| `fs/write_text_file` | ✅ | Working-dir-scoped; refuses to clobber unsaved changes. |
| `terminal/*` | ✅ | Implements `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/release`, and `terminal/kill`. Commands run via `cross-spawn` from the session working directory (an absolute `cwd` outside it is refused), with merged stdout+stderr shown in a `<pre>` and capped by `outputByteLimit`. No per-command approval gate — see [Security](README.md#security). |

## Agent configuration

| ACP feature | Status | Notes |
| --- | --- | --- |
| Model display | 🟡 | The current model name (from the session's `models`) is shown in the status line. |
| Model selection | ⬜ | Switching models via session config options / a model selector. |
| Session modes (`session/set_mode`) | ⬜ | We display the current mode but cannot switch it (e.g. ask vs. code). |
| Session config options | ⬜ | Generic per-session selectors an agent can expose. |
| MCP servers | ⬜ | `session/new` is called with an empty `mcpServers` list; we could forward user-configured MCP servers to the agent. |
| Extensibility (`_meta`) | 🟡 | We read a `terminal-auth` `_meta` hint to build login guidance; `_meta` is the spec's escape hatch for vendor data. |

## Suggested priorities

1. **Session load + list** — restore and reopen past conversations; the deserializer groundwork is already in place.
2. **Slash commands** (`available_commands_update`) — cheap, high-value UX; surfaces agent-native commands.
3. **Session modes / model selection** — let users drive the agent's built-in options instead of only seeing them.
4. **Rich prompt content** — attach the current file/selection or images.
5. **Logout** — account switching without a restart.

## How Zed does it

Zed originated ACP and is its reference client, so it's the best place to see the
full surface in action. Zed hosts the agent thread in its Agent Panel while the
external agent "owns its own runtime, auth, model selection, tools, and native
configuration" ([Zed: External Agents](https://zed.dev/docs/ai/external-agents)).
Compared with us, Zed implements essentially everything above — notably:

- **Terminals** — agents run commands through Zed's integrated terminal with live
  output embedded in the tool-call card.
- **Permission prompts with auto-allow** — Allow/Reject UI plus a tool-permissions
  setting to stop prompting.
- **Slash commands, modes, model selection, MCP, mentions** — surfaced natively in
  the panel (e.g. `/login` for Claude/Codex).
- **Session history** — a threads sidebar backed by session load/list.

Zed shares our trust model, though: external agents are separate processes with
the user's privileges, and Zed does not sandbox them — it gates only what the
agent routes through it.

## References

- ACP spec: <https://agentclientprotocol.com>
- Protocol overview (method list): <https://agentclientprotocol.com/protocol/v1/overview>
- Terminals: <https://agentclientprotocol.com/protocol/v1/terminals>
- Tool calls & permissions: <https://agentclientprotocol.com/protocol/v1/tool-calls>
- Zed external agents: <https://zed.dev/docs/ai/external-agents>
- Our implementation: `src/agent-session.ts`, `src/agent-view.ts`
