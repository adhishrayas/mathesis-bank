import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";

// DESIGN.md §1: one stylesheet, one SPA entry, both unhashed, written to
// web/dist-assets and COPYed into the webd image (SPEC.md §11.3). recordgen
// writes no assets at all (SPEC.md §10, R32), so the entry names are stable:
// a landing page's bytes must not change when a chunk hash changes.
//
// The editor's workers are ES modules: `@codingame/monaco-vscode-api` is
// code-split, and a UMD/IIFE worker format cannot carry a code-splitting build.
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: "dist-assets",
    emptyOutDir: true,
    // DESIGN.md §1 specifies `cssCodeSplit: false` for a tree that held only
    // this project's own CSS. The editor island brings monaco-vscode's
    // stylesheet with it, and merging the two would put ~300 kB of editor CSS
    // in front of every reader of a record page. The contract that matters is
    // kept — ONE unhashed `assets/record.css`, which is the entry's CSS and the
    // sheet `css_covers_templates` compares — and the island's sheet is a
    // hashed chunk loaded only by /submit.
    cssCodeSplit: false,
    sourcemap: false,
    manifest: false,
    target: "es2022",
    // The editor is a large, lazily-loaded island; the record pages never pull
    // it in, so the warning is about a chunk no reader downloads.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: { app: "src/main.tsx" },
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? "";
          if (name.endsWith(".css")) return "assets/record.css";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
