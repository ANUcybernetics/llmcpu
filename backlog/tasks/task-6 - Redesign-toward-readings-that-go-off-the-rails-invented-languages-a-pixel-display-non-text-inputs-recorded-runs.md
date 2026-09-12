---
id: TASK-6
title: >-
  Redesign toward readings that go off the rails: invented languages, a pixel
  display, non-text inputs, recorded runs
status: Done
assignee: []
created_date: '2026-09-12 06:48'
updated_date: '2026-09-12 12:49'
labels: []
dependencies: []
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The growth framing shipped (any bytes are a program, the model decides what an instruction is), but the result it produces most readily is the least interesting one: a model reading text as "print this text", i.e. an LLM echoing a poem. The stutters, the wander into the console page, and the 2B model overwriting the poem with a bytecode of its own are where the life is, and they are incidental. This task is the redesign that makes the weird, deep behaviour the main event rather than a side effect. Nothing here is faked: every trace shown on the site must be a real run of a real model, recorded and labelled as such.

Direction, in order of leverage:

1. The model must commit to a language before it runs anything. Step zero is a design step: given the first chunk of memory (say 64 bytes, with the text rendering), the model writes down how it reads this input: what an instruction is, how long instructions are, what the pieces mean, what the registers and memory are for. That text goes in the scratchpad note, is shown back on every step, and is rendered on the page as a first-class artefact ("the language the model decided this poem is written in"). Consistency then becomes checkable: the same bytes should produce the same reading, and the trace can flag when they do not. Consider letting the model revise its language mid-run, but make revisions visible as events.

2. Give the machine an output where echo is not available: a memory-mapped pixel display (e.g. 32 by 32 monochrome or 4-bit palette at a fixed page, drawn live on the page). Printing stays, but the question becomes "what does the poem draw?", and the artefact is a picture a lay person reads in one glance. Add one RISC-V program that draws (a Mandelbrot or a line), so the silicon comparison has a visual version too. Machine map change: keep the coupled files in sync (link.ld, llmcpu.h, start.S, machine.ts, prompt, about page).

3. Run the inputs that cannot be echoed. The JPEG and the random bytes have never been run against a real model. Run them on Qwen3.5 9B and 2B (recipe in README) and let what happens shape the prompt. Add a couple more non-text inputs with structure: a small ELF for x86-64 (foreign code, see task-3), a MIDI file, a font, a gzip stream.

4. Surface self-modification. The 2B overwrote the poem with its own bytecode; that is a program rewriting itself as it is read and should be a headline measure ("the program has rewritten 40 bytes of itself"), highlighted in the text and memory panes, with a diff against the original image available.

5. Chunking should be the model's decision, not an artefact of the echo. Today it takes sixteen bytes because it is shown sixteen. Show more context (a line or 64 bytes) and make the instruction boundary something the model states in its language design. Watch how chunking changes with input type.

6. Recorded runs, clearly labelled. A run is a trace (JSON). Record the best 9B runs of the poem, the JPEG and noise on weddle, ship them as static data, and let visitors replay them in the same interface with no model loaded, at their own pace, with the model's rounds and reasoning intact. Label every recording with model, knobs, date and hardware, and make "this is a recording" impossible to miss. This is what makes the page interesting on a laptop without a GPU; the live model is the bonus for those with hardware.

Out of scope for this task: a Prompt API backend (task-2), the in-browser assembler (task-1), the CI freshness check (task-5). The systematic knob/size runs (task-4) fold into item 3 here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Step zero produces a language design that is displayed on the page and echoed to the model on every step; the trace flags inconsistent readings of identical bytes
- [x] #2 A memory-mapped pixel display is part of the machine, drawn live, with at least one RISC-V program that draws on it and the map kept in sync across programs/ and site/
- [x] #3 The JPEG and random-bytes inputs have been run on 9B and 2B and the prompt has been revised in light of what happened, with notes on task-4
- [x] #4 Self-modification is a visible measure with highlighted bytes and a diff against the original image
- [x] #5 At least three recorded 9B runs ship as static data and replay in the interface without a model, each labelled with model, knobs, date and hardware, and never presented as live
- [x] #6 Landing and about copy describe the language-design step and the display; CLAUDE.md constraints updated for the new map
<!-- AC:END -->
