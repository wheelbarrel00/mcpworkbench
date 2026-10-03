export class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return { dispose() {} };
    };
  }
  fire(value) {
    for (const listener of this._listeners) {
      listener(value);
    }
  }
}

function recorder() {
  globalThis.__mcpwbVscode ??= { warnings: [], choices: [], commands: [] };
  return globalThis.__mcpwbVscode;
}

export const window = {
  async showWarningMessage(message, ...rest) {
    const state = recorder();
    state.warnings.push({ message, rest });
    return state.choices.shift();
  },
  async showInputBox(options) {
    const state = recorder();
    (state.prompts ??= []).push({ kind: "input", options });
    return (state.answers ??= []).shift();
  },
  async showQuickPick(items, options) {
    const state = recorder();
    (state.prompts ??= []).push({ kind: "pick", items, options });
    const answer = (state.answers ??= []).shift();
    return items.find((item) => item.value === answer);
  },
};

export const commands = {
  async executeCommand(command, ...args) {
    recorder().commands.push({ command, args });
  },
};

export const workspace = {
  get workspaceFolders() {
    return JSON.parse(process.env.MCPWB_TEST_FOLDERS || "[]").map((p) => ({ uri: { fsPath: p } }));
  },
  get isTrusted() {
    return process.env.MCPWB_TEST_UNTRUSTED !== "1";
  },
  getConfiguration() {
    return {
      get(key, fallback) {
        if (key === "showAllClaudeProjects") {
          return process.env.MCPWB_TEST_SHOWALL === "1";
        }
        return fallback;
      },
    };
  },
};

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

export class MarkdownString {
  constructor(value) {
    this.value = value ?? "";
  }
}
