# llmcpu

A language model as the control unit of a tiny RV32I machine, running in the
browser beside a silicon reference. `README.md` has the layout and the check
commands for both halves; run them with `mise exec --`.

## Constraints

- The machine spec (16 KiB RAM, sp at 0x4000, console at 0x4000, halt at
  0x4004, entry at 0) is shared by `programs/link.ld`, `programs/llmcpu.h`,
  `programs/start.S` and `site/src/lib/rv32i/machine.ts`. Change all of them
  together or none.
- Programs are RV32I only, no M extension and no libc: `*`, `/` and `%` on
  integers emit calls to compiler-rt builtins that do not exist, and the
  Makefile fails the link if any symbol is undefined. Keep dynamic traces short
  (a few hundred instructions), because a browser model executes about one
  instruction per second. Inputs that clang would otherwise fold at compile
  time are `volatile` on purpose.
- The committed `main.elf`, `disasm.txt` and `lines.json` are build outputs:
  regenerate with `make` in `programs/` after touching a source, never edit
  them by hand. `tests/programs.test.ts` cross-checks the decoder against
  `disasm.txt`, so a stale listing fails the suite.
- `STEP_JSON_SCHEMA` in `site/src/lib/llm/ops.ts` must stay flat (no
  `oneOf`/`anyOf`) so every constrained-decoding backend accepts it, and must
  match `OpSchema` field for field.
- The mock backend (`site/src/lib/llm/mock.ts`) is the only model in tests and
  in CI. Anything that changes the prompt or op semantics needs a passing run
  against it before a real model is tried.
- The WebLLM runtime is a 6 MB chunk and is loaded with a dynamic import only
  when a real model is chosen. Keep it out of the initial bundle.
