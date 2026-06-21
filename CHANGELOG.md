# Changelog

All notable changes to MCP Workbench are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-21

Initial release.

### Added

- Unified discovery of MCP servers across Cursor, VS Code, Claude Code, and Claude Desktop, with one node per config file.
- Transport normalization so `stdio`, `http`, and `sse` servers are shown with a consistent shape regardless of each editor's field conventions.
- Configuration validation that surfaces the silent failures: wrong root key, unparseable JSON, empty root key, `npx` without `-y`, non-string args/env values, and `${ENV}` references that aren't set.
- Connection testing: a live MCP `initialize` + `tools/list` handshake rendered in a themed webview, listing server capabilities and each tool's input schema, or the exact reason a connection failed.
- Per-project discovery from `~/.claude.json`, scoped to the open workspace by default with a `mcpWorkbench.showAllClaudeProjects` setting to list every recorded project.
- Live refresh when any watched workspace or global config file changes.

### Security

- Spawned stdio servers receive only their explicitly configured environment plus the MCP SDK's safe default allowlist, never the full process environment, so secrets such as tokens and credentials are not handed to tested servers.
