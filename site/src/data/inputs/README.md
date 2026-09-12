# Inputs

The gallery of things that are not RISC-V programs. `src/lib/inputs.ts`
lists them.

- `dickinson.txt`: Emily Dickinson, "Because I could not stop for Death"
  (1890), public domain.
- `plasma.jpg`: a tiny JPEG.
- `dickinson.txt.gz`: the poem again, `gzip -9 -n`.
- `hello-x86_64.elf`: a 368-byte static x86-64 Linux executable that prints
  "hello". Built from `hello-x86_64.s` with
  `clang -nostdlib -static -Wl,--build-id=none -Wl,--gc-sections -Wl,-z,norelro -Wl,-z,noseparate-code`
  and `llvm-strip`.
- `phrase.mid`: a format 0 Standard MIDI File of a seven-note phrase, written
  by hand (a header chunk and one track: tempo, track name, program change,
  note on and off pairs).
- `vga8.psf`: the Linux console font Lat15-VGA8 (PC Screen Font v1, 256 glyphs
  of 8 by 8 pixels, with its Unicode table), from Ubuntu's `console-setup`
  package, ungzipped.
