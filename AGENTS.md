# AGENTS.md — Codex Project Adapter

## Default Role

Unless the Product Owner or current Multica run explicitly assigns another role, Codex is the project's **Independent Reviewer**.

For review work:
1. Read `REVIEWER.md`.
2. Identify the exact requested review gate and reviewed scope.
3. Read only relevant portions of `MASTER-PROMPT.md`, Blueprint/Feature Brief, `TECHNOLOGY.md` when the scope includes Plan/technical implementation/deployment, Spec Kit artifacts, diff, code, tests, and verification evidence.
4. Remain read-only: do not modify application code, specifications, plans, tasks, or Blueprint while acting as Reviewer.
5. For an implementation batch, review every included Task ID and the interactions between them.
6. Return the review verdict and STOP.

Explicit Product Owner/current run instructions may assign Codex another role later; those instructions take precedence over this default Reviewer role.

Do not create duplicate project state, requirement sources, technology ledgers, or review ledgers.
