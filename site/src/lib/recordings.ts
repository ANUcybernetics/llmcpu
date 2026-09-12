// The shipped recordings: JSON files under src/data/recordings. Only their
// meta is bundled; a recording's steps are fetched when a visitor picks it.

import { type Recording, type RecordingMeta } from "./llm";

const metas = import.meta.glob("../data/recordings/*.json", { eager: true, import: "meta" });
const urls = import.meta.glob("../data/recordings/*.json", {
  eager: true,
  query: "?url",
  import: "default",
});

export interface RecordingEntry {
  meta: RecordingMeta;
  load: () => Promise<Recording>;
}

export const RECORDINGS: RecordingEntry[] = Object.entries(metas)
  .map(([path, meta]) => ({
    meta: meta as RecordingMeta,
    load: async () => (await (await fetch(urls[path] as string)).json()) as Recording,
  }))
  .toSorted((a, b) => a.meta.title.localeCompare(b.meta.title));

export const recordingById = (id: string): RecordingEntry | undefined =>
  RECORDINGS.find((r) => r.meta.id === id);
