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
| `session/load` | ✅ | Switches to a prior session; conversation history is streamed back by the agent and cached client-side so switching back does not re-request history. Gated on `agentCapabilities.loadSession`. |
| `session/list` | ✅ | Fetches past sessions and shows them in a scrollable sessions bar (up to 10 visible). Gated on `sessionCapabilities.list`. |
| `session/delete` | ✅ | Delete button per session entry (hover to reveal). Gated on `sessionCapabilities.delete`. |
| `session/resume` / `session/close` | ⬜ | Not yet implemented. |
| `session/cancel` | ✅ | Stop button; also drains pending permission prompts. |
| Stop reasons (`end_turn`, …) | ✅ | Surfaced on turn end. |

## Prompting & content

| ACP feature | Status | Notes |
| --- | --- | --- |
| Text prompts (`session/prompt`) | ✅ | We send a single `text` content block per turn. |
| Rich prompt content — `image`, `audio`, `resource`, `resource_link` | 🟡 | Outgoing image attachments via file picker, drag-and-drop, and paste are supported when the agent advertises `promptCapabilities.image`. `audio`, `resource`, and `resource_link` outgoing blocks are not yet sent. |
| `@`-mention / embedded context | ⬜ | Reference files or symbols in a prompt as resource blocks. |
| Incoming content rendering | 🟡 | `text` and `resource_link` render fully; `image` / `audio` / `resource` show as placeholders (`[image]`, …). |

## Streaming updates (`session/update`)

| Update | Status | Notes |
| --- | --- | --- |
| `agent_message_chunk` | ✅ | Streamed assistant text. |
| `agent_thought_chunk` | ✅ | Reasoning, rendered distinctly. |
| `user_message_chunk` | ✅ | Echoed user content. |
| `tool_call` / `tool_call_update` | ✅ | Rendered with title, status, and content. Permission prompts extract command/URL from `rawInput` and include a collapsible raw-input section. |
| `plan` | ✅ | Execution plan list. |
| `current_mode_update` | ✅ | Reflected live in the footer mode selector. |
| `usage_update` | ✅ | Context-token usage shown in the header live row. |
| `available_commands_update` | ⬜ | Slash commands the agent exposes (e.g. `/login`, `/compact`). Not surfaced yet. |

## Client capabilities (what the agent can ask of us)

| Capability | Status | Notes |
| --- | --- | --- |
| `session/request_permission` | ✅ | Allow/Reject prompt rendered in the panel; auto-cancels on restart/exit. |
| `fs/read_text_file` | ✅ | Served only inside the working directory; prefers unsaved editor-buffer contents. |
| `fs/write_text_file` | ✅ | Working-dir-scoped; refuses to clobber unsaved changes. |
| `terminal/*` | ✅ | Implements `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/release`, and `terminal/kill`. Commands run via `cross-spawn`, default to the session working directory, and may use an agent-requested absolute `cwd` only inside the project. Merged stdout+stderr is shown in a `<pre>` and capped by `outputByteLimit`. No per-command approval gate — see [Security](README.md#security). |

## Agent configuration

| ACP feature | Status | Notes |
| --- | --- | --- |
| Model display | ⬜ | Current model name display is not implemented. |
| Model selection | ⬜ | Switching models via session config options / a model selector. |
| Session modes (`session/set_mode`) | ✅ | Footer selector lists `availableModes` and switches the current mode; reflects agent-pushed `current_mode_update`. Shown only when the agent advertises modes. |
| Session config options | ⬜ | Generic per-session selectors an agent can expose via `configOptions` on the `session/new` response. Copilot uses these for `mode`, `model`, `reasoning_effort`, custom agents (the `_agent` select, e.g. agents from `.github/agents/*.agent.md`), and `allow_all`. Notably **custom agents do not appear in `modes.availableModes`** (only Agent/Plan/Autopilot do) — they are only reachable through `configOptions`. Rendering these would let users switch model and custom agent persona from Pulsar. See `.github/agents/acp-helper.agent.md` for an example agent. |
| Host context hint | ✅ | A configurable first-prompt hint tells the agent it is connected through Pulsar ACP Agent inside Pulsar, plus session `_meta` for protocol-aware agents. |
| MCP servers | ⬜ | `session/new` is called with an empty `mcpServers` list; we could forward user-configured MCP servers to the agent. |
| Extensibility (`_meta`) | 🟡 | We read a `terminal-auth` hint to build login guidance and send host-context metadata for protocol-aware agents; `_meta` is the spec's escape hatch for vendor data. |

## Suggested priorities

1. **Slash commands** (`available_commands_update`) — cheap, high-value UX; surfaces agent-native commands.
2. **Model selection / session config options** — let users drive the agent's other built-in options (session modes are now switchable; Copilot also exposes a model picker via `configOptions`).
3. **Rich prompt content** — attach the current file/selection or images.
4. **Logout** — account switching without a restart.
5. **Session close** — free agent-side resources when leaving a session.

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
