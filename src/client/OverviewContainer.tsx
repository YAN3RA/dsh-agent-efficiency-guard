/**
 * 总览 container — wires `OverviewPanel` to the real usage Remote.
 *
 * `OverviewPanel` is the pure view (hook-free, walkable by the test suite).
 * This container owns the one thing that needs a hook: reading the same usage
 * snapshot the 调用统计 page reads, so 总览 never invents a number.
 *
 * Design rules carried over from the usage page:
 * - A missing snapshot is "unknown", never zero. `calls` stays undefined until
 *   the Host actually returns totals.
 * - A failed read surfaces as an attention item, not as an empty state.
 * - The window is the product default (7 days); 总览 is a summary, and the
 *   usage page owns window selection.
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { UsagePanelApi, UsagePanelSnapshot } from './usage.tsx'
import { OverviewPanel, type OverviewAttention } from './OverviewPanel.tsx'
import type { PluginSectionKey } from './PluginSection.tsx'

/** The window 总览 summarizes. The usage page owns the switchable range. */
const OVERVIEW_RANGE_DAYS = 7 as const

export interface OverviewContainerProps {
  readonly t: (key: PluginSectionKey) => string
  readonly usageApi: UsagePanelApi
  /** Guard state, owned by the Host config; undefined until known. */
  readonly guardEnabled?: boolean
  readonly duplicateDetection?: boolean
  readonly duplicateThresholds?: readonly number[]
  readonly tiers?: { resident: number; onDemand: number; disabled: number }
}

interface State {
  readonly snapshot?: UsagePanelSnapshot
  readonly failed: boolean
}

export function OverviewContainer(props: OverviewContainerProps): ReactElement {
  const { t, usageApi, guardEnabled, duplicateDetection, duplicateThresholds, tiers } = props
  const [state, setState] = useState<State>({ failed: false })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await usageApi.getSnapshot({ days: OVERVIEW_RANGE_DAYS })
      if (cancelled) return
      if (result.ok) setState({ snapshot: result.value, failed: false })
      else setState({ failed: true })
    })()
    return () => { cancelled = true }
  }, [usageApi, reloadKey])

  const totals = state.snapshot?.totals
  const attention: OverviewAttention[] = []

  if (state.failed) {
    attention.push({ kind: 'coverage', text: t('attentionCoverage') })
  }
  if ((totals?.failed ?? 0) > 0) {
    attention.push({ kind: 'failures', text: t('attentionFailures') })
  }
  if ((totals?.idleCandidates ?? 0) > 0) {
    attention.push({ kind: 'idle', text: t('attentionIdle') })
  }

  return createElement(OverviewPanel, {
    t,
    guardEnabled,
    duplicateDetection,
    duplicateThresholds,
    counts: totals === undefined
      ? undefined
      : { calls: totals.calls, failed: totals.failed, succeeded: totals.succeeded },
    tiers,
    attention,
    onRefresh: () => setReloadKey(key => key + 1),
  })
}
