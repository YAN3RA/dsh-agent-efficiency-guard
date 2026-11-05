# DSH host integration boundary

## Ownership boundary

`dsh-plugin-save-token` remains the owner of tool-result compression, lossless storage, and `save_token_expand`. This package does not compress, expand, rewrite, or persist complete tool results, user messages, or raw arguments.

The DSH host runtime remains the owner of model/provider selection, reasoning effort, complete conversation history, prompt-cache lifecycle, and global context budgets. This package uses DSH plugin APIs and only controls its own DSH Agent / Turn state; it does not integrate with standalone PI-Desktop.

## Verified local state

The installed Save Token package exposes its compression and usage behavior through its own tool/result pipeline and Web dashboard. No public `ctx` service for a second plugin to call as a Token Saver or Prompt Cache adapter was found in the installed package. Therefore the current integration is an explicit safe fallback:

- do not duplicate Save Token compression;
- do not call private host fields;
- keep capability lists and duplicate-call reminders short and stable;
- report host Token Saver / Prompt Cache as host-owned rather than claiming direct integration;
- allow the existing Save Token and DSH host pipeline to process results normally.

If a future DSH release exposes a documented host adapter, add it behind a versioned adapter interface and record the exact version and fallback behavior here before enabling it.

## Prompt and token rules

- The resident prompt projection remains stable when the capability catalog is unchanged.
- `meta_search` returns summaries and pagination instead of the full catalog schema.
- Full detail schema is returned only for the explicitly requested capability.
- The Guard does not add an automatic summary model call.
- Exact duplicate-call reminders are emitted at most once per Agent/Turn when duplicate detection is enabled and its threshold is reached.
- Repeated Skill loads remain deduplicated per Agent by the existing `WeakMap` behavior.

## Current Guard behavior after N7

The Guard never reads or stores hidden reasoning. Its Host adapter uses public DSH `agent/pre-step`, `tools/result`, `agent/disposed`, and `ctx.tools.guard()` APIs. State is isolated per Agent/Turn; the loop history is bounded to 16 outcomes, warning and pending-denial sets are bounded, and only SHA-256 tool/result/error fingerprints are retained. Raw arguments and results are not persisted.

Step, tool-count, and duration thresholds do not reject calls or steps and do not emit convergence steers. Legacy `stepLimitMode: hard-stop`, `duplicateHardBlock: true`, and `hostIntegration` loop controls are compatibility-only and deprecated. When `duplicateDetection` is enabled, consecutive repeats warn at 3/5/8 and unchanged alternating cycles warn. Only after matching operation and result/error fingerprint evidence meets the policy does the guard deny one subsequent matching call; that signature is denied at most once per turn. Other calls and the rest of the Turn continue. No whole-turn stop, automatic summary call, synthesized final answer, or claim of task completion is performed.

N7 loop detection is integrated into the Host adapter and covered by focused regression tests. Production Host loading/runtime acceptance is separate; the generated `lib/` package must be rebuilt before a Host loading that output can use these changes.

## Verified upstream result retention (N8)

DSH `0.2.1-rc.5` enables `dsh-spill-policy` with `maxInlineTokens: 12500`. In the tested bundle order, that Host post-execute policy saves the complete formatted result and produces a bounded head/tail preview before Save Token processes the accepted content. `save_token_expand` can therefore return that upstream preview even when its own `truncated` flag is false. This is not a Guard rewrite.

N8 verified the embedded Host spill locator against the full 174,389-character input using SHA-256. Single-text-block boundary tests at 49,984/49,985 matched the Host heuristic; raising only the isolated Host cap to 200,000 also restored the complete value/content/file. Prefer reading the Host locator in bounded ranges under the default policy; the tested raised cap is not a production recommendation. No production settings or third-party code were changed. See [diagnosis and limits](release-0.1.7/n8-diagnosis.md).
