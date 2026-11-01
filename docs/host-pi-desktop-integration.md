# Host PI-Desktop integration

## Ownership boundary

`dsh-plugin-save-token` remains the owner of tool-result compression, lossless storage, and `save_token_expand`. This package does not compress, expand, rewrite, or persist complete tool results, user messages, or raw arguments.

The host PI-Desktop / DSH runtime remains the owner of model/provider selection, reasoning effort, complete conversation history, prompt-cache lifecycle, and global context budgets. This package only controls its own DSH profile, Agent, and Turn state.

## Verified local state

The installed Save Token package exposes its compression and usage behavior through its own tool/result pipeline and Web dashboard. No public `ctx` service for a second plugin to call as a Token Saver or Prompt Cache adapter was found in the installed package. Therefore the current integration is an explicit safe fallback:

- do not duplicate Save Token compression;
- do not call private host fields;
- keep capability lists and convergence hints short and stable;
- report host Token Saver / Prompt Cache as host-owned rather than claiming direct integration;
- allow the existing Save Token and DSH host pipeline to process results normally.

If a future PI-Desktop release exposes a documented adapter, add it behind a versioned adapter interface and record the exact version and fallback behavior here before enabling it.

## Prompt and token rules

- The resident prompt projection remains stable when the capability catalog is unchanged.
- `meta_search` returns summaries and pagination instead of the full catalog schema.
- Full detail schema is returned only for the explicitly requested capability.
- The Guard does not add an automatic summary model call.
- Convergence text is short and emitted at most once through the Guard's own state.
- Repeated Skill loads remain deduplicated per Agent by the existing `WeakMap` behavior.

## Observable no-progress loop protection

The Guard never reads or stores hidden reasoning. It uses only observable DSH events:

- normalized tool name and argument signature;
- result fingerprint retained only as a SHA-256 value;
- model step admission;
- tool result completion;
- `agent/turn-stopping` boundaries;
- user-visible cancellation and disposal boundaries.

Default behavior is one convergence steer per Turn. After that steer, two consecutive stop boundaries with no new result or user progress mark the Turn as stopped; the next model step is rejected through the public admission path. A new Turn creates a fresh state. Existing tool calls are not rewritten or interrupted in flight.

The Guard reports a bounded reason such as `Step budget reached`, `Tool budget reached`, `Time budget reached`, or `No-progress loop stopped`. It does not synthesize a final answer or claim task completion.

## Verified upstream result retention (N8)

DSH `0.2.1-rc.5` enables `dsh-spill-policy` with `maxInlineTokens: 12500`. In the tested bundle order, that Host post-execute policy saves the complete formatted result and produces a bounded head/tail preview before Save Token processes the accepted content. `save_token_expand` can therefore return that upstream preview even when its own `truncated` flag is false. This is not a Guard rewrite.

N8 verified the embedded Host spill locator against the full 174,389-character input using SHA-256. Single-text-block boundary tests at 49,984/49,985 matched the Host heuristic; raising only the isolated Host cap to 200,000 also restored the complete value/content/file. Prefer reading the Host locator in bounded ranges under the default policy; the tested raised cap is not a production recommendation. No production settings or third-party code were changed. See [diagnosis and limits](release-0.1.7/n8-diagnosis.md).
