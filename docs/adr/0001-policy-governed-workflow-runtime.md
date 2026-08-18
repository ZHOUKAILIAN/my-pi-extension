# ADR 0001: Use a Policy-Governed Workflow Runtime

- Status: Accepted for prototype, revised after 2026-08-18 multi-model review
- Date: 2026-08-18

## Context

This project represents a working method, not a generic prompt collection. It needs to control how work enters the system, which roles may act in each stage, what evidence can pass between roles, which skills and tools each role can use, and when a task may progress.

A prompt-only approach cannot enforce these constraints. A worker can ignore role instructions, a main agent can bypass a suggested process, and unrestricted skill discovery causes unrelated operating procedures to contaminate a task.

Three controls must remain distinct:

- Skill Routing decides which skills a role may discover and load.
- Context Isolation decides which task materials a worker receives.
- Capability Isolation decides what a worker can actually read, write, or execute.

## Decision

Implement the extension as a Policy-Governed Workflow Runtime.

A versioned Policy is the single source of control for each Workflow Run. It defines stages, allowed roles, state transitions, skill routes, Context Capsule construction, tool allowlists, artifact schemas, budgets, approval requirements, and write modes.

The extension validates and executes Policy. The main agent may request a delegation but cannot independently expand its tools, skill set, or worker context beyond Policy. All non-allowlisted tools fail closed.

Workers receive a minimal Context Capsule and exchange information through versioned Artifacts, not through unrestricted inheritance of the main session. Context is either strict and explicitly injected with `--no-context-files`, or inherited with every loaded context file captured in a manifest and hash. The initial worker runtime is a child Pi CLI process. Skill discovery is constrained with `--no-skills` and explicit, hash-pinned `--skill` paths. Capability isolation is enforced separately through tool allowlists and, where needed, shell wrappers, worktrees, process policy, and containers/OS sandboxes. CLI flags and Pi tool lists are resource controls, not a security sandbox.

## Consequences

Positive:

- The working method is reproducible, inspectable, and auditable.
- Multi-agent design review and code review can have deterministic stage gates.
- Skill use and context handoff become explicit data rather than invisible prompt behavior.
- Future policy changes can be versioned, reviewed, and rolled back.

Costs:

- Policy schema design and validation become core product work.
- Some flexible one-off behavior requires an explicit policy extension or user escalation.
- Pi CLI resource controls alone do not form a security sandbox; filesystem and shell boundaries need separate implementation and validation.
- The initial CLI-worker protocol needs structured-result validation and early JSON/RPC evaluation for tool events, usage and resource manifests.
- Policy, Artifact and trace data must be kept in a worker-unwritable control plane and fixed by digest for each run.

## Alternatives Considered

### Prompt-only orchestration

Rejected. It can guide model behavior but cannot prevent bypassing direct tools, unrelated skill loading, or context oversharing.

### Hard-code all workflow rules in extension TypeScript

Rejected. It couples policy change to code release, makes per-project variation difficult, and obscures the actual process rules from review.

### Use an external agent-team runtime as the control plane

Deferred. It may provide useful capabilities, but its policy, trace, permission, and lifecycle models need evaluation before it can own this project's core control plane.
