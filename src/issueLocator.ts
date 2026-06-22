import { findNodeAtLocation, parseTree } from "jsonc-parser";
import type { Node } from "jsonc-parser";
import { ConfigIssue } from "./types";

export interface Span {
  offset: number;
  length: number;
}

export function parseDocumentTree(text: string): Node | undefined {
  return parseTree(text, [], { allowTrailingComma: true });
}

export function locateIssue(tree: Node | undefined, issue: ConfigIssue): Span | undefined {
  if (typeof issue.offset === "number") {
    return { offset: issue.offset, length: 1 };
  }
  if (!tree || !issue.path) {
    return undefined;
  }
  const node = findNodeAtLocation(tree, issue.path);
  if (!node) {
    return undefined;
  }
  const keyNode =
    node.parent?.type === "property" ? node.parent.children?.[0] : undefined;
  const target = keyNode ?? node;
  return { offset: target.offset, length: Math.max(target.length, 1) };
}
