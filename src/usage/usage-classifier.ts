/**
 * Trusted source classification for usage statistics (vNext N8 M2).
 *
 * The classifier answers one question for an already-observed call: which
 * capability kind may this call be attributed to *on evidence the caller can
 * prove*? It is a pure function over ids and trusted metadata; it never parses
 * tool names, arguments, prompts, or results.
 *
 * Trust boundary (docs: vNext §3.8):
 *
 * - MCP: only a unique, non-empty server from a trusted registry snapshot. A
 *   tool named `mcp__server__raw` without that mapping is NOT MCP.
 * - Plugin tool: only an owner explicitly supplied as verified registration
 *   metadata. The DSH `ToolDefinition` surface exposes no generic owner field,
 *   so the default is `unknown`.
 * - Native: only an audited, caller-supplied native allowlist, matched exactly.
 * - Skill: only an explicitly observed skill load entry (`skill-tool`,
 *   `slash-invocation`, `meta-invoke`). A skill name in prompt text is not a
 *   load.
 * - Everything else is `unknown`, with a stable reason code.
 *
 * Contradictory trusted inputs (for example a tool that is both in the native
 * allowlist and has a plugin owner, or an ambiguous MCP mapping next to another
 * claim) resolve to `unknown` instead of picking a winner.
 */
import type { UsageSkillEntry, UsageSource } from './usage-core.ts'

/** Stable reason codes for an `unknown` classification. */
export type UsageClassificationReason =
  | 'tool-id-missing'
  | 'owner-not-verified'
  | 'ambiguous-mcp-provider'
  | 'missing-mcp-provider'
  | 'conflicting-trusted-sources'
  | 'skill-id-missing'
  | 'skill-entry-not-observed'

/**
 * Caller-supplied trusted evidence. Every entry must come from a verifiable
 * source: a registry snapshot, explicit registration metadata, or the audited
 * native allowlist. Nothing here may be derived from a tool name, an argument,
 * a prompt, or a session body.
 */
export interface UsageClassifierContext {
  /**
   * Tool id → MCP server names proven by the trusted registry snapshot.
   *
   * A tool is MCP only when exactly one distinct, non-empty server remains
   * after normalizing the candidates. Several distinct servers are ambiguous;
   * an empty or blank-only list is a missing mapping. Both stay `unknown`.
   */
  readonly mcpProviders?: ReadonlyMap<string, readonly string[]>
  /** Tool id → plugin/package owner proven by explicit registration metadata. */
  readonly pluginToolOwners?: ReadonlyMap<string, string>
  /** Audited first-party native tool ids. Exact, case-sensitive matches only. */
  readonly nativeToolIds?: readonly string[]
}

/** Metadata-only input for one observed tool call. Arguments are never an input. */
export interface ToolCallClassificationInput {
  /** The registered tool id exactly as the trusted event reported it. */
  readonly toolId: string
}

/** Metadata-only input for one observed skill load. Skill bodies are never an input. */
export interface SkillLoadClassificationInput {
  readonly skillId: string
  /**
   * The observed load entry. Absent or unrecognized values mean no skill load
   * was proven, which keeps the result `unknown`.
   */
  readonly entry?: string
  /** Skill provider label, only when the caller can verify it. */
  readonly providerId?: string
}

const SKILL_ENTRIES: ReadonlySet<string> = new Set<UsageSkillEntry>([
  'skill-tool',
  'slash-invocation',
  'meta-invoke',
])

/** Narrow an untyped entry value to the observable skill load entries. */
export function isUsageSkillEntry(value: unknown): value is UsageSkillEntry {
  return typeof value === 'string' && SKILL_ENTRIES.has(value)
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function unknown(reason: UsageClassificationReason): UsageSource {
  return { kind: 'unknown', reason }
}

type McpMapping =
  | { readonly status: 'absent' }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'unique'; readonly providerId: string }

/** Resolve one tool id against the trusted MCP map without guessing. */
function resolveMcpMapping(context: UsageClassifierContext, toolId: string): McpMapping {
  const candidates = context.mcpProviders?.get(toolId)
  if (candidates === undefined) return { status: 'absent' }
  const servers = new Set<string>()
  for (const candidate of candidates) {
    const server = nonEmpty(candidate)
    if (server !== undefined) servers.add(server)
  }
  if (servers.size === 0) return { status: 'missing' }
  if (servers.size > 1) return { status: 'ambiguous' }
  return { status: 'unique', providerId: [...servers][0] }
}

/**
 * Classify one tool call from explicit trusted context.
 *
 * `context` is required on purpose: classification must always be handed a
 * caller-chosen snapshot, never an implicit default. An empty context object is
 * a valid, fully explicit "no trusted evidence" input.
 */
export function classifyToolCall(input: ToolCallClassificationInput, context: UsageClassifierContext): UsageSource {
  if (nonEmpty(input.toolId) === undefined) return unknown('tool-id-missing')
  const toolId = input.toolId
  const mcp = resolveMcpMapping(context, toolId)

  const claims: UsageSource[] = []
  const problems: UsageClassificationReason[] = []
  if (mcp.status === 'unique') claims.push({ kind: 'mcp', providerId: mcp.providerId })
  else if (mcp.status === 'ambiguous') problems.push('ambiguous-mcp-provider')
  else if (mcp.status === 'missing') problems.push('missing-mcp-provider')

  const owner = nonEmpty(context.pluginToolOwners?.get(toolId))
  if (owner !== undefined) claims.push({ kind: 'plugin-tool', providerId: owner })

  if (context.nativeToolIds?.includes(toolId) === true) claims.push({ kind: 'native' })

  if (claims.length > 1) return unknown('conflicting-trusted-sources')
  if (claims.length === 1) {
    return problems.length === 0 ? claims[0] : unknown('conflicting-trusted-sources')
  }
  if (problems.length > 0) return unknown(problems[0])
  return unknown('owner-not-verified')
}

/**
 * Classify one observed skill load. No context is needed: a skill load is
 * either proven by an explicit entry or it is not counted at all.
 */
export function classifySkillLoad(input: SkillLoadClassificationInput): UsageSource {
  if (nonEmpty(input.skillId) === undefined) return unknown('skill-id-missing')
  const entry = input.entry
  if (!isUsageSkillEntry(entry)) return unknown('skill-entry-not-observed')
  const providerId = nonEmpty(input.providerId)
  return { kind: 'skill', ...(providerId === undefined ? {} : { providerId }), entry }
}
