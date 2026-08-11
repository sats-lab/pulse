# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `c1a781cb9e19` | `build(pi): pin SDK and vendor reference source`                          |
| `9c4b77cc7259` | `feat(pi): add SDK-backed provider runtime`                               |
| `413ab220bef0` | `feat(providers): add project-scoped composer discovery`                  |
| `1d3c748b1b2f` | `feat(pi): add mid-turn input and queue mutation`                         |
| `73752bae400c` | `fix(web): fold steering messages with settled turn work`                 |
| `064b4bcab0c0` | `dev: support loopback development behind a public proxy`                 |
| `fe5894464927` | `feat(web): persist desktop sidebar state locally`                        |
| `2a967bd4ee1e` | `docs(pi): record provider integration findings`                          |
| `48dd8f7403a0` | `ci(release): maintain fork-specific workflows and Pulse publishing`      |
| `176d61ebc889` | `ci: declare intentionally skipped dependency builds`                     |
| `54154111c192` | `fix(pi): stream live context usage during turns`                         |
| `3f6807bd9f97` | `feat(web): persist Sidebar V2 Settled shelf state`                       |
| `c22885d0c628` | `feat(access): manage remote environment authorization`                   |
| `12dde4852eb1` | `feat(web): select authorized-client environment`                         |
| `1f598f3136db` | `dev: expose web development servers remotely by default`                 |
| `0ade2c0006e5` | `build(server): pack an installable Pulse CLI locally`                    |
| `df35526bdb5a` | `fix(web): restore composer outline and compact editor height`            |
| `96628e7d2d5d` | `feat(pi): expose Pulse preview automation as native tools`               |
| `d530f7838aa5` | `ci: use GitHub-hosted runners outside macOS packaging`                   |
| `1bc4313370d1` | `feat(mobile): expose Pi mid-turn controls and runtime state`             |
| `6046300783c0` | `build(mobile): support local Personal Team iOS installs`                 |
| `d7bd26800d93` | `fix(web): align queued input row controls`                               |
| `9e345e34745a` | `docs(build): document local Personal Team mobile workflows`              |
| `d87a18c2cd8b` | `fix(pi): restore live queue, tool, and compaction activity presentation` |
| `426ba58b30dd` | `fix(sync): adapt downstream contracts to upstream architecture`          |
| `f26accaed296` | `feat(service): brand Pulse unit and persist its port`                    |
| `b87a3a1e4cd5` | `fix(ci): stabilize checks after service branding`                        |
| `dc137df14f75` | `feat(service): persist host and pin local runtimes`                      |
| `22834bc3db06` | `fix(sync): adapt fork contracts to latest upstream`                      |
| `1924be5e18cd` | `fix(ci): align Pulse service tests and formatting`                       |

The release customization preserves upstream workflow definitions under `.github/workflows_upstream/` while activating only CI and the fork-owned release workflow. Releases intentionally omit nightly automation, relay and hosted-web deployment, Discord announcements, WSL preparation, and Windows/Linux builds. They publish macOS artifacts and the existing `@sats-lab/pulse` npm package.

The published server CLI is renamed from the upstream `t3` command and package to the `pulse` executable in `@sats-lab/pulse`. Release tasks, development package filters, pinned runtimes, self-update detection, and service instructions must continue using that Pulse identity. Internal `@t3tools/*` workspace package names remain unchanged.

The hashes change when the stack is rewritten or rebased. Update this table after syncing with upstream.

## Maintaining Fork Changes

1. Keep each downstream feature or customization in a separate Jujutsu change on top of upstream `main`.
2. Write each change description as its behavioral specification: include context, behavior, invariants, scope, and verification where relevant.
3. Rebase the downstream stack when upstream advances and resolve conflicts one change at a time.
4. After any split, squash, reorder, or rebase, read the rewritten stack with `jj log`, then refresh the hashes and titles in the table above in parent-to-child order.
5. Add new maintained changes to the table and remove entries when a change is dropped or replaced by upstream.

## Upstream Sync Protocol

A clean rebase, passing typecheck, or resolved textual conflict is not evidence that a downstream behavior survived. Before and after every upstream sync:

1. **Inventory the downstream contracts.** Read this table and the full Jujutsu description for every maintained change being rebased. Treat each description as an acceptance contract: it must state context, behavior, invariants, scope, and focused verification.
2. **Make a behavior matrix before rebasing.** For each affected downstream feature, record its provider/server event, persistence or projection path, web and mobile presentation, and the targeted tests that prove it. Trace cross-layer paths end-to-end rather than treating a feature as local to the file that conflicts.
3. **Rebase one change at a time and review semantics.** For each rewritten change, compare its old parent-to-change diff with the rebased parent-to-change diff. Resolve conflicts to preserve the stated behavior and invariants, not merely to compile.
4. **Test lifecycle boundaries.** Provider-backed features must cover each applicable transition: requested or queued, provider-delivered, started/in-progress, updated, completed, failed, persisted, and rendered. In particular, validate lifecycle correlation so a completion replaces its matching active row instead of duplicating it.
5. **Run focused verification and client smoke checks.** Run the named targeted tests and typechecks for every affected layer. For user-visible web or mobile behavior, perform the required integrated verification with a concrete before/during/after scenario; broad CI remains a backstop, not proof of the fork contract.
6. **Refresh the index only after verification.** Read the final rewritten stack with `jj log`, update the table in parent-to-child order, and include the new hashes/titles. Do not self-reference the documentation-index commit.

For Pi mid-turn activity, the minimum smoke scenario is: submit steer and follow-up input (queue-only before provider delivery, then a turn-associated user echo); run a long tool and confirm its in-progress row appears before completion; and trigger manual and automatic compaction, confirming that each live row is replaced by its corresponding terminal status.
