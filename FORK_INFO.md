# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                                |
| -------------- | -------------------------------------------------------------------- |
| `4a32bb12303a` | `build(pi): pin SDK and vendor reference source`                     |
| `32e55c6e01b8` | `feat(pi): add SDK-backed provider runtime`                          |
| `a3e8a71fe84b` | `feat(providers): add project-scoped composer discovery`             |
| `52c4fd8bb333` | `feat(pi): add mid-turn input and queue mutation`                    |
| `c9bb24ae14cf` | `fix(web): fold steering messages with settled turn work`            |
| `046475dcf68e` | `dev: support loopback development behind a public proxy`            |
| `97812bdb17e5` | `feat(web): persist desktop sidebar state locally`                   |
| `d06fb034da2b` | `docs(pi): record provider integration findings`                     |
| `b2249342d64f` | `docs(fork): index maintained downstream commits`                    |
| `f3b4397c1473` | `ci(release): maintain fork-specific workflows and Pulse publishing` |
| `946e031555f4` | `docs(fork): refresh downstream stack index`                         |
| `6adfc8511250` | `ci: declare intentionally skipped dependency builds`                |
| `522aa3b93b0b` | `chore(release): prepare v0.0.32`                                    |
| `cf8191f80b8b` | `fix(pi): stream live context usage during turns`                    |
| `e3d4045f1850` | `feat(web): persist Sidebar V2 Settled shelf state`                  |
| `3b706c9520a0` | `feat(access): manage remote environment authorization`              |
| `baa7ff0c6f41` | `feat(web): select authorized-client environment`                    |
| `a682ffcd03ed` | `dev: expose web development servers remotely by default`            |
| `c122ccfdff39` | `build(server): pack an installable Pulse CLI locally`               |
| `17be50385491` | `fix(web): restore composer outline and compact editor height`       |
| `c09432253ee2` | `feat(pi): expose Pulse preview automation as native tools`          |
| `defa7433f1a0` | `docs(fork): index split downstream changes`                         |
| `324745ea3523` | `chore(release): prepare v0.0.33`                                    |
| `3d8843084b5c` | `ci: use GitHub-hosted runners outside macOS packaging`              |
| `257209537981` | `feat(mobile): expose Pi mid-turn controls and runtime state`        |
| `4b5441c6d230` | `build(mobile): support local Personal Team iOS installs`            |
| `333a960da47d` | `fix(web): align queued input row controls`                          |
| `7ca458633a71` | `docs(build): document local Personal Team mobile workflows`         |
| `750c6b1c0667` | `docs(fork): index mobile downstream changes`                        |

The release customization preserves upstream workflow definitions under `.github/workflows_upstream/` while activating only CI and the fork-owned release workflow. Releases intentionally omit nightly automation, relay and hosted-web deployment, Discord announcements, WSL preparation, and Windows/Linux builds. They publish macOS artifacts and the existing `@sats-lab/pulse` npm package.

The published server CLI is renamed from the upstream `t3` command and package to the `pulse` executable in `@sats-lab/pulse`. Release tasks, development package filters, pinned runtimes, self-update detection, and service instructions must continue using that Pulse identity. Internal `@t3tools/*` workspace package names remain unchanged.

The hashes change when the stack is rewritten or rebased. Update this table after syncing with upstream.

## Maintaining Fork Changes

1. Keep each downstream feature or customization in a separate Jujutsu change on top of upstream `main`.
2. Write each change description as its behavioral specification: include context, behavior, invariants, scope, and verification where relevant.
3. Rebase the downstream stack when upstream advances and resolve conflicts one change at a time.
4. After any split, squash, reorder, or rebase, read the rewritten stack with `jj log`, then refresh the hashes and titles in the table above in parent-to-child order.
5. Add new maintained changes to the table and remove entries when a change is dropped or replaced by upstream.
