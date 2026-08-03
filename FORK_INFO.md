# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `d64f4479f6ba` | `build(pi): pin SDK and vendor reference source`                          |
| `ebd0c8c8f11f` | `feat(pi): add SDK-backed provider runtime`                               |
| `a361406efbfa` | `feat(providers): add project-scoped composer discovery`                  |
| `7a92ea7f708c` | `feat(pi): add mid-turn input and queue mutation`                         |
| `a83ac112a736` | `fix(web): fold steering messages with settled turn work`                 |
| `ff633ecd597a` | `dev: support loopback development behind a public proxy`                 |
| `20e325562583` | `feat(web): persist desktop sidebar state locally`                        |
| `61eb57ef8a31` | `docs(pi): record provider integration findings`                          |
| `ca3e4c38b9a0` | `docs(fork): index maintained downstream commits`                         |
| `8b935e0e7cf3` | `ci(release): maintain fork-specific workflows and Pulse publishing`      |
| `3b33805519e1` | `docs(fork): refresh downstream stack index`                              |
| `f1b3d5e6e7c2` | `ci: declare intentionally skipped dependency builds`                     |
| `59d5fa842214` | `chore(release): prepare v0.0.32`                                         |
| `640ada924920` | `fix(pi): stream live context usage during turns`                         |
| `6c8b632aa296` | `feat(web): persist Sidebar V2 Settled shelf state`                       |
| `2a9bc4df1307` | `feat(access): manage remote environment authorization`                   |
| `a86752a246d7` | `feat(web): select authorized-client environment`                         |
| `bd2b77ef1a61` | `dev: expose web development servers remotely by default`                 |
| `a513124784ee` | `build(server): pack an installable Pulse CLI locally`                    |
| `8b7c8cc563e2` | `fix(web): restore composer outline and compact editor height`            |
| `3af06199d8e1` | `feat(pi): expose Pulse preview automation as native tools`               |
| `de539541ac80` | `docs(fork): index split downstream changes`                              |
| `078d1b325c09` | `chore(release): prepare v0.0.33`                                         |
| `9b0bd63f4729` | `ci: use GitHub-hosted runners outside macOS packaging`                   |
| `cc24bc94fd1c` | `feat(mobile): expose Pi mid-turn controls and runtime state`             |
| `9a3aa67c10c0` | `build(mobile): support local Personal Team iOS installs`                 |
| `e05df862d8e3` | `fix(web): align queued input row controls`                               |
| `6622f7e05318` | `docs(build): document local Personal Team mobile workflows`              |
| `22664ecc2ad9` | `docs(fork): index mobile downstream changes`                             |
| `928254da9b95` | `fix(pi): restore live queue, tool, and compaction activity presentation` |
| `4fb7b8975726` | `docs(fork): index Pi activity presentation fix`                          |
| `f306a2647270` | `fix(sync): adapt downstream contracts to upstream architecture`          |
| `3fca0badc297` | `feat(service): brand Pulse unit and persist its port`                    |
| `42d0c24bc161` | `docs(fork): index Pulse service customization`                           |
| `7e6e28928725` | `fix(ci): stabilize checks after service branding`                        |

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
