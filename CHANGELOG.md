# Changelog

All notable changes to MCP Workbench are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.5] - 2026-07-15

### Security

- Launching a server defined in a **workspace** config (`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`) now asks for confirmation and shows the exact command before it runs, so opening a cloned repository can no longer execute a workspace-defined command on a single click. Servers from your user or global configs still launch without a prompt, and "Always allow in this workspace" suppresses the confirmation per workspace.

### Fixed

- `.mcp.json` and `~/.claude.json` are now validated as strict JSON: a trailing comma or comment is reported as an error, matching how Claude Code actually parses them, instead of showing as valid while the real client rejects the file. Editor configs that genuinely support comments (`.vscode` and `.cursor`) stay lenient.
- The tester now notices when a server process exits mid-session — the status changes to disconnected and the action buttons disable — instead of continuing to show "Connected" until the next call fails.
- Transport and protocol errors, such as a server printing a non-JSON line to stdout, now appear in the failure details instead of being silently swallowed.
- A server's captured error output is now bounded and decoded correctly, so a long-running or noisy server no longer grows the extension's memory without limit, and multi-byte characters split across output chunks are no longer garbled in the error details.
- Large tool, resource, and prompt results are now truncated before they are handed to the tester view, so an oversized response no longer risks stalling the extension.

## [0.4.4] - 2026-07-14

### Fixed

- Claude Desktop configs are now discovered at the correct per-OS location — `%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS, `~/.config/Claude` on Linux — instead of a path that never existed, so Claude Desktop servers actually appear in the tree.
- Testing a server no longer leaves an orphaned server process behind when the window reloads or the extension shuts down. On Windows the whole process tree is terminated, including the `npx`/`cmd.exe` launcher chain that the previous shutdown left running.
- The Servers view no longer fails to render when a workspace folder is your home directory. Global and workspace configs that resolve to the same file now keep distinct tree nodes instead of colliding.
- The tester now expands `${workspaceFolder}` and `${userHome}`, expands environment variables whose names contain parentheses such as `${ProgramFiles(x86)}`, and applies expansion to the launch command and remote URL — so a config that works in your editor works here too, instead of failing with a spurious "environment variable is not set" error. Valid `${workspaceFolder}` references are also no longer flagged as unset environment variables, and paths containing `$` are substituted literally.
- Rapid successive edits to a config file now trigger a single tree refresh rather than a burst of rescans.

## [0.4.3] - 2026-06-29

### Changed

- Bundled the full changelog history into the published package so the Marketplace and Open VSX **Changes** tab shows the 0.4.1 and 0.4.2 entries. No functional changes.

## [0.4.2] - 2026-06-28

### Changed

- Refreshed the Marketplace and Open VSX listing with a status-bar rollup screenshot and a dedicated README section documenting it. No functional changes.

## [0.4.1] - 2026-06-23

### Added

- A **Sponsor** button on the extension page, linking to GitHub Sponsors.

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
