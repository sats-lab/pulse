# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                                |
| -------------- | -------------------------------------------------------------------- |
| `758587c59a6e` | `build(pi): pin SDK and vendor reference source`                     |
| `cfb6ef469395` | `feat(pi): add SDK-backed provider runtime`                          |
| `463351cdb349` | `feat(providers): add project-scoped composer discovery`             |
| `bc412cdc9b43` | `feat(pi): add mid-turn input and queue mutation`                    |
| `019e7b8d90df` | `fix(web): fold steering messages with settled turn work`            |
| `3d856114c9cb` | `dev: support loopback development behind a public proxy`            |
| `c86537febaaf` | `feat(web): persist desktop sidebar state locally`                   |
| `623c15de0abc` | `docs(pi): record provider integration findings`                     |
| `c43e295a7003` | `ci(release): maintain fork-specific workflows and Pulse publishing` |
| `63933a37d441` | `fix(pi): stream live context usage during turns`                    |
| `391d2ba4f7ff` | `feat(web): persist Sidebar V2 Settled shelf state`                  |
| `77228d9d10ff` | `feat(access): manage remote environment authorization`              |
| `711678de5e02` | `feat(web): select authorized-client environment`                    |
| `635492e102ac` | `dev: expose web development servers remotely by default`            |
| `f4ecee78c7dc` | `build(server): pack an installable Pulse CLI locally`               |
| `2685ec6ee4c2` | `fix(web): restore composer outline and compact editor height`       |
| `d678b4ee1edf` | `feat(pi): expose Pulse preview automation as native tools`          |

The release customization preserves upstream workflow definitions under `.github/workflows_upstream/` while activating only CI and the fork-owned release workflow. Releases intentionally omit nightly automation, relay and hosted-web deployment, Discord announcements, WSL preparation, and Windows/Linux builds. They publish macOS artifacts and the existing `@sats-lab/pulse` npm package.

The published server CLI is renamed from the upstream `t3` command and package to the `pulse` executable in `@sats-lab/pulse`. Release tasks, development package filters, pinned runtimes, self-update detection, and service instructions must continue using that Pulse identity. Internal `@t3tools/*` workspace package names remain unchanged.

The hashes change when the stack is rewritten or rebased. Update this table after syncing with upstream.

## Maintaining Fork Changes

1. Keep each downstream feature or customization in a separate Jujutsu change on top of upstream `main`.
2. Write each change description as its behavioral specification: include context, behavior, invariants, scope, and verification where relevant.
3. Rebase the downstream stack when upstream advances and resolve conflicts one change at a time.
4. After any split, squash, reorder, or rebase, read the rewritten stack with `jj log`, then refresh the hashes and titles in the table above in parent-to-child order.
5. Add new maintained changes to the table and remove entries when a change is dropped or replaced by upstream.
