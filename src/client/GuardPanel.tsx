/**
 * 思考限制 — the Guard configuration surface.
 *
 * Three sections, in the order the product specified: repeated identical calls,
 * alternating cycles, no-progress protection. Each carries a model-side
 * identifier (`duplicate_call` / `alternating_cycle` / `no_progress`) shown as
 * plain text, because the reminder text injected into the conversation is
 * English while the label a user reads here is Chinese. The identifier is what
 * ties the two together, so it is displayed rather than hidden.
 *
 * NO summary panel: the current effective state is not repeated here. The
 * 总览 page owns "what is on right now"; duplicating it produced two places to
 * read the same thing and a second place to keep in sync.
 *
 * Kept hook-free and prop-driven so the settings test suite (no DOM harness) can
 * walk the returned tree.
 */
import { createElement, type ReactElement } from 'react'
import type { PluginSectionKey } from './PluginSection.tsx'

/** The three Guard capabilities, in display order. */
export type GuardSectionId = 'duplicate_call' | 'alternating_cycle' | 'no_progress'

export interface GuardPanelProps {
  readonly t: (key: PluginSectionKey) => string
  /** Which sections are currently enabled, keyed by section id. */
  readonly enabled?: Readonly<Record<GuardSectionId, boolean>>
  /** Fixed reminder thresholds; the implementation does not offer per-level edits. */
  readonly duplicateThresholds?: readonly number[]
  /** Toggle one section. Omitted = read-only surface. */
  readonly onToggle?: (id: GuardSectionId, next: boolean) => void
  /** Restore the shipped defaults. */
  readonly onReset?: () => void
}

/**
 * Section id → localized title plus the lines that explain what the switch does.
 *
 * The descriptions are part of the contract, not decoration: a bare switch does
 * not tell a reader whether turning it off stops reminders only or also stops
 * local denials. Each bullet states the real behaviour the detector implements.
 */
const SECTIONS: readonly {
  id: GuardSectionId
  titleKey: PluginSectionKey
  bodyKeys: readonly PluginSectionKey[]
}[] = [
  { id: 'duplicate_call', titleKey: 'guardSectionA', bodyKeys: ['guardABody1', 'guardABody2', 'guardABody3'] },
  { id: 'alternating_cycle', titleKey: 'guardSectionB', bodyKeys: ['guardBBody1', 'guardBBody2', 'guardBBody3'] },
  { id: 'no_progress', titleKey: 'guardSectionC', bodyKeys: ['guardCBody1', 'guardCBody2', 'guardCBody3'] },
]

export function GuardPanel(props: GuardPanelProps): ReactElement {
  const { t, enabled, duplicateThresholds, onToggle, onReset } = props

  const section = (entry: typeof SECTIONS[number]): ReactElement => {
    const isOn = enabled?.[entry.id] ?? false
    const canToggle = onToggle !== undefined
    return createElement('div', { key: entry.id, className: 'mc-guard-card', 'data-guard-section': entry.id },
      createElement('div', { className: 'mc-guard-head' },
        createElement('span', { className: 'mc-guard-title' }, t(entry.titleKey)),
        // Model-side identifier: the injected reminder is English, this label is
        // Chinese, and this is the string that ties them together.
        createElement('span', { className: 'mc-guard-model' },
          `${t('guardModelLabel')} ${entry.id}`),
        createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': isOn ? 'true' : 'false',
          'aria-label': t(entry.titleKey),
          className: `mc-guard-switch${isOn ? ' mc-guard-switch--on' : ''}`,
          disabled: !canToggle,
          onClick: () => canToggle && onToggle(entry.id, !isOn),
        }),
      ),
      createElement('div', { className: 'mc-guard-body' },
        createElement('ul', { className: 'mc-guard-points' },
          ...entry.bodyKeys.map(key => createElement('li', { key, className: 'mc-guard-point' }, t(key)))),
        // The fixed thresholds belong to section A only; they are numbers the
        // implementation owns, so they are read from the prop rather than copy.
        // Label and value are separate elements rather than one interpolated
        // string: the separator between them must not be a literal punctuation
        // mark (`：` is Chinese-only), so spacing does the job in both locales.
        entry.id === 'duplicate_call' && duplicateThresholds !== undefined &&
          createElement('div', { className: 'mc-guard-thresholds' },
            createElement('span', { className: 'mc-guard-thresholds-label' }, t('guardThresholds')),
            createElement('span', { className: 'mc-guard-thresholds-value' }, duplicateThresholds.join(' / '))),
      ),
    )
  }

  return createElement('section', { className: 'mc-section' },
    createElement('header', { className: 'mc-heading-row' },
      createElement('h2', { className: 'mc-heading' }, t('guardTitle')),
      createElement('div', { className: 'mc-heading-actions' },
        onReset !== undefined && createElement('button', {
          type: 'button',
          className: 'mc-count mc-count--action',
          onClick: onReset,
        }, t('guardReset'))),
    ),
    createElement('p', { className: 'mc-desc' }, t('guardDesc')),
    createElement('p', { className: 'mc-guard-boundary' }, t('guardBoundary')),
    ...SECTIONS.map(section),
  )
}
