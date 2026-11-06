/**
 * One settings page for the whole plugin, split into four pages.
 *
 * WHY THIS EXISTS — the package used to register two sibling `settings.section`
 * entries (`capability` = 能力菜单, `usage` = 调用统计). They describe the same
 * plugin and the user has to hunt through two side-bar rows to reach it. This
 * shell keeps exactly one entry and switches between the views with a category
 * tab bar, so the category is still one click away but the plugin is one place.
 *
 * Page order is fixed by the product decision: 总览 → 思考限制 → 能力目录 → 调用统计.
 * `catalog` and `usage` reuse their existing views verbatim; `overview` and
 * `guard` are owned by this file's siblings (`OverviewPanel`, `GuardPanel`).
 *
 * The tab bar is the official `SegmentedTabs` primitive rather than a hand-rolled
 * `role=tablist`: it brings the roving tabindex, Left/Right/Home/End navigation
 * and the sliding indicator that the shell's own tabs use. `SegmentedTabs`
 * renders no panels, so all panels stay caller-owned here — which is what we
 * want, because they are toggled with `hidden` instead of unmounting.
 */
import { createElement, useState, type ReactElement } from 'react'
import { SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { CapabilitySection, type CapabilitySectionInjected } from './CapabilitySection.tsx'
import { UsagePanel, type UsagePanelApi } from './usage.tsx'
import { OverviewContainer } from './OverviewContainer.tsx'
import { GuardContainer } from './GuardContainer.tsx'
import type { GuardSwitches } from './remote.ts'

/** Categories shown in the tab bar, in display order. */
export type PluginCategory = 'overview' | 'guard' | 'catalog' | 'usage'

export interface PluginSectionProps {
  /** Props for the 能力目录 view, unchanged from its previous section entry. */
  readonly capability: CapabilitySectionInjected
  /** Data source for the 调用统计 view. */
  readonly usageApi: UsagePanelApi
  /** Guard switch face for 思考限制 and the 总览 status row. */
  readonly guardRemote: {
    getGuard?(): Promise<{ ok: true; value: GuardSwitches } | { ok: false; error: { code: string; message: string } }>
    updateGuard?(change: Partial<GuardSwitches>): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
    classifyAll?(): Promise<
      { ok: true; value: readonly { class: 'resident' | 'on-demand' | 'disabled' }[] }
      | { ok: false; error: { code: string; message: string } }
    >
  }
  /** Copy for the tab bar and the two panels owned here. */
  readonly t: (key: PluginSectionKey) => string
}

/** Props the `settings.section` entry injects; identical to the panel props. */
export type PluginSectionInjected = PluginSectionProps

export type PluginSectionKey =
  | 'nav'
  | 'tabOverview'
  | 'tabGuard'
  | 'tabCatalog'
  | 'tabUsage'
  // 总览
  | 'overviewTitle'
  | 'overviewDesc'
  | 'overviewRefresh'
  | 'guardStateOn'
  | 'guardStateOff'
  | 'guardThresholds'
  | 'recentCalls'
  | 'tierSummary'
  | 'attention'
  | 'attentionNone'
  | 'attentionFailures'
  | 'attentionIdle'
  | 'attentionCoverage'
  | 'tierResident'
  | 'tierOnDemand'
  | 'tierDisabled'
  // 思考限制
  | 'guardTitle'
  | 'guardDesc'
  | 'guardBoundary'
  | 'guardReset'
  | 'guardSectionA'
  | 'guardSectionB'
  | 'guardSectionC'
  | 'guardModelLabel'

/** Tab id → rendered view. Kept as data so the bar cannot drift from the panels. */
const CATEGORIES: readonly [SegmentedTab<PluginCategory>, ...SegmentedTab<PluginCategory>[]] = [
  { value: 'overview', id: 'mc-category-tab-overview', panelId: 'mc-category-panel-overview', label: '' },
  { value: 'guard', id: 'mc-category-tab-guard', panelId: 'mc-category-panel-guard', label: '' },
  { value: 'catalog', id: 'mc-category-tab-catalog', panelId: 'mc-category-panel-catalog', label: '' },
  { value: 'usage', id: 'mc-category-tab-usage', panelId: 'mc-category-panel-usage', label: '' },
]

/** Localized tab labels, resolved at render so the shell controls `locale`. */
const CATEGORY_KEYS: Readonly<Record<PluginCategory, PluginSectionKey>> = {
  overview: 'tabOverview',
  guard: 'tabGuard',
  catalog: 'tabCatalog',
  usage: 'tabUsage',
}

export function PluginSection(props: PluginSectionProps): ReactElement {
  const [active, setActive] = useState<PluginCategory>('overview')
  return createElement(PluginSectionView, {
    capability: props.capability,
    usageApi: props.usageApi,
    guardRemote: props.guardRemote,
    t: props.t,
    active,
    onSelect: setActive,
  })
}

export interface PluginSectionViewProps extends PluginSectionProps {
  /** Currently selected category. */
  readonly active: PluginCategory
  /** React to a tab click. */
  readonly onSelect: (category: PluginCategory) => void
}

/**
 * Pure view: no hooks, so the test suite (which has no DOM harness) can call it
 * directly and walk the returned element tree — same pattern as
 * `UsagePanelView`.
 */
export function PluginSectionView(props: PluginSectionViewProps): ReactElement {
  const { capability, usageApi, guardRemote, t, active, onSelect } = props

  const panel = (
    category: PluginCategory,
    children: ReactElement,
  ): ReactElement => createElement('div', {
    role: 'tabpanel',
    id: CATEGORIES.find(c => c.value === category)?.panelId,
    'aria-labelledby': CATEGORIES.find(c => c.value === category)?.id,
    hidden: active !== category,
    className: 'mc-panel',
  }, children)

  return createElement('div', { className: 'mc-plugin-section' },
    // The tab bar sits above the reused sections; each section already owns
    // its own heading, so no extra page title is injected here.
    createElement(SegmentedTabs<PluginCategory>, {
      items: CATEGORIES.map(category => ({
        ...category,
        label: t(CATEGORY_KEYS[category.value]),
      })) as unknown as readonly [SegmentedTab<PluginCategory>, ...SegmentedTab<PluginCategory>[]],
      value: active,
      onChange: onSelect,
      label: t('nav'),
    }),

    // `hidden` instead of unmounting: the catalog and usage views own live
    // Remote subscriptions and scroll positions, and re-mounting on every tab
    // click would refetch the whole catalog each time.
    panel('overview', createElement(OverviewContainer, { t, usageApi, guardRemote, policyRemote: guardRemote })),
    panel('guard', createElement(GuardContainer, { t, remote: guardRemote, duplicateThresholds: [3, 5, 8] })),
    panel('catalog', createElement(CapabilitySection, capability)),
    panel('usage', createElement(UsagePanel, { api: usageApi })),
  )
}
