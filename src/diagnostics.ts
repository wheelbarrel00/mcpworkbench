import * as vscode from "vscode";
import { ConfigIssue, ScannedFile } from "./types";
import { locateIssue, parseDocumentTree } from "./issueLocator";

const SOURCE = "MCP Workbench";
const SKIP_CODES = new Set(["projects-filtered"]);

const SEVERITY: Record<ConfigIssue["level"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class McpDiagnostics {
  private readonly collection = vscode.languages.createDiagnosticCollection("mcpWorkbench");
  private generation = 0;

  async publish(files: ScannedFile[]): Promise<void> {
    const generation = ++this.generation;
    const byPath = new Map<string, ScannedFile[]>();
    for (const file of files) {
      if (!file.exists || file.path === "(unresolved)") {
        continue;
      }
      const group = byPath.get(file.path) ?? [];
      group.push(file);
      byPath.set(file.path, group);
    }

    const resolved: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];
    for (const [filePath, group] of byPath) {
      const diagnostics = await this.fileDiagnostics(filePath, group);
      if (diagnostics.length) {
        resolved.push([vscode.Uri.file(filePath), diagnostics]);
      }
    }

    if (generation !== this.generation) {
      return;
    }
    this.collection.clear();
    for (const [uri, diagnostics] of resolved) {
      this.collection.set(uri, diagnostics);
    }
  }

  private async fileDiagnostics(filePath: string, group: ScannedFile[]): Promise<vscode.Diagnostic[]> {
    const issues = group.flatMap((file) => [
      ...file.fileIssues,
      ...file.servers.flatMap((server) => server.issues),
    ]);
    if (!issues.some((issue) => !SKIP_CODES.has(issue.code))) {
      return [];
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch {
      return [];
    }
    const tree = parseDocumentTree(doc.getText());

    const diagnostics: vscode.Diagnostic[] = [];
    for (const issue of issues) {
      if (SKIP_CODES.has(issue.code)) {
        continue;
      }
      const span = locateIssue(tree, issue);
      const range = span
        ? new vscode.Range(doc.positionAt(span.offset), doc.positionAt(span.offset + span.length))
        : firstLineRange(doc);
      const diagnostic = new vscode.Diagnostic(range, issue.message, SEVERITY[issue.level]);
      diagnostic.code = issue.code;
      diagnostic.source = SOURCE;
      diagnostics.push(diagnostic);
    }
    return diagnostics;
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function firstLineRange(doc: vscode.TextDocument): vscode.Range {
  const length = doc.lineCount > 0 ? doc.lineAt(0).text.length : 0;
  return new vscode.Range(0, 0, 0, Math.max(length, 1));
}
