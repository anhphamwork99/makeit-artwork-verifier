# Two-repository transaction and safe push

**Type:** research
**Status:** open
**Claimed by:** none
**Blocked by:** 03-agent-autonomy-and-approval-boundaries.md

## Question

Verifier commit, verifier push, FE provider/bridge changes, FE submodule pin,
FE verification và FE push phải được sequence, recorded và recovered như thế
nào để không tạo dangling gitlink, wrong-remote push hoặc split-brain state?

## Expected resolution

Một exact transaction state machine, remote guards, commit order, retry limits,
rollback/recovery states và final success criteria.
