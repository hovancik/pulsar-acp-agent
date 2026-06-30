# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added support for multiple ACP agents: configure several and switch between them from the header.
- Added per-session config option dropdowns in the footer for agent-exposed selectors such as model, custom agent, and reasoning effort (ACP `configOptions`).
- Added a pinned, collapsible **Plan** bar above the composer that shows the agent's live ACP plan with progress and the current step, and snapshots completed plans into the conversation.
- Added editor-context attachments: attach an image, the current selection, or the current file to a prompt from the composer, editor context menu, or commands.
- Tool-call cards with a single file location and permission-prompt locations are now clickable, opening the file at the reported line.
- Added an opt-in **Follow** toggle in the footer: while on, the editor opens and scrolls to each file the agent works on. It turns off automatically when you navigate to another file.

### Changed

- Session history list now takes less vertical space.
- Refined the composer footer styling and layout.

### Fixed

- Cancelled permission prompts are now marked resolved and their action buttons are disabled.
- Failed agent startup now fully resets transient session state before retrying.

## [0.2.0] - 2026-06-21

### Added

- Added a **Permissions** pill in the footer to toggle session-local auto-approval of ACP permission prompts (`Permissions: Ask` / `Permissions: Allow all`). When enabled, prompts are silently approved using `allow_once`; if no `allow_once` option is offered the prompt is shown normally. The setting is not persisted.
- Added a "Scroll to bottom" button that appears when you scroll up in the conversation, and disappears once you reach the bottom.
- Added a loading placeholder when opening a stored session: the conversation pane shows a pulsing "Loading session…" overlay while history is replayed, and reveals the restored conversation once ready.
- Added ACP `terminal/*` capability.
- Added agent info panel: click the agent name in the header to reveal its version, advertised capabilities and metadata as key/value rows, and a Restart button.
- Added image attachment support for PNG, JPEG, GIF, and WebP files up to 5 MiB.
- Added session list in the panel header (history icon): browse past sessions and switch when the agent supports loading sessions.
- Added trashcan delete button per session entry (shown when the agent advertises `sessionCapabilities.delete`).
- Agent responses are now rendered as sanitized Markdown, formatted live as the text streams in.
- Added a configurable host-context hint so agents know they are connected through Pulsar ACP Agent inside Pulsar.
- Permission prompts now show the command or URL from `rawInput` and a collapsible raw-input section.
- Added an in-chat activity indicator at the bottom of the conversation while the agent is busy: "Working…", "Awaiting confirmation…" during a permission prompt, and "Stopping…" after Stop is pressed.
- Tool-call cards now collapse long content by default, with a "Show more"/"Show less" toggle that appears only when the content overflows.
- Added a status bar tile showing the agent name when known and a state dot: a hollow ring while connecting, solid for ready, working, or error, and the theme's warning color while awaiting your confirmation; click it to reveal the panel.

### Removed

- Removed the configurable working directory setting; new sessions now use the first open project folder.

### Fixed

- Chat text is now selectable and copyable with Ctrl/Cmd+C and right-click Copy.
- Conversation now reliably auto-scrolls to follow streamed agent output, and stops following when you scroll up.
- Input textarea now uses theme variables instead of browser defaults.
## [0.1.0] - 2026-06-15

### Added

- Initial version of `pulsar-acp-agent`.
- Dock panel UI for chatting with an AI agent via the Agent Client Protocol (ACP).
- Configurable agent command line and working directory.
- File read/write for the agent, scoped to the session working directory.
- `pulsar-acp-agent:toggle` and `pulsar-acp-agent:focus` activation commands.

[Unreleased]: https://github.com/hovancik/pulsar-acp-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hovancik/pulsar-acp-agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hovancik/pulsar-acp-agent/releases/tag/v0.1.0
