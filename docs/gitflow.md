# GitFlow Rules - @primebrick/dal

This repository follows GitFlow. AI agents MUST follow these rules.

## ⚠️ CRITICAL: COMMIT ⇒ PUSH — origin always aligned

Every commit MUST be pushed immediately. A commit that stays local serves
no one — `git push` is part of the commit, not a separate decision.
The commit cadence itself lives in `docs/ai/commit-verification.md`;
this section adds the mandatory push half.

## ⚠️ CRITICAL: Governed branch lifecycle — `tools/gitflow.ts`

Closing a `feature/*`, `release/*` or `hotfix/*` branch via raw
`git merge` / `git branch -d` / `git push --delete` is FORBIDDEN.
The only path is the canonical tool (same pattern as check-standards):

    bun ../primebrick-v3-sdk/tools/gitflow.ts finish [name]

which merges `--no-ff` into the base, pushes the base, deletes the
branch locally AND on origin, then audits the final state.


**On the `git flow` binary** (AVH edition 1.12.3, installed in `~/bin`
— upstream nvie 0.4.2 fast-forwards feature finishes; AVH defaults to
`--no-ff` for multi-commit features but still fast-forwards single-commit
ones, so every repo carries `gitflow.feature.finish.no-ff=true` plus the
standard config: master→main, develop, prefixes, no version-tag).
`git flow` is then fine for `feature start`/`publish`/`track` —
but closing stays ONLY via the governed tool: native `finish` neither
pushes the base nor deletes the remote branch nor audits.

## ⚠️ CRITICAL: One open work branch — never orphans

At most ONE branch across `feature/*`, `release/*`, `hotfix/*` may be
open at a time (zero is the cleanest state: `/main` + `/develop` only).
Before starting or closing work — and at every session start — run:

    bun ../primebrick-v3-sdk/tools/gitflow.ts audit

- An open branch fully merged into its base is an **ORPHAN** (landed,
  never closed) — a STOP condition: report and ask the user.
- An unexpected open work branch is the same class of anomaly — STOP,
  notify, ask. Never resolve silently.
- Release/Hotfix follow the same law: one open at a time, closed via
  `gitflow finish` (merge to main, tag, back-merge to develop, delete
  local + remote).
- Origin must carry only `main`, `develop` and the one open branch.

**Bases are merge-only — nobody commits on `main` or `develop`,
ever** (no fixes, no docs, no regen output, no exceptions). All work
lands through a work branch. Consequently an open work branch MUST
contain every commit of its base: `audit` fails with `STALE BASE`
when the base moved while a work branch is open — that is proof of a
violation (a direct base commit or an illicit close), not drift to
tolerate. STOP and report; resync only by merging the base into the
work branch once the violation is explained.
## Branch Creation Rules

- **NEVER work directly on `develop` or `main`** - always create feature branches first
- **Feature branches**: `git checkout -b feature/<slug>` from updated `develop`
- **Release branches**: `git checkout -b release/<version>` from `develop` (for version bumps)
- **Hotfix branches**: `git checkout -b hotfix/<version>` from `main` (for production fixes)

## When to ask user permission

- **ASK before creating NEW feature branch** if another feature branch is already open
- **DO NOT ask permission** to commit changes on existing feature branch
- **DO NOT ask permission** to close a feature branch (follow proper closing procedure)

## Branch Closing Procedure (MANDATORY)

When closing ANY branch (`feature/*`, `release/*`, `hotfix/*`):

1. **Merge to appropriate base branch**:
   - Feature: `git merge --no-ff feature/<branch>` into `develop`
   - Release: `git merge --no-ff release/<version>` into `main`
   - Hotfix: `git merge --no-ff hotfix/<version>` into `main`

2. **Push the merged base branch**: `git push origin <base-branch>`

3. **Delete branch LOCALLY**: `git branch -d <branch-name>`

4. **Delete branch on ORIGIN**: `git push origin --delete <branch-name>`

5. **For Release/Hotfix**: Also merge `main` back to `develop` to stay aligned

## CRITICAL: Version Bump MUST Be Committed Before Merge

**The `package.json` version MUST be updated and committed on the `release/` or `hotfix/` branch BEFORE merging to `main`.**

This ensures the source code at the git tag has the correct `package.json` version. CI does NOT infer the version from the tag — it reads it from the committed `package.json`.

**Correct release flow:**
1. `git checkout -b release/0.2.0` from `develop`
2. `pnpm run version:auto` → `version-sync.mjs` updates `package.json` to `0.2.0`
3. `git add package.json && git commit -m "bump version to 0.2.0"` ← **VERSION IS COMMITTED**
4. (optional final fixes on the release branch)
5. `git checkout main && git merge --no-ff release/0.2.0` → version bump IS part of merge
6. `git tag 0.2.0` → source code at tag HAS `package.json` version `0.2.0`
7. `git push origin main --tags`
8. CI triggers on tag → `package.json` already has `0.2.0` → build → publish

The `prebuild` hook (`node scripts/version-sync.mjs`) is a **safety net** — it runs during `pnpm run build` and will update `package.json` if the version doesn't match the branch. But the canonical flow is: run `version:auto` manually, commit the result, merge.

## CRITICAL: Automated Package.json Version Sync

**The version in `package.json` is automatically managed by the `version-sync.mjs` script.**

The script runs automatically as a `prebuild` hook and:
- Detects the branch type (`release/` or `hotfix/`)
- Calculates the expected version from the latest git tag
- Validates that the branch name matches the expected version
- Automatically updates `package.json` to the correct version if needed

**Note:** The script exits early on `HEAD` (detached HEAD in CI) — it cannot infer the version from a tag checkout. The version MUST be committed on the release/hotfix branch before merging.

## Version Tagging Rules

- **NO 'v' prefix** in branch names: `release/0.13.2` (not `release/v0.13.2`)
- **NO 'v' prefix** in tags: `0.13.2` (not `v0.13.2`)
- **Tag derived from branch name**: `release/0.13.2` → tag `0.13.2`
- **Hotfix increments PATCH**: `0.13.1` → `hotfix/0.13.2` → tag `0.13.2`
- **Release increments MINOR**: `0.13.2` → `release/0.14.0` → tag `0.14.0`

## Common Mistakes to Avoid

- ❌ Committing directly on `develop` or `main`
- ❌ Creating commits before creating feature branch
- ❌ Forgetting to delete branches (both local and origin)
- ❌ Using 'v' prefix in tags
- ❌ Not pushing merged base branch
- ❌ Leaving feature branches open after merge
- ❌ NOT committing the version bump on release/hotfix branch before merge to main

## Commit rules

- NEVER commit automatically - wait for explicit user instruction
- DO NOT ask user to approve commit messages
- Write appropriate commit messages directly when instructed
- DO NOT open editor for commit approval

## New task workflow

When the user starts a fresh piece of work with phrases such as "Let's start a new task", "Iniziamo un nuovo task", or equivalent:

1. Infer a branch slug from context — lowercase, kebab-case, ASCII letters/digits/hyphens only
2. Before the first tracked-file change, ensure a branch `feature/<slug>` exists from up-to-date `develop`
3. State the slug once (e.g. "Branch: `feature/iana-timezone`") so the user can rename if needed
