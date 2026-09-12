---
id: TASK-1
title: In-browser RV32I assembler for an editable program pane
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
labels: []
dependencies: []
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Godbolt feature deferred from v1: a small RV32I assembler in TypeScript (labels, the standard pseudo-instructions) so visitors can write their own program in the source pane and run it on both tracks without a C toolchain.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Assembly text round-trips through the existing decoder and formatCanonical
- [ ] #2 Errors point at the offending line
<!-- AC:END -->
