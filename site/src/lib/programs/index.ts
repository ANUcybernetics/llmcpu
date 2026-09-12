// The curated program corpus, imported straight from ../programs. Metadata,
// sources and line tables are bundled; the ELF binaries are emitted as assets
// and fetched on demand.

import { LinesSchema, type LineRow, type ProgramMeta, ProgramSchema } from "./schema";

const metas = import.meta.glob("../../../../programs/*/program.json", {
  eager: true,
  import: "default",
});
const sources = import.meta.glob("../../../../programs/*/main.c", {
  eager: true,
  query: "?raw",
  import: "default",
});
const lineTables = import.meta.glob("../../../../programs/*/lines.json", {
  eager: true,
  import: "default",
});
const elfUrls = import.meta.glob("../../../../programs/*/main.elf", {
  eager: true,
  query: "?url",
  import: "default",
});

export interface Program extends ProgramMeta {
  slug: string;
  source: string;
  lines: LineRow[];
  elfUrl: string;
}

const slugOf = (path: string): string => path.split("/").at(-2)!;

export const PROGRAMS: Program[] = Object.entries(metas)
  .map(([path, meta]) => {
    const slug = slugOf(path);
    const dir = path.slice(0, path.lastIndexOf("/"));
    return {
      slug,
      ...ProgramSchema.parse(meta),
      source: sources[`${dir}/main.c`] as string,
      lines: LinesSchema.parse(lineTables[`${dir}/lines.json`]),
      elfUrl: elfUrls[`${dir}/main.elf`] as string,
    };
  })
  .toSorted((a, b) => a.order - b.order);

export const programBySlug = (slug: string): Program | undefined =>
  PROGRAMS.find((p) => p.slug === slug);
