// Isolated integration fixture only. Not part of the published package.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
export const name = 'n9-agent-probe'
export const inject = ['appReady', 'agents', 'tools', 'sessions']
const publicName = 'mcp__n9_probe__n9_echo'
const connectionKey = 'custom-n9_probe'
const text = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
const ok = result => result?.isError === false && result.value?.ok === true
export function apply(ctx) {
  ctx.get('appReady').onReady(async () => {
    const root = process.env.N9_RUN_DIR
    const report = { assertions: [], calls: [], modelRequests: 0, fixture: 'public Agent registry / SessionStore / Scope / tools.execute' }
    const disposers = []
    const mark = (name, pass, detail) => report.assertions.push({ name, pass: Boolean(pass), detail })
    const run = async (agent, name, args = {}) => {
      const result = await ctx.tools.execute({callId: `n9-${report.calls.length}-${Date.now()}`, name, arguments: args, agent, signal: AbortSignal.timeout(20000)})
      report.calls.push({ name, agent: agent.id, isError: result.isError, value: result.value ?? null, text: text(result) })
      await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify(report, null, 2))
      return result
    }
    const makeAgent = async label => {
      const id = `n9-${label}-${Date.now()}`
      const session = ctx.sessions.create(id, {meta: {cwd: root}})
      const agent = {id, session, options: {}, status: 'idle', ctx, inject() {}, steer() {}}
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      disposers.push(() => scope.dispose())
      const dispose = await ctx.agents.register(agent)
      if (typeof dispose === 'function') disposers.push(dispose)
      return agent
    }
    try {
      if (!root) throw Error('N9_RUN_DIR is required')
      await fs.writeFile(path.join(root, 'loaded.json'), JSON.stringify({loaded: true}))
      const deadline = Date.now() + 120000
      while (true) {
        try { await fs.access(path.join(root, 'ready.json')); break } catch {}
        if (Date.now() > deadline) throw Error('MCP readiness gate timed out')
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const a = await makeAgent('a'), b = await makeAgent('b')
      const denied = (r, needle) => r.isError === true && /activat|激活|not found|not available|不可用|not accessible|not registered/i.test(text(r)) && (!needle || text(r).includes(needle))
      const directBefore = await run(a, publicName, {text: 'denied-before'})
      mark('unauthorized direct call rejected', denied(directBefore), text(directBefore))
      const metaBefore = await run(a, 'meta_invoke', {id: publicName, kind: 'tool', args: {text: 'denied-meta-before'}})
      mark('unauthorized meta_invoke rejected', denied(metaBefore), text(metaBefore))
      const search = await run(a, 'mcp_connector_session_tools', {action: 'search', connectionKey, query: 'n9_echo', limit: 5})
      mark('session search returns exact publicName', ok(search) && search.value.detail.items.some(t => t.publicName === publicName), search.value ?? text(search))
      const preview = await run(a, 'mcp_connector_session_tools', {action: 'preview-activate', connectionKey, publicNames: [publicName], ttlMinutes: 5})
      mark('preview provides exact tool and revision', ok(preview) && preview.value.detail.publicNames.includes(publicName) && Number.isInteger(preview.value.detail.baseRevision), preview.value ?? text(preview))
      if (!ok(preview)) throw Error('Cannot proceed without a valid preview')
      const active = await run(a, 'mcp_connector_session_tools', {action: 'activate', connectionKey, publicNames: [publicName], ttlMinutes: 5, confirmed: true, expectedRevision: preview.value.detail.baseRevision})
      mark('explicit synthetic-test activation succeeds', ok(active) && active.value.detail.activated.includes(publicName), active.value ?? text(active))
      if (!ok(active)) throw Error('Cannot proceed without successful activation')
      const direct = await run(a, publicName, {text: 'authorized-agent-only'})
      mark('authorized direct MCP call succeeds', !direct.isError && text(direct).includes('n9-local:authorized-agent-only'), text(direct))
      const meta = await run(a, 'meta_invoke', {id: publicName, kind: 'tool', args: {text: 'authorized-meta-call'}})
      mark('authorized meta_invoke MCP call succeeds', !meta.isError && text(meta).includes('n9-local:authorized-meta-call'), text(meta))
      const other = await run(b, publicName, {text: 'denied-other-agent'})
      mark('another Agent direct call rejected', denied(other), text(other))
      const otherMeta = await run(b, 'meta_invoke', {id: publicName, kind: 'tool', args: {text: 'denied-other-meta'}})
      mark('another Agent meta_invoke rejected', denied(otherMeta), text(otherMeta))
      const status = await run(a, 'mcp_connector_session_tools', {action: 'status'})
      if (!ok(status)) throw Error('Cannot obtain current revision')
      const deactivate = await run(a, 'mcp_connector_session_tools', {action: 'deactivate', connectionKey, publicNames: [publicName], expectedRevision: status.value.detail.revision})
      mark('deactivation removes authorization', ok(deactivate) && deactivate.value.detail.changed && deactivate.value.detail.activeCount === 0, deactivate.value ?? text(deactivate))
      const after = await run(a, publicName, {text: 'denied-after'})
      mark('direct call rejected after deactivation', denied(after), text(after))
      const afterMeta = await run(a, 'meta_invoke', {id: publicName, kind: 'tool', args: {text: 'denied-meta-after'}})
      mark('meta_invoke rejected after deactivation', denied(afterMeta), text(afterMeta))
      const marker = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      report.marker = marker
      mark('server receives exactly the two authorized calls', JSON.stringify(marker.map(x => x.text)) === JSON.stringify(['authorized-agent-only', 'authorized-meta-call']), marker)
    } catch (error) {
      report.fatal = String(error?.stack ?? error)
    } finally {
      for (const dispose of disposers.reverse()) { try { await dispose() } catch (error) { (report.cleanupErrors ??= []).push(String(error)) } }
      if (root) await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    }
  })
}
