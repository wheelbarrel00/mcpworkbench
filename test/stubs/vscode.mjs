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

export const workspace = {
  get workspaceFolders() {
    return JSON.parse(process.env.MCPWB_TEST_FOLDERS || "[]").map((p) => ({ uri: { fsPath: p } }));
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
