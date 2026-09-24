import { defineConfig } from "astro/config";

export default defineConfig({
  // Astro 7's default ("jsx") drops the line break between wrapped prose and
  // an inline element, running words into links. `true` collapses it to a space.
  compressHTML: true,
  site: "https://anucybernetics.github.io",
  base: "/llmcpu",
  output: "static",
  vite: {
    css: { transformer: "lightningcss" },
    build: { cssMinify: "lightningcss" },
    // the program corpus (ELF binaries, C sources, line tables) lives in
    // ../programs and is imported straight from there
    server: { fs: { allow: [".."] } },
  },
});
