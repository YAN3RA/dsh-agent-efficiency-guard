/**
 * One settings page for the whole plugin, split by capability category.
 *
 * WHY THIS EXISTS — the package used to register two sibling `settings.section`
 * entries (`capability` = 能力菜单, `usage` = 调用统计). They describe the same
 * plugin and the user has to hunt through two side-bar rows to reach it. This
 * shell keeps exactly one entry and switches between the views with a category
 * tab bar, so the category is still one click away but the plugin is one place.
 *
 * The two views are reused verbatim: this file only owns the tab chrome. Neither
 * view changes its data flow, and each keeps its own `inject` props.
 */
import { useState, type ReactElement } from 'react'
import { createElement } from 'react'
import { CapabilitySection, type CapabilitySectionInjected } from './CapabilitySection.tsx'
import { UsagePanel, type UsagePanelApi } from './usage.tsx'

/** Categories shown in the tab bar, in display order. */
export type PluginCategory = 'catalog' | 'usage'

export interface PluginSectionProps {
  /** Props for the 能力目录 view, unchanged from its previous section entry. */
  readonly capability: CapabilitySectionInjected
  /** Data source for the 调用统计 view. */
  readonly usageApi: UsagePanelApi
  /** Copy for the tab bar; both namespaces already own their own page copy. */
  readonly t: (key: PluginSectionKey) => string
}

/** Props the `settings.section` entry injects; identical to the panel props. */
export type PluginSectionInjected = PluginSectionProps

export type PluginSectionKey = 'nav' | 'tabCatalog' | 'tabUsage'

/** Tab id → rendered view. Kept as data so the bar cannot drift from the panels. */
const CATEGORIES: ReadonlyArray<{ readonly id: PluginCategory; readonly key: PluginSectionKey }> = [
  { id: 'catalog', key: 'tabCatalog' },
  { id: 'usage', key: 'tabUsage' },
]

export function PluginSection(props: PluginSectionProps): ReactElement {
  const [active, setActive] = useState<PluginCategory>('catalog')
  return createElement(PluginSectionView, {
    capability: props.capability,
    usageApi: props.usageApi,
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
  const { capability, usageApi, t, active, onSelect } = props

  return (
    <div className="mc-plugin-section">
      {/* The tab bar sits above the reused sections; each section already owns
          its own heading, so no extra page title is injected here. */}
      <div className="mc-tabs" role="tablist" aria-label={t('nav')}>
        {CATEGORIES.map(category => {
          const selected = active === category.id
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className="mc-tab"
              data-active={selected ? 'true' : undefined}
              onClick={() => onSelect(category.id)}
            >
              {t(category.key)}
            </button>
          )
        })}
      </div>

      {/* `hidden` instead of unmounting: both views own live Remote subscriptions
          and scroll positions, and re-mounting on every tab click would refetch
          the whole catalog each time. */}
      <div role="tabpanel" hidden={active !== 'catalog'} className="mc-panel">
        {createElement(CapabilitySection, capability)}
      </div>
      <div role="tabpanel" hidden={active !== 'usage'} className="mc-panel">
        {createElement(UsagePanel, { api: usageApi })}
      </div>
    </div>
  )
}
