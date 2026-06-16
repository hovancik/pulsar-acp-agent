# Pulsar ACP Agent

Pulsar package for using [Agent Client Protocol (ACP)](https://agentclientprotocol.com)-compatible coding agents inside the editor.

Much of this package was written by AI coding agents, with human review.

Currently tested with GitHub Copilot CLI and Mistral Vibe.

## Install

In Pulsar, open **Settings → Install**, search for `pulsar-acp-agent`, and click
**Install**. Or from a terminal:

```sh
ppm install pulsar-acp-agent
```

Package page: <https://web.pulsar-edit.dev/packages/pulsar-acp-agent>

## Configure Copilot CLI

Install Copilot CLI and authenticate once:

```sh
copilot login
```

Defaults:

- command: `copilot --acp --stdio`

If Pulsar cannot find `copilot`, set the full command line with an absolute
path (keep the arguments) in:

```text
Settings -> Packages -> pulsar-acp-agent -> Agent command
```

On Linux this may be something like:

```text
/home/you/.local/bin/copilot --acp --stdio
```

Wrap a path that contains spaces in double quotes, e.g.
`"C:\Program Files\agent\agent.exe" --acp --stdio`.

## Use

- Toggle panel: `Ctrl+Alt+A`
- Command palette: `Pulsar ACP Agent: Toggle`
- Send: `Enter`
- Newline: `Shift+Enter`
- Stop: cancel current turn
- Restart: kill and restart the agent process

If the agent advertises image prompt support, attach PNG, JPEG, GIF, or WebP
images up to 5 MiB via the attachment button, drag-and-drop, or paste.

The session working directory defaults to the first open project folder.
Multi-root workspaces are not supported yet: only the configured working
directory, or the first open project folder when no directory is configured, is
sent to the agent and allowed for file access.

## Develop

```sh
git clone https://github.com/hovancik/pulsar-acp-agent.git
cd pulsar-acp-agent
npm install
ppm link          # symlink the checkout into Pulsar
npm run typecheck
npm run build
npm run watch
```

Pulsar loads `lib/main.js`. Rebuild after editing `src/`, then reload Pulsar.

## Architecture

- `src/main.ts` registers commands, opener, and dock item.
- `src/agent-view.ts` renders the panel UI.
- `src/agent-session.ts` manages the ACP session via `@agentclientprotocol/sdk`.
- `src/util.ts` holds pure helpers (`parseCommandLine`, `TerminalRecord`) split
  out so they can be unit-tested without loading `atom`.

The SDK is ESM-only, so esbuild bundles it and `zod` into `lib/main.js`.

## Testing

`npm test` runs Node's built-in runner over `test/*.test.mjs`. Run
`npm run build` first because tests import the built `lib/util.js`.

## Capabilities

| Capability | Status |
| --- | --- |
| `fs.readTextFile` / `fs.writeTextFile` | yes, restricted to the session working directory |
| `session/request_permission` | yes |
| `terminal` | yes, commands run from the session working directory |
| `authenticate` | yes, uses the first auth method advertised by the agent |

## Security

The agent runs as a separate command-line process that Pulsar launches with
your user account. Pulsar does not sandbox it, so it has the same access to
your machine as any program you run yourself.

The limits below only constrain the requests an agent makes **through Pulsar**
over ACP. They do not restrict what the agent does in its own process:

- `fs/read_text_file` and `fs/write_text_file` are served only when the target
  path resolves inside the session working directory; the agent reads and writes
  there without a per-action prompt.
- Writes to open files with unsaved changes are refused.
- The ACP `terminal` capability is accepted: the agent can run commands *through*
  Pulsar, with their merged output shown in the panel. Commands launch from the
  session working directory (an absolute `cwd` outside it is refused) and run as
  separate processes with your user account. There is **no per-command approval
  prompt** and no sandbox — a launched command can do anything your account can.
  Terminals are killed when you Stop a turn, restart, or close the panel.

These are guard rails for a cooperating agent, not a security boundary: a
malicious agent can read or write any file your account can, or run any command,
without going through Pulsar at all. Use Pulsar ACP Agent only with agents you
trust; for stronger isolation, run it inside a container or VM.
