# Fork Information

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The following downstream commits are maintained on top of upstream `main`:

| Commit         | Title                                                     |
| -------------- | --------------------------------------------------------- |
| `758587c59a6e` | `build(pi): pin SDK and vendor reference source`          |
| `cfb6ef469395` | `feat(pi): add SDK-backed provider runtime`               |
| `463351cdb349` | `feat(providers): add project-scoped composer discovery`  |
| `bc412cdc9b43` | `feat(pi): add mid-turn input and queue mutation`         |
| `019e7b8d90df` | `fix(web): fold steering messages with settled turn work` |
| `3d856114c9cb` | `dev: support loopback development behind a public proxy` |
| `c86537febaaf` | `feat(web): persist desktop sidebar state locally`        |
| `623c15de0abc` | `docs(pi): record provider integration findings`          |

The hashes change when the stack is rewritten or rebased. Update this table after syncing with upstream.

## Maintaining Fork Changes

1. Keep each downstream feature or customization in a separate Jujutsu change on top of upstream `main`.
2. Write each change description as its behavioral specification: include context, behavior, invariants, scope, and verification where relevant.
3. Rebase the downstream stack when upstream advances and resolve conflicts one change at a time.
4. After any split, squash, reorder, or rebase, read the rewritten stack with `jj log`, then refresh the hashes and titles in the table above in parent-to-child order.
5. Add new maintained changes to the table and remove entries when a change is dropped or replaced by upstream.

The `docs(fork)` change containing this file is intentionally omitted from the table because embedding its own commit hash would rewrite that hash again.
