import { describe, expect, it } from 'vitest'
import {
  classifySkillLoad,
  classifyToolCall,
  isUsageSkillEntry,
  type ToolCallClassificationInput,
  type UsageClassifierContext,
} from '../src/usage/usage-classifier.ts'
import type { UsageSource } from '../src/usage/usage-core.ts'

function classify(toolId: string, context: UsageClassifierContext = {}): UsageSource {
  return classifyToolCall({ toolId }, context)
}

describe('usage classifier: MCP attribution', () => {
  it('classifies an MCP tool from a unique trusted server mapping', () => {
    const context: UsageClassifierContext = {
      mcpProviders: new Map([['mcp__files__read', ['files']]]),
    }
    expect(classify('mcp__files__read', context)).toEqual({ kind: 'mcp', providerId: 'files' })
  })

  it('stays unknown when the MCP mapping has several candidate servers', () => {
    const context: UsageClassifierContext = {
      mcpProviders: new Map([['mcp__files__read', ['files', 'git']]]),
    }
    expect(classify('mcp__files__read', context)).toEqual({ kind: 'unknown', reason: 'ambiguous-mcp-provider' })
  })

  it('stays unknown when the MCP mapping exists but holds no usable server', () => {
    expect(classify('mcp__files__read', { mcpProviders: new Map([['mcp__files__read', []]]) }))
      .toEqual({ kind: 'unknown', reason: 'missing-mcp-provider' })
    expect(classify('mcp__files__read', { mcpProviders: new Map([['mcp__files__read', [' ', '']]]) }))
      .toEqual({ kind: 'unknown', reason: 'missing-mcp-provider' })
  })

  it('treats repeated identical server candidates as one unique mapping', () => {
    const context: UsageClassifierContext = {
      mcpProviders: new Map([['mcp__files__read', ['files', ' files ']]]),
    }
    expect(classify('mcp__files__read', context)).toEqual({ kind: 'mcp', providerId: 'files' })
  })

  it('does not map a tool through a different tool id', () => {
    const context: UsageClassifierContext = {
      mcpProviders: new Map([['mcp__files__read', ['files']]]),
    }
    expect(classify('mcp__files__write', context)).toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
  })
})

describe('usage classifier: plugin tools and native tools', () => {
  it('classifies a plugin tool only from an explicit verified owner', () => {
    const context: UsageClassifierContext = {
      pluginToolOwners: new Map([['mnemon_remember', 'dsh-mnemon']]),
    }
    expect(classify('mnemon_remember', context)).toEqual({ kind: 'plugin-tool', providerId: 'dsh-mnemon' })
    expect(classify('mnemon_recall', context)).toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
  })

  it('ignores blank owners instead of inventing a package', () => {
    expect(classify('some_tool', { pluginToolOwners: new Map([['some_tool', '   ']]) }))
      .toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
  })

  it('classifies a native tool only from the audited allowlist with an exact match', () => {
    const context: UsageClassifierContext = { nativeToolIds: ['bash', 'read', '   '] }
    expect(classify('bash', context)).toEqual({ kind: 'native' })
    expect(classify('read', context)).toEqual({ kind: 'native' })
    expect(classify('Bash', context)).toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
    expect(classify('bash2', context)).toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
  })

  it('refuses to choose between contradictory trusted sources', () => {
    const both: UsageClassifierContext = {
      pluginToolOwners: new Map([['read', 'some-plugin']]),
      nativeToolIds: ['read'],
    }
    expect(classify('read', both)).toEqual({ kind: 'unknown', reason: 'conflicting-trusted-sources' })

    expect(classify('read', {
      mcpProviders: new Map([['read', ['files']]]),
      nativeToolIds: ['read'],
    })).toEqual({ kind: 'unknown', reason: 'conflicting-trusted-sources' })

    expect(classify('read', {
      mcpProviders: new Map([['read', ['files', 'git']]]),
      nativeToolIds: ['read'],
    })).toEqual({ kind: 'unknown', reason: 'conflicting-trusted-sources' })
  })
})

describe('usage classifier: no name-based inference', () => {
  it('does not derive a kind or owner from a tool name prefix', () => {
    for (const toolId of ['mcp__files__read', 'plugin__pkg__tool', 'skill__summarize', 'built-in.bash']) {
      expect(classify(toolId)).toEqual({ kind: 'unknown', reason: 'owner-not-verified' })
    }
  })

  it('rejects a blank tool id without guessing', () => {
    expect(classify('   ')).toEqual({ kind: 'unknown', reason: 'tool-id-missing' })
    expect(classify('')).toEqual({ kind: 'unknown', reason: 'tool-id-missing' })
  })

  it('never reads or echoes call arguments', () => {
    const withArguments = {
      toolId: 'mcp__files__read',
      arguments: { path: '/private/secret.txt' },
    } as unknown as ToolCallClassificationInput
    const context: UsageClassifierContext = {
      mcpProviders: new Map([['mcp__files__read', ['files']]]),
    }
    const result = classifyToolCall(withArguments, context)
    expect(result).toEqual({ kind: 'mcp', providerId: 'files' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('leaves the trusted context untouched', () => {
    const mcpProviders = new Map([['mcp__files__read', ['files']]])
    const pluginToolOwners = new Map([['some_tool', 'pkg']])
    const nativeToolIds = ['bash']
    classify('mcp__files__read', { mcpProviders, pluginToolOwners, nativeToolIds })
    expect([...mcpProviders]).toEqual([['mcp__files__read', ['files']]])
    expect([...pluginToolOwners]).toEqual([['some_tool', 'pkg']])
    expect(nativeToolIds).toEqual(['bash'])
  })
})

describe('usage classifier: skill loads', () => {
  it('classifies only an explicitly observed skill entry', () => {
    expect(classifySkillLoad({ skillId: 'summarize', entry: 'slash-invocation' }))
      .toEqual({ kind: 'skill', entry: 'slash-invocation' })
    expect(classifySkillLoad({ skillId: 'summarize', entry: 'skill-tool', providerId: 'user-dsh' }))
      .toEqual({ kind: 'skill', providerId: 'user-dsh', entry: 'skill-tool' })
    expect(classifySkillLoad({ skillId: 'summarize', entry: 'meta-invoke', providerId: '  ' }))
      .toEqual({ kind: 'skill', entry: 'meta-invoke' })
  })

  it('stays unknown without an observable skill entry', () => {
    expect(classifySkillLoad({ skillId: 'summarize' }))
      .toEqual({ kind: 'unknown', reason: 'skill-entry-not-observed' })
    expect(classifySkillLoad({ skillId: 'summarize', entry: 'prompt-mention' }))
      .toEqual({ kind: 'unknown', reason: 'skill-entry-not-observed' })
  })

  it('rejects a blank skill id', () => {
    expect(classifySkillLoad({ skillId: '  ', entry: 'skill-tool' }))
      .toEqual({ kind: 'unknown', reason: 'skill-id-missing' })
  })

  it('exposes the entry guard used by the classifier', () => {
    expect(isUsageSkillEntry('skill-tool')).toBe(true)
    expect(isUsageSkillEntry('meta-invoke')).toBe(true)
    expect(isUsageSkillEntry('prompt-listing')).toBe(false)
    expect(isUsageSkillEntry(undefined)).toBe(false)
  })
})
