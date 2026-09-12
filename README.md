# llmcpu

A computer whose CPU is a language model. The model is handed the bytes at the
program counter and a few tools (read and write memory, read and write
registers, one piece of 32-bit arithmetic, move the program counter) and runs
whatever is in memory: a poem, a photograph, noise, or a real RISC-V program. By
default it is told nothing about what an instruction is; it chooses how many
bytes to take and what they mean. For RISC-V programs a silicon RV32I
interpreter can run alongside in lockstep to show where the model's reading
parts from the official one.

Everything runs in the browser: the model through
[WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU, the machine in
TypeScript. There is no server. Live at
<https://anucybernetics.github.io/llmcpu/>.

Two halves:

- **`programs/`**: small bare-metal C programs compiled with clang for the
  machine (RV32I, 16 KiB, a memory-mapped console page and halt port). The ELFs,
  objdump listings and DWARF line tables are committed, so the site build needs
  no cross-compiler. `programs/README.md` has the machine spec and build notes.
- **`site/`**: the Astro static site. `site/src/lib/rv32i` is the machine
  (decoder, executor, ELF loader, any-bytes images), `site/src/lib/llm` is the
  model side (micro-op schema, prompt builder, runner, lockstep comparator,
  reading measures, WebLLM and mock backends), `site/src/lib/inputs.ts` is the
  gallery (texts and images under `site/src/data/inputs`, plus the programs),
  `site/src/app` is the page.

## Working on it

Toolchain comes from `mise.toml` (node, pnpm, uv); the programs additionally
need Ubuntu 24.04's `clang-18`, `lld-18` and `llvm-18` packages, which CI
rebuilds with to check the committed artefacts are fresh.

```sh
cd site
mise exec -- pnpm install
mise exec -- pnpm run dev          # http://localhost:4321/llmcpu/
mise exec -- pnpm run typecheck
mise exec -- pnpm run lint && mise exec -- pnpm run lint:css
mise exec -- pnpm run format:check
mise exec -- pnpm run test         # decoder vs objdump, every program to halt, runner + lockstep
mise exec -- pnpm run build

cd ../programs
make                               # rebuild every program's .elf, disasm.txt and lines.json
```

The "perfect oracle" entry in the model dropdown is the silicon CPU answering in
the model's place. It needs no download or GPU and is the quickest way to see
the machinery work, including in tests and on machines without WebGPU.

### Trying a real model from the command line

Headless Chrome gets no WebGPU adapter by default. On a Linux box with an NVIDIA
card and the Vulkan ICD installed, `agent-browser` can reach it:

```sh
cd site && mise exec -- pnpm run build && mise exec -- pnpm exec astro preview --port 4321 &
export AGENT_BROWSER_SESSION=gpu
agent-browser --args "--no-sandbox,--enable-unsafe-webgpu,--ignore-gpu-blocklist,--enable-features=Vulkan,--use-vulkan=native,--use-angle=vulkan" \
  open http://localhost:4321/llmcpu/
agent-browser select "#model" "Qwen3.5-2B" && agent-browser click "#load-model"   # ~1 min first time, cached after
agent-browser click "#step"                     # then read #status, #latest, #trace
```

The adapter reports no `shader-f16`, so the page picks the q4f32 model builds
there. Once a model is loaded,
`window.llmcpu.backend.complete(messages, { jsonSchema, maxTokens, temperature })`
in the page console calls it directly, which is the fastest way to try a schema
or prompt change.

## How a step works

1. Step zero, in the free reading: the model is shown the first 64 bytes of
   memory and designs the language they are in (a JSON-constrained reply: name,
   what an instruction is, what its pieces mean, what registers and memory are
   for, what gets printed or drawn). The design is echoed to it on every step
   and shown on the page; a `revise` op changes one part of it out loud.
2. The prompt carries the machine state (how much is a knob), 64 bytes from pc
   in the free reading, the model's own recent trace, its language and its
   scratchpad note. The reading knob decides what it is told about instructions:
   nothing (the default), or RISC-V with raw words, a manual, or each
   instruction decoded for it.
3. The model replies with JSON, constrained to a schema: a one-sentence comment
   and a list of ops.
4. Ops are applied in order. Ops that return information (`peek`, `load`,
   `get_reg`, `alu`, `disasm`) pause the list and the model is asked again with
   the results. `set_pc` commits the instruction.
5. In the free reading the runner insists on two things: an instruction must do
   something besides moving pc, and pc must move. The trace reports what was
   read, printed, drawn and written, flags an instruction whose bytes were read
   before with a different effect, and counts the bytes of the program the model
   has rewritten. With a RISC-V program and the silicon comparison on, silicon
   executes one instruction per model step and the two machines are compared
   register by register, byte by byte, pixel by pixel.

## Recordings

`site/src/data/recordings/*.json` are complete traces of real runs (image,
knobs, design step, every step with its rounds and delta, who ran it where and
when), replayed through the same page with no model loaded. They are never
edited. To make one, build and preview the site, open the GPU-enabled browser
session as above, then:

```sh
scripts/record-run.sh Qwen3.5-9B dickinson 40 site/src/data/recordings/poem-9b.json \
  poem-9b "The poem, read by Qwen3.5 9B" "NVIDIA RTX 6000 Ada (48 GB), weddle" "what happened, in a sentence"
```

The script runs up to that many instructions (or to a halt), then saves what the
page's `window.llmcpu.record()` returns. Add `notes` afterwards by editing
`meta.notes` only.

Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`.
