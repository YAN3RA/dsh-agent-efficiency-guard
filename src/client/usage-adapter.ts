/**
 * Pure adapter from the `usage` wire snapshot (`src/client/usage-remote.ts`) to
 * the panel view model (`src/client/usage.tsx`).
 *
 * WHY THIS FILE EXISTS — the Host Remote answers `getSnapshot()` / `refresh()`
 * with one bounded {@link UsageSnapshot}: per-Session/day/capability report rows
 * plus a per-Session coverage map. The panel deliberately consumes a small,
 * pre-aggregated view model and takes a `query` (`days`, `workspaceId`, `kind`).
 * Those are two different shapes, and the missing translation is exactly the
 * work this module does: it re-aggregates the raw rows client-side, derives the
 * filter options the Host does not send, and turns every "no data" answer into
 * an explicit error instead of a zero.
 *
 * WHAT IT NEVER DOES:
 * - Never imports a Host module, a Session object, or an event. The rows are
 *   already content-free; this layer only reads their counters and labels.
 * - Never claims a fact the wire does not carry. Exposure tier is not part of
 *   the report, so a capability row reports `status: 'unknown'` rather than
 *   guessing `resident`; `suggestion` and the 30-day idle-candidate count are
 *   left unset for the same reason.
 * - Never reports `event-time` workspace attribution. Rows are attributed per
 *   Session by the collector, and merging them can only weaken the evidence, so
 *   the merged coverage says `current-mapping` (or `unknown`), never
 *   `event-time`.
 * - Never turns an unavailable snapshot into numbers. `{ available: false }`
 *   and an unmounted Remote both map to an error result, so the panel shows the
 *   reason and no totals — "0 calls" would be a lie.
 *
 * The module is intentionally free of React, browser globals and network code:
 * every rule below is directly testable (`tests/client-usage-adapter.spec.ts`).
 *
 * @module dsh-agent-efficiency-guard/client/usage-adapter
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  UsageSnapshot,
  UsageSnapshotAggregate,
  UsageSnapshotAvailable,
  UsageSnapshotCoverage,
  UsageSnapshotUnavailableReason,
  UsageSnapshotWorkspaceAttribution,
} from './usage-remote.ts'
import type {
  UsageCapability,
  UsageCapabilityKind,
  UsageCapabilityStatus,
  UsageCoverage,
  UsageCoverageStatus,
  UsageFilterOptions,
  UsagePanelApi,
  UsagePanelSnapshot,
  UsageQuery,
  UsageRangeDays,
  UsageResult,
  UsageTotals,
  UsageWorkspaceAttribution,
  UsageWorkspaceOption,
} from './usage.tsx'

/** One UTC day in milliseconds; the report buckets by `YYYY-MM-DD` only. */
const MS_PER_DAY = 86_400_000

/** Strict `YYYY-MM-DD`; anything else is a Host defect, not a date we guess at. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** The panel's contractual time filter. */
export const USAGE_PANEL_RANGES: readonly UsageRangeDays[] = Object.freeze([7, 15, 30])

/** Merged coverage keeps at most this many distinct reasons. */
export const USAGE_MAX_COVERAGE_REASONS = 8

/** Canonical kind order so the filter row does not shuffle between reads. */
const KIND_ORDER: readonly UsageCapabilityKind[] = ['mcp', 'skill', 'plugin-tool', 'native', 'unknown']

const KIND_SET: ReadonlySet<string> = new Set<string>(KIND_ORDER)

const COVERAGE_RANK: Readonly<Record<UsageCoverageStatus, number>> = {
  complete: 0,
  partial: 1,
  unknown: 2,
}

/**
 * Stable codes for failures this adapter produces itself. The Host's own
 * reasons (`service-absent`, …) pass through unchanged.
 */
export const USAGE_ADAPTER_ERRORS = Object.freeze({
  remoteUnmounted: 'remote-unmounted',
  transport: 'transport-error',
  invalidSnapshot: 'snapshot-invalid',
} as const)

/**
 * User-facing text for every non-available answer. Kept next to the codes it
 * explains so a new reason cannot be added on one side only.
 */
export const USAGE_UNAVAILABLE_MESSAGES: Readonly<Record<UsageSnapshotUnavailableReason, string>> = Object.freeze({
  'service-absent': '统计服务未安装：Host 没有可读的 Usage runtime。这里不是「0 次调用」，而是没有数据来源。',
  'snapshot-unavailable': '统计尚未就绪：Host 已安装统计服务，但当前没有可读快照。0 不代表未使用。',
  'snapshot-invalid': '统计快照无效：Host 返回的数据结构不正确，已拒绝显示，避免把缺数据当成 0 调用。',
})

/** Result of {@link usageDayWindow}; dates are inclusive UTC day strings. */
export interface UsageDayWindow {
  readonly days: UsageRangeDays
  readonly startDay: number
  readonly endDay: number
  readonly startDate: string
  readonly endDate: string
}

/** Structural shape of the mounted `remote.usage` namespace service. */
export interface UsagePanelRemote {
  readonly getSnapshot: () => Promise<RemoteResult<UsageSnapshot>>
  readonly refresh: () => Promise<RemoteResult<UsageSnapshot>>
}

/**
 * Lazily resolved face. The section mounts the Remote contribution in `apply`,
 * so the service may not exist yet when the component is constructed; resolving
 * per call also survives a re-mount without rebuilding the api object (the
 * panel requires a stable `api`).
 */
export type UsagePanelRemoteProvider = () => UsagePanelRemote | undefined

/** Adapter knobs. Both exist for determinism in tests, not for product logic. */
export interface UsagePanelAdapterOptions {
  /** Clock used for the day window and `generatedAt`; defaults to `Date.now`. */
  readonly now?: () => number
  /** Host method to read. `refresh` re-reads Host state instead of the cached one. */
  readonly method?: 'getSnapshot' | 'refresh'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRangeDays(value: unknown): value is UsageRangeDays {
  return value === 7 || value === 15 || value === 30
}

function isKind(value: unknown): value is UsageCapabilityKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function isCoverageStatus(value: unknown): value is UsageCoverageStatus {
  return value === 'complete' || value === 'partial' || value === 'unknown'
}

/** Parse one `YYYY-MM-DD` into a UTC day index; `undefined` when malformed. */
export function parseUsageDay(date: string): number | undefined {
  const match = DAY_PATTERN.exec(date)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const time = Date.UTC(year, month - 1, day)
  const parsed = new Date(time)
  // Rejects 2026-02-31 and friends: Date rolls them over silently.
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined
  }
  return time / MS_PER_DAY
}

/** Format a UTC day index back to `YYYY-MM-DD`. */
export function formatUsageDay(day: number): string {
  const date = new Date(day * MS_PER_DAY)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Inclusive window covering today and the previous `days - 1` UTC days.
 *
 * The report buckets per UTC calendar day (`date`), so the window is expressed
 * in the same units instead of guessing at row timestamps; a 7-day query keeps
 * today plus six earlier dates, which is what the panel's tabs mean.
 */
export function usageDayWindow(days: UsageRangeDays, now: number): UsageDayWindow {
  const range = isRangeDays(days) ? days : 7
  const safeNow = Number.isFinite(now) && now > 0 ? now : 0
  const endDay = Math.floor(safeNow / MS_PER_DAY)
  const startDay = endDay - (range - 1)
  return {
    days: range,
    startDay,
    endDay,
    startDate: formatUsageDay(startDay),
    endDate: formatUsageDay(endDay),
  }
}

/**
 * Merge per-Session coverage into the panel's single status.
 *
 * Worst status wins: one unreadable Session makes the whole page `unknown`, and
 * one partial Session makes it `partial`. A snapshot with no coverage at all is
 * `unknown` rather than `complete` — "nothing reported" is not "nothing missing".
 * Rows dropped for an unparsable date, and a Host that hit its aggregate cap,
 * both downgrade a `complete` page to `partial` because the page really is
 * missing observations.
 */
interface CoverageMergeInput {
  readonly coverage: Readonly<Record<string, UsageSnapshotCoverage>> | undefined
  readonly rowsInWindow: readonly UsageSnapshotAggregate[]
  readonly droppedRows: number
  readonly limitsReached: boolean
}

function mergeCoverage(input: CoverageMergeInput): UsageCoverage {
  const entries = isRecord(input.coverage) ? Object.values(input.coverage) : []
  let status: UsageCoverageStatus = entries.length === 0 ? 'unknown' : 'complete'
  let skippedSessions = 0
  let skippedEvents = 0
  let reasonsTruncated = false
  const reasons: string[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!isRecord(entry)) {
      status = 'unknown'
      continue
    }
    const entryStatus = isCoverageStatus(entry.status) ? entry.status : 'unknown'
    if (COVERAGE_RANK[entryStatus] > COVERAGE_RANK[status]) status = entryStatus
    if (isFiniteNumber(entry.skippedSessions)) skippedSessions += entry.skippedSessions
    if (isFiniteNumber(entry.skippedEvents)) skippedEvents += entry.skippedEvents
    if (entry.reasonsTruncated === true) reasonsTruncated = true
    if (!Array.isArray(entry.reasons)) continue
    for (const reason of entry.reasons) {
      if (typeof reason !== 'string' || reason === '' || seen.has(reason)) continue
      seen.add(reason)
      if (reasons.length < USAGE_MAX_COVERAGE_REASONS) reasons.push(reason)
      else reasonsTruncated = true
    }
  }

  if (input.droppedRows > 0 && status === 'complete') status = 'partial'
  if (input.limitsReached && status === 'complete') status = 'partial'

  let from: number | undefined
  let through: number | undefined
  for (const row of input.rowsInWindow) {
    const first = isFiniteNumber(row.firstObservedAt) ? row.firstObservedAt : undefined
    if (first !== undefined && (from === undefined || first < from)) from = first
    const last = isFiniteNumber(row.lastUsedAt) ? row.lastUsedAt : first
    if (last !== undefined && (through === undefined || last > through)) through = last
  }

  return {
    status,
    ...from !== undefined ? { from } : {},
    ...through !== undefined ? { through } : {},
    reasons,
    reasonsTruncated,
    skippedSessions,
    skippedEvents,
    workspaceAttribution: mergedWorkspaceAttribution(input.rowsInWindow),
  }
}

/**
 * Attribution for the merged page.
 *
 * The wire attributes each Session, not each event, and merging Sessions cannot
 * upgrade the evidence. `event-time` is therefore never reported here: rows that
 * carry a usable attribution collapse to `current-mapping` (the panel labels it
 * as an inference), and any `unknown`/missing attribution keeps the page
 * `unknown`.
 */
export function mergedWorkspaceAttribution(
  rows: readonly UsageSnapshotAggregate[],
): UsageWorkspaceAttribution {
  if (rows.length === 0) return 'unknown'
  for (const row of rows) {
    const attribution: UsageSnapshotWorkspaceAttribution | undefined = row.workspaceAttribution
    if (attribution !== 'current-mapping' && attribution !== 'event-time') return 'unknown'
  }
  return 'current-mapping'
}

interface CapabilityGroup {
  readonly key: string
  readonly capabilityId: string
  readonly capabilityKind: UsageCapabilityKind
  readonly providerId?: string
  calls: number
  succeeded: number
  failed: number
  lastUsedAt?: number
  firstObservedAt?: number
}

function groupKey(row: UsageSnapshotAggregate): string {
  const kind = isKind(row.capabilityKind) ? row.capabilityKind : 'unknown'
  // NUL never appears in a Tool/Skill id, so the key is unambiguous.
  return `${row.capabilityId}\u0000${kind}\u0000${row.providerId ?? ''}`
}

/**
 * One row per `capabilityId + kind + providerId`, mirroring the report's own
 * identity. The same tool served by two MCP servers stays two rows because they
 * are two different sources; the same id under two kinds stays two rows because
 * the kind is a classification result, not a label.
 */
function groupCapabilities(rows: readonly UsageSnapshotAggregate[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>()
  for (const row of rows) {
    const key = groupKey(row)
    const calls = isFiniteNumber(row.calls) ? row.calls : 0
    const succeeded = isFiniteNumber(row.succeeded) ? row.succeeded : 0
    const failed = isFiniteNumber(row.failed) ? row.failed : 0
    const lastUsedAt = isFiniteNumber(row.lastUsedAt) ? row.lastUsedAt : undefined
    const firstObservedAt = isFiniteNumber(row.firstObservedAt) ? row.firstObservedAt : undefined
    const existing = groups.get(key)
    if (existing === undefined) {
      const kind = isKind(row.capabilityKind) ? row.capabilityKind : 'unknown'
      groups.set(key, {
        key,
        capabilityId: row.capabilityId,
        capabilityKind: kind,
        ...row.providerId !== undefined && row.providerId !== '' ? { providerId: row.providerId } : {},
        calls,
        succeeded,
        failed,
        ...lastUsedAt !== undefined ? { lastUsedAt } : {},
        ...firstObservedAt !== undefined ? { firstObservedAt } : {},
      })
      continue
    }
    existing.calls += calls
    existing.succeeded += succeeded
    existing.failed += failed
    if (lastUsedAt !== undefined && (existing.lastUsedAt === undefined || lastUsedAt > existing.lastUsedAt)) {
      existing.lastUsedAt = lastUsedAt
    }
    if (firstObservedAt !== undefined
      && (existing.firstObservedAt === undefined || firstObservedAt < existing.firstObservedAt)) {
      existing.firstObservedAt = firstObservedAt
    }
  }
  return [...groups.values()].sort((left, right) => (
    right.calls - left.calls
    || left.capabilityId.localeCompare(right.capabilityId)
    || left.capabilityKind.localeCompare(right.capabilityKind)
    || (left.providerId ?? '').localeCompare(right.providerId ?? '')
  ))
}

function toCapabilityRow(group: CapabilityGroup): UsageCapability {
  return {
    // The raw id alone is not unique across kinds/providers; the composite key
    // keeps React keys and any future row selection unambiguous. `name` stays
    // the capability id, which is what users search for.
    id: group.key,
    name: group.capabilityId,
    kind: group.capabilityKind,
    ...group.providerId !== undefined ? { source: group.providerId } : {},
    // The wire snapshot carries counters but no exposure tier: say unknown
    // rather than inventing `resident`. Policy state lives in the 能力菜单 tab.
    status: 'unknown' as UsageCapabilityStatus,
    calls: group.calls,
    succeeded: group.succeeded,
    failed: group.failed,
    ...group.lastUsedAt !== undefined ? { lastUsedAt: group.lastUsedAt } : {},
  }
}

function summarize(rows: readonly UsageSnapshotAggregate[], groups: readonly CapabilityGroup[]): UsageTotals {
  const totals = { calls: 0, succeeded: 0, failed: 0, denied: 0, cancelled: 0, unresolved: 0 }
  const byKind: Record<UsageCapabilityKind, number> = {
    mcp: 0,
    skill: 0,
    'plugin-tool': 0,
    native: 0,
    unknown: 0,
  }
  const mcpServers = new Set<string>()
  for (const row of rows) {
    const calls = isFiniteNumber(row.calls) ? row.calls : 0
    totals.calls += calls
    if (isFiniteNumber(row.succeeded)) totals.succeeded += row.succeeded
    if (isFiniteNumber(row.failed)) totals.failed += row.failed
    if (isFiniteNumber(row.denied)) totals.denied += row.denied
    if (isFiniteNumber(row.cancelled)) totals.cancelled += row.cancelled
    if (isFiniteNumber(row.unresolved)) totals.unresolved += row.unresolved
    const kind = isKind(row.capabilityKind) ? row.capabilityKind : 'unknown'
    byKind[kind] += calls
    if (kind === 'mcp' && calls > 0 && typeof row.providerId === 'string' && row.providerId !== '') {
      mcpServers.add(row.providerId)
    }
  }
  return {
    calls: totals.calls,
    succeeded: totals.succeeded,
    failed: totals.failed,
    denied: totals.denied,
    cancelled: totals.cancelled,
    unresolved: totals.unresolved,
    distinctCapabilities: groups.length,
    mcpCalls: byKind.mcp,
    activeMcpServers: mcpServers.size,
    skillCalls: byKind.skill,
    pluginToolCalls: byKind['plugin-tool'],
    nativeCalls: byKind.native,
    unknownCalls: byKind.unknown,
    // `idleCandidates` needs a capability catalog (which capabilities exist but
    // were never called). The snapshot has no catalog, so the metric stays
    // unset instead of being reported as zero.
  }
}

/**
 * Derive the panel's filter options from the rows.
 *
 * The Host sends no option lists — `getSnapshot()` takes no arguments — so the
 * only truthful source is the snapshot itself. Options are derived from *all*
 * rows (not just the current window) so switching 7 → 30 days does not drop a
 * workspace or kind from the controls. `ranges` is the page contract.
 */
function deriveFilters(rows: readonly UsageSnapshotAggregate[]): UsageFilterOptions {
  const workspaceIds = new Set<string>()
  const kinds = new Set<UsageCapabilityKind>()
  for (const row of rows) {
    if (typeof row.workspaceId === 'string' && row.workspaceId !== '') workspaceIds.add(row.workspaceId)
    if (isKind(row.capabilityKind)) kinds.add(row.capabilityKind)
  }
  const workspaces: UsageWorkspaceOption[] = [...workspaceIds]
    .sort((left, right) => left.localeCompare(right))
    .map(id => ({ id, label: id }))
  return {
    ranges: [...USAGE_PANEL_RANGES],
    workspaces,
    kinds: KIND_ORDER.filter(kind => kinds.has(kind)),
  }
}

function buildNotes(
  report: Readonly<{ orphanResults: number; duplicateResults: number; limitsReached: boolean }>,
  droppedRows: number,
  query: UsageQuery,
): string[] {
  const notes: string[] = []
  if (query.workspaceId !== undefined || query.kind !== undefined) {
    notes.push('工作区与类型筛选在本机快照上完成，不额外请求 Host。')
  }
  if (report.limitsReached) {
    notes.push('Host 报告聚合行已到上限，结果可能被截断，不能当作完整统计。')
  }
  if (droppedRows > 0) {
    notes.push(`有 ${droppedRows} 条聚合行的日期无法解析，未计入统计。`)
  }
  if (report.orphanResults > 0) {
    notes.push(`有 ${report.orphanResults} 条调用结果未配对，已计入覆盖缺口，不计入成功率。`)
  }
  if (report.duplicateResults > 0) {
    notes.push(`有 ${report.duplicateResults} 条重复调用结果已忽略。`)
  }
  return notes
}

/**
 * Project one readable snapshot into the panel view model for `query`.
 *
 * Pure and total: every write is a copy, no input row is mutated (the group
 * accumulator is local), and no branch throws on a Host-side defect — malformed
 * rows are skipped, counters default to zero only when they are actually zero.
 */
export function mapUsageSnapshot(
  snapshot: UsageSnapshotAvailable,
  query: UsageQuery,
  now: number,
): UsagePanelSnapshot {
  const window = usageDayWindow(query.days, now)
  const allRows: readonly UsageSnapshotAggregate[] = Array.isArray(snapshot.report.aggregates)
    ? snapshot.report.aggregates as readonly UsageSnapshotAggregate[]
    : []
  const inWindow: UsageSnapshotAggregate[] = []
  let droppedRows = 0
  for (const row of allRows) {
    if (!isRecord(row)) {
      droppedRows += 1
      continue
    }
    const day = parseUsageDay(row.date)
    if (day === undefined) {
      droppedRows += 1
      continue
    }
    if (day < window.startDay || day > window.endDay) continue
    inWindow.push(row)
  }
  const selected = inWindow.filter(row => (
    (query.workspaceId === undefined || row.workspaceId === query.workspaceId)
    && (query.kind === undefined || row.capabilityKind === query.kind)
  ))
  const groups = groupCapabilities(selected)
  return {
    // The wire snapshot carries no assembly timestamp; this is when the browser
    // mapped it, which is the honest reading of the panel's “更新于”.
    generatedAt: now,
    coverage: mergeCoverage({
      coverage: snapshot.report.coverage,
      rowsInWindow: inWindow,
      droppedRows,
      limitsReached: snapshot.report.limitsReached === true,
    }),
    totals: summarize(selected, groups),
    capabilities: groups.map(toCapabilityRow),
    filters: deriveFilters(allRows),
    notes: buildNotes(
      {
        orphanResults: isFiniteNumber(snapshot.report.orphanResults) ? snapshot.report.orphanResults : 0,
        duplicateResults: isFiniteNumber(snapshot.report.duplicateResults) ? snapshot.report.duplicateResults : 0,
        limitsReached: snapshot.report.limitsReached === true,
      },
      droppedRows,
      query,
    ),
  }
}

/** Validate the untyped wire value; `undefined` means "do not trust it". */
function readUsageSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (value.available === true) {
    if (!isRecord(value.report) || !Array.isArray(value.report.aggregates)) return undefined
    if (value.report.coverage !== undefined && !isRecord(value.report.coverage)) return undefined
    return value as unknown as UsageSnapshot
  }
  if (value.available === false) {
    if (typeof value.reason !== 'string') return undefined
    return value as unknown as UsageSnapshot
  }
  return undefined
}

/**
 * Map one Remote answer (or any untyped value) to the panel envelope.
 *
 * The error branch is the whole point: `available: false` becomes a result the
 * panel renders as a blocked state with its reason, so the page never shows
 * `0` for data it does not have.
 */
export function toUsagePanelResult(
  raw: unknown,
  query: UsageQuery,
  now: number = Date.now(),
): UsageResult<UsagePanelSnapshot> {
  const snapshot = readUsageSnapshot(raw)
  if (snapshot === undefined) {
    return {
      ok: false,
      error: { code: USAGE_ADAPTER_ERRORS.invalidSnapshot, message: USAGE_UNAVAILABLE_MESSAGES['snapshot-invalid'] },
    }
  }
  if (!snapshot.available) {
    const message = (USAGE_UNAVAILABLE_MESSAGES as Readonly<Record<string, string>>)[snapshot.reason]
      ?? USAGE_UNAVAILABLE_MESSAGES['snapshot-unavailable']
    return { ok: false, error: { code: snapshot.reason, message } }
  }
  return { ok: true, value: mapUsageSnapshot(snapshot, query, now) }
}

function isUsagePanelRemote(value: unknown): value is UsagePanelRemote {
  return isRecord(value)
    && typeof value.getSnapshot === 'function'
    && typeof value.refresh === 'function'
}

/**
 * Build the `api` the panel expects on top of the real `usage` Remote.
 *
 * `getSnapshot` is read on every call, so a missing/unmounted namespace is an
 * explicit error rather than a stale object captured at construction time. A
 * thrown call is folded into the same error envelope: the panel has one error
 * channel and should not have to distinguish transport from business failure.
 */
export function createUsagePanelApi(
  remote: UsagePanelRemote | UsagePanelRemoteProvider,
  options: UsagePanelAdapterOptions = {},
): UsagePanelApi {
  const now = options.now ?? ((): number => Date.now())
  const method = options.method ?? 'getSnapshot'
  const resolve = (): UsagePanelRemote | undefined => (
    typeof remote === 'function' ? remote() : remote
  )
  return {
    async getSnapshot(query: UsageQuery): Promise<UsageResult<UsagePanelSnapshot>> {
      const face = resolve()
      if (face === undefined || !isUsagePanelRemote(face)) {
        return {
          ok: false,
          error: {
            code: USAGE_ADAPTER_ERRORS.remoteUnmounted,
            message: '统计 Remote 未挂载：无法读取调用统计。0 不代表未使用。',
          },
        }
      }
      let result: RemoteResult<UsageSnapshot>
      try {
        result = await face[method]()
      } catch (error) {
        return {
          ok: false,
          error: {
            code: USAGE_ADAPTER_ERRORS.transport,
            message: `读取调用统计失败：${error instanceof Error ? error.message : String(error)}`,
          },
        }
      }
      if (!result.ok || !isRecord(result)) {
        const code = isRecord(result) && isRecord(result.error) && typeof result.error.code === 'string'
          ? result.error.code
          : USAGE_ADAPTER_ERRORS.transport
        const message = isRecord(result) && isRecord(result.error) && typeof result.error.message === 'string'
          && result.error.message !== ''
          ? result.error.message
          : '读取调用统计失败：Remote 返回了无法识别的错误。'
        return { ok: false, error: { code, message } }
      }
      return toUsagePanelResult(result.value, query, now())
    },
  }
}
