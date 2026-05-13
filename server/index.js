import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { getWriteSecret, isLegacySyncSecretOnly } from "./admin-auth.js";
import { registerPhotoTimelineRoutes } from "./photo-timeline.js";
import { registerAdminPhotoTimelineRoutes } from "./admin-photo-timeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");

dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const secret = getWriteSecret();
if (secret.length) {
  const tail = isLegacySyncSecretOnly()
    ? "（兼容：正从 PHOTO_TIMELINE_SYNC_SECRET 读取，请改为 ADMIN_SECRET）"
    : "";
  console.log("[auth] ADMIN_SECRET 已加载，长度 %d。%s", secret.length, tail);
} else {
  console.warn("[auth] 未配置 ADMIN_SECRET：后台登录与需鉴权的写接口将不可用。");
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "16mb" }));

function resolvePhotoTimelineLiveRoot() {
  const raw = String(process.env.PHOTO_TIMELINE_LIVE_ROOT || "").trim();
  if (!raw) return path.join(rootDir, "data", "live");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(rootDir, raw);
}

const liveRoot = resolvePhotoTimelineLiveRoot();
const uploadPhotosRoot = path.join(rootDir, "uploadphotos");
try {
  fs.mkdirSync(uploadPhotosRoot, { recursive: true });
} catch (_) {}
try {
  fs.mkdirSync(liveRoot, { recursive: true });
} catch (_) {}
app.use("/assets/live", express.static(liveRoot, { fallthrough: true }));
app.use("/uploadphotos", express.static(uploadPhotosRoot, { fallthrough: true, index: false }));

registerPhotoTimelineRoutes(app, {
  publicDir,
  serverDir: __dirname,
  rootDir,
  uploadPhotosRoot,
});
registerAdminPhotoTimelineRoutes(app, { publicDir, serverDir: __dirname, uploadPhotosRoot });

app.use(express.static(publicDir, { index: "index.html", extensions: ["html"] }));

app.listen(PORT, function () {
  console.log("Photo album: http://localhost:" + PORT + "/photo-timeline.html");
  console.log("Static root: " + publicDir);
  console.log("Live assets root: " + liveRoot);
});

