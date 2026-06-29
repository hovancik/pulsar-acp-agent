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
| Text prompts (`session/prompt`) | ✅ | We send a `text` block per turn (skipped when the message is empty), followed by any attached image and embedded-context blocks. |
| Rich prompt content — `image`, `audio`, `resource`, `resource_link` | 🟡 | Outgoing image attachments (file picker, drag-and-drop, paste) when the agent advertises `promptCapabilities.image`, and embedded `resource` blocks for the active file / selection when it advertises `promptCapabilities.embeddedContext`. `audio` and `resource_link` outgoing blocks are not yet sent. |
| `@`-mention / embedded context | 🟡 | Attach the active file or current selection as embedded `resource` blocks from the composer's **Attach to prompt** button or the editor context menu. Inline `@`-mention autocomplete and a file/symbol picker are not yet implemented. |
| Incoming content rendering | 🟡 | `text` and `resource_link` render fully; `image` / `audio` / `resource` show as placeholders (`[image]`, …). |

## Streaming updates (`session/update`)

| Update | Status | Notes |
| --- | --- | --- |
| `agent_message_chunk` | ✅ | Streamed assistant text. |
| `agent_thought_chunk` | ✅ | Reasoning, rendered distinctly. |
| `user_message_chunk` | ✅ | Echoed user content. |
| `tool_call` / `tool_call_update` | ✅ | Rendered with title, status, and content. A single file `location` makes the tool title clickable to open it at the line. Permission prompts extract command/URL from `rawInput`, list clickable locations, and include a collapsible raw-input section. |
| `plan` | ✅ | Execution plan list. |
| `current_mode_update` | ⬜ | Not surfaced directly; agents that expose mode as a session config option drive it through the selectors below. |
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
| Agent registry & selection | ✅ | Configure multiple agents (`{ name, command }`) under the `pulsar-acp-agent` config namespace; a header picker selects the active agent and switches between them. Mirrors Zed's `agent_servers` record shape (without the registry/install variant). The active agent persists across reloads. |
| Model display | 🟡 | The model config selector's button shows the current model when the agent exposes a `model` option. |
| Model selection | ✅ | Switch models when the agent exposes a `model` session config option (see below). |
| Session modes (`session/set_mode`) | ⬜ | Superseded by session config options, which expose `mode` as a selectable option; the legacy standalone selector is not implemented. |
| Session config options | ✅ | Footer dropdown per `select` config option (model, custom agent, reasoning effort, …); `boolean` options are not yet surfaced. |
| Host context hint | ✅ | A configurable first-prompt hint tells the agent it is connected through Pulsar ACP Agent inside Pulsar, plus session `_meta` for protocol-aware agents. |
| MCP servers | ⬜ | `session/new` is called with an empty `mcpServers` list; we could forward user-configured MCP servers to the agent. |
| Extensibility (`_meta`) | 🟡 | We read a `terminal-auth` hint to build login guidance and send host-context metadata for protocol-aware agents; `_meta` is the spec's escape hatch for vendor data. |

## Suggested priorities

1. **Slash commands** (`available_commands_update`) — cheap, high-value UX; surfaces agent-native commands.
2. **`@`-mention autocomplete** — reference files/symbols inline; today the whole active file or current selection is attached via the **Attach to prompt** button or the editor context menu.
3. **Boolean config options** — render the `boolean` config option kind; only `select` is surfaced today.
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
