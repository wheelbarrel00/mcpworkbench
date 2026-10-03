# Changelog

All notable changes to MCP Workbench are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.9] - 2026-10-02

### Added

- The tester now reads variables the way each editor does. Claude Code configs expand `${VAR}` and `${VAR:-default}`. VS Code and Cursor configs expand `${env:VAR}` and their folder, home, and path-separator variables. Claude Desktop configs expand nothing. Anything the editor would leave as written now reaches the server as written.
- VS Code `${input:...}` values are asked for when a server launches, after the launch prompt, with password inputs masked.
- An `http` server that refuses Streamable HTTP is retried over SSE, the way VS Code and Claude Code fall back. The tester and Test Connection say when this happens.
- Tools, resources, resource templates, and prompts are now loaded across pages, up to 50 pages or 2,000 items each, and the tester says when a list was cut short.
- New checks: `variable-not-expanded` for a `${...}` the editor passes through as written, `credential-blanked` for a credential Claude Code reads as empty in a remote server's url or headers, `input-undefined` for a VS Code input with no definition, `variable-unsupported` for a variable the tester can't fill in, and `missing-type` for a Claude Code url entry with no `type`, which Claude Code skips.
- When MCP Workbench runs in VS Code Insiders, VSCodium, or a portable install, it reads that install's own default-profile `mcp.json`.

### Changed

- Local servers now get your full environment, as they do in editors, so a server behind a proxy or one that reads a token from your shell works in the tester. Claude Desktop servers still get only Claude Desktop's small default set. The launch prompt says when a program inherits your environment.
- Claude Code servers are given `CLAUDE_PROJECT_DIR` and `CLAUDECODE`, as Claude Code does.
- An environment variable that isn't set no longer stops a launch, unless it's in the command. It reaches the server as written in Claude Code configs and as an empty value in VS Code and Cursor configs, matching the editor, and the launch prompt and the tester list it.
- In Claude Code configs, `${workspaceFolder}` and `${userHome}` are no longer filled in, because Claude Code reads them as environment variables. Use `${CLAUDE_PROJECT_DIR:-.}` for the project folder.
- `${workspaceFolder}` in a VS Code user config or a global Cursor config is no longer replaced with an empty path. The tester now says it can't fill it in.
- The `env-unset` check now also covers the command, arguments, and url, and follows each editor's variable syntax.
- When Test Connection times out on a launcher such as `npx`, the details now explain that the first run may still be downloading the package.
- The secret warnings suggest each editor's own variable syntax.

### Security

- Inputs are asked for only after the launch prompt is accepted. If a value you enter makes the program resolve through the workspace folder, you're asked to confirm that separately.
- "Always allow" now also remembers a server's input definitions, so changing an input's options or default asks again. Servers approved in 0.4.8 ask once more, because the environment rules changed.
- A command that still contains `${` after its variables are filled in is never run, so a repository file named like an unexpanded variable can't run in its place.
- In a Claude Code remote server's url and headers, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, and `NPM_TOKEN` are sent empty, as Claude Code does.

### Fixed

- On Windows, a server started through a `.cmd` launcher such as `npx` is now stopped when its connection fails or times out, instead of being left running.
- A failing list request is shown as an error in the tester instead of as an empty list, and a server that has resources but no resource templates no longer shows an error.
- Tools on every page keep their output-schema validation.
- If a server exits while the tester is still loading it, the tester now says it disconnected instead of showing it as connected.
- On Windows, a Claude Desktop config's own `PATH` is no longer replaced by the default one.

## [0.4.8] - 2026-09-26

### Added

- MCP Workbench now works in Restricted Mode. Configs are still discovered and validated, but nothing that runs from an untrusted workspace is launched, including your own servers set up to run in that folder.
- A new `env-code-injection` security rule flags environment variables that load extra code before a server starts, such as `NODE_OPTIONS` with `--require`, `LD_PRELOAD`, `BASH_ENV`, or `DOTNET_STARTUP_HOOKS`, and variables that point the package installer at a different registry, such as `npm_config_registry`, `PIP_INDEX_URL`, or `UV_INDEX_URL`.
- A new **MCP Workbench: Reset Launch Trust** command forgets every launch approval in the current workspace.

### Security

- Before a server defined by a workspace launches or connects, the prompt now shows the program and where it resolves on Windows, each argument on its own line, the environment, the headers, and which values will be filled in from your machine. Hidden and direction-changing characters are shown escaped, and long values are shortened with a marker.
- "Always allow" now remembers a server's exact configuration and asks again whenever what would run changes. Earlier workspace-wide approvals are cleared, so each workspace server asks once more.
- On Windows, a bare command such as `npx` is now resolved from your PATH before the project folder, so a same-named file committed to a repository can't stand in for the real program.
- The security settings are now read from user settings only, so a repository's workspace settings can't switch the checks off.
- The hardcoded-secret check now recognizes GitLab, Stripe, Google, Hugging Face, and npm tokens and JSON Web Tokens. It also looks in the command and the URL, and flags literal credentials under fields such as `Authorization` or `*_API_KEY`.

### Fixed

- A config path that exists but can't be read is now reported as `read-failed` instead of as invalid JSON.
- Variable references are now expanded in a single pass, so a value filled in from one variable is never expanded a second time.
- Secret warnings are now worded for the file they appear in, so user-level config files are no longer told not to commit the value.
- Validation stays fast on configs with extremely long values.

### Changed

- The MCP SDK is updated to 1.30.1.
- The published package is smaller, because README screenshots are no longer bundled and the icon is now 256 by 256 pixels.
- Releases are now tested and built in a separate step from publishing, and every push and pull request runs the typecheck and tests on Windows and Linux.

## [0.4.7] - 2026-07-19

### Added

- VS Code user-profile MCP servers are now discovered and listed as a "VS Code (user)" source. The file is read from `%APPDATA%\Code\User\mcp.json` on Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS, and `~/.config/Code/User/mcp.json` on Linux, where `XDG_CONFIG_HOME` is honored when set.

### Fixed

- Config files saved as UTF-16, which is the default of PowerShell's `Out-File`, are now decoded and parsed correctly instead of failing with a misleading invalid-JSON error.
- An empty `~/.claude.json`, which is normal for a fresh Claude Code install, is no longer reported as an error. A file that uses the wrong root key or a malformed `mcpServers` is still flagged, so genuine mistakes are not hidden.
- Numeric and boolean values in a server's `args` are now passed through as strings instead of being dropped, so an argument list such as `["--port", 8080, "--verbose"]` keeps its order and its values.
- Project paths recorded in `~/.claude.json` are now matched case-sensitively on Linux, so two projects that differ only by letter case are no longer treated as the same folder.

## [0.4.6] - 2026-07-17

### Security

- The hardcoded-secret check now recognizes modern OpenAI project and service-account keys (`sk-proj-`, `sk-svcacct-`) and GitHub fine-grained tokens (`github_pat_`), so a literal key of one of these formats in a config is flagged instead of passing silently.
- Credentials in a remote server URL query string are now detected regardless of letter case, so parameters such as `apiKey` or `Token` are caught, not only their lowercase spellings.
- The Test Server panel webview can no longer load local files from your workspace or the extension directory, tightening the sandbox around rendered results.

### Fixed

- A remote server pointed at the IPv6 loopback address (`http://[::1]`) is now treated as local and no longer flagged with a spurious insecure-transport warning.
- The missing `-y` warning for `npx` now recognizes the launcher when it is written as `npx.cmd` or as an absolute path, not only as a bare `npx`.
- When a configured launcher cannot be found, the connection error now explains that the command is not on the editor's PATH and suggests using an absolute path. This is a common cause on GUI-launched editors that do not inherit a shell PATH.
- Connecting to a server is faster and no longer risks a long stall. The tester now queries the server's tools, resources, and prompts at the same time rather than one after another, so a slow listing no longer adds up across all of them.
- A server that fails to list its tools now opens with an empty tool list and its resources and prompts intact, instead of reporting the whole connection as failed.
- Long-running tool calls that report progress are no longer cut off at the base timeout, so a tool that keeps sending progress updates can run to completion.
- Testing a stateful Streamable HTTP server now ends the session on the server when you close the tester, and this cleanup is time-bounded so an unresponsive server cannot stall the extension while it shuts down.

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
