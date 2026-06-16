# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added ACP `terminal/*` capability.
- Added image attachment support for PNG, JPEG, GIF, and WebP files up to 5 MiB.

### Fixed

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
