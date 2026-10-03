export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "sse"; url: string; headers: Record<string, string> };

export type StdioTransport = Extract<McpTransport, { kind: "stdio" }>;

export type McpSource =
  | "cursor-global"
  | "cursor-workspace"
  | "vscode-workspace"
  | "vscode-user"
  | "claude-code-workspace"
  | "claude-code-user"
  | "claude-desktop";

export type JsonPath = (string | number)[];

export interface ConfigIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: JsonPath;
  offset?: number;
}

export type InputValues = ReadonlyMap<string, string>;

export interface InputOption {
  label: string;
  value: string;
}

export interface InputDefinition {
  id: string;
  type: string;
  description?: string;
  password?: boolean;
  default?: string;
  options?: InputOption[];
}

export interface DiscoveredServer {
  name: string;
  transport: McpTransport;
  source: McpSource;
  configPath: string;
  rootKey: "servers" | "mcpServers";
  scope?: string;
  projectDir?: string;
  inputs?: InputDefinition[];
  raw: unknown;
  issues: ConfigIssue[];
}

export interface ScannedFile {
  path: string;
  source: McpSource;
  workspaceFolder?: string;
  exists: boolean;
  fileIssues: ConfigIssue[];
  servers: DiscoveredServer[];
}
