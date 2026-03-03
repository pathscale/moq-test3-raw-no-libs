import path from "node:path";
import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";

const solidPath = path.resolve(__dirname, "node_modules/solid-js");

export default defineConfig({
  plugins: [pluginBabel({ include: /\.(?:jsx|tsx|ts)$/ }), pluginSolid()],
  resolve: {
    alias: { "~": "./src" },
  },
  html: {
    template: "./index.html",
    title: "MoQ Test",
    mountId: "root",
  },
  dev: {
    hmr: true,
    liveReload: true,
  },
  server: {
    port: 3001,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  tools: {
    rspack: {
      resolve: {
        symlinks: false,
        modules: [path.resolve(__dirname, "node_modules"), "node_modules"],
        alias: {
          "solid-js/web": `${solidPath}/web/dist/web.js`,
          "solid-js/store": `${solidPath}/store/dist/store.js`,
          "solid-js": `${solidPath}/dist/solid.js`,
        },
        conditionNames: ["browser", "import", "module", "default"],
      },
      module: {
        parser: {
          javascript: {
            dynamicImportMode: "eager",
            worker: [
              "...",
              "*context.audioWorklet.addModule()",
            ],
          },
        },
      },
      optimization: {
        splitChunks: false,
        runtimeChunk: false,
      },
    },
  },
  output: {
    sourceMap: {
      js: "cheap-module-source-map",
      css: true,
    },
  },
});
