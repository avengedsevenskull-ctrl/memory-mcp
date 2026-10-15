/**
 * Freshness guard — reload-on-read for JSONL-backed GraphStorage.
 *
 * Failure class (opencode pipeline retro, 2026-10-15 — finding
 * `opencode_dotfiles_finding_memory_server_staleness_20261015`):
 * every opencode instance runs its own memory-mcp process, and memoryjs's
 * GraphStorage reads the JSONL file ONCE into an in-memory cache and never
 * re-reads it. A write performed by any other process (another instance's
 * server, a one-shot CLI run, a manual edit) is therefore invisible to a
 * long-lived server until that server restarts. Observed cost: a cross-session
 * handoff deposit was unreadable by the depositing session itself and by the
 * fresh agent it was written for (diagnosis session: ses_ebe925c7bffeUnt4m9w0Pq2Ajv).
 *
 * Fix: wrap the storage instance's read entry points (`loadGraph`,
 * `ensureLoaded`) and its public write methods. On every guarded read, compare
 * the file's stat stamp (`mtimeMs:size`) with the stamp recorded at the last
 * known load; when it changed, invalidate the cache (`clearCache()`) so the
 * original `ensureLoaded()` re-reads the file from disk. Writes refresh the
 * stamp afterwards so our own appends do not trigger a reload. A write path we
 * missed degrades to one extra reload on the next read — it can never serve
 * stale data past the next guarded read.
 *
 * Notes:
 * - JSONL `GraphStorage` only. Other backends (SQLite/Postgres) are skipped:
 *   they have their own cache/validity model and may not expose clearCache().
 * - The guard is behaviour-preserving for a single writer and makes
 *   multi-process reads fresh within one read call.
 */

import { promises as fs } from 'node:fs';
import { logger } from '@danielsimonjr/memoryjs';

export interface FreshnessState {
  /** Path of the file backing the guarded storage. */
  filePath: string;
  /** File stamp (`${mtimeMs}:${size}`) the in-memory cache is known to reflect. */
  stamp: string | null;
  /** Guarded entry-point invocations observed (reads; nested wraps double-count). */
  checks: number;
  /** Times the cache was actually loaded from disk while cold. */
  loads: number;
  /** Times an external change was detected and the cache invalidated. */
  reloads: number;
  /** Epoch ms of the most recent check. */
  lastCheckAt: number | null;
  /** Epoch ms of the most recent completed (re)load. */
  lastLoadAt: number | null;
  /** Epoch ms of the most recent change-detected invalidation. */
  lastReloadAt: number | null;
  /** Epoch ms of the most recent guarded write. */
  lastWriteAt: number | null;
  /** stat() failures observed by the guard (informational). */
  statErrors: number;
}

interface GuardableStorage {
  loadGraph(...args: unknown[]): Promise<unknown>;
  ensureLoaded(...args: unknown[]): Promise<unknown>;
  clearCache(): void;
  getFilePath?: () => string;
  memoryFilePath?: string;
  cache?: unknown;
}

const states = new WeakMap<object, FreshnessState>();

/** Public write methods whose completion refreshes the known-good stamp. */
const WRITE_METHODS = [
  'saveGraph',
  'appendEntity',
  'appendEntities',
  'appendRelation',
  'appendRelations',
  'updateEntity',
  'updateEntities',
  'deleteEntities',
  'deleteRelations',
  'renameEntity',
  'compact',
] as const;

async function statStamp(filePath: string, state: FreshnessState): Promise<string | null> {
  try {
    const st = await fs.stat(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    state.statErrors += 1;
    return null;
  }
}

function hasCache(storage: GuardableStorage): boolean {
  return storage.cache != null;
}

/**
 * If the file changed since the cache was loaded, invalidate the cache so the
 * next original `ensureLoaded()` re-reads it.
 *
 * Baseline rule (race-safe): `state.stamp` advances only when a load is about
 * to happen — never on a warm read. The load reads the file at-or-after this
 * stat, so anything newer is caught by the next check; a warm read advancing
 * the baseline would mask a write landing between this check and the read's
 * return. (Found in review: the previous post-read stat had exactly that race.)
 */
async function detectExternalChange(storage: GuardableStorage, state: FreshnessState): Promise<void> {
  const stamp = await statStamp(state.filePath, state);
  state.lastCheckAt = Date.now();
  if (stamp === null) return;
  if (state.stamp === null || stamp !== state.stamp) {
    if (hasCache(storage)) {
      storage.clearCache();
      state.reloads += 1;
      state.lastReloadAt = Date.now();
    }
  }
  if (!hasCache(storage)) state.stamp = stamp;
}

function wrapRead(storage: GuardableStorage, state: FreshnessState, method: 'loadGraph' | 'ensureLoaded'): void {
  const original = (storage[method] as (...args: unknown[]) => Promise<unknown>).bind(storage);
  (storage as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    state.checks += 1;
    await detectExternalChange(storage, state);
    const wasCold = !hasCache(storage);
    try {
      return await original(...args);
    } finally {
      if (wasCold && hasCache(storage)) {
        state.loads += 1;
        state.lastLoadAt = Date.now();
      }
      // No post-read stat here: the baseline was set pre-load by
      // detectExternalChange (cold) or stays at the last known-good stamp
      // (warm). Re-stamping here would mask a concurrent external write.
    }
  };
}

function wrapWrite(storage: GuardableStorage, state: FreshnessState, method: string): void {
  const original = (storage as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method].bind(storage);
  (storage as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } finally {
      // The write has hit the file; adopt the new stamp so the next read does
      // not reload what we just wrote. Residual window: an external write
      // landing between our write completing and this stat advances the
      // baseline past it (microseconds; the next external change recovers).
      // The read path avoids this masking class entirely.
      const stamp = await statStamp(state.filePath, state);
      if (stamp !== null) state.stamp = stamp;
      state.lastWriteAt = Date.now();
    }
  };
}

/**
 * Install the reload-on-read guard on a storage instance. Returns the
 * (WeakMap-held) state, or null when the storage does not expose the surface
 * the guard needs — installing is then skipped with a warning.
 */
export function installFreshnessGuard(storage: unknown, filePath?: string): FreshnessState | null {
  // Idempotent: a second install would double-wrap and strand the first state.
  const existing = states.get(storage as object);
  if (existing) return existing;
  const s = storage as GuardableStorage;
  for (const m of ['loadGraph', 'ensureLoaded', 'clearCache'] as const) {
    if (typeof (s as unknown as Record<string, unknown>)[m] !== 'function') {
      logger.warn(`[freshness-guard] storage lacks ${m}() — reload-on-read not installed`);
      return null;
    }
  }
  if (!('cache' in (s as object))) {
    logger.warn('[freshness-guard] storage lacks a `cache` field — reload-on-read not installed');
    return null;
  }
  const resolvedPath = filePath ?? s.getFilePath?.() ?? s.memoryFilePath;
  if (!resolvedPath) {
    logger.warn('[freshness-guard] no file path available — reload-on-read not installed');
    return null;
  }

  const state: FreshnessState = {
    filePath: resolvedPath,
    stamp: null,
    checks: 0,
    loads: 0,
    reloads: 0,
    lastCheckAt: null,
    lastLoadAt: null,
    lastReloadAt: null,
    lastWriteAt: null,
    statErrors: 0,
  };
  states.set(storage as object, state);

  // Establish a known baseline: if a cache already exists (install after a
  // first load), drop it so the first guarded read re-reads from disk instead
  // of adopting a possibly-stale cache as "current".
  if (hasCache(s)) s.clearCache();

  // Capture originals before overwriting: both wrappers call the original bound
  // implementations, and the original loadGraph's internal `this.ensureLoaded()`
  // resolves dynamically to the patched method (composition is intended).
  wrapRead(s, state, 'ensureLoaded');
  wrapRead(s, state, 'loadGraph');
  for (const m of WRITE_METHODS) {
    if (typeof (s as unknown as Record<string, unknown>)[m] === 'function') wrapWrite(s, state, m);
  }
  return state;
}

/** Guard state for a storage instance, or null when the guard was not installed. */
export function getFreshnessState(storage: unknown): FreshnessState | null {
  return states.get(storage as object) ?? null;
}

export interface StaleCheck {
  /** `null` = unknown (the file could not be stat'd, e.g. deleted). */
  stale: boolean | null;
  fileMtimeMs: number | null;
  stamp: string | null;
}

/**
 * Live staleness probe: compares the file's current stamp with the last
 * known-good stamp. `null` when the storage is not guarded.
 */
export async function isStale(storage: unknown): Promise<StaleCheck | null> {
  const state = states.get(storage as object);
  if (!state) return null;
  let fileMtimeMs: number | null = null;
  let stamp: string | null = null;
  try {
    const st = await fs.stat(state.filePath);
    fileMtimeMs = st.mtimeMs;
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // Unknown, not fresh: a missing file must not read as "not stale".
    state.statErrors += 1;
    return { stale: null, fileMtimeMs: null, stamp: state.stamp };
  }
  return { stale: state.stamp !== null && stamp !== state.stamp, fileMtimeMs, stamp };
}
