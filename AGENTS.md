# llmcpu

A computer whose CPU is a language model, in the browser. The default framing is
growth, not deficit: any bytes are a program, the model designs the language
they are in before running them (step zero), and the trace reports what it read,
printed, drew and wrote, where it rewrote itself and where it broke its own
rules. The interesting behaviour is the model going off the rails and ploughing
on, not echo; keep copy, defaults and layout pointed that way. RISC-V programs
and the silicon comparison are one input and one option among others.
`README.md` has the layout, the check commands for both halves and the
real-model and recording recipes; run commands with `mise exec --`.

## Constraints

- The machine spec (16 KiB RAM, sp at 0x4000, console page 0x4000 to 0x40ff,
  halt at 0x4100, display 0x5000 to 0x53ff as 32 by 32 bytes, entry at 0) is
  shared by `programs/link.ld`, `programs/llmcpu.h`, `programs/start.S`,
  `site/src/lib/rv32i/machine.ts`, the system prompt in `prompt.ts` and the
  about page. Change all or none.
- Programs are RV32I only, no M extension, no libc: `*`, `/` and `%` emit calls
  to builtins that do not exist and the Makefile fails the link on any undefined
  symbol. Keep dynamic traces to a few hundred instructions (a browser model
  takes 5 to 30 s per instruction). Inputs clang would fold at compile time are
  `volatile` on purpose.
- `main.elf`, `disasm.txt` and `lines.json` are build outputs: `make` in
  `programs/` after touching a source, never edit them. The test suite
  cross-checks the decoder against `disasm.txt`, so a stale listing fails it,
  and CI rebuilds everything with the pinned Ubuntu 24.04 llvm-18 packages and
  fails on any differing byte, so build with those packages and no other.
- The grammar in `site/src/lib/llm/ops.ts` is one shape per op, fields required,
  and every number admits a hex string. Both were learned the hard way: a flat
  schema let a 2B model put addresses in the wrong field, and an integer-only
  grammar turned every "0x4000" into 0. Keep `OpSchema` (zod) accepting
  everything the grammar can produce.
- `stripThinking` in `webllm.ts` is load-bearing: with thinking off, WebLLM
  still prepends an empty `<think>` block, which breaks JSON parsing.
- The mock backend is the only model in tests and CI. Prompt or op changes need
  a green suite before a real model is tried, and a real-model check before they
  ship (see README).
- Recordings under `site/src/data/recordings` are real runs captured with
  `scripts/record-run.sh`, never edited or synthesised, and the page must always
  say when it is replaying one. Only their `meta` is bundled; keep
  `RecordingMeta` and the replay compatible with the files already shipped, or
  re-record them.
- `LlmStep`, `Delta` and `DesignStep` are the recording format. A change to
  their shape is a change to every shipped recording.
- WebLLM is a 6 MB chunk loaded by dynamic import only when a real model is
  chosen. Keep it out of the initial bundle.
