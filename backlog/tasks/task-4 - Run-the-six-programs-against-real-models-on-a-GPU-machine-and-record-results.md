---
id: TASK-4
title: Run the six programs against real models on a GPU machine and record results
status: To Do
assignee: []
created_date: '2026-09-12 04:36'
updated_date: '2026-09-12 10:19'
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

2026-09-12, task-6 redesign: JPEG and random bytes run on Qwen3.5 9B and 2B (q4f32, RTX 6000 Ada, headless Chrome), free reading, default knobs, with the language-design step. 9B on the JPEG: designs a one-byte-per-instruction language with JPEG markers as opcodes, sets flags the machine lacks, prints JFIF from the header, rewrites a byte of the file, loops to the start. 9B on noise: a three-byte bytecode (opcode, register, immediate), declares most instructions invalid for out-of-range registers and does nothing about it. 9B on the poem: print-until-terminator, with runs of hyphens and stalls at a lone newline. 2B on the JPEG: 32-byte instructions, prints the JFIF header repeatedly, refuses to move pc for 27 of 30 instructions. 2B on noise: a hex dump of itself, oscillating between 0 and 4. 2B on the poem: 64-byte instructions, lines out of order, 11 bytes rewritten, 7 pixels. Prompt changes that came out of it: the design asks for rules plus a worked example rather than a story (the first attempt narrated a print subroutine and jumped to 0 looking for it); an unchanged revise is not a revision (2B chants); the shown bytes need no peek; WebLLM context raised to 8 KiB (both models overran 4 KiB by instruction 12 to 15 on binary input). Every run was cut short by a WebLLM GPUBuffer mapAsync error after 19 to 31 instructions; recordings ship as they are. The systematic knob-by-size grid over the RISC-V programs is still to do.
<!-- SECTION:NOTES:END -->
