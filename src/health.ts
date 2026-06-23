import type { Memento } from "vscode";
import type { ProbeResult } from "./mcpClient";
import { ScannedFile } from "./types";

const STORE_KEY = "mcpWorkbench.health";
const STATUSES = ["ok", "error", "unknown"] as const;
type HealthStatus = (typeof STATUSES)[number];

export interface HealthRecord {
  status: HealthStatus;
  latencyMs?: number;
  toolCount?: number;
  error?: string;
  checkedAt: number;
}

export interface RollupCounts {
  servers: number;
  errors: number;
  warnings: number;
}

export type StatusSeverity = "error" | "warning" | "none";

export class HealthStore {
  private records = new Map<string, HealthRecord>();

  constructor(private readonly memento: Memento) {
    const raw = memento.get<unknown>(STORE_KEY);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const record = sanitize(value);
        if (record) {
          this.records.set(id, record);
        }
      }
    }
  }

  get(id: string): HealthRecord | undefined {
    return this.records.get(id);
  }

  set(id: string, record: HealthRecord): Thenable<void> {
    this.records.set(id, record);
    return this.persist();
  }

  prune(validIds: Set<string>): Thenable<void> | void {
    let changed = false;
    for (const id of [...this.records.keys()]) {
      if (!validIds.has(id)) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (changed) {
      return this.persist();
    }
  }

  private persist(): Thenable<void> {
    return this.memento.update(STORE_KEY, Object.fromEntries(this.records));
  }
}

export function recordFromProbe(result: ProbeResult, checkedAt: number): HealthRecord {
  if (result.ok) {
    return { status: "ok", latencyMs: result.latencyMs, toolCount: result.toolCount, checkedAt };
  }
  return { status: "error", latencyMs: result.latencyMs, error: result.error, checkedAt };
}

export function rollup(files: ScannedFile[]): RollupCounts {
  let servers = 0;
  let errors = 0;
  let warnings = 0;
  const tally = (issues: { level: string }[]) => {
    for (const issue of issues) {
      if (issue.level === "error") {
        errors++;
      } else if (issue.level === "warning") {
        warnings++;
      }
    }
  };
  for (const file of files) {
    if (!file.exists) {
      continue;
    }
    tally(file.fileIssues);
    for (const server of file.servers) {
      servers++;
      tally(server.issues);
    }
  }
  return { servers, errors, warnings };
}

export function statusBarSeverity(counts: RollupCounts): StatusSeverity {
  if (counts.errors > 0) {
    return "error";
  }
  if (counts.warnings > 0) {
    return "warning";
  }
  return "none";
}

export function statusBarText(counts: RollupCounts): string {
  const servers = `${counts.servers} ${plural(counts.servers, "server")}`;
  const issues = counts.errors + counts.warnings;
  if (issues === 0) {
    return `$(server) MCP: ${servers}`;
  }
  return `$(server) MCP: ${servers}, ${issues} ${plural(issues, "issue")}`;
}

export function statusBarTooltip(counts: RollupCounts): string {
  const servers = `${counts.servers} ${plural(counts.servers, "server")}`;
  const errors = `${counts.errors} ${plural(counts.errors, "error")}`;
  const warnings = `${counts.warnings} ${plural(counts.warnings, "warning")}`;
  return `MCP Workbench — ${servers}, ${errors}, ${warnings}`;
}

export function healthSuffix(record: HealthRecord | undefined): string {
  if (!record || record.status === "unknown") {
    return "";
  }
  if (record.status === "error") {
    return "✗ unreachable";
  }
  const parts: string[] = [];
  if (typeof record.latencyMs === "number") {
    parts.push(`${record.latencyMs}ms`);
  }
  if (typeof record.toolCount === "number") {
    parts.push(`${record.toolCount} ${plural(record.toolCount, "tool")}`);
  }
  return parts.length ? `✓ ${parts.join(" · ")}` : "✓";
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function sanitize(value: unknown): HealthRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (!(STATUSES as readonly string[]).includes(v.status as string)) {
    return undefined;
  }
  const record: HealthRecord = {
    status: v.status as HealthStatus,
    checkedAt: typeof v.checkedAt === "number" ? v.checkedAt : 0,
  };
  if (typeof v.latencyMs === "number") {
    record.latencyMs = v.latencyMs;
  }
  if (typeof v.toolCount === "number") {
    record.toolCount = v.toolCount;
  }
  if (typeof v.error === "string") {
    record.error = v.error;
  }
  return record;
}
