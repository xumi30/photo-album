import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const albumRoot = path.join(__dirname, "..");
const parentRoot = path.join(albumRoot, "..");

const tasks = [
  {
    from: path.join(parentRoot, "server", "photo-timeline.js"),
    to: path.join(albumRoot, "server", "photo-timeline.js"),
    label: "server/photo-timeline.js",
  },
  {
    from: path.join(parentRoot, "public", "assets", "scripts", "photo-timeline-page.js"),
    to: path.join(albumRoot, "public", "assets", "scripts", "photo-timeline-page.js"),
    label: "public/assets/scripts/photo-timeline-page.js",
  },
];

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const missing = tasks.filter((t) => !fs.existsSync(t.from));
if (missing.length) {
  console.error("[vendorize] missing sources (expected in parent repo):");
  for (const m of missing) console.error(" -", m.from);
  process.exit(2);
}

for (const t of tasks) {
  ensureDirFor(t.to);
  fs.copyFileSync(t.from, t.to);
  console.log("[vendorize] copied", t.label);
}

console.log("[vendorize] done. You can now move photo-album/ out safely.");

