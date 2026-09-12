---
id: TASK-4
title: Run the six programs against real models on a GPU machine and record results
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
updated_date: '2026-09-12 06:22'
labels: []
dependencies: []
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The headless host has no WebGPU adapter, so no real model has been exercised end to end yet. Run each program at each knob setting on a couple of Qwen3.5 sizes, note instructions-until-divergence and whether the console output matched, and fix whatever the prompt gets wrong. Consider persisting runs to a results table on the site.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-12 later: growth framing shipped. Qwen3.5 9B (q4f32) on the Dickinson poem, free reading: takes 16-byte chunks as instructions, prints the poem back with stutters, jumps into the console page and back. 2B invents a bytecode over the poem then stalls. Print op and console page were the harness changes that made the 9B run legible. Systematic runs still to do.
<!-- SECTION:NOTES:END -->
