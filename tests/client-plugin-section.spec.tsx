/**
 * Rules for the single combined settings page.
 *
 * Same constraint as `client-usage.spec.tsx`: this package has no DOM harness,
 * so the component is inspected as an element tree rather than mounted. What
 * matters here is the shell's contract — one page, one tab bar keyed to
 * categories, and both views present so neither loses its subscriptions.
 */
import { describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'

// `CapabilitySection.tsx` pulls in `@deepseek-ai/dsh-client-ui-primitives`, whose
// runtime dependency on `clsx` is not installed in this package's test
// environment. This test is about the SHELL (tabs + which views stay mounted),
// so the heavy view is stubbed; `client-usage.spec.tsx` already covers usage.
vi.mock('../src/client/CapabilitySection.tsx', () => ({
  CapabilitySection: function CapabilitySection() { return null },
}))

import { PluginSectionView, type PluginSectionProps } from '../src/client/PluginSection.tsx'
import { UsagePanel, type UsagePanelApi } from '../src/client/usage.tsx'
import type { CapabilitySectionInjected } from '../src/client/CapabilitySection.tsx'

const capability = {
  remote: {} as CapabilitySectionInjected['remote'],
  t: (key: string) => key,
  subscribeSignals: () => () => undefined,
} satisfies CapabilitySectionInjected

const usageApi: UsagePanelApi = {
  getSnapshot: async () => ({ ok: false, error: { code: 'unavailable', message: 'test' } }),
  refresh: async () => ({ ok: false, error: { code: 'unavailable', message: 'test' } }),
} as unknown as UsagePanelApi

const labels: Record<string, string> = {
  nav: '能力菜单',
  tabCatalog: '能力目录',
  tabUsage: '调用统计',
}

function props(): PluginSectionProps {
  return { capability, usageApi, t: (key: string) => labels[key] ?? key }
}

interface TreeNode {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

function isElement(value: unknown): value is ReactElement {
  return isValidElement(value)
}

/** Depth-first walk over the static element tree. */
function walk(node: ReactNode, visit: (element: TreeNode) => void): void {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  const element = node as unknown as TreeNode
  visit(element)
  walk(element.props.children as ReactNode, visit)
}

function find(node: ReactNode, predicate: (element: TreeNode) => boolean): TreeNode | undefined {
  let hit: TreeNode | undefined
  walk(node, (element) => {
    if (hit === undefined && predicate(element)) hit = element
  })
  return hit
}

function render(active: 'catalog' | 'usage' = 'catalog'): ReactElement {
  return PluginSectionView({ ...props(), active, onSelect: () => undefined }) as ReactElement
}

const tree = render()

/**
 * The tab list comes from the official `SegmentedTabs`, which renders the
 * tablist from its `items` prop rather than from `children`. Expand that one
 * hook-free component so the walk can see the real `role="tab"` buttons — the
 * same technique `client-usage.spec.tsx` already uses for nested components.
 */
function tabsTreeOf(source: ReactNode): ReactNode {
  const tabs = find(source, element => String((element.type as { name?: string })?.name) === 'SegmentedTabs')
  if (tabs === undefined) return null
  const render = tabs.type as (props: unknown) => ReactNode
  return render(tabs.props)
}

function tabButtons(source: ReactNode = tree): TreeNode[] {
  const buttons: TreeNode[] = []
  walk(tabsTreeOf(source), (element) => {
    if (element.props.role === 'tab') buttons.push(element)
  })
  return buttons
}

describe('combined settings page', () => {
  it('renders one category tab bar with a tab per category', () => {
    const buttons = tabButtons()
    expect(buttons.map(button => button.props.children)).toEqual(['能力目录', '调用统计'])
    // Exactly one of them is selected on first paint.
    expect(buttons.filter(button => button.props['aria-selected'] === true)).toHaveLength(1)
    expect(buttons[0]?.props['aria-selected']).toBe(true)
  })

  it('starts on the capability catalog', () => {
    const panels = [] as TreeNode[]
    walk(tree, (element) => {
      if (element.props.role === 'tabpanel') panels.push(element)
    })
    expect(panels).toHaveLength(2)
    // Catalog visible first; usage mounted but hidden, so it keeps its
    // subscription instead of refetching on every tab click.
    expect(panels[0]?.props.hidden).toBe(false)
    expect(panels[1]?.props.hidden).toBe(true)
  })

  it('keeps both reused views mounted, not conditionally swapped', () => {
    expect(find(tree, element => element.type === UsagePanel)).toBeDefined()
    // The capability view is a function component; assert its element exists
    // rather than reaching into its internals.
    const section = find(tree, element => String((element.type as { name?: string })?.name) === 'CapabilitySection')
    expect(section).toBeDefined()
  })

  it('passes the usage api straight through', () => {
    const panel = find(tree, element => element.type === UsagePanel)
    expect((panel?.props as { api?: unknown } | undefined)?.api).toBe(usageApi)
  })

  it('flips which panel is visible when the category changes', () => {
    const usageTree = render('usage')
    const panels: TreeNode[] = []
    walk(usageTree, (element) => {
      if (element.props.role === 'tabpanel') panels.push(element)
    })
    expect(panels[0]?.props.hidden).toBe(true)
    expect(panels[1]?.props.hidden).toBe(false)
  })

  it('reports the selected category on the tabs', () => {
    const buttons = tabButtons(render('usage'))
    expect(buttons.map(button => button.props['aria-selected'])).toEqual([false, true])
  })
})
