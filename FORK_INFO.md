# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                                |
| -------------- | -------------------------------------------------------------------- |
| `4a32bb12303a` | `build(pi): pin SDK and vendor reference source`                     |
| `32e55c6e01b8` | `feat(pi): add SDK-backed provider runtime`                          |
| `a3e8a71fe84b` | `feat(providers): add project-scoped composer discovery`             |
| `52c4fd8bb333` | `feat(pi): add mid-turn input and queue mutation`                    |
| `412381718257` | `fix(web): fold steering messages with settled turn work`            |
| `4f3c1f0ea4b2` | `dev: support loopback development behind a public proxy`            |
| `45abdbbd40ea` | `feat(web): persist desktop sidebar state locally`                   |
| `d4a4e658fc34` | `docs(pi): record provider integration findings`                     |
| `33d954e0d92c` | `docs(fork): index maintained downstream commits`                    |
| `ef8308031373` | `ci(release): maintain fork-specific workflows and Pulse publishing` |
| `361fd411d723` | `docs(fork): refresh downstream stack index`                         |
| `e8b0c85e96f2` | `ci: declare intentionally skipped dependency builds`                |
| `0ff34772ab48` | `chore(release): prepare v0.0.32`                                    |
| `774fd9cd188b` | `fix(pi): stream live context usage during turns`                    |
| `9666f95ee5cb` | `feat(web): persist Sidebar V2 Settled shelf state`                  |
| `78a5fb3f4215` | `feat(access): manage remote environment authorization`              |
| `2327b1541077` | `feat(web): select authorized-client environment`                    |
| `63c62ecd279d` | `dev: expose web development servers remotely by default`            |
| `7c3a44974f13` | `build(server): pack an installable Pulse CLI locally`               |
| `f3dcd8b5843e` | `fix(web): restore composer outline and compact editor height`       |
| `a1ef413cb3fb` | `feat(pi): expose Pulse preview automation as native tools`          |
| `a74678406322` | `docs(fork): index split downstream changes`                         |
| `e82f0d8b00e0` | `chore(release): prepare v0.0.33`                                    |
| `1f9e6d6d9862` | `ci: use GitHub-hosted runners outside macOS packaging`              |
| `db292bfe0d70` | `feat(mobile): expose Pi mid-turn controls and runtime state`        |
| `3af5c728ae8a` | `build(mobile): support local Personal Team iOS installs`            |
| `13fea367912b` | `fix(web): align queued input row controls`                          |
| `c5dca06373e8` | `docs(build): document local Personal Team mobile workflows`         |
| `c68139a579a2` | `docs(fork): index mobile downstream changes`                        |

The release customization preserves upstream workflow definitions under `.github/workflows_upstream/` while activating only CI and the fork-owned release workflow. Releases intentionally omit nightly automation, relay and hosted-web deployment, Discord announcements, WSL preparation, and Windows/Linux builds. They publish macOS artifacts and the existing `@sats-lab/pulse` npm package.

The published server CLI is renamed from the upstream `t3` command and package to the `pulse` executable in `@sats-lab/pulse`. Release tasks, development package filters, pinned runtimes, self-update detection, and service instructions must continue using that Pulse identity. Internal `@t3tools/*` workspace package names remain unchanged.

The hashes change when the stack is rewritten or rebased. Update this table after syncing with upstream.

## Maintaining Fork Changes

1. Keep each downstream feature or customization in a separate Jujutsu change on top of upstream `main`.
2. Write each change description as its behavioral specification: include context, behavior, invariants, scope, and verification where relevant.
3. Rebase the downstream stack when upstream advances and resolve conflicts one change at a time.
4. After any split, squash, reorder, or rebase, read the rewritten stack with `jj log`, then refresh the hashes and titles in the table above in parent-to-child order.
5. Add new maintained changes to the table and remove entries when a change is dropped or replaced by upstream.
