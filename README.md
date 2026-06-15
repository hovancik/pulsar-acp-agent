# Pulsar ACP Agent

Pulsar package for using [Agent Client Protocol (ACP)](https://agentclientprotocol.com)-compatible coding agents inside the editor.

Currently tested with GitHub Copilot CLI.

## Install

```sh
git clone https://github.com/hovancik/pulsar-acp-agent.git
cd pulsar-acp-agent
ppm link
```

Reload Pulsar after linking.

## Configure Copilot CLI

Install Copilot CLI and authenticate once:

```sh
copilot login
```

Defaults:

- command: `copilot`
- args: `--acp --stdio`

If Pulsar cannot find `copilot`, set an absolute path in:

```text
Settings -> Packages -> pulsar-acp-agent -> Agent command
```

On Linux this may be something like:

```text
/home/you/.local/bin/copilot
```

## Use

- Toggle panel: `Ctrl+Alt+A`
- Command palette: `Pulsar ACP Agent: Toggle`
- Send: `Enter`
- Newline: `Shift+Enter`
- Stop: cancel current turn
- Restart: kill and restart the agent process

The session working directory defaults to the first open project folder.
Multi-root workspaces are not supported yet: only the configured working
directory, or the first open project folder when no directory is configured, is
sent to the agent and allowed for file access.

## Develop

```sh
npm install
npm run typecheck
npm run build
npm run watch
```

Pulsar loads `lib/main.js`. Rebuild after editing `src/`, then reload Pulsar.

## Architecture

- `src/main.ts` registers commands, opener, and dock item.
- `src/agent-view.ts` renders the panel UI.
- `src/agent-session.ts` manages the ACP session via `@agentclientprotocol/sdk`.

The SDK is ESM-only, so esbuild bundles it and `zod` into `lib/main.js`.

## Capabilities

| Capability | Status |
| --- | --- |
| `fs.readTextFile` / `fs.writeTextFile` | yes, restricted to the session working directory |
| `session/request_permission` | yes |
| `terminal` | no |
| `authenticate` | yes, uses the first auth method advertised by the agent |

## Security

File access is restricted to the session working directory.
Writes to open files with unsaved changes are refused.

This package currently trusts the configured ACP agent for file writes. If the
agent calls `fs/write_text_file`, Pulsar ACP Agent writes the requested content
as long as the target path is inside the session working directory. Use it only
with agents you trust.
