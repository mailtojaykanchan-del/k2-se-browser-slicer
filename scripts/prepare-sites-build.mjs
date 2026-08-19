import { copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const dist = new URL("dist/", root);
const client = new URL("client/", dist);
const server = new URL("server/", dist);

await mkdir(client, { recursive: true });

for (const entry of await readdir(dist)) {
  if (entry === "client" || entry === "server") continue;
  await rename(new URL(entry, dist), new URL(entry, client));
}

await mkdir(server, { recursive: true });
await copyFile(new URL("worker/index.js", root), new URL("index.js", server));

const requiredAssets = [
  "index.html",
  "kiri/engine.js",
  "kiri/worker.js",
  "wasm/manifold.wasm",
];

const files = await Promise.all(
  requiredAssets.map(async (path) => {
    const parent = join(new URL(client).pathname, path.split("/").slice(0, -1).join("/"));
    const name = path.split("/").at(-1);
    return (await readdir(parent)).includes(name);
  }),
);

if (files.some((present) => !present)) {
  throw new Error("The hosted build is missing one or more browser-slicer assets.");
}
