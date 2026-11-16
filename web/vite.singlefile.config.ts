import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Build ONLY the tool page (app.html) as one self-contained HTML:
// JS + CSS inlined, and the WASM inlined as a base64 data: URL
// (assetsInlineLimit forces every asset inline). Output: dist-single/app.html.
//
// NOTE: WebUSB still needs a secure context — serve over localhost or https,
// not file://. The single file just makes it one portable artifact.
export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: "dist-single",
    assetsInlineLimit: () => true,   // inline the .wasm as a data: URL too
    rollupOptions: { input: { app: "app.html" } },
  },
});
