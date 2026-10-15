/**
 * Ratchet for the stale-read failure class (opencode pipeline retro,
 * 2026-10-15 — `opencode_dotfiles_finding_memory_server_staleness_20261015`).
 *
 * Observed failure: a long-lived memory-mcp server (one per opencode instance)
 * loads memory.jsonl ONCE and never re-reads it, so writes made by any other
 * process were invisible until restart. A cross-session handoff deposit was
 * unreadable by the depositing session itself and by the fresh agent session it
 * was written for.
 *
 * This test stands up the real failure: a warm-cached storage instance, a write
 * performed by a SECOND PROCESS appending to the same JSONL file, then reads.
 *
 * - unguarded control:   must NOT see the external write  (the failure class)
 * - guarded storage:     must see it after the next read  (the fix — reload-on-read)
 * - no-change reads:     must not trigger redundant reloads
 * - own writes:          must refresh the stamp (no spurious reload afterwards)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ManagerContext } from '@danielsimonjr/memoryjs';
import { installFreshnessGuard, getFreshnessState } from '../../src/freshness-guard.js';

const require = createRequire(import.meta.url);

function entityNames(graph: { entities: Array<{ name: string }> }): string[] {
  return graph.entities.map(e => e.name);
}

function runWriter(scriptPath: string, filePath: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, filePath, name], {
      stdio: 'inherit',
      env: { ...process.env, MEMORY_STORAGE_TYPE: 'jsonl' },
    });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer process exited ${code}`))));
  });
}

describe('freshness-guard (reload-on-read)', () => {
  let dir: string;
  let filePath: string;
  let contexts: ManagerContext[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshness-guard-'));
    filePath = path.join(dir, 'memory.jsonl');
    contexts = [];
  });

  afterEach(async () => {
    for (const ctx of contexts) {
      try { ctx.close(); } catch { /* best effort */ }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a guarded storage sees writes made by a second process; an unguarded one stays stale', async () => {
    const makeCtx = (): ManagerContext => {
      const ctx = new ManagerContext({ storagePath: filePath, storageType: 'jsonl' });
      contexts.push(ctx);
      return ctx;
    };

    // Seed + warm both caches.
    const guardedCtx = makeCtx();
    await guardedCtx.entityManager.createEntities([
      { name: 'seed_entity', entityType: 'test', observations: ['seed'] },
    ] as never[]);

    const controlCtx = makeCtx();
    const controlWarm = await controlCtx.storage.loadGraph();
    expect(entityNames(controlWarm)).toContain('seed_entity');

    installFreshnessGuard(guardedCtx.storage, filePath);
    const before = await guardedCtx.storage.loadGraph();
    expect(entityNames(before)).toContain('seed_entity');
    const state = getFreshnessState(guardedCtx.storage);
    expect(state).not.toBeNull();

    // Second process appends an entity to the same file.
    const memoryjsEntry = require.resolve('@danielsimonjr/memoryjs');
    const writerPath = path.join(dir, 'writer.mjs');
    await fs.writeFile(
      writerPath,
      `import { ManagerContext } from ${JSON.stringify(pathToFileURL(memoryjsEntry).href)};\n` +
      `const [filePath, name] = process.argv.slice(2);\n` +
      `const ctx = new ManagerContext({ storagePath: filePath, storageType: 'jsonl' });\n` +
      `await ctx.entityManager.createEntities([{ name, entityType: 'external_writer', observations: ['written by a second process'] }]);\n` +
      `ctx.close?.();\n` +
      `process.exit(0);\n`
    );
    await runWriter(writerPath, filePath, 'external_entity');

    // The fix: the next guarded read reloads and sees the external write.
    const after = await guardedCtx.storage.loadGraph();
    expect(entityNames(after)).toContain('external_entity');
    expect(state!.reloads).toBeGreaterThanOrEqual(1);
    expect(state!.lastReloadAt).not.toBeNull();

    // No-change read: no redundant reload.
    const reloadsAfterFix = state!.reloads;
    const again = await guardedCtx.storage.loadGraph();
    expect(entityNames(again)).toContain('external_entity');
    expect(state!.reloads).toBe(reloadsAfterFix);

    // Own write refreshes the stamp: next read includes it with no extra reload.
    await guardedCtx.entityManager.createEntities([
      { name: 'own_entity', entityType: 'test', observations: ['written by the guarded process'] },
    ] as never[]);
    const afterOwn = await guardedCtx.storage.loadGraph();
    expect(entityNames(afterOwn)).toContain('own_entity');
    expect(state!.reloads).toBe(reloadsAfterFix);

    // Planted twin (the failure class): the unguarded, warm-cached control
    // still serves its pre-write snapshot — this is what the guard fixes.
    const controlStale = await controlCtx.storage.loadGraph();
    expect(entityNames(controlStale)).not.toContain('external_entity');
  });

  it('does not advance the baseline past a write landing during a warm read (concurrent-write race)', async () => {
    // Regression for the review finding: the first implementation re-stamped
    // the file AFTER every read. If an external write landed between a warm
    // read's change-check and its return, the baseline was advanced past that
    // write and it stayed invisible until the next change.
    const racePath = path.join(dir, 'race.jsonl');
    await fs.writeFile(racePath, 'v0');

    let ensureLoadedCalls = 0;
    const fake: {
      cache: { entities: Array<{ name: string }> } | null;
      onServe: null | (() => Promise<void>);
      loadGraph: () => Promise<unknown>;
      ensureLoaded: () => Promise<void>;
      clearCache: () => void;
    } = {
      cache: null,
      onServe: null, // fires inside the storage while it serves the warm cache
      async loadGraph() {
        if (this.cache === null) await this.ensureLoaded();
        if (this.onServe) {
          const cb = this.onServe;
          this.onServe = null;
          await cb();
        }
        return this.cache;
      },
      async ensureLoaded() {
        if (this.cache === null) {
          ensureLoadedCalls += 1;
          this.cache = { entities: [{ name: 'base' }] };
        }
      },
      clearCache() {
        this.cache = null;
      },
    };

    installFreshnessGuard(fake, racePath);
    await fake.loadGraph(); // cold: loads, baseline = stamp(v0)
    const state = getFreshnessState(fake)!;
    expect(state.loads).toBeGreaterThanOrEqual(1);

    // Warm read; the external write lands while the storage is serving it —
    // after the change-check, before the read returns.
    fake.onServe = async () => {
      await fs.writeFile(racePath, 'v1-longer');
    };
    const warm = await fake.loadGraph() as { entities: Array<{ name: string }> };
    expect(warm.entities.map(e => e.name)).toEqual(['base']); // stale snapshot, as served

    // The race must NOT have advanced the baseline: the next read detects the
    // write and reloads.
    const reloadsBefore = state.reloads;
    await fake.loadGraph();
    expect(state.reloads).toBe(reloadsBefore + 1);
    expect(ensureLoadedCalls).toBe(2);
  });
});
