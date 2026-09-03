import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const version = `${packageJson.version}+${sha}`;

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  outfile: resolve(root, "dist/swarm.mjs"),
  external: ["@opentui/*", "react", "react-reconciler"],
  jsx: "automatic",
  jsxImportSource: "@opentui/react",
  define: { __SWARM_VERSION__: JSON.stringify(version) },
});
