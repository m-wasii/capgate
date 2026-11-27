# Parallel agents operator guide

One write agent owns one branch and one worktree under `.worktrees/<branch>/`. Scale to **8 agent slots** per wave, of which at most **5** are concurrent write worktrees. The rest are read-only reviewers or no-code work (interviews, ADRs, docs).

Slot count is a ceiling, not a target. A wave with one writer runs one writer.

## Slot budget

| Slots | Kind | Rule |
|-------|------|------|
| 8 | total | ceiling per wave — never pad to fill it |
| 5 | write agents | one branch + one worktree each |
| 3 | remaining | no-code (docs, ADRs, validation) or read-only review |

**Single-writer files.** One writer per wave, no matter how many slots are free:

- `capgate/src/policy.ts`, `src/gate.ts`, `src/client.ts` — the shared policy contract, touched from both repos
- `capgate-cloud/lib/store.ts`
- `capgate-cloud/app/dashboard.tsx` — until the split merges; afterwards one writer per `app/components/*` panel

## Mapping

| Layer | Role |
|-------|------|
| Linear team **CAP** | Backlog + status (source of truth). Issues `CAP-N`. |
| Cursor Goal | Agent objective. Text starts with `CAP-N: …`. |
| Git worktree | Isolated writes. Path `.worktrees/feat/cap-<n>-<slug>/` (folder may use hyphens). |
| GitHub PR title | `CAP-N: <Linear issue title>` — must match Linear (enables auto-link / status sync). |

Flow: Linear issue → In Progress → CreateGoal → worktree → PR → merge → Goal complete → Linear Done.

## Isolation rules

- **One write agent ↔ one branch ↔ one worktree**.
- Read-only explore/review agents may share a tree; writers must not.
- Prefer disjoint scopes (different labels / repos) when multiple writers run in parallel.
- Do not run two writers that both change the shared `capgate` policy API in the same wave.
- Slot assignments and per-wave file ownership live in the Linear doc *CapGate — 8-agent wave plan and file-ownership map*.

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
2. Set the PR title to the Linear issue verbatim:

   ```text
   CAP-11: Ops: prod smoke script (API dogfood gate)
   ```

   Use the same `CAP-N` as the branch and Cursor Goal; copy the title from Linear (do not paraphrase).

   ```powershell
   gh pr create --title "CAP-11: Ops: prod smoke script (API dogfood gate)" --body "..."
   ```

3. Squash-merge when ready.
4. Remove the tree:

```powershell
git worktree remove .worktrees/feat-cap-N-slug
```

5. Complete the Cursor Goal; set Linear `CAP-N` to Done.

Do not reuse another agent’s branch. Resolve conflicts on the PR — do not edit the other worktree.

## Ponytail skip / risk lines

Weigh writer skip/risk lines after each return (and before the writer ends the turn). Auto-address if necessary — do not wait for the user to quote them. Act in-wave if they threaten correctness, data loss, security, CI, or acceptance; otherwise leave the skip.
