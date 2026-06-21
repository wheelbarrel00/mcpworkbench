# MCP Workbench

Discover, validate, and test every MCP server across Cursor, VS Code, and Claude — in one place.

MCP server definitions end up scattered across half a dozen files with different root keys and transport conventions, and a single typo silently drops a server with no warning. MCP Workbench scans every known location, normalizes the results into one tree, and flags the misconfigurations that usually cost you an hour of debugging.

![The Servers panel](media/screenshots/servers-panel.png)

## Features

- **Unified discovery** — one tree of every MCP server found across Cursor, VS Code, Claude Code, and Claude Desktop, grouped by source.
- **Transport normalization** — `stdio`, `http`, and `sse` servers shown with a consistent shape regardless of which editor's field conventions the file used.
- **Configuration validation** — surfaces the silent failures: wrong root key, unparseable JSON, `npx` without `-y`, and `${ENV}` references that aren't set in your environment.
- **Provenance at a glance** — every server shows which file and editor it came from, with the absolute config path one click away.
- **Live refresh** — re-scans automatically when any known MCP config changes in your workspace.

## Screenshots

Hover any server to see its source, the exact config file it came from, and every validation issue:

![Validation on hover](media/screenshots/validation-tooltip.png)

## Where it looks

| Source | Location | Root key |
| --- | --- | --- |
| Cursor (global) | `~/.cursor/mcp.json` | `mcpServers` |
| Cursor (workspace) | `<workspace>/.cursor/mcp.json` | `mcpServers` |
| VS Code (workspace) | `<workspace>/.vscode/mcp.json` | `servers` |
| Claude Code (workspace) | `<workspace>/.mcp.json` | `mcpServers` |
| Claude Code (user) | `~/.claude.json` | `mcpServers` |
| Claude Desktop | `~/.claude/claude_desktop_config.json` | `mcpServers` |

## Validation checks

| Issue | Level | What it catches |
| --- | --- | --- |
| `missing-root-key` | error | The right file with the wrong top-level key, so the editor loads no servers without warning. |
| `bad-json` | error | A config file that can't be parsed. |
| `unknown-transport` | error | An entry with neither a `command` (stdio) nor a `url` (http/sse). |
| `npx-missing-y` | warning | `npx` without `-y`/`--yes`, which can hang waiting for an install prompt. |
| `env-unset` | warning | A `${VAR}` / `${env:VAR}` reference that isn't set in your environment. |

## Getting started

### Run from source

```bash
git clone https://github.com/wheelbarrel00/mcpworkbench.git
cd mcpworkbench
npm install
npm run compile
```

Open the folder in VS Code or Cursor and press **F5** to launch an Extension Development Host with MCP Workbench loaded. Click the **MCP Workbench** icon in the activity bar to open the **Servers** view.

### Install the packaged extension

```bash
npx @vscode/vsce package
cursor --install-extension mcp-workbench-0.1.0.vsix
```

Then reload Cursor and open the MCP Workbench panel from the activity bar.

## Usage

- **Refresh** — re-scan all locations from the view's title bar.
- **Open Config File** — right-click a server to jump to the exact file it came from.
- **Test Server** — right-click a server to connect and exercise it *(coming next; currently a stub)*.

## Roadmap

- Connect to a server over the MCP SDK and run the `initialize` + `tools/list` handshake, then render tools and schemas in a webview with a live `tools/call`.
- Parse per-project servers nested under `projects["<path>"].mcpServers` in `~/.claude.json`.
- Opt-in support for VS Code user-profile `mcp.json` paths.
