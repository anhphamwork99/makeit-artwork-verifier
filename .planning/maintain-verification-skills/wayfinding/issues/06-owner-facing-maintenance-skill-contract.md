# Owner-facing maintenance skill contract

**Type:** prototype
**Status:** open
**Claimed by:** none
**Blocked by:** 03-agent-autonomy-and-approval-boundaries.md, 04-two-repository-transaction-and-safe-push.md, 05-verification-gates-and-independent-acceptance.md

## Question

User invocation, progress states, reports, approval prompts, blocked outcomes và
final handoff của `maintain-verification-skills` phải trông như thế nào để PO có
thể hiểu và kiểm soát một maintenance run mà không cần biết CLI/git internals?

## Expected resolution

Một agent-neutral skill UX prototype và machine-readable maintenance result
envelope covering `clean`, `changed`, `blocked`, `bug-found` và `recovery-needed`.
