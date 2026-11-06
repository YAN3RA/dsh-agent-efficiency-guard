/**
 * Host-face Typert contribution plus the wire DTO contract for the `usage`
 * Remote namespace.
 *
 * WHY THIS FILE EXISTS — the usage stack (N8) keeps the whole observation
 * pipeline on the Host: the collector state is memory-only and the runtime
 * re-reads it on demand. The browser must nevertheless be able to show what was
 * observed, so exactly one read-only surface is exported: a bounded, JSON-safe
 * projection of the runtime's current state.
 *
 * THE CONTRACT (do not widen it without changing both faces and their tests):
 *
 * - The runtime service is optional. The root entry publishes it under the
 *   Cordis key {@link USAGE_HOST_FACE_SERVICE}'s sibling `usageRuntime`
 *   (`USAGE_RUNTIME_SERVICE`) once the adapter is installed; a Host without it
 *   is normal and must stay a normal plugin host.
 * - The service exposes one synchronous method, `snapshot(): { metadata, stats,
 *   report } | undefined`. `undefined` means "installed, nothing readable yet".
 * - The gateway ({@link UsageGateway} in `src/server/usage-remote.ts`) probes the
 *   service with `ctx.get('usageRuntime')` — never a static `inject` — and always
 *   answers with a discriminated union: {@link UsageSnapshot} on success, or
 *   {@link UsageSnapshotUnavailable} with a stable reason. A missing service,
 *   a throwing `snapshot()`, and a structurally invalid payload are all answerable
 *   states, not transport errors.
 * - The projection is bounded: at most {@link USAGE_SNAPSHOT_AGGREGATE_LIMIT}
 *   aggregate rows, {@link USAGE_SNAPSHOT_COVERAGE_LIMIT} coverage entries, and
 *   {@link USAGE_SNAPSHOT_ERROR_COUNT_LIMIT} error-code counters per aggregate.
 *   Per-row strings (error codes, coverage reasons, capability ids) are already
 *   bounded by the collector's `UsageLimits`; this layer adds count bounds only.
 * - No raw Session or event object crosses the wire. The projection is built
 *   field-by-field from a fixed allowlist, so a runtime that (wrongly) hangs an
 *   `events` or `sessions` array off its snapshot cannot leak it through this
 *   face.
 *
 * The wire metadata mirrors the browser face in `src/client/usage-remote.ts`;
 * keep the two tables in step (`tests/usage-host-face.spec.ts` fails when they
 * drift, `tests/usage-remote.spec.ts` parses real gateway output with the
 * browser codecs).
 *
 * @module dsh-thinking-guard/usage/usage-host-face
 */

// `@deepseek-ai/dsh-typert-protocol` augments this same cordis `Context` with
// the `typert` registry, so this file only needs the type for its signatures.
import type { Context } from '@deepseek-ai/cordis'
import type {
  HostFaceCodec,
  HostFaceInvocation,
  HostFaceParameter,
  TypertHostFace,
} from '../host-face.ts'
import { HOST_FACE_PACKAGE } from '../host-face.ts'

/** Package that owns this face — must equal the package the manifest is registered for. */
export const USAGE_HOST_FACE_PACKAGE = HOST_FACE_PACKAGE

/** Wire namespace shared with the browser face. */
export const USAGE_HOST_FACE_NAMESPACE = 'usage'

/**
 * Service key the gateway registers under
 * (`super(ctx, 'usageGateway', { namespace: 'usage' })`).
 *
 * Deliberately distinct from `usageRuntime`: that key belongs to the optional
 * data owner, this one to the always-mounted read-only gateway. The gateway
 * looks its receiver up by this key, so it has to match
 * `src/server/usage-remote.ts` exactly.
 */
export const USAGE_HOST_FACE_SERVICE = 'usageGateway'

/**
 * Optional Cordis key the runtime installs under. Probed with `ctx.get`; never
 * a static `inject`, which would unmount the gateway on a Host that has no
 * runtime and make the panel 404 instead of showing "unavailable".
 */
export const USAGE_RUNTIME_SERVICE = 'usageRuntime'

/** Maximum aggregate rows one snapshot may carry. */
export const USAGE_SNAPSHOT_AGGREGATE_LIMIT = 500

/** Maximum error-code counters copied from one aggregate row. */
export const USAGE_SNAPSHOT_ERROR_COUNT_LIMIT = 64

/** Maximum per-Session coverage entries one snapshot may carry. */
export const USAGE_SNAPSHOT_COVERAGE_LIMIT = 4096

/** Why a snapshot could not be produced. Stable wire values; never free text. */
export type UsageSnapshotUnavailableReason =
  | 'service-absent'
  | 'snapshot-unavailable'
  | 'snapshot-invalid'

/** Collector capability kinds, mirrored for the wire. */
export type UsageSnapshotCapabilityKind = 'mcp' | 'plugin-tool' | 'native' | 'skill' | 'unknown'

/** How a call's workspace was attributed, mirrored for the wire. */
export type UsageSnapshotWorkspaceAttribution = 'event-time' | 'current-mapping' | 'unknown'

/** Per-Session observation coverage, mirrored for the wire. */
export type UsageSnapshotCoverageStatus = 'complete' | 'partial' | 'unknown'

/** One aggregate row: counters for one capability in one Session and day. */
export interface UsageSnapshotAggregate {
  readonly sessionId: string
  readonly date: string
  readonly workspaceId?: string
  readonly workspaceAttribution: UsageSnapshotWorkspaceAttribution
  readonly capabilityId: string
  readonly capabilityKind: UsageSnapshotCapabilityKind
  readonly providerId?: string
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly denied: number
  readonly cancelled: number
  readonly unresolved: number
  readonly lastUsedAt?: number
  readonly firstObservedAt: number
  /** Error code → count. A plain JSON object: the core's `Map` never crosses the wire. */
  readonly errors: Readonly<Record<string, number>>
}

/** One Session's coverage record, mirrored for the wire. */
export interface UsageSnapshotCoverage {
  readonly status: UsageSnapshotCoverageStatus
  readonly fromSeq?: number
  readonly throughSeq?: number
  readonly skippedSessions: number
  readonly skippedEvents: number
  readonly reasons: readonly string[]
  readonly reasonsTruncated: boolean
}

/** The already-aggregated report: no events, no calls, no arguments. */
export interface UsageSnapshotReport {
  readonly aggregates: readonly UsageSnapshotAggregate[]
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly denied: number
  readonly cancelled: number
  readonly unresolved: number
  readonly coverage: Readonly<Record<string, UsageSnapshotCoverage>>
  readonly orphanResults: number
  readonly duplicateResults: number
  readonly limitsReached: boolean
}

/** Install-time metadata, already content-free on the Host side. */
export interface UsageSnapshotMetadata {
  readonly mode: 'memory'
  readonly profile:
    | { readonly status: 'known'; readonly name: string }
    | { readonly status: 'unknown'; readonly label: 'profile unknown'; readonly reason: string }
  readonly workspaceRegistry: boolean
  readonly capability: boolean
  readonly feed: 'session/event'
}

/** Adapter counters: bounded integers and stable reason codes only. */
export interface UsageSnapshotStats {
  readonly received: number
  readonly delivered: number
  readonly accepted: number
  readonly duplicates: number
  readonly invalid: number
  readonly dropped: number
  readonly batches: number
  readonly reasons: Readonly<Record<string, number>>
}

/** A readable snapshot. */
export interface UsageSnapshotAvailable {
  readonly available: true
  readonly metadata: UsageSnapshotMetadata
  readonly stats: UsageSnapshotStats
  readonly report: UsageSnapshotReport
}

/**
 * The answer when no snapshot can be produced. The panel shows this as a
 * disabled/blocked state with the reason, never as a transport failure.
 */
export interface UsageSnapshotUnavailable {
  readonly available: false
  readonly reason: UsageSnapshotUnavailableReason
}

/** Every possible answer of `usage/getSnapshot` and `usage/refresh`. */
export type UsageSnapshot = UsageSnapshotAvailable | UsageSnapshotUnavailable

/**
 * Structural view of the optional runtime service this face reads.
 *
 * Kept structural on purpose: `src/usage/usage-runtime.ts` owns the concrete
 * snapshot type, and the gateway must survive an older runtime that predates
 * `snapshot()` as well as a hostile one. Everything is validated during
 * projection, so no Host type leaks to the browser.
 */
export interface UsageRuntimeSnapshotSource {
  readonly snapshot: () => unknown
  readonly [key: string]: unknown
}

type UnknownRecord = { readonly [key: string]: unknown }

/** True for a non-null, non-array object. */
export function isUsageRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The gateway's Remote surface: `[method, required wire fields, optional wire
 * fields]`, in the same order as `src/server/usage-remote.ts` and
 * `src/client/usage-remote.ts`.
 *
 * Both methods carry no arguments and answer with the same {@link UsageSnapshot}:
 * the runtime reads its state synchronously, so `refresh` is a plain re-read
 * rather than a separate asynchronous pipeline.
 */
export const USAGE_WIRE_METHODS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['getSnapshot', [], []],
  ['refresh', [], []],
]

/**
 * A wire value is already JSON on both sides, and the gateway runs the codec on
 * every argument. Both endpoints take and return validated JSON, so this codec
 * has nothing to convert.
 */
function passThroughCodec(typeSymbol: string): HostFaceCodec {
  return { mode: 'strict', typeSymbol, create: () => ({ parse: (value: unknown) => value }) }
}

function jsonParameter(wire: string, optional: boolean): HostFaceParameter {
  return {
    name: wire,
    wire,
    source: 'json',
    ...(optional ? { acceptsUndefined: true as const } : {}),
    codec: passThroughCodec(wire),
  }
}

/** Build the host face for the `usage` namespace. */
export function usageHostFace(): TypertHostFace {
  return {
    package: USAGE_HOST_FACE_PACKAGE,
    face: 'host',
    // Every codec travels with its invocation, so there is no `<package>#<name>`
    // schema for the registry to resolve.
    schemas: [],
    invocations: USAGE_WIRE_METHODS.map(([method, required, optional]) => ({
      id: `${USAGE_HOST_FACE_PACKAGE}#${USAGE_HOST_FACE_NAMESPACE}/${method}`,
      service: USAGE_HOST_FACE_SERVICE,
      namespace: USAGE_HOST_FACE_NAMESPACE,
      method,
      invocation: { kind: 'direct' as const },
      parameters: [
        ...required.map((wire) => jsonParameter(wire, false)),
        ...optional.map((wire) => jsonParameter(wire, true)),
      ],
      result: passThroughCodec(`${USAGE_HOST_FACE_PACKAGE}#${USAGE_HOST_FACE_NAMESPACE}/${method}:result`),
    })),
    model: { services: [], events: [], objects: [] },
  }
}

/**
 * Claim the `usage` namespace on a host that has a Typert registry. Call from a
 * `ctx.inject(['typert'], …)` hook so hosts without the registry are unaffected,
 * for the same start-up-ordering reason documented in `src/host-face.ts`.
 */
export function registerUsageHostFace(ctx: Context): void {
  const registry = ctx.typert as unknown as { register(contribution: TypertHostFace): unknown }
  registry.register(usageHostFace())
}

/** Wire invocation row as the host face declares it (exposed for the parity test). */
export type UsageHostFaceInvocation = HostFaceInvocation
