import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

// Single source of truth for the toolchain Node version (also used by CI via
// `node-version-file`). Pinned to Pulsar's runtime: Electron 30.5.1 / Node 20.16.0.
const nodeTarget = readFileSync(
  new URL("./.nvmrc", import.meta.url),
  "utf8",
).trim();

// main.ts is Pulsar's entry point. util.ts, agent-config.ts and search.ts are
// bundled on their own as well so their pure helpers can be unit-tested
// without loading `atom` (test/ imports lib/util.js, lib/agent-config.js and lib/search.js).
const options = {
  entryPoints: ["src/main.ts", "src/util.ts", "src/agent-config.ts", "src/search.ts"],
  outdir: "lib",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${nodeTarget}`,
  sourcemap: true,
  external: ["atom", "electron"],
  define: {
    __PULSAR_ACP_AGENT_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(options);
}
