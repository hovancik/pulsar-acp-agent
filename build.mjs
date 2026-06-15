import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "lib/main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
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
