// The gallery of things to run. Texts, images and random bytes sit beside the
// RISC-V programs as peers: to this machine every byte string is a program.

import { PROGRAMS, type Program } from "./programs";
import { type Image, imageFromBytes, imageFromRandom, imageFromText } from "./rv32i";

import dickinson from "../data/inputs/dickinson.txt?raw";
import gzipUrl from "../data/inputs/dickinson.txt.gz?url";
import x86Url from "../data/inputs/hello-x86_64.elf?url";
import midiUrl from "../data/inputs/phrase.mid?url";
import plasmaUrl from "../data/inputs/plasma.jpg?url";
import fontUrl from "../data/inputs/vga8.psf?url";

export interface InputEntry {
  slug: string;
  title: string;
  blurb: string;
  group: "things" | "programs";
  program: Program | null;
  load: () => Promise<Image>;
}

const fetchBytes = async (url: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());

export const INPUTS: InputEntry[] = [
  {
    slug: "dickinson",
    title: "A poem",
    blurb: 'Emily Dickinson, "Because I could not stop for Death" (1890), as plain text.',
    group: "things",
    program: null,
    load: () => Promise.resolve(imageFromText(dickinson, "the poem")),
  },
  {
    slug: "plasma",
    title: "A photograph",
    blurb: "A tiny JPEG: headers, tables and compressed pixels.",
    group: "things",
    program: null,
    load: async () => imageFromBytes(await fetchBytes(plasmaUrl), "a JPEG"),
  },
  {
    slug: "random",
    title: "Random bytes",
    blurb: "256 bytes of noise, different every time.",
    group: "things",
    program: null,
    load: () => Promise.resolve(imageFromRandom(256)),
  },
  {
    slug: "x86",
    title: "A program for another machine",
    blurb:
      "A 368-byte x86-64 Linux executable that prints hello: real code, in the wrong instruction set.",
    group: "things",
    program: null,
    load: async () => imageFromBytes(await fetchBytes(x86Url), "an x86-64 program"),
  },
  {
    slug: "midi",
    title: "A tune",
    blurb: "A MIDI file: seven notes with their timing, as a sequencer would read them.",
    group: "things",
    program: null,
    load: async () => imageFromBytes(await fetchBytes(midiUrl), "a MIDI file"),
  },
  {
    slug: "font",
    title: "A font",
    blurb:
      "A PC Screen Font: 256 glyphs of 8 by 8 pixels, one bit each, as the Linux console draws them.",
    group: "things",
    program: null,
    load: async () => imageFromBytes(await fetchBytes(fontUrl), "a bitmap font"),
  },
  {
    slug: "gzip",
    title: "The poem, compressed",
    blurb: "The same poem after gzip: 752 bytes of English squeezed into 449 that look like noise.",
    group: "things",
    program: null,
    load: async () => imageFromBytes(await fetchBytes(gzipUrl), "the poem, gzipped"),
  },
  ...PROGRAMS.map((p): InputEntry => ({
    slug: p.slug,
    title: `${p.title} (RISC-V)`,
    blurb: p.blurb,
    group: "programs",
    program: p,
    load: async () => imageFromBytes(await fetchBytes(p.elfUrl), p.title),
  })),
];

export const inputBySlug = (slug: string): InputEntry | undefined =>
  INPUTS.find((i) => i.slug === slug);
