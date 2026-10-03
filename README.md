<p align="center">
  <img src="media/logo.png" alt="MCP Workbench" width="256" />
</p>

# MCP Workbench

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=wheelbarrel00.mcp-workbench-wb00"><img src="https://img.shields.io/visual-studio-marketplace/v/wheelbarrel00.mcp-workbench-wb00?label=VS%20Marketplace&color=2b7cd3" alt="VS Marketplace"></a>
  <a href="https://open-vsx.org/extension/wheelbarrel00/mcp-workbench-wb00"><img src="https://img.shields.io/open-vsx/v/wheelbarrel00/mcp-workbench-wb00?label=Open%20VSX&color=a60ee5" alt="Open VSX"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
</p>

Discover, validate, and test every MCP server across Cursor, VS Code, and Claude — in one place.

MCP server definitions end up scattered across half a dozen files with different root keys and transport conventions, and a single typo silently drops a server with no warning. MCP Workbench scans every known location, normalizes the results into one tree, and flags the misconfigurations that usually cost you an hour of debugging.

![The Servers panel](media/screenshots/servers-panel.png)

## Features

- **Unified discovery** — one tree of every MCP server found across Cursor, VS Code, Claude Code, and Claude Desktop, grouped by source.
- **Transport normalization** — `stdio`, `http`, and `sse` servers shown with a consistent shape regardless of which editor's field conventions the file used.
- **Configuration validation** — surfaces the silent failures: wrong root key, unparseable JSON, `npx` without `-y`, environment variables that aren't set, and variable syntax the editor leaves as written.
- **Security & correctness checks** — flags hardcoded API keys, credentials in URLs, plaintext `http://` remotes, unpinned `npx`/`bunx` launchers, `curl | sh` bootstrap chains, encoded PowerShell, code-loading or registry-redirecting environment variables like `NODE_OPTIONS=--require`, and cloud-metadata endpoints, all from the config you already have.
- **Safe with untrusted repos** — servers defined by a workspace never launch without showing you the program, each argument, the environment, the headers, and which of your environment variables they read. Approvals are pinned to that exact configuration, and in Restricted Mode nothing that runs from the workspace launches at all while validation keeps working.
- **Problems-panel diagnostics** — every issue is published as a native VS Code diagnostic anchored to the exact key in the config file, so it shows up as a squiggle and in the Problems panel with click-to-jump.
- **Connection testing** — launch any server over the MCP SDK, run the `initialize` handshake, and list its capabilities, tools, resources, and prompts (with input schemas) — or see the exact reason it failed to connect.
- **Per-server health** — a fast **Test Connection** records each server's handshake latency and tool count, shown inline in the tree, with a status-bar rollup of how many servers and issues were found across every source.
- **Live tool calls, resource reads, and prompt fetches** — call any tool through a form generated from its input schema, with required-field validation and a Form/JSON toggle for advanced edits; read any resource (or fill in a template URI); and fetch a prompt's messages with its arguments — all against the live server, rendered inline.
- **Provenance at a glance** — every server shows which file and editor it came from, with the absolute config path one click away.
- **Live refresh** — re-scans automatically when any known MCP config changes in your workspace.

## Screenshots

Hover any server to see its source, the exact config file it came from, and every validation issue:

![Validation on hover](media/screenshots/validation-tooltip.png)

### Per-server health

Run a fast **Test Connection** on any server to record its handshake latency and tool count, shown inline in the tree — with a status-bar rollup of every server and issue found:

![Health shown inline in the Servers tree](media/screenshots/server-health.png)

![Test Connection result](media/screenshots/test-connection.png)

### Status-bar rollup

An always-visible **MCP** item in the status bar rolls up every source at a glance — the total server count, plus a running tally of configuration and security issues. Hover for the full **N servers, X errors, Y warnings** breakdown, click to jump straight to the Servers view, and watch it turn yellow or red the moment a warning or error appears:

![The status-bar rollup with its hover tooltip](media/screenshots/status-bar-rollup.png)

### Tool, resource & prompt tester

Open a server to call its tools through a form generated from each tool's input schema (or switch to raw JSON), read resources, and fetch prompts — live, with results rendered inline:

![The tool tester](media/screenshots/tool-tester.png)

## Where it looks

| Source | Location | Root key |
| --- | --- | --- |
| Cursor (global) | `~/.cursor/mcp.json` | `mcpServers` |
| Cursor (workspace) | `<workspace>/.cursor/mcp.json` | `mcpServers` |
| VS Code (workspace) | `<workspace>/.vscode/mcp.json` | `servers` |
| VS Code (user) | `%APPDATA%\Code\User\mcp.json` (Windows) · `~/Library/Application Support/Code/User/mcp.json` (macOS) · `~/.config/Code/User/mcp.json` (Linux) | `servers` |
| Claude Code (workspace) | `<workspace>/.mcp.json` | `mcpServers` |
| Claude Code (user) | `~/.claude.json` | `mcpServers` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) · `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `~/.config/Claude/claude_desktop_config.json` (Linux) | `mcpServers` |

Servers recorded per project under `projects["<path>"].mcpServers` in `~/.claude.json` are scoped to the open workspace folder by default. Set `mcpWorkbench.showAllClaudeProjects` to list every recorded project. Edits to the global config files above refresh the tree automatically.

When MCP Workbench runs inside VS Code, VS Code Insiders, or VSCodium, the VS Code (user) entry is the default profile's `mcp.json` for that install, including portable installs. In other editors it falls back to the default VS Code location above.

## Validation checks

Every issue below is also published to the Problems panel, anchored to the exact key it concerns.

### Configuration

| Issue | Level | What it catches |
| --- | --- | --- |
| `missing-root-key` | error | The right file with the wrong top-level key, so the editor loads no servers without warning. |
| `bad-json` | error | A config file that can't be parsed. |
| `read-failed` | error | A config path that exists but can't be read (permissions, or a folder where a file should be). |
| `unknown-transport` | error | An entry with neither a `command` (stdio) nor a `url` (http/sse). |
| `empty-command` | error | An stdio server whose `command` is blank. |
| `missing-type` | error | A Claude Code entry with a `url` but no `type`, which Claude Code reads as a stdio server and skips. |
| `empty-root-key` | warning | The root key is present but defines no servers. |
| `npx-missing-y` | warning | `npx` without `-y`/`--yes`, which can hang waiting for an install prompt. |
| `env-unset` | warning | A reference to an environment variable that isn't set and has no default, using the syntax of the config's editor (`${VAR}` in Claude Code, `${env:VAR}` in VS Code and Cursor). Checked in the command, args, env, url, and headers. |
| `variable-not-expanded` | warning | A `${...}` the editor passes through as written, such as a bare `${VAR}` in VS Code or Cursor, `${env:VAR}` in Claude Code, or any variable in Claude Desktop. |
| `credential-blanked` | warning | A credential such as `ANTHROPIC_API_KEY` or `NPM_TOKEN` in a Claude Code remote server's url or headers, which Claude Code reads as empty. |
| `input-undefined` | warning | A VS Code `${input:id}` with no matching entry under `inputs` in the file. |
| `non-string-arg` / `non-string-value` | warning | A non-string arg, env value, or header that would otherwise be silently coerced. |
| `variable-unsupported` | info | A variable the tester can't fill in, like `${command:...}`, `${config:...}`, a `command` input, or `${workspaceFolder}` in a config that isn't tied to a project folder, so the tester can't launch that server. |

### Security

| Issue | Level | What it catches |
| --- | --- | --- |
| `hardcoded-secret` | warning | A literal API key, token, or private key in the command, an arg, the URL, an env value, or a header (OpenAI, Anthropic, GitHub, GitLab, Slack, Stripe, Google, Hugging Face, npm, AWS, JWTs, PEM), or a literal credential under a field like `Authorization` or `*_API_KEY`. Reference an environment variable instead, as `${VAR}` in Claude Code or `${env:VAR}` in VS Code and Cursor. |
| `credential-in-url` | warning | Credentials in the URL's userinfo or a `token`/`secret`/`key`-style query parameter, where they leak into logs. |
| `insecure-remote-transport` | warning | A plaintext `http://` URL to a non-local host, so traffic and credentials travel unencrypted. |
| `risky-shell-pipe` | warning | An argument that pipes a downloaded script straight into a shell (`curl … \| sh`), running remote code at launch. |
| `encoded-powershell` | warning | PowerShell invoked with an encoded command (`-enc`), which hides what actually runs. |
| `env-code-injection` | warning | An environment variable that loads extra code before the server starts (`NODE_OPTIONS` with `--require`/`--import`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `DOTNET_STARTUP_HOOKS`, and similar) or points the package installer at another registry (`npm_config_registry`, `PIP_INDEX_URL`, `UV_INDEX_URL`). |
| `metadata-endpoint` | warning | A URL pointing at the cloud metadata address (`169.254.169.254`), a common SSRF target. |
| `unpinned-launcher` | info | `npx`/`bunx`/`pnpm dlx`/`yarn dlx`/`npm exec` running a package with no version pin, so a future release could change behavior. |

Turn the whole security lens off with `mcpWorkbench.security.enabled: false`, or retune individual rules with `mcpWorkbench.security.ruleSeverity` — e.g. `{ "unpinned-launcher": "off", "hardcoded-secret": "error" }` (values: `off`, `info`, `warning`, `error`). Both settings are read from your user settings only, so a repository's workspace settings can't switch the checks off.

## Install

- **VS Code** — open the Extensions view and search **"MCP Workbench: Discover & Test"**, or [install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=wheelbarrel00.mcp-workbench-wb00).
- **Cursor** — open Extensions and search **"MCP Workbench"** (Cursor installs from Open VSX), or [install from Open VSX](https://open-vsx.org/extension/wheelbarrel00/mcp-workbench-wb00).

Then click the **MCP Workbench** icon in the activity bar to open the **Servers** view.

### Build from source

```bash
git clone https://github.com/wheelbarrel00/mcpworkbench.git
cd mcpworkbench
npm install
npm run compile
```

Press **F5** to launch an Extension Development Host with MCP Workbench loaded, or run `npm run package` to build a `.vsix` you can install with `--install-extension`.

## Usage

- **Refresh** — re-scan all locations from the view's title bar.
- **Open Config File** — right-click a server to jump to the exact file it came from.
- **Test Connection** — click the plug button on a server (or right-click → Test Connection) for a fast health check: it connects, times the handshake, and counts the tools without opening the full panel. The latency and tool count are cached and shown inline in the tree, and a rollup of every server and issue stays in the status bar.

  ![The Test Connection button](media/screenshots/test-connection-button.png)

- **Test Server** — click the ▶ button on a server (or right-click → Test Server) to connect over the MCP SDK and open a panel with the server's `initialize` info, capabilities, tools, resources, and prompts — or the exact connection error. The panel stays connected while open: call a tool through a form generated from its schema (or switch to raw JSON), **Read** a resource (filling in any template variables), or **Get prompt** with its arguments to run against the live server, then close the panel to disconnect.
- **Launching like your editor** — the tester starts each server the way the editor that owns its config would. It expands only that editor's variable syntax, and after the launch prompt it asks for any VS Code `${input:...}` values. Stdio servers get your full environment, except Claude Desktop servers, which get only Claude Desktop's small default set. A command that still contains `${...}` after filling in is never run. An `http` server that refuses Streamable HTTP is retried over SSE, and tools, resources, and prompts are loaded across pages, up to 50 pages or 2,000 items each.
- **Launching workspace servers** — servers from `.mcp.json`, `.vscode/mcp.json`, or `.cursor/mcp.json` come from the repo, so you're asked before the first test runs. The prompt shows the command, environment, headers, which of your environment variables will be filled in or are not set, and that a local program also inherits your environment. **Always allow this configuration** remembers that exact entry, and if the repo later changes it, you're asked again. Run **MCP Workbench: Reset Launch Trust** to forget every approval in this workspace. In Restricted Mode, nothing that runs from the workspace launches until you trust it, including your own servers set up to run in that folder. On Windows, a bare command like `npx` is resolved from your PATH before the project folder, so a same-named file committed to the repo can't stand in for it. If the program is only found through the workspace folder, the prompt says so.

## License

[MIT](LICENSE)
