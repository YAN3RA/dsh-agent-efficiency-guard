/**
 * Minimal native tool executor for tests.
 *
 * 0.2.2 moved both prompt assembly and batch execution behind a mounted
 * `ToolExecutor`: `ToolsService` registers a `systemPrompt.tools()` provider
 * that calls `selectExecutor(scope).describe(...)`, and `execute()` delegates to
 * the selected executor
 * (`@deepseek-ai/dsh-tools/lib/index.js`, `ToolsService` constructor + `execute`).
 * Without one, `systemPrompt.assemble()` and `ctx.tools.execute()` both throw
 * `ToolExecutorUnavailableError` — which is exactly what a composition without
 * an executor should do.
 *
 * This stub is the official pattern, not a mock of internals: it implements the
 * published `ToolExecutor` contract (`lib/types/executor.d.ts`) with the shared
 * `ToolExecutionPipeline` + `executeToolBatch` from
 * `@deepseek-ai/dsh-tools/pipeline`, so tests keep exercising the real
 * pre-execute → guards → execute → post-execute → result chain, including the
 * policy's Disabled hard deny.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolBatchInput, ToolBatchResult, ToolDefinition, ToolExecutor, ToolModelInput } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

/** Executor that exposes every visible definition directly (native mode). */
export class TestNativeExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline

  constructor(ctx: Context) {
    this.pipeline = new ToolExecutionPipeline(ctx)
  }

  /** Mirror `projectToolSchema`: only model-facing fields, `deferLoading` preserved. */
  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return {
      schemas: tools.map(({ name, description, parameters, deferLoading }) => ({
        name,
        description,
        parameters,
        ...deferLoading === true ? { deferLoading } : {},
      })),
      knownNames: tools.map(tool => tool.name),
    }
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    // Serial execution keeps assertions deterministic; the scheduler itself is
    // covered by the upstream package.
    return executeToolBatch(input, this.pipeline, () => 1)
  }
}

/** Mount the stub executor as the deployment-default provider. */
export function mountTestExecutor(ctx: Context): TestNativeExecutor {
  const executor = new TestNativeExecutor(ctx)
  ctx.tools.setExecutor(executor)
  return executor
}

/** One raw model call in the batch contract's shape (`arguments` is JSON text). */
export interface RawToolCall {
  readonly name: string
  readonly arguments?: unknown
  readonly callId?: string
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

/**
 * Run one call through `ctx.tools.execute` and return its settled result.
 *
 * 0.2.2 replaced the single-call entry point with a batch contract, so a test
 * that wants "run this one tool" now has to build a `ToolCallBlock` batch and
 * pick the matching result out of `ToolBatchResult.results`.
 */
export async function runOneToolCall(
  ctx: Context,
  call: RawToolCall,
): Promise<ToolExecutionResult> {
  const callId = ToolCallId(call.callId ?? `call-${call.name}`)
  const batch = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: callId,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    }],
    signal: call.signal ?? new AbortController().signal,
    ...call.agent === undefined ? {} : { agent: call.agent as never },
  })
  const settled = batch.results.find(entry => entry.callId === callId)
  if (settled === undefined) throw new Error(`no result settled for tool "${call.name}"`)
  return settled.result
}
