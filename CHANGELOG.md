# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added ACP `terminal/*` capability.
- Added agent info panel: click the agent name pill in the header to reveal its version, advertised capabilities, and metadata.
- Added image attachment support for PNG, JPEG, GIF, and WebP files up to 5 MiB.
- Added session list in the sessions bar: browse and switch between past sessions.
- Added delete button per session entry (shown when the agent advertises `sessionCapabilities.delete`).
- Agent responses are now rendered as Markdown (GFM). Text streams as plain text during generation and is formatted once the message is complete.
- Added a configurable host-context hint so agents know they are connected through Pulsar ACP Agent inside Pulsar.
- Tool-call cards now show the command or URL from `rawInput` and a collapsible raw-input section.

### Changed

- Redesigned the header and sessions list. The agent name is now a clickable disclosure that opens the agent details panel (version, capabilities, metadata, and Restart) and shows live activity (connecting, working); the live status row shows mode and token usage only and collapses when empty. "+ New" session is now the primary action.

### Fixed

- Conversation now reliably auto-scrolls to follow streamed agent output unless you scroll up, including after a late-loading image preview grows.
- Input textarea now uses theme variables instead of browser defaults.

## [0.1.0] - 2026-06-15

### Added

- Initial version of `pulsar-acp-agent`.
- Dock panel UI for chatting with an AI agent via the Agent Client Protocol (ACP).
- Configurable agent command line and working directory.
- File read/write for the agent, scoped to the session working directory.
- `pulsar-acp-agent:toggle` and `pulsar-acp-agent:focus` activation commands.

[Unreleased]: https://github.com/hovancik/pulsar-acp-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hovancik/pulsar-acp-agent/releases/tag/v0.1.0
