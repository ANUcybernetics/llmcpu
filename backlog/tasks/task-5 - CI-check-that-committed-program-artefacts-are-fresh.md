---
id: TASK-5
title: CI check that committed program artefacts are fresh
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
labels: []
dependencies: []
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A workflow step that installs clang/lld/llvm-18, runs make in programs/, and fails if main.elf, disasm.txt or lines.json differ from what is committed. Clang version drift may make this noisy; pin the apt package.
<!-- SECTION:DESCRIPTION:END -->
