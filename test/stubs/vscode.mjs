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
};
