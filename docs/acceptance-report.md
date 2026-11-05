# Acceptance report — 0.1.8 candidate

Updated: 2026-11-02. Detailed 0.1.7 isolation evidence and limitations: [release-0.1.7/report.md](release-0.1.7/report.md). Version 0.1.8 updates release metadata and documentation only; no runtime source behavior changed.

当前工作区说明（2026-11-05）：N6–N8 未提交源码已重新通过完整本地检查与实际 0.1.8 tarball 隔离 GUI 验收；设置页“调用统计”可加载且 `usage/getSnapshot` HTTP 200。Typert capability 与 usage descriptors 已合并为单一 package mount，避免重复注册。该证据不覆盖生产 profile、真实模型调用、历史回补或完整共存验收；详见 [HANDOFF.md](../HANDOFF.md)。

## 0.1.8 local checks

- Node.js `v24.22.1`, pnpm `11.28.5`; typecheck/unit tests use locked DSH peers `0.2.1-rc.3`.
- `pnpm typecheck` — passed.
- `pnpm test` — 14 files, 203 tests passed.
- `pnpm build` — passed; browser bundle emitted.
- `npm pack --dry-run` — 0.1.8 package metadata and GitHub release notes passed; the 63-file package retains the 0.1.7-verified export targets. See [0.1.7 package evidence](release-0.1.7/evidence/package.json).

The earlier 95 Windows fixture failures were resolved using `node:os` `tmpdir()` and platform-safe joins. No new runtime behavior was added in this acceptance round; the package metadata removes the nonexistent `./src/*` export and README installation/documentation links were corrected.

## 0.1.7 isolated host verification

DSH `0.2.1-rc.5`, an independent scratch `DSH_HOME`, fresh `web` template and actual `0.1.7` tarball were used. Production credentials, Sessions and MCP connections were not copied. Save Token `2.4.1` and MCP Connector `0.2.87` were installed from the local cache.

- Capability tiers, `meta_search`, `meta_invoke`, caller Session preservation and caller Scope denial passed through public APIs using synthetic Agent subjects with real SessionStore entries and per-Agent Scope.
- Disabled direct/meta rejection, duplicate reminder, Step/Tool hard budgets, Agent/Turn isolation and no-progress next-step rejection passed. These tests did not run a model.
- The complete first runtime assertion run had 10 passes and one failure for a 174,389-character Save Token recovery sample. Only Save Token was then retested with a 46,289-character sample: compressed to 25,793 characters and exactly recovered all 46,289 characters in value and display.
- Connector management tools mounted after host readiness; no external MCP server connection was made.
- Edge cold navigation and capability settings had zero captured exceptions; the actual 1440×1000 [screenshot](release-0.1.7/evidence/capability-menu.png) shows all three tiers.
- `capabilityPolicy/getConfig`, `classifyAll` and `catalogVersion` returned HTTP 200 with business `ok:true`.
- Rollback stopped the isolated server, removed the three test packages and restored the initial profile patch. The effective config contains no test entries; the baseline server returns homepage 200 and removed capability API 404.

Structured evidence: [results.json](release-0.1.7/evidence/results.json). Raw logs, profiles and tokens are excluded from the repository.

## Remaining limits — no full production sign-off

- **Large-result cause identified (N8 complete):** Host `dsh-spill-policy` defaults to 12,500 estimated inline tokens. Save Token caches the upstream head/tail preview, so expansion is not necessarily the initial tool output. The fresh 174,389-character sample expanded to 49,933, but its embedded host spill locator recovered the complete file with matching SHA-256. Boundary tests at 49,984/49,985 and an isolated-only 200,000-token override confirmed the cause; the latter restored all 174,389 characters in value, content and Save Token file. See [N8 diagnosis](release-0.1.7/n8-diagnosis.md). Production settings remain unchanged; arbitrary-size/restart recovery is not claimed.
- **Hot reload cause identified (N11 complete):** cold start, isolated profile patch reload and isolated package-manager operations were clean, but the public Web CLI did not emit the Electron Client Modules `rebuilt` replace frame. Source inspection attributes `session-maybe` to the host's serial teardown window and Connector `layout` to its unload path missing a `layout` Cordis inject/using an unsafe fallback. The supported mitigation is cold restart/page refresh; Connector remediation belongs upstream. See [N11 diagnosis](release-0.1.7/n11-diagnosis.md) and [evidence](release-0.1.7/evidence/n11-results.json).
- Real Electron renderer was verified in an independent DSH_HOME/userData. A local synthetic stdio MCP server initialized and synchronized `n9_echo`; Host `toolsList` reported one healthy tool, and Connector accepted `injectionMode=session` with business tools hidden by default. The preserved 1920×1233 [renderer screenshot](release-0.1.7/evidence/n9-electron-renderer.png) remains the visual evidence. A subsequent real Agent run passed all 13 authorization assertions: unauthorized direct and `meta_invoke` calls were rejected; search/preview/activate worked; authorized direct and meta calls reached the server; another Agent was isolated; and deactivation restored both denials. The server marker contained exactly the two authorized calls. No fatal or cleanup errors occurred; the connection was disconnected, no connections remained, the isolated patch was restored to `[]`, and isolated Electron/Host processes were stopped. No model request or production profile change occurred. See [N9 evidence](release-0.1.7/evidence/n9-results.json).
- Local `pnpm typecheck`, all 203 tests, `pnpm build`, and `npm pack --dry-run` passed for 0.1.8. The release updates metadata and documentation only; no runtime source behavior changed.
- GitHub Release `v0.1.8` was created from its matching annotated tag. GitHub Actions API rate limiting prevented confirmation of the CI run; npm was not published by decision.
- No public host Token Saver/Prompt Cache adapter is claimed. Save Token retains compression/original recovery ownership; Guard uses public events and hashes only.
- No dedicated Guard statistics UI was added.

The production manifest already listed this plugin as a local source link and bundle when inspected. The old Capability Menu remains a dependency but is absent from the bundle list. Building this workspace updates the source link's `lib/`; it is not an immutable deployment. See the prepared [production rollout/rollback plan](release-0.1.7/production-rollout.md).
