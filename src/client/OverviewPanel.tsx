/**
 * 总览 — the plugin's landing page.
 *
 * Shows only state a reader needs to decide what to do next: whether the guard
 * is on, its thresholds, the recent call volume, the tier split, and anything
 * that needs attention. Every number comes from a prop; this file never invents
 * a figure, and an absent figure renders as an explicit empty state rather than
 * a fabricated zero.
 *
 * Kept hook-free and prop-driven so the settings test suite (no DOM harness) can
 * walk the returned tree.
 */
import { createElement, type ReactElement } from 'react'
import type { PluginSectionKey } from './PluginSection.tsx'

export interface OverviewCounts {
  /** Calls observed in the selected window. Undefined when not yet known. */
  readonly calls?: number
  readonly failed?: number
  readonly succeeded?: number
}

export interface OverviewTiers {
  readonly resident: number
  readonly onDemand: number
  readonly disabled: number
}

export interface OverviewAttention {
  /** Which kind of attention item this is; drives tone and copy. */
  readonly kind: 'failures' | 'idle' | 'coverage'
  /** Already-localized sentence. */
  readonly text: string
}

export interface OverviewPanelProps {
  readonly t: (key: PluginSectionKey) => string
  /** Guard switch, as currently configured. */
  readonly guardEnabled?: boolean
  /** Fixed 3/5/8 reminder thresholds when duplicate detection is on. */
  readonly duplicateThresholds?: readonly number[]
  readonly duplicateDetection?: boolean
  readonly counts?: OverviewCounts
  readonly tiers?: OverviewTiers
  readonly attention?: readonly OverviewAttention[]
  readonly onRefresh?: () => void
}

export function OverviewPanel(props: OverviewPanelProps): ReactElement {
  const {
    t,
    guardEnabled,
    duplicateThresholds,
    duplicateDetection,
    counts,
    tiers,
    attention,
    onRefresh,
  } = props

  const metric = (label: string, value: string, hint?: string): ReactElement =>
    createElement('div', { className: 'mc-metric' },
      createElement('div', { className: 'mc-metric-label' }, label),
      createElement('div', { className: 'mc-metric-value' }, value),
      hint !== undefined && createElement('div', { className: 'mc-metric-hint' }, hint))

  const guardText = guardEnabled === undefined
    ? '—'
    : guardEnabled ? t('guardStateOn') : t('guardStateOff')

  const thresholdText = duplicateDetection === true && duplicateThresholds !== undefined
    ? duplicateThresholds.join(' / ')
    : '—'

  const callsText = counts?.calls === undefined ? '—' : String(counts.calls)
  const callsHint = counts?.calls === undefined
    ? undefined
    : counts.failed === undefined
      ? undefined
      : `成功 ${counts.succeeded ?? 0} · 失败 ${counts.failed}`

  const tierText = tiers === undefined
    ? '—'
    : `${tiers.resident} / ${tiers.onDemand} / ${tiers.disabled}`

  const items = attention ?? []

  return createElement('section', { className: 'mc-section' },
    createElement('header', { className: 'mc-heading-row' },
      createElement('h2', { className: 'mc-heading' }, t('overviewTitle')),
      createElement('div', { className: 'mc-heading-actions' },
        onRefresh !== undefined && createElement('button', {
          type: 'button',
          className: 'mc-count mc-count--action',
          onClick: onRefresh,
        }, t('overviewRefresh'))),
    ),
    createElement('p', { className: 'mc-desc' }, t('overviewDesc')),

    createElement('div', { className: 'mc-metric-grid' },
      metric(t('tabGuard'), guardText),
      metric(t('guardThresholds'), thresholdText),
      metric(t('recentCalls'), callsText, callsHint),
      metric(t('tierSummary'), tierText,
        `${t('tierResident')} / ${t('tierOnDemand')} / ${t('tierDisabled')}`),
    ),

    createElement('div', { className: 'mc-attention' },
      createElement('h3', { className: 'mc-attention-title' }, t('attention')),
      items.length === 0
        ? createElement('p', { className: 'mc-desc' }, t('attentionNone'))
        : createElement('ul', { className: 'mc-attention-list' },
            ...items.map((item, index) => createElement('li', {
              key: `${item.kind}-${index}`,
              className: `mc-attention-item mc-attention-item--${item.kind}`,
            }, item.text)))),
  )
}
