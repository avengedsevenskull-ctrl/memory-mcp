/**
 * Tool category gating map tests.
 *
 * The deployment exposes a subset of the 241 tools via MEMORY_TOOL_CATEGORIES
 * (opencode.json). This guards two regression classes:
 *  1. map drift — a category name that no longer matches a real tool name
 *  2. traversal gap — entity_neighbors missing from the exposed set
 *     (open_nodes uses induced-subgraph semantics: relations are returned
 *     only when BOTH endpoints are requested, so single-entity relation
 *     reads have no other path).
 */

import { describe, it, expect } from 'vitest';
import { toolDefinitions, toolCategoryMap } from '../../../src/server/toolDefinitions.js';

const deploymentCategories = [
  'entity', 'relation', 'observation', 'search', 'search_ranked',
  'search_boolean', 'search_fuzzy', 'freshness', 'analytics', 'versioning',
  'compression', 'io', 'rbac',
];

describe('toolCategoryMap', () => {
  const defined = new Set(toolDefinitions.map(t => t.name));

  it('every gated tool name exists in toolDefinitions (no drift)', () => {
    const missing: string[] = [];
    for (const [cat, names] of Object.entries(toolCategoryMap)) {
      for (const n of names) if (!defined.has(n)) missing.push(`${cat}:${n}`);
    }
    expect(missing).toEqual([]);
  });

  it('relation category exposes entity_neighbors (one-hop traversal)', () => {
    expect(toolCategoryMap.relation).toContain('entity_neighbors');
  });

  it('categories named in the deployment env resolve in the map', () => {
    // 'rbac' is passed by the deployment but maps to no exposed tools — allowed.
    const unknown = deploymentCategories.filter(c => c !== 'rbac' && !(c in toolCategoryMap));
    expect(unknown).toEqual([]);
  });
});
