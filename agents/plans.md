# Plans

Writing a plan and running one. Part of [`AGENTS.md`](../AGENTS.md) — read it first.

## Writing a Plan — and running one

**Two different jobs, two different files. Do not confuse them.**

> **Writing a plan → read [`CREATING_A_PLAN.md`](../CREATING_A_PLAN.md) first.**
> A multi-phase feature breakdown, a multi-agent dispatch, or anything that lands
> under `docs/plans/`. It is the **authoring** authority; a plan under
> `docs/plans/<feature-slug>/` is one instance of it.
>
> It owns: where plan files live and why they never merge (`git rm -r docs` is
> the last commit before the PR), the orchestrator/reviewer/worker topology and
> their prompt templates, the dispatch mechanics (workers `sonnet`, reviewer and
> orchestrator `opus`, named on **every** spawn), the mandatory skills, the task
> spec, the **refinement waves** (§5.3), the gate command, the ledger format, and
> the plan's definition of done.
>
> **A drafted plan is not a runnable plan** (`CREATING_A_PLAN.md` §5.3). Two
> further Opus roles refine it, per wave, before anything is dispatched — the
> **Loopholes and Details Fixer** (ambiguity, goal reachability, disjointness,
> and every `Signatures` / `Test first` claim verified against the actual tree)
> and the **Tasks Optimizer and Resource Finder**, which is the plan's **TDD and
> DRY** specialist: it enforces that each task's test work is ordered *before*
> its implementation in the task's own text, and that every task names the
> existing component, helper, table or service it reuses rather than growing a
> sibling. Cycle is A → apply → B → apply → A again → `ready`. Both roles are
> **read-and-report and never edit a file** — the plan is single-writer, like the
> ledger.
>
> **Refinement passes are human-triggered and agent-requested**, exactly like
> execution waves. The authoring agent stops after each draft or application and
> **asks** for the next pass by name and scope; it never chains A → B → A on its
> own, and `READY` means *runnable*, never *run it*. The plan carries a
> refinement status table mirrored into `progress.md`, and **no wave is
> dispatchable while its row reads anything but `ready`.**

> **Running a plan → read the plan, and nothing else.**
> **Every plan in this repo is self-contained by construction**
> (`CREATING_A_PLAN.md` §5.2): it ends with an **execution appendix** carrying all
> five role prompt templates verbatim — the three execution roles and the two
> refinement roles — plus the dispatch mechanics, the gate, the review loop, the
> commit-and-push policy, the skills table and the static-analysis rule.
> An orchestrator that has never opened `CREATING_A_PLAN.md` can run it.
>
> **Do not send an executing agent to `CREATING_A_PLAN.md`.** It is ~800 lines of
> guidance about a job that is already finished, and it invites re-deriving
> decisions the plan has already made and recorded. If something needed to execute
> is missing from the plan, that is a **bug in the plan** — fix it there. The only
> agent that opens the authoring file after authoring is one whose task is to edit
> it.
>
> A plan's three files — `plan.md`, `progress.md`, `jira-tickets.md` — are one
> document in three projections (specification · ledger · external contract). All
> three are read before dispatch, and a change to one propagates to all three;
> `docs/` is gitignored, so no diff or CI will ever catch a divergence.
>
> Two standing rules from it that bind work outside a plan too:
> **static analysis runs through the *SonarQube for IDE* (SonarLint) VS Code
> extension** — its `<ide_diagnostics>` arrive on their own after every
> `Edit`/`Write` and are fixed, not filed; never invoke `sonar-analyze`, the
> `mcp__sonarqube__*` tools, or the `sonar` CLI (§3.1). And the IDE analyser
> does **no taint analysis**, so on subprocess, filesystem, and webview
> surfaces a manual security trace is the only check that exists.

---
