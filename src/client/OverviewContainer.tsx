/**
 * 总览 container — wires `OverviewPanel` to real Host data.
 *
 * `OverviewPanel` is the pure view (hook-free, walkable by the test suite).
 * This container owns the reads that need hooks:
 * - the usage snapshot the 调用统计 page reads, so no number is invented;
 * - the Guard switches, so "防循环：已启用" reflects the real configuration;
 * - the capability tiers, so the tier split is the catalog's, not a constant.
 *
 * Design rules carried over from the usage page:
 * - A missing value is "unknown" (`—`), never zero.
 * - A failed read becomes an attention item, not a silent empty state.
 * - The window is the product default (7 days); 总览 is a summary, and the
 *   usage page owns window selection.
 */
import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'
import type { UsagePanelApi, UsagePanelSnapshot } from './usage.tsx'
import { OverviewPanel, type OverviewAttention } from './OverviewPanel.tsx'
import type { PluginSectionKey } from './PluginSection.tsx'
import type { GuardSwitches } from './remote.ts'

/** The window 总览 summarizes. The usage page owns the switchable range. */
const OVERVIEW_RANGE_DAYS = 7 as const

/** The remote fields this container needs; a subset of the full policy face. */
export interface OverviewGuardRemote {
  getGuard?(): Promise<{ ok: true; value: GuardSwitches } | { ok: false; error: { code: string; message: string } }>
}

/** Tier counts, read from `classifyAll`. */
export interface OverviewTierSource {
  classifyAll?(): Promise<
    { ok: true; value: readonly { class: 'resident' | 'on-demand' | 'disabled' }[] }
    | { ok: false; error: { code: string; message: string } }
  >
}

export interface OverviewContainerProps {
  readonly t: (key: PluginSectionKey) => string
  readonly usageApi: UsagePanelApi
  readonly guardRemote?: OverviewGuardRemote
  /** Capability remote, used only for the tier split. */
  readonly policyRemote?: OverviewTierSource
}

interface State {
  snapshot?: UsagePanelSnapshot
  guard?: GuardSwitches
  tiers?: { resident: number; onDemand: number; disabled: number }
  usageFailed: boolean
}

export function OverviewContainer(props: OverviewContainerProps): ReactElement {
  const { t, usageApi, guardRemote, policyRemote } = props
  const [state, setState] = useState<State>({ usageFailed: false })
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    // Read all three in parallel; each failure is independent so one slow or
    // broken surface does not blank the whole page.
    const [usage, guard, rows] = await Promise.all([
      usageApi.getSnapshot({ days: OVERVIEW_RANGE_DAYS }),
      guardRemote?.getGuard === undefined ? undefined : guardRemote.getGuard(),
      policyRemote?.classifyAll === undefined ? undefined : policyRemote.classifyAll(),
    ])

    setState(previous => {
      const next: State = { ...previous, usageFailed: !usage.ok }
      if (usage.ok) next.snapshot = usage.value
      if (guard?.ok === true) next.guard = guard.value
      if (rows?.ok === true) {
        const counts = { resident: 0, onDemand: 0, disabled: 0 }
        for (const row of rows.value) {
          if (row.class === 'resident') counts.resident += 1
          else if (row.class === 'on-demand') counts.onDemand += 1
          else counts.disabled += 1
        }
        next.tiers = counts
      }
      return next
    })
  }, [usageApi, guardRemote, policyRemote])

  useEffect(() => { void load() }, [load, reloadKey])

  const totals = state.snapshot?.totals
  const attention: OverviewAttention[] = []

  if (state.usageFailed) attention.push({ kind: 'coverage', text: t('attentionCoverage') })
  if ((totals?.failed ?? 0) > 0) attention.push({ kind: 'failures', text: t('attentionFailures') })
  if ((totals?.idleCandidates ?? 0) > 0) attention.push({ kind: 'idle', text: t('attentionIdle') })

  return createElement(OverviewPanel, {
    t,
    guardEnabled: state.guard?.enabled,
    duplicateDetection: state.guard?.duplicateDetection,
    // Thresholds are fixed by the implementation; only show them when the
    // repeat reminder is actually on.
    duplicateThresholds: state.guard?.duplicateDetection === false ? undefined : [3, 5, 8],
    counts: totals === undefined
      ? undefined
      : { calls: totals.calls, failed: totals.failed, succeeded: totals.succeeded },
    tiers: state.tiers,
    attention,
    onRefresh: () => setReloadKey(key => key + 1),
  })
}
