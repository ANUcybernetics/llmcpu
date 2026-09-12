import { defineConfig } from "astro/config";

export default defineConfig({
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
