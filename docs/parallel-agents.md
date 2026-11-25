# Parallel agents operator guide

One write agent owns one branch and one worktree under `.worktrees/<branch>/`. Cap concurrent write worktrees at **3**.

## Mapping

| Layer | Role |
|-------|------|
| Linear team **CAP** | Backlog + status (source of truth). Issues `CAP-N`. |
| Cursor Goal | Agent objective. Text starts with `CAP-N: …`. |
| Git worktree | Isolated writes. Path `.worktrees/feat/cap-<n>-<slug>/` (folder may use hyphens). |

Flow: Linear issue → In Progress → CreateGoal → worktree → PR → merge → Goal complete → Linear Done.

## Isolation rules

- **One write agent ↔ one branch ↔ one worktree**.
- Read-only explore/review agents may share a tree; writers must not.
- Prefer disjoint scopes (different labels / repos) when multiple writers run in parallel.
- Do not run two writers that both change the shared `capgate` policy API in the same wave.

## Create a worktree

From the primary checkout repo root (`master` is default):

```powershell
git fetch origin master
git worktree add .worktrees/feat-cap-N-slug -b feat/cap-N-slug origin/master
```

Confirm isolation: `git-dir` ≠ `git-common-dir`. Prefer `move_agent_to_root` to the worktree; if declined, edit only under that worktree’s absolute path.

## Sibling cloud / OSS

- Cloud worktrees run `scripts/ensure-oss-pin.ps1` so `.worktrees/capgate` junctions to this primary checkout.
- OSS-only issues never edit `capgate-cloud`.

## Finish

1. Push with `-u` and open a PR to `master`.
2. Squash-merge when ready.
3. Remove the tree:

```powershell
git worktree remove .worktrees/feat-cap-N-slug
```

4. Complete the Cursor Goal; set Linear `CAP-N` to Done.

Do not reuse another agent’s branch. Resolve conflicts on the PR — do not edit the other worktree.

## Ponytail skip / risk lines

Weigh writer skip/risk lines after each return. Act in-wave if they threaten correctness, data loss, security, CI, or acceptance; otherwise ignore.
