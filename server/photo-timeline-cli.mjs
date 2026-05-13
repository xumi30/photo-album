#!/usr/bin/env node
// 扫描默认素材根 data/live（或 PHOTO_TIMELINE_LIVE_ROOT）下的 photo-timeline-entry.json，写入 SQLite。
// 用法:
//   node server/photo-timeline-cli.mjs
//   node server/photo-timeline-cli.mjs resolve-missing-locations [--dry-run] [--limit=50]
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { resolveMissingLocationLabels, syncPhotoTimelineFromDisk } from "./photo-timeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = __dirname;
const rootDir = path.join(serverDir, "..");
const publicDir = path.join(rootDir, "public");

dotenv.config({ path: path.join(serverDir, ".env"), override: true });

const args = process.argv.slice(2);
const command = args[0] || "sync";
const dryRun = args.includes("--dry-run");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 0;

if (command === "resolve-missing-locations") {
  const r = await resolveMissingLocationLabels({ publicDir, serverDir, dryRun, limit });
  console.log("缺失位置条目数:", r.scannedEntries);
  console.log("缺失位置分组数:", `${r.processedGroups}/${r.totalGroups}`);
  console.log("复用已有位置分组:", r.reusedGroups);
  console.log("近邻复用分组:", r.reusedNearbyGroups || 0);
  console.log("实际逆地理查询分组:", r.requestedGroups);
  console.log("高德查询分组:", r.amapRequestedGroups || 0);
  console.log("OSM 兜底分组:", r.osmRequestedGroups || 0);
  console.log("更新条目数:", r.updatedEntries);
  if (dryRun) console.log("当前为 dry-run，未写入任何结果。");
  if (r.errors.length) {
    console.log("提示/错误:");
    for (const e of r.errors) console.log("  -", e);
  }
} else {
  const r = syncPhotoTimelineFromDisk({ publicDir, serverDir });
  console.log("素材根目录 (resolvePhotoTimelineLiveRoot):", r.liveRoot);
  console.log(
    "提示: 若 server/.env 配置了 PHOTO_TIMELINE_LIVE_ROOT，只扫描该路径；未包含默认 data/live 时，其中的软链接也不会被扫到。"
  );
  console.log("扫描 JSON 文件数:", r.scanned);
  console.log("写入/更新条目数:", r.upserted);
  if (r.errors.length) {
    console.log("提示/错误:");
    for (const e of r.errors) console.log("  -", e);
  }
}

