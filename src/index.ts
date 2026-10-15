#!/usr/bin/env node

/**
 * MCP Memory Server Entry Point
 *
 * This is the main entry point for the MCP memory server.
 * All core functionality is imported from @danielsimonjr/memoryjs.
 *
 * @module index
 */

import {
  logger,
  defaultMemoryPath,
  ensureMemoryFilePath,
  ManagerContext,
  // Re-export types for backward compatibility
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type GraphStats,
  type ValidationReport,
  type ValidationIssue,
  type ValidationWarning,
  type SavedSearch,
  type TagAlias,
  type SearchResult,
  type BooleanQueryNode,
  type ImportResult,
  type CompressionResult,
  // v1.7.0 new types
  type ArtifactEntity,
  type ArtifactType,
  type ArtifactFilter,
  type FreshnessReport,
  type AuditEntry,
  type AuditOperation,
  type RefEntry,
  type RefIndexStats,
  type AgentRole,
  type RoleProfile,
  type CognitiveLoadMetrics,
  type AdaptiveReductionResult,
  type SynthesisResult,
  type FailureDistillationResult,
  type DistilledLesson,
} from '@danielsimonjr/memoryjs';
import { MCPServer } from './server/MCPServer.js';
import { installFreshnessGuard } from './freshness-guard.js';

// Re-export path utilities for backward compatibility
export { defaultMemoryPath, ensureMemoryFilePath };

// Reload-on-read guard (opencode retro 2026-10-15, finding F1). Long-lived
// servers must see writes made by *other* processes; see freshness-guard.ts.
export { installFreshnessGuard, getFreshnessState, isStale } from './freshness-guard.js';
export type { FreshnessState } from './freshness-guard.js';

// Re-export types for backward compatibility
export type {
  Entity,
  Relation,
  KnowledgeGraph,
  GraphStats,
  ValidationReport,
  ValidationIssue,
  ValidationWarning,
  SavedSearch,
  TagAlias,
  SearchResult,
  BooleanQueryNode,
  ImportResult,
  CompressionResult,
  // v1.7.0 new types
  ArtifactEntity,
  ArtifactType,
  ArtifactFilter,
  FreshnessReport,
  AuditEntry,
  AuditOperation,
  RefEntry,
  RefIndexStats,
  AgentRole,
  RoleProfile,
  CognitiveLoadMetrics,
  AdaptiveReductionResult,
  SynthesisResult,
  FailureDistillationResult,
  DistilledLesson,
};

// Re-export ManagerContext (replaces KnowledgeGraphManager)
export { ManagerContext };

// Backward compatibility alias
export { ManagerContext as KnowledgeGraphManager };

let managerContext: ManagerContext;

// Exit cleanly when our stdio pipe closes (e.g., Claude Code's /reload-plugins
// tearing down the connection). Without this, other event-loop refs — file
// watchers, the embeddings pool, the consolidation timer — can keep the
// process alive as an orphan until manually killed.
// ctx.close() (memoryjs v3) releases storage handles before exit; it is a
// no-op for JSONL but closes the SQLite handle when MEMORY_STORAGE_TYPE=sqlite.
function shutdown(): never {
  managerContext?.close();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

async function main() {
  // Initialize memory file path with backward compatibility
  const memoryFilePath = await ensureMemoryFilePath();

  // Honour MEMORY_STORAGE_TYPE. Passing a bare string here selects memoryjs's default
  // (jsonl) backend unconditionally, so `MEMORY_STORAGE_TYPE=sqlite` was documented but
  // silently ignored — and `diag` reported it as sqlite while writes went to memory.jsonl.
  const storageType = process.env.MEMORY_STORAGE_TYPE === "sqlite" ? "sqlite" : "jsonl";
  managerContext = new ManagerContext({
    storagePath: memoryFilePath,
    storageType,
  });

  // Reload-on-read for the JSONL backend: without it, a long-lived server never
  // observes writes made by another process (fresh session, one-shot CLI, a
  // second opencode instance) — the staleness failure diagnosed 2026-10-15.
  // The guard refreshes the in-memory cache when the file's stamp changes.
  // Non-JSONL backends are skipped deliberately (their cache model differs).
  if (storageType === "jsonl") {
    installFreshnessGuard(managerContext.storage, memoryFilePath);
  }

  // Initialize and start MCP server
  const server = new MCPServer(managerContext);
  await server.start();
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
