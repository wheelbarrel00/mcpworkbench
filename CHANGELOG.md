# Changelog

All notable changes to MCP Workbench are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-06-22

### Added

- Per-server health: a fast **Test Connection** command (the plug button on a server, or right-click → Test Connection) connects, times the `initialize` handshake, and counts the server's tools without opening the full panel. The latency and tool count are cached per server and shown inline in the tree.
- Status-bar rollup: a status-bar item shows how many MCP servers and validation issues were found across every source, turns its background warning or error when issues exist, and clicks through to the Servers view.
- Schema-driven tool argument forms in the Test Server panel: each tool's arguments render as a form generated from its input schema, with required-field validation and a Form/JSON toggle for advanced edits, falling back to a raw JSON box for schemas a form can't represent.

## [0.3.0] - 2026-06-21

### Added

- Problems-panel diagnostics: every validation issue is now published as a native VS Code diagnostic anchored to the exact key in the config file, so issues appear as inline squiggles and in the Problems panel with click-to-jump.
- Security & correctness checks over the config you already have: hardcoded API keys or private keys in args/env/headers (`hardcoded-secret`), credentials in a URL's userinfo or query string (`credential-in-url`), plaintext `http://` to a non-local host (`insecure-remote-transport`), `curl … | sh` bootstrap chains (`risky-shell-pipe`), encoded PowerShell commands (`encoded-powershell`), cloud-metadata endpoints (`metadata-endpoint`), and unpinned `npx`/`bunx`/`pnpm dlx`/`yarn dlx`/`npm exec` launchers (`unpinned-launcher`).
- Resources and prompts in the Test Server panel: it now lists resources, resource templates, and prompts alongside tools. Read any resource (or fill in a template URI) to render its contents, and fetch a prompt's messages by filling in its arguments — all against the live server.
- Settings to tune the security lens: `mcpWorkbench.security.enabled` turns all security checks on or off, and `mcpWorkbench.security.ruleSeverity` overrides the severity of an individual rule (`off`, `info`, `warning`, or `error`).

## [0.2.2] - 2026-06-21

### Fixed

- The logo background is now transparent, removing the white box that appeared around the icon on dark backgrounds (GitHub, the Marketplace, and Open VSX).

## [0.2.1] - 2026-06-21

### Changed

- Published under the extension id `mcp-workbench-wb00` with the display name "MCP Workbench: Discover & Test" so the extension can ship to the VS Code Marketplace, where the previous display name was already taken.

## [0.2.0] - 2026-06-21

### Added

- Call tools live from the Test Server panel: each tool gets a JSON arguments box pre-filled from its input schema and a button that runs a real `tools/call` against the connected server, rendering the result inline (text, structured content, and labels for image, audio, and resource blocks).
- Spawned stdio servers now default their working directory to the server's project or workspace folder, so tools that resolve paths relative to the working directory behave as they do in the host editor.

### Changed

- The Test Server panel keeps one MCP session connected while it is open and reuses it for tool calls; closing the panel disconnects the server.

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
