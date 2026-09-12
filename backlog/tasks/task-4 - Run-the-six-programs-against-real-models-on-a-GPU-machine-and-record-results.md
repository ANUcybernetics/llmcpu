---
id: TASK-4
title: Run the six programs against real models on a GPU machine and record results
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
updated_date: '2026-09-12 05:11'
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
2026-09-12: exercised on weddle (RTX 6000 Ada) via agent-browser with Vulkan flags; recipe in README. Qwen3.5 0.8B and 2B both load (f32 builds, no shader-f16). Fixed in the harness: WebLLM's empty <think> prefix broke JSON parsing; a flat op schema let the model put addresses in the wrong field; an integer-only grammar turned every hex value into 0. After those, 2B moves pc and uses the tools with real values but still misexecutes auipc (sets sp to 4) and bounces between the first three instructions with the decoded-instruction knob on. Still to do: the systematic runs across programs, knobs and sizes.
<!-- SECTION:NOTES:END -->
