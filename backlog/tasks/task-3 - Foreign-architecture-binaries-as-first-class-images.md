---
id: TASK-3
title: Foreign-architecture binaries as first-class images
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
labels: []
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Load ELF64 and non-RISC-V ELF segments into memory (rather than the raw file bytes) so an x86 or ARM binary's actual code is what the model sees. The conceit is watching the control unit plough through code from another architecture; today those files load raw, header and all.
<!-- SECTION:DESCRIPTION:END -->
