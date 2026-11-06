/**
 * Client-side Typert remote contribution for the `usage` Host gateway
 * (`src/server/usage-remote.ts`).
 *
 * Mirrors the generated shape that `@deepseek-ai/dsh-typert-generator` emits
 * (see `@deepseek-ai/dsh-host-plugin-inventory/lib/typert.remote-client.js`),
 * the same way `src/client/remote.ts` does for `capabilityPolicy`: it augments
 * `@deepseek-ai/dsh-typert-protocol` with the `usage` namespace and exports a
 * separate `USAGE_TYPERT_REMOTE` contribution.
 *
 * Why a separate contribution instead of an extra descriptor list on the
 * existing one: `$mount` is per contribution and the usage face is optional
 * (a Host without the runtime still mounts the gateway and answers
 * `{ available: false }`). Keeping the tables apart means the panel can drop
 * this face — or mount it later — without touching the capability face, and the
 * parity test compares each face with its own schema set instead of a merged
 * soup.
 *
 * Shape contract (mirrored from `src/usage/usage-host-face.ts`):
 *
 * - `getSnapshot()` and `refresh()` take no arguments;
 * - both answer {@link UsageSnapshot}: `{ available: true, metadata, stats,
 *   report }` or `{ available: false, reason }`;
 * - the report is bounded — at most {@link USAGE_AGGREGATE_LIMIT} aggregate rows
 *   and at most {@link USAGE_COVERAGE_LIMIT} coverage entries — so the codecs
 *   below reject rather than silently truncate an over-cap payload;
 * - no field ever carries a Session object, an event, tool arguments, or tool
 *   results. Strings (error codes, coverage reasons, ids) are already bounded by
 *   the collector and cross the wire unchanged.
 *
 * @module dsh-thinking-guard/client/usage-remote
 */
import { z } from 'zod'
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { UsageSnapshot } from '../usage/usage-host-face.ts'

export type {
  UsageSnapshot,
  UsageSnapshotAggregate,
  UsageSnapshotAvailable,
  UsageSnapshotCapabilityKind,
  UsageSnapshotCoverage,
  UsageSnapshotCoverageStatus,
  UsageSnapshotMetadata,
  UsageSnapshotReport,
  UsageSnapshotStats,
  UsageSnapshotUnavailable,
  UsageSnapshotUnavailableReason,
  UsageSnapshotWorkspaceAttribution,
} from '../usage/usage-host-face.ts'

/** Package owning the wire methods; must equal the Host contribution's package. */
export const USAGE_REMOTE_PACKAGE = 'dsh-thinking-guard'

/** Wire namespace; must equal `USAGE_HOST_FACE_NAMESPACE` on the Host. */
export const USAGE_REMOTE_NAMESPACE = 'usage'

/**
 * Mirror of the Host-side caps. Kept as literals rather than imported so the
 * browser bundle never pulls a Host module in for two integers; the parity test
 * asserts both sides agree.
 */
export const USAGE_AGGREGATE_LIMIT = 500
export const USAGE_COVERAGE_LIMIT = 4096

/** Create a strict codec for the DSH 0.2 protocol. */
function strictCodec(typeSymbol: string, schema: { parse(value: unknown): unknown }) {
  return { mode: 'strict' as const, typeSymbol, create: () => schema }
}

const capabilityKind$schema = z.union([
  z.literal('mcp'),
  z.literal('plugin-tool'),
  z.literal('native'),
  z.literal('skill'),
  z.literal('unknown'),
])

const workspaceAttribution$schema = z.union([
  z.literal('event-time'),
  z.literal('current-mapping'),
  z.literal('unknown'),
])

const coverageStatus$schema = z.union([
  z.literal('complete'),
  z.literal('partial'),
  z.literal('unknown'),
])

const unavailableReason$schema = z.union([
  z.literal('service-absent'),
  z.literal('snapshot-unavailable'),
  z.literal('snapshot-invalid'),
])

const countMap$schema = z.record(z.string(), z.number())

const aggregate$schema = z.object({
  sessionId: z.string().readonly(),
  date: z.string().readonly(),
  workspaceId: z.string().optional().readonly(),
  workspaceAttribution: workspaceAttribution$schema.readonly(),
  capabilityId: z.string().readonly(),
  capabilityKind: capabilityKind$schema.readonly(),
  providerId: z.string().optional().readonly(),
  calls: z.number().readonly(),
  succeeded: z.number().readonly(),
  failed: z.number().readonly(),
  denied: z.number().readonly(),
  cancelled: z.number().readonly(),
  unresolved: z.number().readonly(),
  lastUsedAt: z.number().optional().readonly(),
  firstObservedAt: z.number().readonly(),
  errors: countMap$schema.readonly(),
})

const coverage$schema = z.object({
  status: coverageStatus$schema.readonly(),
  fromSeq: z.number().optional().readonly(),
  throughSeq: z.number().optional().readonly(),
  skippedSessions: z.number().readonly(),
  skippedEvents: z.number().readonly(),
  reasons: z.array(z.string()).readonly(),
  reasonsTruncated: z.boolean().readonly(),
})

/**
 * Coverage stays a keyed object (one entry per observed Session), so the cap is
 * enforced with a refinement: an over-cap payload is a Host bug worth seeing in
 * a test, not something the browser should quietly truncate.
 */
const coverageMap$schema = z.record(z.string(), coverage$schema)
  .refine(
    (value) => Object.keys(value).length <= USAGE_COVERAGE_LIMIT,
    { message: `usage coverage must not exceed ${USAGE_COVERAGE_LIMIT} entries` },
  )

const report$schema = z.object({
  aggregates: z.array(aggregate$schema).max(USAGE_AGGREGATE_LIMIT).readonly(),
  calls: z.number().readonly(),
  succeeded: z.number().readonly(),
  failed: z.number().readonly(),
  denied: z.number().readonly(),
  cancelled: z.number().readonly(),
  unresolved: z.number().readonly(),
  coverage: coverageMap$schema.readonly(),
  orphanResults: z.number().readonly(),
  duplicateResults: z.number().readonly(),
  limitsReached: z.boolean().readonly(),
})

const metadata$schema = z.object({
  mode: z.literal('memory').readonly(),
  profile: z.union([
    z.object({ status: z.literal('known').readonly(), name: z.string().readonly() }),
    z.object({
      status: z.literal('unknown').readonly(),
      label: z.literal('profile unknown').readonly(),
      reason: z.string().readonly(),
    }),
  ]).readonly(),
  workspaceRegistry: z.boolean().readonly(),
  capability: z.boolean().readonly(),
  feed: z.literal('session/event').readonly(),
})

const stats$schema = z.object({
  received: z.number().readonly(),
  delivered: z.number().readonly(),
  accepted: z.number().readonly(),
  duplicates: z.number().readonly(),
  invalid: z.number().readonly(),
  dropped: z.number().readonly(),
  batches: z.number().readonly(),
  reasons: countMap$schema.readonly(),
})

const snapshot$schema = z.union([
  z.object({
    available: z.literal(true).readonly(),
    metadata: metadata$schema.readonly(),
    stats: stats$schema.readonly(),
    report: report$schema.readonly(),
  }),
  z.object({
    available: z.literal(false).readonly(),
    reason: unavailableReason$schema.readonly(),
  }),
])

/** `'usage'` → `7573616765`; the protocol's per-namespace augmentation key. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$7573616765 {
    getSnapshot: () => Promise<RemoteResult<UsageSnapshot>>
    refresh: () => Promise<RemoteResult<UsageSnapshot>>
  }
  interface TypertRemoteMap {
    'usage/getSnapshot': () => Promise<RemoteResult<UsageSnapshot>>
    'usage/refresh': () => Promise<RemoteResult<UsageSnapshot>>
  }
  interface TypertRemoteNamespaceMap {
    usage: TypertRemoteNamespace$7573616765
  }
}

export const USAGE_TYPERT_REMOTE: TypertRemoteContribution = {
  package: USAGE_REMOTE_PACKAGE,
  descriptors: [
    {
      id: `${USAGE_REMOTE_PACKAGE}#${USAGE_REMOTE_NAMESPACE}/getSnapshot`,
      service: USAGE_REMOTE_NAMESPACE,
      namespace: USAGE_REMOTE_NAMESPACE,
      method: 'getSnapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${USAGE_REMOTE_PACKAGE}#UsageSnapshot`, snapshot$schema),
      sourceLocation: { file: 'src/server/usage-remote.ts', line: 400, column: 3 },
    },
    {
      id: `${USAGE_REMOTE_PACKAGE}#${USAGE_REMOTE_NAMESPACE}/refresh`,
      service: USAGE_REMOTE_NAMESPACE,
      namespace: USAGE_REMOTE_NAMESPACE,
      method: 'refresh',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${USAGE_REMOTE_PACKAGE}#UsageSnapshot`, snapshot$schema),
      sourceLocation: { file: 'src/server/usage-remote.ts', line: 412, column: 3 },
    },
  ],
}

export default USAGE_TYPERT_REMOTE
