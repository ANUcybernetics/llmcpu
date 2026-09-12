// The gallery of things to run. Texts, images and random bytes sit beside the
// RISC-V programs as peers: to this machine every byte string is a program.

import { PROGRAMS, type Program } from "./programs";
import { type Image, imageFromBytes, imageFromRandom, imageFromText } from "./rv32i";

import dickinson from "../data/inputs/dickinson.txt?raw";
import plasmaUrl from "../data/inputs/plasma.jpg?url";

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
