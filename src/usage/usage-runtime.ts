/**
 * Host adapter for live Session usage observation (vNext N8).
 *
 * This module is the only place that connects the pure usage core to a real
 * DSH Host: it subscribes to the public `session/event` append feed, resolves
 * optional public services through `ctx.get` (never a static `inject`), and
 * folds observed events into {@link UsageCollectorState}.
 *
 * Scope and hard limits:
 *
 * - Memory only. Nothing is written to disk. When the optional public
 *   `sessionPersistence` service is available and the profile is known, a
 *   bounded backfill reads historical pages into the same collector. The live
 *   listener is installed first and its bounded queue is held until the history
 *   snapshot is ready; if live pressure reaches the queue bound, backfill is
 *   cancelled and the queued live events take priority.
 * - Optional services: `workspaceRegistry` (session → workspace membership),
 *   `profileContext` (profile name) and `sessionPersistence` (bounded history)
 *   are probed through `ctx.get`. Missing profile disables backfill; missing
 *   workspace attribution becomes `unknown`.
 * - Classification is evidence-based. The runtime asks `ctx.capability` to
 *   resolve the registered *tool record* for a tool id and uses the record's
 *   resolved `origin.serverName` as trusted MCP server evidence. It never
 *   parses a tool name, arguments, prompt, or any event payload to guess a
 *   source. A `built-in` server means "not MCP" only: native vs. a third-party
 *   plugin tool cannot be proven from that record, so those stay `unknown`
 *   unless the caller supplies explicit audited evidence through options.
 * - Privacy: the listener copies only `session.id` and `event.seq`; the event
 *   object itself is retained only until the flush and is then dropped. The
 *   projector inside the collector is the only code that reads event payload
 *   fields, and it reads a fixed allowlist.
 *
 * Batching contract (the "collector single event is slow" question):
 *
 * The runtime uses a bounded FIFO queue and flushes on the next timer tick,
 * one micro-batch at a time ({@link UsageRuntimeOptions.maxBatch}). Events
 * within each micro-batch are ordered by `(sessionId, seq)` before delivery.
 * Reordering across separate ticks is not buffered and remains visible through
 * the collector's sequence-gap/orphan coverage.
 *
 * Each micro-batch is folded by the collector's public
 * `ingestUsageSessionEvents` page API. That API keeps the exact per-event
 * semantics of `ingestUsageSessionEvent` — the observed-`seq` watermark for
 * every event, the duplicate gate for control-plane records that never project
 * to a Usage event, adjacent `sequence-gap` counts, projection gaps, and the
 * `live-only` coverage marker — while folding the core aggregate once with
 * `applyUsageEvents` (O(events + state) per page instead of O(events × state)).
 * The adapter therefore never re-implements the coverage contract, and it never
 * calls `applyUsageEvents` around the collector: doing that from here would
 * lose the watermark/coverage state that only the collector owns.
 *
 * If the page API reports `out-of-order-batch` (possible only when a hostile
 * event getter changes its `seq` between observation and projection), the
 * adapter falls back to one-by-one collector calls for that page instead of
 * dropping it, so correctness survives even when the bulk fast path refuses the
 * page.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BUILT_IN_SERVER } from '../constants.ts'
import { classifyToolCall, type UsageClassifierContext } from './usage-classifier.ts'
import {
  createUsageCollectorState,
  ingestUsageSessionEvent,
  ingestUsageSessionEvents,
  type UsageCollectorState,
  type UsageIngestBatchOutcome,
  type UsageIngestEventInput,
} from './usage-collector.ts'
import {
  buildUsageReport,
  type UsageLimits,
  type UsageReport,
} from './usage-core.ts'
import type { UsageSourceClassifier } from './usage-event-projector.ts'
import {
  runUsageBackfill,
  type UsageBackfillCursor,
  type UsageBackfillLimits,
  type UsageBackfillResult,
} from './usage-backfill.ts'
import { resolveUsageProfile, type UsageProfileUnavailableReason } from './usage-profile.ts'

const DEFAULT_MAX_QUEUE = 1_024
const DEFAULT_MAX_BATCH = 128
const LOG_PREFIX = 'thinking-guard usage-runtime'
const WARN_CODE_LIMIT = 32

/**
 * Schedules one flush callback and returns its cancellation.
 *
 * The callback must run asynchronously, after the current call stack; a
 * synchronous scheduler would re-enter `flush` from inside itself.
 */
export type UsageRuntimeScheduler = (flush: () => void) => () => void

/** Minimal logger surface; a missing or throwing logger never disturbs the Host. */
export interface UsageRuntimeLogger {
  readonly warn?: (...args: unknown[]) => void
}

/** Optional explicit trusted evidence. Nothing here is derived from a tool name. */
export interface UsageRuntimeOptions {
  /** Collector limits; invalid values fall back to the collector defaults. */
  readonly limits?: Partial<UsageLimits>
  /** Hard queue bound. Reaching it forces an early flush instead of dropping. */
  readonly maxQueue?: number
  /** Maximum events folded into one collector pass / host tick. */
  readonly maxBatch?: number
  /** Run bounded Session history backfill after subscribing to the live feed. */
  readonly historyBackfill?: boolean
  /** Reader limits; `maxRuntimeMs` is enforced between persistence operations. */
  readonly backfillLimits?: Partial<UsageBackfillLimits>
  /** Override the one-tick scheduler (tests, custom hosts). */
  readonly schedule?: UsageRuntimeScheduler
  /** Override `ctx.logger` for warnings. */
  readonly logger?: UsageRuntimeLogger
  /** Audited first-party native tool ids; exact matches only. */
  readonly nativeToolIds?: readonly string[]
  /** Verified explicit tool → plugin owner registration metadata. */
  readonly pluginToolOwners?: ReadonlyMap<string, string>
  /** Verified tool → MCP server mapping that supplements `ctx.capability`. */
  readonly mcpProviders?: ReadonlyMap<string, readonly string[]>
}

/** Profile metadata when `profileContext.name` resolved to a safe name. */
export interface UsageRuntimeKnownProfile {
  readonly status: 'known'
  readonly name: string
}

/** Profile metadata when no usable `profileContext.name` is available. */
export interface UsageRuntimeUnknownProfile {
  readonly status: 'unknown'
  /** Literal marker required by the N8 memory-only contract. */
  readonly label: 'profile unknown'
  readonly reason: UsageProfileUnavailableReason
}

export type UsageRuntimeProfile = UsageRuntimeKnownProfile | UsageRuntimeUnknownProfile

/** Install-time service snapshot. Absence is normal and never throws. */
export interface UsageRuntimeMetadata {
  /** This adapter never persists; the collector state lives in memory only. */
  readonly mode: 'memory'
  readonly profile: UsageRuntimeProfile
  /** Whether a usable `workspaceRegistry` was visible at install time. */
  readonly workspaceRegistry: boolean
  /** Whether a usable `ctx.capability` lookup was visible at install time. */
  readonly capability: boolean
  readonly feed: 'session/event'
}

/** Bounded, content-free counters for diagnostics and tests. */
export interface UsageRuntimeStats {
  /** `session/event` callbacks received, including unusable ones. */
  readonly received: number
  /** Events handed to the collector. */
  readonly delivered: number
  /** Collector transitions that were accepted (counted or observed). */
  readonly accepted: number
  /** Events rejected by the collector's per-Session duplicate gate. */
  readonly duplicates: number
  /** Events rejected as unusable / invalid. */
  readonly invalid: number
  /** Events intentionally discarded by the adapter (currently none). */
  readonly dropped: number
  /** Number of collector micro-batch passes performed. */
  readonly batches: number
  /** Stable collector and runtime reason codes accumulated outside history reads. */
  readonly reasons: Readonly<Record<string, number>>
  /** History-only reason codes, isolated from live collector diagnostics. */
  readonly backfillReasons: Readonly<Record<string, number>>
}

/** Handle returned to the installing fiber. */
export interface UsageRuntime {
  readonly metadata: UsageRuntimeMetadata
  /** Current collector state. Treat as immutable; it is replaced on every change. */
  readonly state: () => UsageCollectorState
  readonly report: () => UsageReport
  readonly stats: () => UsageRuntimeStats
  /** Current bounded Remote source; contains only metadata, counters and aggregates. */
  readonly snapshot: () => { readonly metadata: UsageRuntimeMetadata; readonly stats: UsageRuntimeStats; readonly report: UsageReport }
  /** Run or await the bounded history backfill managed by this runtime. */
  readonly historyBackfill: () => Promise<UsageBackfillResult | undefined>
  /** Number of queued events not yet folded into the collector. */
  readonly pending: () => number
  /** Fold at most one micro-batch now; queued remainder is rescheduled. */
  readonly flush: () => void
  /** Stop accepting events, drop the listener, and flush everything queued. */
  readonly dispose: () => void
}

interface PendingSessionEvent {
  readonly sessionId: string
  readonly seq: number | undefined
  readonly event: SessionEvent
  readonly order: number
}

interface MutableStats {
  received: number
  delivered: number
  accepted: number
  duplicates: number
  invalid: number
  batches: number
  readonly reasons: Map<string, number>
}

type UnknownRecord = { readonly [key: string]: unknown }

interface ServiceContext {
  readonly get?: (name: string) => unknown
}

interface EventContext {
  readonly on?: (name: string, listener: (session: unknown, event: unknown) => void) => unknown
}

interface EffectContext {
  readonly effect?: (execute: () => () => void) => unknown
}

interface LoggerContext {
  readonly logger?: UsageRuntimeLogger
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

/** Read exactly one property; a throwing getter degrades to absent. */
function readField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function readIdentifier(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined
}

function readSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message.slice(0, 200)
  } catch {
    // A hostile error getter must not escape an observer callback.
  }
  return 'unknown error'
}

function lookupService(context: Context, name: string): unknown {
  const get = (context as unknown as ServiceContext).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(context, name)
  } catch {
    return undefined
  }
}

interface WorkspaceRow {
  readonly id?: unknown
  readonly sessionIds?: readonly unknown[]
}

/**
 * Resolve session → workspace id from the optional registry's projection.
 *
 * `WorkspaceRegistry.list()` is documented as a synchronous, persistence-free
 * projection. A session listed under two different workspaces is ambiguous and
 * therefore omitted (attribution `unknown`) rather than resolved by order.
 */
function collectWorkspaceMap(
  context: Context,
  warn: (code: string, error?: unknown) => void,
): ReadonlyMap<string, string> {
  const registry = lookupService(context, 'workspaceRegistry')
  if (!isRecord(registry)) return EMPTY_WORKSPACES
  const list = readField(registry, 'list')
  if (typeof list !== 'function') return EMPTY_WORKSPACES

  let rows: unknown
  try {
    rows = (list as (this: unknown) => unknown).call(registry)
  } catch (error) {
    warn('workspace-list', error)
    return EMPTY_WORKSPACES
  }
  if (!Array.isArray(rows)) return EMPTY_WORKSPACES

  const map = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const row of rows as readonly WorkspaceRow[]) {
    const workspaceId = readIdentifier(row, 'id')
    if (workspaceId === undefined) continue
    const sessionIds = readField(row, 'sessionIds')
    if (!Array.isArray(sessionIds)) continue
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) continue
      const existing = map.get(sessionId)
      if (existing === undefined) map.set(sessionId, workspaceId)
      else if (existing !== workspaceId) ambiguous.add(sessionId)
    }
  }
  for (const sessionId of ambiguous) map.delete(sessionId)
  return map
}

const EMPTY_WORKSPACES: ReadonlyMap<string, string> = new Map()

/** Build an O(1) `capability.get(id, 'tool')` lookup from an optional service. */
function createCapabilityLookup(context: Context): ((toolId: string) => unknown) | undefined {
  const service = lookupService(context, 'capability')
  if (!isRecord(service)) return undefined
  const get = readField(service, 'get')
  if (typeof get !== 'function') return undefined
  return (toolId: string) => (get as (id: string, kind?: string) => unknown).call(service, toolId, 'tool')
}

/** Read the registry-resolved server name of a capability record. */
function resolvedServerName(record: unknown): string | undefined {
  const origin = readField(record, 'origin')
  const serverName = readField(origin, 'serverName')
  if (typeof serverName !== 'string') return undefined
  const trimmed = serverName.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Build the projector classifier from trusted evidence.
 *
 * The capability record is only consulted by exact tool id (`get(id, 'tool')`);
 * its `origin.serverName` is used as MCP server evidence unless it is the
 * reserved `built-in` pseudo-server. No name prefix or payload is parsed.
 */
function createClassifier(
  options: UsageRuntimeOptions,
  context: Context,
  warn: (code: string, error?: unknown) => void,
): UsageSourceClassifier {
  const capability = createCapabilityLookup(context)
  // Native ids discovered from the catalog, cached per classifier: the lookup is
  // a synchronous map read, but re-allocating a Set per call is pointless when a
  // session makes thousands of calls.
  let nativeToolIds: readonly string[] | undefined
  return (toolName: string) => {
    let mcpProviders = options.mcpProviders
    if (capability !== undefined) {
      let record: unknown
      try {
        record = capability(toolName)
      } catch (error) {
        warn('capability-lookup', error)
        record = undefined
      }
      const server = resolvedServerName(record)
      if (server !== undefined && server !== BUILT_IN_SERVER) {
        const overrides = new Map<string, readonly string[]>(options.mcpProviders ?? [])
        overrides.set(toolName, [server])
        mcpProviders = overrides
      }
      // A record cataloged under the reserved `built-in` pseudo-server is a
      // harness-native tool. Without this evidence every native call fell through
      // to `owner-not-verified`, which is why the whole page reported an unknown
      // source even though the catalog knew the answer.
      if (server === BUILT_IN_SERVER) nativeToolIds = addNative(nativeToolIds, toolName)
    }
    const classifierContext: UsageClassifierContext = {
      ...(mcpProviders === undefined ? {} : { mcpProviders }),
      ...(options.pluginToolOwners === undefined ? {} : { pluginToolOwners: options.pluginToolOwners }),
      ...(options.nativeToolIds === undefined && nativeToolIds === undefined
        ? {}
        : { nativeToolIds: [...(options.nativeToolIds ?? []), ...(nativeToolIds ?? [])] }),
    }
    return classifyToolCall({ toolId: toolName }, classifierContext)
  }
}

/** Append one id to an immutable id list, preserving identity when already present. */
function addNative(current: readonly string[] | undefined, id: string): readonly string[] {
  if (current === undefined) return [id]
  return current.includes(id) ? current : [...current, id]
}

function hasWorkspaceRegistry(context: Context): boolean {
  const registry = lookupService(context, 'workspaceRegistry')
  return isRecord(registry) && typeof readField(registry, 'list') === 'function'
}

function hasCapability(context: Context): boolean {
  const service = lookupService(context, 'capability')
  return isRecord(service) && typeof readField(service, 'get') === 'function'
}

function defaultScheduler(flush: () => void): () => void {
  const timer = setTimeout(flush, 0)
  return () => clearTimeout(timer)
}

function comparePending(a: PendingSessionEvent, b: PendingSessionEvent): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq
  return a.order - b.order
}

/** Create the install-time warning sink (deduplicated, content-free). */
function createWarn(context: Context, options: UsageRuntimeOptions): (code: string, error?: unknown) => void {
  const emitted = new Set<string>()
  return (code: string, error?: unknown): void => {
    if (emitted.has(code) || emitted.size >= WARN_CODE_LIMIT) return
    emitted.add(code)
    const logger = options.logger ?? (context as LoggerContext).logger
    try {
      const detail = error === undefined ? '' : ` (${errorMessage(error)})`
      logger?.warn?.(`${LOG_PREFIX}: ${code}${detail}`)
    } catch {
      // Logging is best effort; a broken logger must not break the Host.
    }
  }
}

/**
 * Install live usage observation on the current fiber.
 *
 * Call it from `apply` or from inside a `ctx.inject([...], child => ...)`
 * callback. No static `inject` is declared here: every optional service is
 * probed with `ctx.get`, so a Host without `workspaceRegistry`,
 * `profileContext`, or `capability` still observes usage (with honest
 * `unknown` attribution). The returned handle is also flushed and disposed by
 * the fiber's `ctx.effect` cleanup when that API is available.
 */
export function installUsageRuntime(ctx: Context, options: UsageRuntimeOptions = {}): UsageRuntime {
  const maxQueue = positiveInteger(options.maxQueue, DEFAULT_MAX_QUEUE)
  const maxBatch = positiveInteger(options.maxBatch, DEFAULT_MAX_BATCH)
  const schedule = options.schedule ?? defaultScheduler
  const warn = createWarn(ctx, options)

  const profile = resolveUsageProfile(ctx)
  const frozenProfile: UsageRuntimeProfile = profile.status === 'available'
    ? Object.freeze({ status: 'known' as const, name: profile.name })
    : Object.freeze({ status: 'unknown' as const, label: 'profile unknown' as const, reason: profile.reason })
  const metadata: UsageRuntimeMetadata = Object.freeze({
    mode: 'memory' as const,
    profile: frozenProfile,
    workspaceRegistry: hasWorkspaceRegistry(ctx),
    capability: hasCapability(ctx),
    feed: 'session/event' as const,
  })

  let collector: UsageCollectorState
  try {
    collector = createUsageCollectorState(options.limits)
  } catch (error) {
    warn('collector-limits', error)
    collector = createUsageCollectorState()
  }

  const queue: PendingSessionEvent[] = []
  let backfillCursor: UsageBackfillCursor | undefined
  let backfillResult: UsageBackfillResult | undefined
  let backfillPromise: Promise<UsageBackfillResult | undefined> | undefined
  let backfillPromiseGeneration = 0
  let backfillController: AbortController | undefined
  let backfillPending = false
  let backfillGeneration = 0
  const backfillReasons = new Map<string, number>()
  const stats: MutableStats = {
    received: 0,
    delivered: 0,
    accepted: 0,
    duplicates: 0,
    invalid: 0,
    batches: 0,
    reasons: new Map(),
  }
  let closed = false
  let disposed = false
  let schedulingFailed = false
  let scheduledCancel: (() => void) | undefined
  let listenerDispose: (() => void) | undefined
  let nextOrder = 0

  function countReason(reason: string): void {
    stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1)
  }

  function countBackfillReason(reason: string): void {
    backfillReasons.set(reason, (backfillReasons.get(reason) ?? 0) + 1)
  }

  function countOutcome(outcome: UsageIngestBatchOutcome): void {
    stats.delivered += 1
    if (outcome.accepted) stats.accepted += 1
    if (outcome.reason === 'duplicate-event') stats.duplicates += 1
    if (outcome.reason === 'invalid-input' || outcome.reason === 'invalid-event') stats.invalid += 1
    countReason(outcome.reason)
  }

  /** Fallback that reuses the exact single-event collector transition. */
  function ingestOne(input: UsageIngestEventInput): void {
    try {
      const result = ingestUsageSessionEvent(collector, input)
      collector = result.state
      countOutcome(result)
    } catch (error) {
      // A hostile event getter or an unexpected collector failure must never
      // escape to the Host; the event is dropped from this pass.
      stats.invalid += 1
      warn('ingest', error)
    }
  }

  function deliverBatch(batch: PendingSessionEvent[]): void {
    batch.sort(comparePending)
    const workspaces = collectWorkspaceMap(ctx, warn)
    const classify = createClassifier(options, ctx, warn)
    const inputs = batch.map((item): UsageIngestEventInput => {
      const workspaceId = workspaces.get(item.sessionId)
      return {
        kind: 'session-event',
        sessionId: item.sessionId,
        event: item.event,
        workspace: workspaceId === undefined
          ? { attribution: 'unknown' }
          : { workspaceId, attribution: 'current-mapping' },
        classify,
        origin: 'live',
      }
    })

    try {
      const result = ingestUsageSessionEvents(collector, inputs)
      if (result.rejectedReason !== undefined) {
        // The page was refused as a whole. Replaying it one event at a time
        // preserves the collector's sequential semantics instead of losing a
        // burst that the bulk fast path could not order.
        warn('batch-rejected')
        for (const input of inputs) ingestOne(input)
      } else {
        collector = result.state
        for (const outcome of result.results) countOutcome(outcome)
      }
    } catch (error) {
      warn('batch-ingest', error)
      for (const input of inputs) ingestOne(input)
    }
    stats.batches += 1
  }

  function applyOneBatch(): boolean {
    if (backfillPending || queue.length === 0) return false
    const size = Math.min(maxBatch, queue.length)
    deliverBatch(queue.splice(0, size))
    return true
  }

  function drainAll(): void {
    while (applyOneBatch()) {
      // Bounded per pass; the loop only runs under dispose/overflow pressure.
    }
  }

  function runScheduled(): void {
    scheduledCancel = undefined
    if (closed) return
    flush()
  }

  function scheduleTick(): void {
    if (closed || backfillPending || schedulingFailed || scheduledCancel !== undefined || queue.length === 0) return
    try {
      const cancel: unknown = schedule(runScheduled)
      scheduledCancel = typeof cancel === 'function' ? cancel as () => void : () => {}
    } catch (error) {
      // A broken scheduler must not create an unbounded retry loop. Fall back to
      // synchronous draining for this burst; later events stay synchronous too.
      schedulingFailed = true
      warn('schedule', error)
      drainAll()
    }
  }

  function cancelScheduled(): void {
    const cancel = scheduledCancel
    scheduledCancel = undefined
    if (cancel === undefined) return
    try {
      cancel()
    } catch (error) {
      warn('schedule-cancel', error)
    }
  }

  function flush(): void {
    if (disposed || backfillPending) return
    try {
      applyOneBatch()
    } catch (error) {
      warn('flush', error)
    }
    if (queue.length === 0) return
    if (schedulingFailed) drainAll()
    else scheduleTick()
  }

  function cancelBackfill(reason: 'backfill-cancelled-live-pressure' | 'backfill-cancelled-dispose'): void {
    if (!backfillPending) return
    backfillGeneration += 1
    backfillPending = false
    backfillController?.abort()
    countBackfillReason(reason)
  }

  function startBackfill(): Promise<UsageBackfillResult | undefined> {
    if (closed || disposed) return Promise.resolve(undefined)
    if (backfillPromise !== undefined) return backfillPromise
    if (profile.status !== 'available') {
      countBackfillReason('backfill-disabled-profile-unknown')
      return Promise.resolve(undefined)
    }
    const service = lookupService(ctx, 'sessionPersistence')
    if (!isRecord(service) || typeof readField(service, 'list') !== 'function' || typeof readField(service, 'open') !== 'function') {
      countBackfillReason('backfill-disabled-service-unavailable')
      return Promise.resolve(undefined)
    }
    const generation = ++backfillGeneration
    const controller = new AbortController()
    backfillController = controller
    backfillPending = true
    const workspaces = collectWorkspaceMap(ctx, warn)
    const classify = createClassifier(options, ctx, warn)
    const pending = runUsageBackfill({
      context: ctx,
      classify,
      state: collector,
      workspaces,
      ...(backfillCursor === undefined ? {} : { cursor: backfillCursor }),
      limits: options.backfillLimits,
      signal: controller.signal,
    }).then((result) => {
      if (generation !== backfillGeneration || disposed) return undefined
      collector = result.state
      backfillCursor = result.cursor
      backfillResult = result
      for (const [reason, count] of Object.entries(result.stats.reasons)) {
        backfillReasons.set(reason, (backfillReasons.get(reason) ?? 0) + count)
      }
      return result
    }).catch((error: unknown) => {
      if (generation === backfillGeneration) {
        countBackfillReason('backfill-runtime-failed')
        warn('backfill', error)
      }
      return undefined
    }).finally(() => {
      if (backfillPromiseGeneration !== generation) return
      backfillPromise = undefined
      backfillController = undefined
      if (generation === backfillGeneration) {
        backfillPending = false
        if (!closed) scheduleTick()
      }
    })
    backfillPromise = pending
    backfillPromiseGeneration = generation
    return pending
  }

  const listener = (session: unknown, event: unknown): void => {
    if (closed) return
    stats.received += 1
    try {
      const sessionId = readIdentifier(session, 'id')
      if (sessionId === undefined || !isRecord(event)) {
        stats.invalid += 1
        warn('event-unusable')
        return
      }
      const seq = readSeq(readField(event, 'seq'))

      // Backpressure: history is abandoned under queue pressure; the bounded live
      // queue is then drained synchronously before accepting the new event.
      if (queue.length >= maxQueue) {
        if (backfillPending) cancelBackfill('backfill-cancelled-live-pressure')
        drainAll()
      }

      queue.push({ sessionId, seq, event: event as SessionEvent, order: nextOrder })
      nextOrder += 1
      if (schedulingFailed) drainAll()
      else scheduleTick()
    } catch (error) {
      stats.invalid += 1
      warn('listener', error)
    }
  }

  function dispose(): void {
    if (disposed) return
    closed = true
    cancelBackfill('backfill-cancelled-dispose')
    cancelScheduled()
    try {
      drainAll()
    } catch (error) {
      warn('dispose-flush', error)
    }
    try {
      listenerDispose?.()
    } catch (error) {
      warn('dispose-listener', error)
    }
    listenerDispose = undefined
    disposed = true
  }

  const subscribe = (ctx as unknown as EventContext).on
  if (typeof subscribe === 'function') {
    try {
      const cancel: unknown = subscribe.call(ctx, 'session/event', listener)
      listenerDispose = typeof cancel === 'function' ? cancel as () => void : undefined
    } catch (error) {
      warn('subscribe', error)
    }
  } else {
    warn('subscribe-unavailable')
  }

  const effect = (ctx as unknown as EffectContext).effect
  if (typeof effect === 'function') {
    try {
      effect.call(ctx, () => () => { dispose() })
    } catch (error) {
      warn('effect', error)
      dispose()
    }
  } else {
    warn('effect-unavailable')
    dispose()
  }

  if (options.historyBackfill !== false) {
    try {
      void startBackfill()
    } catch (error) {
      countBackfillReason('backfill-runtime-failed')
      warn('backfill-start', error)
    }
  }

  return Object.freeze({
    metadata,
    state: () => collector,
    report: () => buildUsageReport(collector.usage),
    stats: () => Object.freeze({
      received: stats.received,
      delivered: stats.delivered,
      accepted: stats.accepted,
      duplicates: stats.duplicates,
      invalid: stats.invalid,
      dropped: 0,
      batches: stats.batches,
      reasons: Object.freeze(Object.fromEntries(stats.reasons)),
      backfillReasons: Object.freeze(Object.fromEntries(backfillReasons)),
    }),
    snapshot: () => Object.freeze({
      metadata,
      stats: Object.freeze({
        received: stats.received,
        delivered: stats.delivered,
        accepted: stats.accepted,
        duplicates: stats.duplicates,
        invalid: stats.invalid,
        dropped: 0,
        batches: stats.batches,
        reasons: Object.freeze(Object.fromEntries(stats.reasons)),
        backfillReasons: Object.freeze(Object.fromEntries(backfillReasons)),
      }),
      report: buildUsageReport(collector.usage),
    }),
    historyBackfill: () => options.historyBackfill === false
      ? Promise.resolve(backfillResult)
      : startBackfill(),
    pending: () => queue.length,
    flush,
    dispose,
  })
}
