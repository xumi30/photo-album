/**
 * Photo timeline: SQLite + scan public/assets/live (recursive) for photo-timeline-entry.json
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getWriteSecret } from "./admin-auth.js";
import {
  assertUserLogin,
  clearUserSessionCookie,
  getUserAuthConfig,
  getUserSessionTtlSec,
  isUserLoggedIn,
  issueUserSessionCookie,
} from "./user-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTO_TIMELINE_SCHEMA_PATH = path.join(__dirname, "schema", "photo-timeline-3nf.sql");

const SYNC_HEADER = "x-photo-timeline-sync-secret";
const GUEST_VISIBLE_PHOTO_LIMIT = 30;

function resolvePhotoTimelineLiveRoot(publicDir, serverDir) {
  const raw = String(process.env.PHOTO_TIMELINE_LIVE_ROOT || "").trim();
  if (!raw) return path.join(publicDir, "assets", "live");
  if (path.isAbsolute(raw)) return raw;
  const rootDir = path.join(serverDir, "..");
  return path.resolve(rootDir, raw);
}

function sourcePathForEntryJson(publicDir, absJsonPath) {
  try {
    const rel = path.relative(publicDir, absJsonPath) || absJsonPath;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return absJsonPath;
    return rel;
  } catch {
    return absJsonPath;
  }
}

function assertSafePublicRelativePath(rel) {
  const s = String(rel || "").trim();
  if (!s) return "";
  if (s.includes("\0")) throw new Error("非法路径");
  const norm = s.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.startsWith("..")) throw new Error("非法路径");
  if (path.isAbsolute(norm)) throw new Error("非法路径");
  return norm;
}

function resolveVerifiedPublicFilePath(publicDir, rel) {
  const safeRel = assertSafePublicRelativePath(rel);
  const abs = path.resolve(publicDir, safeRel);
  const pub = path.resolve(publicDir);
  const relBack = path.relative(pub, abs);
  if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
    throw new Error("非法路径");
  }
  return abs;
}

function resolveVerifiedSiteFilePath(publicDir, liveRoot, relOrAbs) {
  const raw = String(relOrAbs || "").trim();
  if (!raw) throw new Error("非法路径");

  // 兼容 source_path 被写成绝对路径（PHOTO_TIMELINE_LIVE_ROOT 不在 public 内时）。
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const pub = path.resolve(publicDir);
    const live = path.resolve(liveRoot);
    const relToPub = path.relative(pub, abs);
    const relToLive = path.relative(live, abs);
    const inPublic = !(relToPub.startsWith("..") || path.isAbsolute(relToPub));
    const inLive = !(relToLive.startsWith("..") || path.isAbsolute(relToLive));
    if (!inPublic && !inLive) throw new Error("非法路径");
    return abs;
  }

  const safeRel = assertSafePublicRelativePath(raw);
  const norm = safeRel.replace(/\\/g, "/");
  if (norm === "assets/live" || norm.startsWith("assets/live/")) {
    const sub = norm.slice("assets/live".length).replace(/^\/+/, "");
    const abs = path.resolve(liveRoot, sub);
    const live = path.resolve(liveRoot);
    const relBack = path.relative(live, abs);
    if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
      throw new Error("非法路径");
    }
    return abs;
  }

  return resolveVerifiedPublicFilePath(publicDir, norm);
}

function getOpenAIBaseUrl() {
  return String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function getPhotoTimelineVisionModel() {
  return String(process.env.PHOTO_TIMELINE_VISION_MODEL || "gpt-4.1-mini").trim();
}

function getPhotoTimelineVisionPromptOverride() {
  return String(process.env.PHOTO_TIMELINE_VISION_PROMPT || "").trim();
}

function getOpenAIApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function inferMimeTypeFromPath(filepath) {
  const ext = path.extname(String(filepath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

function extractOpenAIResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === "string" && part.text.trim()) return part.text.trim();
    }
  }
  return "";
}

function pickPhotoAnalysisAsset(publicDir, liveRoot, photoRow) {
  const candidates = [photoRow && photoRow.src, photoRow && photoRow.thumb];
  for (const rel of candidates) {
    const raw = String(rel || "").trim();
    if (!raw) continue;
    let abs = "";
    try {
      abs = resolveVerifiedSiteFilePath(publicDir, liveRoot, raw);
    } catch {
      continue;
    }
    if (!abs || !fs.existsSync(abs)) continue;
    const mime = inferMimeTypeFromPath(abs);
    if (!mime) continue;
    return { absPath: abs, mimeType: mime, relPath: raw };
  }
  throw new Error("未找到可供 AI 分析的图片资源（当前仅支持 jpg/png/webp/gif）");
}

function tryUnlinkSiteMedia(publicDir, liveRoot, relOrAbs) {
  const r = String(relOrAbs || "").trim();
  if (!r) return false;
  try {
    const abs = resolveVerifiedSiteFilePath(publicDir, liveRoot, r);
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

function removeEntryFromSourceJsonFiles(publicDir, liveRoot, entryId, sourceRelRaw) {
  const id = String(entryId || "");
  if (!id) return;
  const raw = String(sourceRelRaw || "").trim();
  if (!raw) return;

  const parts = raw
    .split(",")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  for (const rel of parts) {
    let abs;
    try {
      abs = resolveVerifiedSiteFilePath(publicDir, liveRoot, rel);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    if (path.basename(abs) !== "photo-timeline-entry.json") continue;

    let fileJson;
    try {
      fileJson = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    const entries = Array.isArray(fileJson.entries) ? fileJson.entries : [];
    const next = entries.filter((e) => {
      if (!e) return true;
      if (e.id === id) return false;
      const der = deriveBusinessEntryIdFromObject(e);
      return der !== id;
    });
    fileJson.entries = next;
    fs.writeFileSync(abs, JSON.stringify(fileJson, null, 2), "utf8");
  }
}

function removePhotoFromSourceJsonFiles(publicDir, liveRoot, entryId, photoRow, sourceRelRaw) {
  const id = String(entryId || "");
  if (!id || !photoRow || typeof photoRow !== "object") return;
  const src = photoRow.src != null ? String(photoRow.src) : "";
  const thumb = photoRow.thumb != null ? String(photoRow.thumb) : "";
  const video = photoRow.video != null ? String(photoRow.video) : "";

  const raw = String(sourceRelRaw || "").trim();
  if (!raw) return;
  const parts = raw
    .split(",")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  for (const rel of parts) {
    let abs;
    try {
      abs = resolveVerifiedSiteFilePath(publicDir, liveRoot, rel);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    if (path.basename(abs) !== "photo-timeline-entry.json") continue;

    let fileJson;
    try {
      fileJson = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    const entries = Array.isArray(fileJson.entries) ? fileJson.entries : [];
    let changed = false;
    for (const e of entries) {
      if (!e) continue;
      const match =
        e.id === id ||
        deriveBusinessEntryIdFromObject(e) === id ||
        (e.id == null && deriveBusinessEntryIdFromObject(e) === id);
      if (!match) continue;
      const photos = Array.isArray(e.photos) ? e.photos : [];
      const nextPhotos = photos.filter((p) => {
        if (!p || typeof p !== "object") return true;
        const ps = p.src != null ? String(p.src) : "";
        const pt = p.thumb != null ? String(p.thumb) : "";
        const pv = p.video != null ? String(p.video) : "";
        if (src && ps === src) return false;
        if (!src && thumb && pt === thumb) return false;
        if (!src && !thumb && video && pv === video) return false;
        return true;
      });
      if (nextPhotos.length !== photos.length) {
        e.photos = nextPhotos;
        changed = true;
      }
    }
    if (changed) {
      fileJson.entries = entries;
      fs.writeFileSync(abs, JSON.stringify(fileJson, null, 2), "utf8");
    }
  }
}

/**
 * 若存在旧版 `timeline_entries.payload` 列，则丢弃旧表并重建规范化表（开发期可接受）。
 */
function migrateLegacyPhotoTimelineIfNeeded(db) {
  let info;
  try {
    info = db.prepare("PRAGMA table_info(timeline_entries)").all();
  } catch {
    return;
  }
  if (!info.length) return;
  const names = new Set(info.map((c) => c.name));
  if (!names.has("payload")) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS timeline_photos;
    DROP TABLE IF EXISTS entry_tags;
    DROP TABLE IF EXISTS entry_weather;
    DROP TABLE IF EXISTS entry_gps;
    DROP TABLE IF EXISTS media_embeddings;
    DROP TABLE IF EXISTS timeline_entries;
    DROP TABLE IF EXISTS tags;
    PRAGMA foreign_keys = ON;
  `);
}

function ensurePhotoTimelineSchema(db) {
  migrateLegacyPhotoTimelineIfNeeded(db);
  if (!fs.existsSync(PHOTO_TIMELINE_SCHEMA_PATH)) {
    throw new Error("missing schema: " + PHOTO_TIMELINE_SCHEMA_PATH);
  }
  db.exec(fs.readFileSync(PHOTO_TIMELINE_SCHEMA_PATH, "utf8"));
  ensureTimelineEntryBusinessColumns(db);
  ensureTimelineEntryVisibilityColumn(db);
  ensureTimelinePhotoBusinessColumns(db);
  migrateTimelineEntryBusinessModel(db);
  migrateGpsGridTruncateV2(db);
}

/** 与 public/assets/scripts/photo-timeline-page.js 中 GEO_BUCKET_DECIMALS 一致 */
const GEO_BUCKET_DECIMALS = 3;
const REVERSE_GEOCODE_BUCKET_DECIMALS = 2;
const OSM_NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastOsmNominatimRequestAt = 0;

/** 向零截断到 N 位小数（避免 toFixed 四舍五入把 30.2235 并进相邻格） */
function truncateCoordToDecimals(value, decimals) {
  const f = 10 ** decimals;
  return Math.trunc(Number(value) * f) / f;
}

/**
 * @param {string | null | undefined} dateStr
 * @returns {string | null} YYYY-MM-DD
 */
function extractCalendarDate(dateStr) {
  const s = String(dateStr || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const d = new Date(m[1] + "T00:00:00");
    if (Number.isNaN(d.getTime())) return null;
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * @param {number} lat
 * @param {number} lng
 */
function gpsGridKeyFromCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "nogps";
  const t = truncateCoordToDecimals(la, GEO_BUCKET_DECIMALS);
  const u = truncateCoordToDecimals(ln, GEO_BUCKET_DECIMALS);
  return `geo_${t.toFixed(GEO_BUCKET_DECIMALS)}_${u.toFixed(GEO_BUCKET_DECIMALS)}`;
}

function gpsBucketKeyFromCoords(lat, lng, decimals) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "nogps";
  const t = truncateCoordToDecimals(la, decimals);
  const u = truncateCoordToDecimals(ln, decimals);
  return `geo_${t.toFixed(decimals)}_${u.toFixed(decimals)}`;
}

function reverseGeocodeBucketKeyFromCoords(lat, lng) {
  return gpsBucketKeyFromCoords(lat, lng, REVERSE_GEOCODE_BUCKET_DECIMALS);
}

/**
 * @param {string} calendarDate YYYY-MM-DD
 * @param {string} gpsGridKey
 */
function deriveBusinessEntryId(calendarDate, gpsGridKey) {
  const safe = (x) =>
    String(x).replace(/[^a-zA-Z0-9._-]/g, (ch) => (ch === "." ? "_" : "_"));
  return `pt_${safe(calendarDate)}_${safe(gpsGridKey)}`;
}

function ensureTimelineEntryBusinessColumns(db) {
  const info = db.prepare("PRAGMA table_info(timeline_entries)").all();
  const names = new Set(info.map((c) => c.name));
  if (!names.has("calendar_date")) {
    db.exec("ALTER TABLE timeline_entries ADD COLUMN calendar_date TEXT NOT NULL DEFAULT '';");
  }
  if (!names.has("gps_grid_key")) {
    db.exec("ALTER TABLE timeline_entries ADD COLUMN gps_grid_key TEXT NOT NULL DEFAULT '';");
  }
}

function ensureTimelineEntryVisibilityColumn(db) {
  const info = db.prepare("PRAGMA table_info(timeline_entries)").all();
  const names = new Set(info.map((c) => c.name));
  if (!names.has("visibility")) {
    db.exec(`ALTER TABLE timeline_entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';`);
  }
}

function ensureTimelinePhotoBusinessColumns(db) {
  const info = db.prepare("PRAGMA table_info(timeline_photos)").all();
  const names = new Set(info.map((c) => c.name));
  if (!names.has("visibility")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';`);
  }
  if (!names.has("captured_at")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN captured_at TEXT;`);
  }
  if (!names.has("camera_make")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN camera_make TEXT;`);
  }
  if (!names.has("camera_model")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN camera_model TEXT;`);
  }
  if (!names.has("lens_model")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN lens_model TEXT;`);
  }
  if (!names.has("device_model")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN device_model TEXT;`);
  }
  if (!names.has("gps_latitude")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN gps_latitude REAL;`);
  }
  if (!names.has("gps_longitude")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN gps_longitude REAL;`);
  }
  if (!names.has("metadata_json")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN metadata_json TEXT;`);
  }
  if (!names.has("semantic_json")) {
    db.exec(`ALTER TABLE timeline_photos ADD COLUMN semantic_json TEXT;`);
  }
}

function parseJsonObjectOrNull(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const out = JSON.parse(String(raw));
    return out && typeof out === "object" ? out : null;
  } catch {
    return null;
  }
}

function normalizePhotoSemanticInput(value) {
  if (!value || typeof value !== "object") return null;
  const asList = (v) =>
    Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const out = {
    people: asList(value.people),
    place_name: value.place_name != null ? String(value.place_name).trim() : "",
    place_category: value.place_category != null ? String(value.place_category).trim() : "",
    scene: value.scene != null ? String(value.scene).trim() : "",
    scene_tags: asList(value.scene_tags),
    summary: value.summary != null ? String(value.summary).trim() : "",
    source: value.source != null ? String(value.source).trim() : "",
    notes: value.notes != null ? String(value.notes).trim() : "",
  };
  const hasAny =
    out.people.length ||
    out.place_name ||
    out.place_category ||
    out.scene ||
    out.scene_tags.length ||
    out.summary ||
    out.source ||
    out.notes;
  return hasAny ? out : null;
}

function normalizePhotoMetadataInput(value) {
  if (!value || typeof value !== "object") return null;
  const raw = { ...value };
  const gpsIn = raw.gps && typeof raw.gps === "object" ? raw.gps : {};
  const out = {
    captured_at: raw.captured_at != null ? String(raw.captured_at).trim() : "",
    datetime_original: raw.datetime_original != null ? String(raw.datetime_original).trim() : "",
    datetime_digitized: raw.datetime_digitized != null ? String(raw.datetime_digitized).trim() : "",
    datetime_file: raw.datetime_file != null ? String(raw.datetime_file).trim() : "",
    camera_make: raw.camera_make != null ? String(raw.camera_make).trim() : "",
    camera_model: raw.camera_model != null ? String(raw.camera_model).trim() : "",
    lens_model: raw.lens_model != null ? String(raw.lens_model).trim() : "",
    device_model: raw.device_model != null ? String(raw.device_model).trim() : "",
    aperture_f_number:
      raw.aperture_f_number != null && Number.isFinite(Number(raw.aperture_f_number))
        ? Number(raw.aperture_f_number)
        : null,
    exposure_time_s:
      raw.exposure_time_s != null && Number.isFinite(Number(raw.exposure_time_s))
        ? Number(raw.exposure_time_s)
        : null,
    exposure_time_text: raw.exposure_time_text != null ? String(raw.exposure_time_text).trim() : "",
    iso:
      raw.iso != null && Number.isFinite(Number(raw.iso)) ? Math.floor(Number(raw.iso)) : null,
    focal_length_mm:
      raw.focal_length_mm != null && Number.isFinite(Number(raw.focal_length_mm))
        ? Number(raw.focal_length_mm)
        : null,
    width_px:
      raw.width_px != null && Number.isFinite(Number(raw.width_px))
        ? Math.floor(Number(raw.width_px))
        : null,
    height_px:
      raw.height_px != null && Number.isFinite(Number(raw.height_px))
        ? Math.floor(Number(raw.height_px))
        : null,
    software: raw.software != null ? String(raw.software).trim() : "",
    gps: {
      latitude:
        gpsIn.latitude != null && Number.isFinite(Number(gpsIn.latitude))
          ? Number(gpsIn.latitude)
          : null,
      longitude:
        gpsIn.longitude != null && Number.isFinite(Number(gpsIn.longitude))
          ? Number(gpsIn.longitude)
          : null,
      altitude_m:
        gpsIn.altitude_m != null && Number.isFinite(Number(gpsIn.altitude_m))
          ? Number(gpsIn.altitude_m)
          : null,
      label: gpsIn.label != null ? String(gpsIn.label).trim() : "",
    },
    apple_photos: raw.apple_photos && typeof raw.apple_photos === "object" ? raw.apple_photos : null,
    raw_exif: raw.raw_exif && typeof raw.raw_exif === "object" ? raw.raw_exif : null,
  };
  const hasAny =
    out.captured_at ||
    out.datetime_original ||
    out.datetime_digitized ||
    out.datetime_file ||
    out.camera_make ||
    out.camera_model ||
    out.lens_model ||
    out.device_model ||
    out.aperture_f_number != null ||
    out.exposure_time_s != null ||
    out.exposure_time_text ||
    out.iso != null ||
    out.focal_length_mm != null ||
    out.width_px != null ||
    out.height_px != null ||
    out.software ||
    out.gps.latitude != null ||
    out.gps.longitude != null ||
    out.gps.altitude_m != null ||
    out.gps.label ||
    out.apple_photos ||
    out.raw_exif;
  return hasAny ? out : null;
}

function photoColumnsFromObjects(metadata, semantic) {
  const normMeta = normalizePhotoMetadataInput(metadata);
  const normSemantic = normalizePhotoSemanticInput(semantic);
  return {
    captured_at:
      normMeta && normMeta.captured_at
        ? normMeta.captured_at
        : normMeta && normMeta.datetime_original
          ? normMeta.datetime_original
          : null,
    camera_make: normMeta && normMeta.camera_make ? normMeta.camera_make : null,
    camera_model: normMeta && normMeta.camera_model ? normMeta.camera_model : null,
    lens_model: normMeta && normMeta.lens_model ? normMeta.lens_model : null,
    device_model: normMeta && normMeta.device_model ? normMeta.device_model : null,
    gps_latitude: normMeta && normMeta.gps && normMeta.gps.latitude != null ? normMeta.gps.latitude : null,
    gps_longitude:
      normMeta && normMeta.gps && normMeta.gps.longitude != null ? normMeta.gps.longitude : null,
    metadata_json: normMeta ? JSON.stringify(normMeta) : null,
    semantic_json: normSemantic ? JSON.stringify(normSemantic) : null,
  };
}

function materializePhotoMetadataFromRow(row) {
  const parsed = parseJsonObjectOrNull(row && row.metadata_json);
  if (parsed) return parsed;
  return normalizePhotoMetadataInput({
    captured_at: row && row.captured_at != null ? row.captured_at : null,
    datetime_original: row && row.captured_at != null ? row.captured_at : null,
    camera_make: row && row.camera_make != null ? row.camera_make : null,
    camera_model: row && row.camera_model != null ? row.camera_model : null,
    lens_model: row && row.lens_model != null ? row.lens_model : null,
    device_model: row && row.device_model != null ? row.device_model : null,
    gps: {
      latitude: row && row.gps_latitude != null ? row.gps_latitude : null,
      longitude: row && row.gps_longitude != null ? row.gps_longitude : null,
    },
  });
}

function renumberTimelinePhotos(db, entryId) {
  const rows = db
    .prepare(`SELECT id FROM timeline_photos WHERE entry_id = ? ORDER BY sort_index ASC, id ASC`)
    .all(entryId);
  const upd = db.prepare(`UPDATE timeline_photos SET sort_index = ? WHERE id = ?`);
  rows.forEach((r, i) => upd.run(i, r.id));
}

/**
 * 多份 photo-timeline-entry.json 映射到同一业务 id（同日 + 同粗网格）时合并照片：按 src 更新或追加，不先 DELETE 全表（避免只保留最后一个 JSON 的照片）。
 * @param {import("better-sqlite3").Database} db
 * @param {string} entryId
 * @param {unknown[]} photos
 */
function mergePhotosFromIncomingForUpsert(db, entryId, photos) {
  const isVideoPath = (rel) => /\.(mov|mp4|webm|m4v)$/i.test(String(rel || ""));
  const pickString = (obj, keys) => {
    if (!obj || typeof obj !== "object") return "";
    for (const k of keys) {
      if (obj[k] == null) continue;
      const s = String(obj[k]).trim();
      if (s) return s;
    }
    return "";
  };
  const pickVisibility = (p) => {
    if (!p || typeof p !== "object") return null;
    const hasOwn = (k) => Object.prototype.hasOwnProperty.call(p, k);
    let explicit = false;
    let raw = "";
    if (hasOwn("visibility")) {
      explicit = true;
      raw = p.visibility;
    } else if (hasOwn("scope")) {
      explicit = true;
      raw = p.scope;
    } else if (hasOwn("private")) {
      explicit = true;
      raw = p.private === true || p.private === 1 ? "private" : "public";
    }
    if (!explicit) return null;
    const s = String(raw || "").trim().toLowerCase();
    if (s === "private" || s === "login" || s === "authed" || s === "auth") return "private";
    return "public";
  };
  const normalizeIncomingPhoto = (p) => {
    const thumbIn = pickString(p, ["thumb", "thum"]);
    const srcIn = pickString(p, ["src", "preview"]);
    const videoIn = pickString(p, ["video", "mov"]);
    const visibility = pickVisibility(p);
    const extra = photoColumnsFromObjects(p.metadata, p.semantic);
    const caption = p.caption != null ? String(p.caption) : null;
    const ratio = p.ratio != null ? String(p.ratio) : null;

    let thumb = thumbIn;
    let src = srcIn;
    let video = videoIn;

    // 允许只传一个：缺 thumb 默认用 preview（src）；缺 preview 默认用 thumb
    if (!src && thumb) src = thumb;
    if (!thumb && src) thumb = src;

    // mov 不传默认与 preview（src）一致（仅当 preview/thumbnail 本身是视频路径时）
    if (!video) {
      if (src && isVideoPath(src)) video = src;
      else if (thumb && isVideoPath(thumb)) video = thumb;
    }

    return {
      thumb: thumb || null,
      src: src || null,
      video: video || null,
      caption,
      ratio,
      visibility,
      ...extra,
    };
  };

  const incoming = Array.isArray(photos) ? photos : [];
  const existing = db.prepare(`SELECT id, src FROM timeline_photos WHERE entry_id = ?`).all(entryId);
  const bySrc = new Map();
  for (const r of existing) {
    if (r.src != null && String(r.src).trim() !== "") {
      bySrc.set(String(r.src), r.id);
    }
  }
  const maxSortStmt = db.prepare(
    `SELECT COALESCE(MAX(sort_index), -1) AS m FROM timeline_photos WHERE entry_id = ?`
  );
  const insPhoto = db.prepare(`
    INSERT INTO timeline_photos (
      entry_id, sort_index, thumb, src, video, caption, ratio, visibility,
      captured_at, camera_make, camera_model, lens_model, device_model,
      gps_latitude, gps_longitude, metadata_json, semantic_json
    )
    VALUES (
      @entry_id, @sort_index, @thumb, @src, @video, @caption, @ratio, @visibility,
      @captured_at, @camera_make, @camera_model, @lens_model, @device_model,
      @gps_latitude, @gps_longitude, @metadata_json, @semantic_json
    )
  `);
  const updPhotoNoVis = db.prepare(
    `UPDATE timeline_photos
     SET thumb = ?, video = ?, caption = ?, ratio = ?,
         captured_at = COALESCE(?, captured_at),
         camera_make = COALESCE(?, camera_make),
         camera_model = COALESCE(?, camera_model),
         lens_model = COALESCE(?, lens_model),
         device_model = COALESCE(?, device_model),
         gps_latitude = COALESCE(?, gps_latitude),
         gps_longitude = COALESCE(?, gps_longitude),
         metadata_json = COALESCE(?, metadata_json),
         semantic_json = COALESCE(?, semantic_json)
     WHERE id = ?`
  );
  const updPhotoWithVis = db.prepare(
    `UPDATE timeline_photos
     SET thumb = ?, video = ?, caption = ?, ratio = ?, visibility = ?,
         captured_at = COALESCE(?, captured_at),
         camera_make = COALESCE(?, camera_make),
         camera_model = COALESCE(?, camera_model),
         lens_model = COALESCE(?, lens_model),
         device_model = COALESCE(?, device_model),
         gps_latitude = COALESCE(?, gps_latitude),
         gps_longitude = COALESCE(?, gps_longitude),
         metadata_json = COALESCE(?, metadata_json),
         semantic_json = COALESCE(?, semantic_json)
     WHERE id = ?`
  );
  for (const p of incoming) {
    if (!p || typeof p !== "object") continue;
    const norm = normalizeIncomingPhoto(p);
    const thumb = norm.thumb;
    const src = norm.src;
    const video = norm.video;
    const caption = norm.caption;
    const ratio = norm.ratio;
    const visibility = norm.visibility;
    if (src && bySrc.has(src)) {
      const pid = bySrc.get(src);
      if (visibility == null) {
        updPhotoNoVis.run(
          thumb,
          video,
          caption,
          ratio,
          norm.captured_at,
          norm.camera_make,
          norm.camera_model,
          norm.lens_model,
          norm.device_model,
          norm.gps_latitude,
          norm.gps_longitude,
          norm.metadata_json,
          norm.semantic_json,
          pid
        );
      } else {
        updPhotoWithVis.run(
          thumb,
          video,
          caption,
          ratio,
          visibility,
          norm.captured_at,
          norm.camera_make,
          norm.camera_model,
          norm.lens_model,
          norm.device_model,
          norm.gps_latitude,
          norm.gps_longitude,
          norm.metadata_json,
          norm.semantic_json,
          pid
        );
      }
    } else if (src) {
      const m = maxSortStmt.get(entryId);
      const idx = (m && m.m != null ? m.m : -1) + 1;
      const info = insPhoto.run({
        entry_id: entryId,
        sort_index: idx,
        thumb,
        src,
        video,
        caption,
        ratio,
        visibility: visibility || "public",
        captured_at: norm.captured_at,
        camera_make: norm.camera_make,
        camera_model: norm.camera_model,
        lens_model: norm.lens_model,
        device_model: norm.device_model,
        gps_latitude: norm.gps_latitude,
        gps_longitude: norm.gps_longitude,
        metadata_json: norm.metadata_json,
        semantic_json: norm.semantic_json,
      });
      const newId = Number(info.lastInsertRowid);
      if (Number.isFinite(newId) && newId > 0) {
        bySrc.set(src, newId);
      }
    } else {
      const m = maxSortStmt.get(entryId);
      const idx = (m && m.m != null ? m.m : -1) + 1;
      insPhoto.run({
        entry_id: entryId,
        sort_index: idx,
        thumb,
        src: null,
        video,
        caption,
        ratio,
        visibility: visibility || "public",
        captured_at: norm.captured_at,
        camera_make: norm.camera_make,
        camera_model: norm.camera_model,
        lens_model: norm.lens_model,
        device_model: norm.device_model,
        gps_latitude: norm.gps_latitude,
        gps_longitude: norm.gps_longitude,
        metadata_json: norm.metadata_json,
        semantic_json: norm.semantic_json,
      });
    }
  }
  renumberTimelinePhotos(db, entryId);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} keepId
 * @param {string} dropId
 */
function mergeEntriesInto(db, keepId, dropId) {
  if (keepId === dropId) return;
  const delWeather = db.prepare(`DELETE FROM entry_weather WHERE entry_id = ?`);
  const insWeather = db.prepare(`
    INSERT INTO entry_weather (
      entry_id, provider, fetched_at, summary, temp_high_c, temp_low_c,
      icon_code, precipitation_mm, wind_max_m_s, amap_detail
    ) VALUES (
      @entry_id, @provider, @fetched_at, @summary, @temp_high_c, @temp_low_c,
      @icon_code, @precipitation_mm, @wind_max_m_s, @amap_detail
    )
  `);
  const insGps = db.prepare(`
    INSERT INTO entry_gps (entry_id, latitude, longitude, altitude_m, label)
    VALUES (@entry_id, @latitude, @longitude, @altitude_m, @label)
  `);

  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_index), -1) AS m FROM timeline_photos WHERE entry_id = ?`)
    .get(keepId);
  let next = (maxSort && maxSort.m != null ? maxSort.m : -1) + 1;
  const keepSrc = new Set(
    db
      .prepare(`SELECT src FROM timeline_photos WHERE entry_id = ?`)
      .all(keepId)
      .map((r) => r.src)
      .filter(Boolean)
  );
  const dropPhotos = db
    .prepare(`SELECT * FROM timeline_photos WHERE entry_id = ? ORDER BY sort_index ASC, id ASC`)
    .all(dropId);
  const updPh = db.prepare(`UPDATE timeline_photos SET entry_id = ?, sort_index = ? WHERE id = ?`);
  const delPh = db.prepare(`DELETE FROM timeline_photos WHERE id = ?`);
  for (const p of dropPhotos) {
    const src = p.src != null ? String(p.src) : null;
    if (src && keepSrc.has(src)) {
      delPh.run(p.id);
      continue;
    }
    if (src) keepSrc.add(src);
    updPh.run(keepId, next++, p.id);
  }
  renumberTimelinePhotos(db, keepId);

  const tagRows = db.prepare(`SELECT tag_id FROM entry_tags WHERE entry_id = ?`).all(dropId);
  const insLink = db.prepare(`INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`);
  for (const t of tagRows) {
    insLink.run(keepId, t.tag_id);
  }
  db.prepare(`DELETE FROM entry_tags WHERE entry_id = ?`).run(dropId);

  const wKeep = db.prepare(`SELECT * FROM entry_weather WHERE entry_id = ?`).get(keepId);
  const wDrop = db.prepare(`SELECT * FROM entry_weather WHERE entry_id = ?`).get(dropId);
  const keepHas =
    wKeep && weatherRowHasAnyData(weatherToDbRow(weatherFromDbRow(wKeep)));
  const dropHas =
    wDrop && weatherRowHasAnyData(weatherToDbRow(weatherFromDbRow(wDrop)));
  if (!keepHas && dropHas && wDrop) {
    delWeather.run(keepId);
    const wr = weatherToDbRow(weatherFromDbRow(wDrop));
    insWeather.run({ entry_id: keepId, ...wr });
  }

  const gKeep = db.prepare(`SELECT * FROM entry_gps WHERE entry_id = ?`).get(keepId);
  const gDrop = db.prepare(`SELECT * FROM entry_gps WHERE entry_id = ?`).get(dropId);
  if (!gKeep && gDrop) {
    insGps.run({
      entry_id: keepId,
      latitude: gDrop.latitude,
      longitude: gDrop.longitude,
      altitude_m: gDrop.altitude_m,
      label: gDrop.label != null ? String(gDrop.label) : "",
    });
  }
  db.prepare(`DELETE FROM entry_gps WHERE entry_id = ?`).run(dropId);

  const k = db.prepare(`SELECT * FROM timeline_entries WHERE id = ?`).get(keepId);
  const d = db.prepare(`SELECT * FROM timeline_entries WHERE id = ?`).get(dropId);
  if (k && d) {
    const title =
      String(k.title || "").length >= String(d.title || "").length ? k.title : d.title;
    const place =
      String(k.place || "").length >= String(d.place || "").length ? k.place : d.place;
    const note =
      String(k.note || "").length >= String(d.note || "").length ? k.note : d.note;
    const paths = [k.source_path, d.source_path]
      .filter((x) => x != null && String(x).trim() !== "")
      .map((x) => String(x));
    const sourcePath = [...new Set(paths)].join(",");
    db.prepare(
      `UPDATE timeline_entries SET title = ?, place = ?, note = ?, source_path = ?, updated_at = ? WHERE id = ?`
    ).run(
      title != null ? title : "",
      place != null ? place : "",
      note != null ? note : "",
      sourcePath,
      new Date().toISOString(),
      keepId
    );
  }

  db.prepare(`DELETE FROM timeline_entries WHERE id = ?`).run(dropId);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function moveEntryToNewId(db, fromId, toId) {
  if (fromId === toId) return;
  const clash = db.prepare(`SELECT 1 FROM timeline_entries WHERE id = ?`).get(toId);
  if (clash) {
    mergeEntriesInto(db, toId, fromId);
    return;
  }
  const row = db.prepare(`SELECT * FROM timeline_entries WHERE id = ?`).get(fromId);
  if (!row) return;
  /**
   * 若先 INSERT 再 DELETE，会在唯一索引 idx_timeline_entries_day_grid 下短暂出现两行相同
   * (calendar_date, gps_grid_key)。改为先改子表再 UPDATE 主键 id，避免 UNIQUE 冲突。
   */
  const prevFk = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.prepare(`UPDATE timeline_photos SET entry_id = ? WHERE entry_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE entry_tags SET entry_id = ? WHERE entry_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE entry_gps SET entry_id = ? WHERE entry_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE entry_weather SET entry_id = ? WHERE entry_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE timeline_entries SET id = ? WHERE id = ?`).run(toId, fromId);
  } finally {
    db.pragma(`foreign_keys = ${prevFk ? "ON" : "OFF"}`);
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function recomputeAllEntryGridKeysFromGps(db) {
  const rows = db.prepare(`SELECT id, date FROM timeline_entries`).all();
  for (const row of rows) {
    let cal = extractCalendarDate(row.date);
    if (!cal) {
      const m = String(row.date || "").match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) cal = m[1];
    }
    if (!cal) continue;
    const g = db.prepare(`SELECT latitude, longitude FROM entry_gps WHERE entry_id = ?`).get(row.id);
    let grid = "nogps";
    if (g && g.latitude != null && g.longitude != null) {
      const la = Number(g.latitude);
      const ln = Number(g.longitude);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        grid = gpsGridKeyFromCoords(la, ln);
      }
    }
    db.prepare(`UPDATE timeline_entries SET calendar_date = ?, gps_grid_key = ? WHERE id = ?`).run(
      cal,
      grid,
      row.id
    );
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function mergeDuplicateCalendarGridEntries(db) {
  const dupGroups = db
    .prepare(
      `SELECT calendar_date, gps_grid_key, COUNT(*) AS c
       FROM timeline_entries
       GROUP BY calendar_date, gps_grid_key
       HAVING c > 1`
    )
    .all();
  for (const g of dupGroups) {
    const groupRows = db
      .prepare(
        `SELECT id FROM timeline_entries
         WHERE calendar_date = ? AND gps_grid_key = ?
         ORDER BY updated_at DESC`
      )
      .all(g.calendar_date, g.gps_grid_key);
    const keep = groupRows[0].id;
    for (let i = 1; i < groupRows.length; i++) {
      mergeEntriesInto(db, keep, groupRows[i].id);
    }
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function alignAllEntryIdsToDerived(db) {
  const all = db.prepare(`SELECT id, calendar_date, gps_grid_key FROM timeline_entries`).all();
  for (const r of all) {
    const expected = deriveBusinessEntryId(String(r.calendar_date), String(r.gps_grid_key));
    if (r.id !== expected) {
      moveEntryToNewId(db, r.id, expected);
    }
  }
}

function ensureTimelineEntrySecondaryIndexes(db) {
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_entries_cal ON timeline_entries (calendar_date DESC);`);
  } catch {
    /* legacy */
  }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_entries_day_grid ON timeline_entries(calendar_date, gps_grid_key);`
    );
  } catch {
    /* duplicates or legacy */
  }
}

/** 重算网格时两行可能暂时落在同一 (calendar_date, gps_grid_key)，须先去掉唯一索引，合并后再建回 */
function dropTimelineDayGridUniqueIndexIfExists(db) {
  try {
    db.exec(`DROP INDEX IF EXISTS idx_timeline_entries_day_grid`);
  } catch {
    /* ignore */
  }
}

/** 粗网格由「四舍五入」改为「截断」后，一次性重算并合并（PRAGMA user_version） */
const GRID_TRUNC_VERSION = 2;

function migrateGpsGridTruncateV2(db) {
  const v = Number(db.pragma("user_version", { simple: true })) || 0;
  if (v >= GRID_TRUNC_VERSION) return;
  dropTimelineDayGridUniqueIndexIfExists(db);
  recomputeAllEntryGridKeysFromGps(db);
  mergeDuplicateCalendarGridEntries(db);
  alignAllEntryIdsToDerived(db);
  ensureTimelineEntrySecondaryIndexes(db);
  db.pragma(`user_version = ${GRID_TRUNC_VERSION}`);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function migrateTimelineEntryBusinessModel(db) {
  const needsWork = db
    .prepare(
      `SELECT 1 FROM timeline_entries WHERE calendar_date = '' OR gps_grid_key = '' LIMIT 1`
    )
    .get();
  if (!needsWork) {
    ensureTimelineEntrySecondaryIndexes(db);
    return;
  }

  dropTimelineDayGridUniqueIndexIfExists(db);
  recomputeAllEntryGridKeysFromGps(db);
  mergeDuplicateCalendarGridEntries(db);
  alignAllEntryIdsToDerived(db);
  ensureTimelineEntrySecondaryIndexes(db);
}

/** @param {Record<string, unknown> | null | undefined} w */
function weatherToDbRow(w) {
  if (!w || typeof w !== "object") {
    return {
      provider: null,
      fetched_at: null,
      summary: null,
      temp_high_c: null,
      temp_low_c: null,
      icon_code: null,
      precipitation_mm: null,
      wind_max_m_s: null,
      amap_detail: null,
    };
  }
  return {
    provider: w.provider != null ? String(w.provider) : null,
    fetched_at: w.fetched_at != null ? String(w.fetched_at) : null,
    summary: w.summary != null ? String(w.summary) : null,
    temp_high_c:
      w.temp_high_c != null && Number.isFinite(Number(w.temp_high_c))
        ? Math.round(Number(w.temp_high_c))
        : null,
    temp_low_c:
      w.temp_low_c != null && Number.isFinite(Number(w.temp_low_c))
        ? Math.round(Number(w.temp_low_c))
        : null,
    icon_code: w.icon_code != null ? String(w.icon_code) : null,
    precipitation_mm:
      w.precipitation_mm != null && Number.isFinite(Number(w.precipitation_mm))
        ? Number(w.precipitation_mm)
        : null,
    wind_max_m_s:
      w.wind_max_m_s != null && Number.isFinite(Number(w.wind_max_m_s))
        ? Number(w.wind_max_m_s)
        : null,
    amap_detail: w.amap_detail != null ? String(w.amap_detail) : null,
  };
}

/** @param {Record<string, unknown>} r */
function weatherFromDbRow(r) {
  return {
    provider: r.provider,
    fetched_at: r.fetched_at,
    summary: r.summary,
    temp_high_c: r.temp_high_c,
    temp_low_c: r.temp_low_c,
    icon_code: r.icon_code,
    precipitation_mm: r.precipitation_mm,
    wind_max_m_s: r.wind_max_m_s,
    amap_detail: r.amap_detail,
  };
}

function weatherRowHasAnyData(row) {
  return !!(
    row.provider ||
    row.fetched_at ||
    row.summary ||
    row.icon_code ||
    row.amap_detail ||
    (row.temp_high_c != null && Number.isFinite(row.temp_high_c)) ||
    (row.temp_low_c != null && Number.isFinite(row.temp_low_c)) ||
    (row.precipitation_mm != null && Number.isFinite(row.precipitation_mm)) ||
    (row.wind_max_m_s != null && Number.isFinite(row.wind_max_m_s))
  );
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function normalizeTimelineFilterOptions(opts) {
  const tags = Array.isArray(opts.tags)
    ? [...new Set(opts.tags.map((tag) => String(tag || "").trim()).filter(Boolean))]
    : [];
  return {
    query: String(opts.query || "").trim().toLowerCase(),
    tags,
  };
}

function buildTimelineWhereParts(filters) {
  const params = [];
  const clauses = [];
  if (filters.tags.length > 0) {
    const placeholders = filters.tags.map(() => "?").join(",");
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM entry_tags et
        JOIN tags t ON t.id = et.tag_id
        WHERE et.entry_id = e.id AND t.name IN (${placeholders})
      )`
    );
    params.push(...filters.tags);
  }
  if (filters.query) {
    const like = `%${escapeSqlLike(filters.query)}%`;
    clauses.push(
      `(
        lower(COALESCE(e.title, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(e.place, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(e.note, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM entry_tags et
          JOIN tags t ON t.id = et.tag_id
          WHERE et.entry_id = e.id AND lower(t.name) LIKE ? ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1
          FROM timeline_photos p
          WHERE p.entry_id = e.id AND lower(COALESCE(p.caption, '')) LIKE ? ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1
          FROM entry_gps g
          WHERE g.entry_id = e.id AND (
            lower(COALESCE(g.label, '')) LIKE ? ESCAPE '\\'
            OR CAST(g.latitude AS TEXT) LIKE ? ESCAPE '\\'
            OR CAST(g.longitude AS TEXT) LIKE ? ESCAPE '\\'
          )
        )
        OR EXISTS (
          SELECT 1
          FROM entry_weather w
          WHERE w.entry_id = e.id AND (
            lower(COALESCE(w.summary, '')) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(w.provider, '')) LIKE ? ESCAPE '\\'
          )
        )
      )`
    );
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function timelineOrderSql(sortDesc) {
  const order = sortDesc ? "DESC" : "ASC";
  return `ORDER BY e.calendar_date ${order}, e.gps_grid_key ${order}, e.id ${order}`;
}

function listTimelineTagNames(db, filters) {
  const built = buildTimelineWhereParts(filters);
  const rows = db
    .prepare(
      `SELECT DISTINCT t.name AS name
       FROM timeline_entries e
       JOIN entry_tags et ON et.entry_id = e.id
       JOIN tags t ON t.id = et.tag_id
       ${built.whereSql}
       ORDER BY t.name ASC`
    )
    .all(...built.params);
  return rows.map((row) => String(row.name));
}

function isNonGeographicPlaceNoise(value) {
  if (!value || typeof value !== "string") return true;
  const text = value.trim();
  if (!text) return true;
  if (/^(刚刚|刚才|昨天|今天|前天|近期|此刻|现在|刚刚发布)$/.test(text)) return true;
  if (/^\d+[分秒小时天周月年]前$/.test(text)) return true;
  return false;
}

function simplifyTimelinePlaceLabel(value) {
  const raw = String(value || "").trim();
  if (!raw || isNonGeographicPlaceNoise(raw)) return "";
  const trimmed = raw
    .replace(/^中国/, "")
    .replace(/^浙江省/, "")
    .replace(/^杭州市/, "")
    .replace(/^浙江省杭州市/, "")
    .replace(/^上海市/, "")
    .replace(/^北京市/, "")
    .replace(/^重庆市/, "")
    .replace(/^天津市/, "")
    .replace(/^(西湖区|余杭区|拱墅区|上城区|滨江区|萧山区|临平区|钱塘区)/, "")
    .trim();
  const source = trimmed || raw;
  const scenic =
    source.match(/([^省市区县]{1,24}(?:风景名胜区|景区|公园|山庄|寺|园|湖|山|馆|大学|学校))/g) || [];
  const streets =
    source.match(/([^省市区县]{1,12}(?:街道|镇|乡|村))/g) || [];
  const normalizedScenic = scenic.map((item) =>
    item.replace(/^[^省市区县]{1,12}(?:街道|镇|乡|村)/, "").trim()
  );
  const candidates = [...new Set([...normalizedScenic, ...streets])]
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  const picked = candidates
    .filter((item) => !/^(浙江省|杭州市|上海市|北京市|重庆市|天津市)$/.test(item))
    .slice(-2)
    .join(" / ");
  const shortLabel = (picked || source || raw).replace(/[，,]+/g, " · ").trim();
  return shortLabel.length > 28 ? shortLabel.slice(0, 28) : shortLabel;
}

function listTimelinePlaces(db, filters, sortDesc, limit = 24) {
  const built = buildTimelineWhereParts(filters);
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.calendar_date AS calendar_date, e.place AS place, g.label AS gps_label
       FROM timeline_entries e
       LEFT JOIN entry_gps g ON g.entry_id = e.id
       ${built.whereSql}
       ${timelineOrderSql(sortDesc)}`
    )
    .all(...built.params);
  const map = new Map();
  rows.forEach((row) => {
    const labelSource =
      (row.gps_label != null && String(row.gps_label).trim()) ||
      (row.place != null && String(row.place).trim()) ||
      "";
    const label = String(labelSource).trim();
    if (!label || isNonGeographicPlaceNoise(label)) return;
    if (!map.has(label)) {
      map.set(label, {
        label: simplifyTimelinePlaceLabel(label) || label,
        queryLabel: label,
        count: 0,
        anchorDate: row.calendar_date != null ? String(row.calendar_date) : "",
        anchorEntryId: row.id != null ? String(row.id) : "",
      });
    }
    map.get(label).count += 1;
  });
  return Array.from(map.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return sortDesc
        ? String(b.anchorDate).localeCompare(String(a.anchorDate))
        : String(a.anchorDate).localeCompare(String(b.anchorDate));
    })
    .slice(0, limit);
}

function groupTimelinePlaces(items, groupLimit = 8, childLimit = 6) {
  const groups = new Map();
  items.forEach((item) => {
    const parts = String(item.label || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const parentLabel = parts.length > 1 ? parts[parts.length - 1] : String(item.label || "").trim();
    const childLabel = parts.length > 1 ? parts[0] : "";
    const key = parentLabel || String(item.label || "").trim();
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, {
        label: key,
        count: 0,
        anchorDate: item.anchorDate,
        anchorEntryId: item.anchorEntryId,
        queryLabel: item.queryLabel,
        children: [],
      });
    }
    const group = groups.get(key);
    group.count += Number(item.count) || 0;
    if (!group.anchorDate || String(item.anchorDate || "").localeCompare(String(group.anchorDate || "")) > 0) {
      group.anchorDate = item.anchorDate;
      group.anchorEntryId = item.anchorEntryId;
      group.queryLabel = item.queryLabel;
    }
    if (childLabel && childLabel !== key) {
      group.children.push({
        label: childLabel,
        queryLabel: item.queryLabel,
        count: item.count,
        anchorDate: item.anchorDate,
        anchorEntryId: item.anchorEntryId,
      });
    }
  });
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      children: group.children
        .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label)))
        .slice(0, childLimit),
    }))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label)))
    .slice(0, groupLimit);
}

function getTimelineDateBounds(db, built) {
  const row = db
    .prepare(
      `SELECT MIN(e.calendar_date) AS min_date, MAX(e.calendar_date) AS max_date
       FROM timeline_entries e
       ${built.whereSql}`
    )
    .get(...built.params);
  return {
    minDate: row && row.min_date ? String(row.min_date) : "",
    maxDate: row && row.max_date ? String(row.max_date) : "",
  };
}

function getTimelineAnchorInfo(db, built, sortDesc, anchorDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate || ""))) {
    return null;
  }
  const normalized = String(anchorDate);
  const compare = sortDesc ? ">" : "<";
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM timeline_entries e
       ${built.whereSql ? `${built.whereSql} AND` : "WHERE"} e.calendar_date ${compare} ?`
    )
    .get(...built.params, normalized);
  const offset = countRow && countRow.c != null ? Number(countRow.c) : 0;
  const anchorRow = db
    .prepare(
      `SELECT e.id AS id, e.calendar_date AS calendar_date
       FROM timeline_entries e
       ${built.whereSql ? `${built.whereSql} AND` : "WHERE"} e.calendar_date ${sortDesc ? "<=" : ">="} ?
       ${timelineOrderSql(sortDesc)}
       LIMIT 1`
    )
    .get(...built.params, normalized);
  return {
    anchorDate: normalized,
    offset,
    entryId: anchorRow && anchorRow.id ? String(anchorRow.id) : "",
    matchedDate: anchorRow && anchorRow.calendar_date ? String(anchorRow.calendar_date) : "",
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string[]} ids
 */
function loadChildMapsForEntryIds(db, ids) {
  const tagsByEntry = new Map();
  const photosByEntry = new Map();
  const gpsById = new Map();
  const weatherById = new Map();
  if (ids.length === 0) {
    return { tagsByEntry, photosByEntry, gpsById, weatherById };
  }
  const ph = ids.map(() => "?").join(",");

  const tagRows = db
    .prepare(
      `SELECT et.entry_id AS entry_id, t.name AS name
       FROM entry_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.entry_id IN (${ph})
       ORDER BY t.name`
    )
    .all(...ids);
  for (const r of tagRows) {
    if (!tagsByEntry.has(r.entry_id)) tagsByEntry.set(r.entry_id, []);
    tagsByEntry.get(r.entry_id).push(r.name);
  }

  const photoRows = db
    .prepare(
      `SELECT id, entry_id, thumb, src, video, caption, ratio, visibility, sort_index,
              captured_at, camera_make, camera_model, lens_model, device_model,
              gps_latitude, gps_longitude, metadata_json, semantic_json
       FROM timeline_photos WHERE entry_id IN (${ph})
       ORDER BY entry_id, sort_index ASC`
    )
    .all(...ids);
  for (const p of photoRows) {
    if (!photosByEntry.has(p.entry_id)) photosByEntry.set(p.entry_id, []);
    const metadata = materializePhotoMetadataFromRow(p);
    const semantic = parseJsonObjectOrNull(p.semantic_json);
    photosByEntry.get(p.entry_id).push({
      id: p.id != null ? Number(p.id) : null,
      thumb: p.thumb != null ? p.thumb : null,
      src: p.src != null ? p.src : null,
      video: p.video != null ? p.video : null,
      caption: p.caption != null ? p.caption : null,
      ratio: p.ratio != null ? p.ratio : null,
      visibility: p.visibility != null ? String(p.visibility) : "public",
      metadata: metadata || null,
      semantic: semantic || null,
    });
  }

  const gpsRows = db.prepare(`SELECT * FROM entry_gps WHERE entry_id IN (${ph})`).all(...ids);
  for (const g of gpsRows) {
    gpsById.set(g.entry_id, g);
  }

  const wRows = db.prepare(`SELECT * FROM entry_weather WHERE entry_id IN (${ph})`).all(...ids);
  for (const w of wRows) {
    weatherById.set(w.entry_id, w);
  }

  return { tagsByEntry, photosByEntry, gpsById, weatherById };
}

/**
 * @param {Record<string, unknown>} row timeline_entries row
 * @param {object} maps 由 loadChildMapsForEntryIds 返回
 */
function assembleClientEntry(row, maps) {
  const { tagsByEntry, photosByEntry, gpsById, weatherById } = maps;
  const id = String(row.id);
  const w = weatherById.get(id);
  const weather = w ? weatherFromDbRow(w) : {};

  const g = gpsById.get(id);
  let gps = {};
  if (g && (g.latitude != null || g.longitude != null)) {
    gps = {
      latitude: g.latitude,
      longitude: g.longitude,
      altitude_m: g.altitude_m,
      label: g.label != null ? g.label : "",
    };
  }

  const cal =
    row.calendar_date != null && String(row.calendar_date).trim() !== ""
      ? String(row.calendar_date)
      : extractCalendarDate(String(row.date)) || "";
  const grid =
    row.gps_grid_key != null && String(row.gps_grid_key).trim() !== ""
      ? String(row.gps_grid_key)
      : "";

  return {
    id,
    calendar_date: cal,
    gps_grid_key: grid,
    date: String(row.date),
    title: row.title != null ? row.title : "",
    place: row.place != null ? row.place : "",
    note: row.note != null ? row.note : "",
    visibility:
      row.visibility != null && String(row.visibility).trim() !== ""
        ? String(row.visibility)
        : "public",
    tags: tagsByEntry.get(id) || [],
    gps,
    weather,
    photos: photosByEntry.get(id) || [],
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 */
export function readOneTimelineEntry(db, id) {
  const row = db
    .prepare(
      `SELECT id, calendar_date, gps_grid_key, date, title, place, note, visibility, data_version, source_path, updated_at
       FROM timeline_entries WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  const maps = loadChildMapsForEntryIds(db, [String(id)]);
  return assembleClientEntry(row, maps);
}

/**
 * 将单条条目 JSON 写入规范化表（事务内）。
 * @param {import("better-sqlite3").Database} db
 * @param {Record<string, unknown>} entry
 * @param {string} sourceRel
 * @param {string} updatedAt
 */
function upsertNormalizedEntryFromObject(db, entry, sourceRel, updatedAt) {
  const date = entry && entry.date != null ? String(entry.date) : null;
  if (!date) throw new Error("entry date required");

  const calendarDate = extractCalendarDate(date);
  if (!calendarDate) throw new Error("entry date must yield a calendar day (YYYY-MM-DD)");

  const coords = _readGpsCoords(entry.gps);
  const gpsGridKey = coords ? gpsGridKeyFromCoords(coords.lat, coords.lng) : "nogps";
  const id = deriveBusinessEntryId(calendarDate, gpsGridKey);

  const title = entry.title != null ? String(entry.title) : "";
  const place = entry.place != null ? String(entry.place) : "";
  const note = entry.note != null ? String(entry.note) : "";
  const dataVersion = entry.data_version != null ? String(entry.data_version) : null;

  const insMain = db.prepare(`
    INSERT INTO timeline_entries (id, calendar_date, gps_grid_key, date, title, place, note, visibility, data_version, source_path, updated_at)
    VALUES (@id, @calendar_date, @gps_grid_key, @date, @title, @place, @note, @visibility, @data_version, @source_path, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      calendar_date = excluded.calendar_date,
      gps_grid_key = excluded.gps_grid_key,
      date = excluded.date,
      title = excluded.title,
      place = excluded.place,
      note = excluded.note,
      visibility = excluded.visibility,
      data_version = excluded.data_version,
      source_path = excluded.source_path,
      updated_at = excluded.updated_at
  `);

  const delTags = db.prepare(`DELETE FROM entry_tags WHERE entry_id = ?`);
  const insTag = db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`);
  const tagId = db.prepare(`SELECT id FROM tags WHERE name = ?`);
  const linkTag = db.prepare(`INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`);

  const delGps = db.prepare(`DELETE FROM entry_gps WHERE entry_id = ?`);
  const insGps = db.prepare(`
    INSERT INTO entry_gps (entry_id, latitude, longitude, altitude_m, label)
    VALUES (@entry_id, @latitude, @longitude, @altitude_m, @label)
  `);

  const delWeather = db.prepare(`DELETE FROM entry_weather WHERE entry_id = ?`);
  const insWeather = db.prepare(`
    INSERT INTO entry_weather (
      entry_id, provider, fetched_at, summary, temp_high_c, temp_low_c,
      icon_code, precipitation_mm, wind_max_m_s, amap_detail
    ) VALUES (
      @entry_id, @provider, @fetched_at, @summary, @temp_high_c, @temp_low_c,
      @icon_code, @precipitation_mm, @wind_max_m_s, @amap_detail
    )
  `);

  const incomingVisRaw = entry.visibility != null ? String(entry.visibility) : "";
  const incomingVis = incomingVisRaw.trim().toLowerCase() === "private" ? "private" : "";
  const prevRow = db.prepare(`SELECT visibility FROM timeline_entries WHERE id = ?`).get(id);
  const prevVis =
    prevRow && prevRow.visibility != null && String(prevRow.visibility).trim().toLowerCase() === "private"
      ? "private"
      : "public";
  const visibility = incomingVis ? "private" : prevRow ? prevVis : "public";

  const run = db.transaction(() => {
    insMain.run({
      id,
      calendar_date: calendarDate,
      gps_grid_key: gpsGridKey,
      date: calendarDate,
      title,
      place,
      note,
      visibility,
      data_version: dataVersion,
      source_path: sourceRel,
      updated_at: updatedAt,
    });

    delTags.run(id);
    const tagList = Array.isArray(entry.tags) ? entry.tags : [];
    for (const raw of tagList) {
      const name = String(raw).trim();
      if (!name) continue;
      insTag.run(name);
      const tid = tagId.get(name);
      if (tid && tid.id != null) linkTag.run(id, tid.id);
    }

    mergePhotosFromIncomingForUpsert(db, id, entry.photos);

    delGps.run(id);
    const coords = _readGpsCoords(entry.gps);
    if (coords) {
      const gps = entry.gps && typeof entry.gps === "object" ? entry.gps : {};
      const alt = gps.altitude_m;
      insGps.run({
        entry_id: id,
        latitude: coords.lat,
        longitude: coords.lng,
        altitude_m:
          alt != null && Number.isFinite(Number(alt)) ? Number(alt) : null,
        label: gps.label != null ? String(gps.label) : "",
      });
    }

    delWeather.run(id);
    const wr = weatherToDbRow(
      entry.weather && typeof entry.weather === "object" ? entry.weather : null
    );
    if (weatherRowHasAnyData(wr)) {
      insWeather.run({
        entry_id: id,
        ...wr,
      });
    }
  });

  run();
}

/**
 * 若条目仍关联磁盘上的 photo-timeline-entry.json，则把当前 API 形态写回该文件（可选，便于工具链）。
 * @param {string} publicDir
 * @param {string | null | undefined} sourceRel
 * @param {string} id
 * @param {Record<string, unknown>} entry
 */
function writeEntryToSourceJsonFile(publicDir, serverDir, sourceRel, id, entry) {
  if (!sourceRel) return;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  let absPath;
  try {
    absPath = resolveVerifiedSiteFilePath(publicDir, liveRoot, sourceRel);
  } catch {
    return;
  }
  if (!fs.existsSync(absPath)) return;
  let fileJson;
  try {
    fileJson = JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return;
  }
  const entries = Array.isArray(fileJson.entries) ? fileJson.entries : [];
  const idx = entries.findIndex((e) => {
    if (!e) return false;
    if (e.id === id) return true;
    const der = deriveBusinessEntryIdFromObject(e);
    return der === id;
  });
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  fileJson.entries = entries;
  fs.writeFileSync(absPath, JSON.stringify(fileJson, null, 2), "utf8");
}

/**
 * 时间轴写回（天气 / 地名）调试日志，默认 server/.data/photo-timeline-write.log
 * 可通过环境变量 PHOTO_TIMELINE_WRITE_LOG 指定绝对路径或相对 server 目录的路径。
 */
function getPhotoTimelineWriteLogPath(serverDir) {
  const custom = String(process.env.PHOTO_TIMELINE_WRITE_LOG || "").trim();
  if (custom) {
    return path.isAbsolute(custom) ? custom : path.join(serverDir, custom);
  }
  return path.join(serverDir, ".data", "photo-timeline-write.log");
}

function appendPhotoTimelineWriteLog(serverDir, message) {
  try {
    const logPath = getPhotoTimelineWriteLogPath(serverDir);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${String(message).trim()}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  } catch (e) {
    console.error("[photo-timeline] appendPhotoTimelineWriteLog:", e && e.message);
  }
}

function jsonSnippet(obj, maxLen) {
  const n = maxLen != null ? maxLen : 4500;
  try {
    const s = JSON.stringify(obj);
    return s.length > n ? `${s.slice(0, n)}…(truncated,len=${s.length})` : s;
  } catch (e) {
    return String(e && e.message);
  }
}

/** Open-Meteo 天气调试：终端 + photo-timeline-write.log */
function logOpenMeteoWeather(serverDir, message) {
  const line = `[open-meteo] ${message}`;
  console.log(line);
  if (serverDir) appendPhotoTimelineWriteLog(serverDir, line);
}

/** WMO weathercode（Open-Meteo daily）→ 简短中文 */
const WMO_SUMMARY_ZH = {
  0: "晴",
  1: "大部晴朗",
  2: "少云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "大冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "大冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "大阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};

function wmoCodeToZhSummary(code) {
  if (code == null || Number.isNaN(Number(code))) return "未知";
  const c = Math.round(Number(code));
  return WMO_SUMMARY_ZH[c] || `天气码 ${c}`;
}

/**
 * 按需天气：Open-Meteo 无 Key。过去日期用 archive；今天及未来用 forecast。
 * @param {number} lat
 * @param {number} lng
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} [serverDir]
 */
async function fetchOpenMeteoWeatherForDate(lat, lng, dateStr, serverDir) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const useForecast = dateStr >= todayUtc;
  const daily =
    "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,wind_speed_10m_max";
  const u = new URL(
    useForecast
      ? "https://api.open-meteo.com/v1/forecast"
      : "https://archive-api.open-meteo.com/v1/archive"
  );
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("start_date", dateStr);
  u.searchParams.set("end_date", dateStr);
  u.searchParams.set("daily", daily);
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("windspeed_unit", "ms");

  logOpenMeteoWeather(
    serverDir,
    `${useForecast ? "forecast" : "archive"} date=${dateStr} lat=${lat} lng=${lng}`
  );
  logOpenMeteoWeather(serverDir, `GET ${u.toString()}`);

  const res = await fetch(u.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
  const data = await res.json();
  const d = data.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) {
    logOpenMeteoWeather(serverDir, `empty daily ${jsonSnippet(data, 2000)}`);
    throw new Error("Open-Meteo 未返回该日数据");
  }
  let idx = d.time.indexOf(dateStr);
  if (idx < 0) idx = 0;
  const tmax = d.temperature_2m_max != null ? d.temperature_2m_max[idx] : null;
  const tmin = d.temperature_2m_min != null ? d.temperature_2m_min[idx] : null;
  const precip = d.precipitation_sum != null ? d.precipitation_sum[idx] : null;
  const wcode = d.weathercode != null ? d.weathercode[idx] : null;
  const wmax = d.wind_speed_10m_max != null ? d.wind_speed_10m_max[idx] : null;

  const summary = wmoCodeToZhSummary(wcode);
  const detail = useForecast
    ? "Open-Meteo 预报 API（日级：最高/最低温、降水、WMO 天气码）"
    : "Open-Meteo 历史归档 ERA5/Land 等（日级再分析，非当日实况观测）";

  logOpenMeteoWeather(
    serverDir,
    `OK summary=${summary} tmax=${tmax} tmin=${tmin} precip=${precip} code=${wcode}`
  );

  return {
    provider: "open-meteo",
    fetched_at: new Date().toISOString(),
    summary: summary.slice(0, 120),
    temp_high_c: tmax != null ? Math.round(Number(tmax)) : null,
    temp_low_c: tmin != null ? Math.round(Number(tmin)) : null,
    icon_code: `wmo-${wcode ?? "?"}`,
    precipitation_mm: precip != null ? Math.round(Number(precip) * 100) / 100 : null,
    wind_max_m_s:
      wmax != null ? Math.round(Number(wmax) * 10) / 10 : null,
    amap_detail: detail,
  };
}

function _isLoopbackIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1"
  );
}

function _constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function _isProbablyProxied(req) {
  return !!(req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
}

/**
 * POST /api/photo-timeline/sync 鉴权：
 * - 密钥：与后台相同，见 getWriteSecret()（统一为 ADMIN_SECRET）。
 * - 请求头：X-Photo-Timeline-Sync-Secret，或 Authorization: Bearer <同一密钥>。
 * - 未设置密钥时：仅允许直连 Node 且 remote 为 loopback，且**无**反向代理头。
 * - 存在 X-Forwarded-For / X-Real-Ip 时必须配置密钥。
 */
export function assertPhotoTimelineSyncAuth(req, res) {
  const secret = getWriteSecret();
  const headerLegacy = String(req.headers[SYNC_HEADER] || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  const bearer = m ? m[1].trim() : "";
  const proxied = _isProbablyProxied(req);

  if (proxied && !secret) {
    res.status(503).json({
      ok: false,
      error:
        "ADMIN_SECRET required when behind a reverse proxy (X-Forwarded-For present)",
    });
    return false;
  }
  if (secret) {
    const ok =
      (headerLegacy && _constantTimeEqual(headerLegacy, secret)) ||
      (bearer && _constantTimeEqual(bearer, secret));
    if (!ok) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }
  if (!_isLoopbackIp(req.socket.remoteAddress)) {
    res.status(403).json({
      ok: false,
      error:
        "sync forbidden: set ADMIN_SECRET in server/.env, or call only from localhost without proxy headers",
    });
    return false;
  }
  return true;
}

/**
 * @param {{ publicDir: string; serverDir: string }} opts
 * @returns {{ scanned: number; upserted: number; errors: string[] }}
 */
export function syncPhotoTimelineFromDisk(opts) {
  const publicDir = opts.publicDir;
  const serverDir = opts.serverDir;
  const dataDir = path.join(serverDir, ".data");
  const dbPath = path.join(dataDir, "photo-timeline.sqlite");
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);

  const errors = [];
  let scanned = 0;
  let upserted = 0;

  if (!fs.existsSync(liveRoot)) {
    fs.mkdirSync(liveRoot, { recursive: true });
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const jsonFiles = [];
  function walk(dir) {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(String(dir) + ": " + (e && e.message));
      return;
    }
    for (const ent of names) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "photo-timeline-entry.json") jsonFiles.push(full);
    }
  }
  walk(liveRoot);
  scanned = jsonFiles.length;

  const now = new Date().toISOString();

  for (const fp of jsonFiles) {
    try {
      const raw = fs.readFileSync(fp, "utf8");
      const data = JSON.parse(raw);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const sourceRel = sourcePathForEntryJson(publicDir, fp);
      for (const entry of entries) {
        if (!entry || !entry.date) {
          errors.push(`${fp}: 跳过无效条目（需要 date）`);
          continue;
        }
        upsertNormalizedEntryFromObject(db, entry, sourceRel, now);
        upserted += 1;
      }
    } catch (e) {
      errors.push(`${fp}: ${e && e.message}`);
    }
  }

  db.close();
  return { scanned, upserted, errors };
}

/**
 * @param {{ publicDir: string; serverDir: string; sortDesc?: boolean }} opts
 */
export function readAllTimelineEntries(opts) {
  const serverDir = opts.serverDir;
  const sortDesc = opts.sortDesc !== false;
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const order = sortDesc ? "DESC" : "ASC";
  const mainRows = db
    .prepare(
      `SELECT id, calendar_date, gps_grid_key, date, title, place, note, visibility, data_version, source_path, updated_at
       FROM timeline_entries ORDER BY calendar_date ${order}, gps_grid_key ${order === "DESC" ? "DESC" : "ASC"}, id ${order}`
    )
    .all();
  const ids = mainRows.map((r) => String(r.id));
  const maps = loadChildMapsForEntryIds(db, ids);
  db.close();
  return mainRows.map((row) => assembleClientEntry(row, maps));
}

/**
 * @param {{ serverDir: string; sortDesc?: boolean; offset?: number; limit?: number; query?: string; tags?: string[] }} opts
 */
export function readTimelineEntriesPage(opts) {
  const serverDir = opts.serverDir;
  const sortDesc = opts.sortDesc !== false;
  const rawLimit = Math.floor(Number(opts.limit) || 5);
  const limit = Math.max(1, Math.min(1000, rawLimit));
  const filters = normalizeTimelineFilterOptions(opts);
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    return {
      entries: [],
      total: 0,
      offset: 0,
      limit,
      nextOffset: null,
      availableTags: [],
      availablePlaces: [],
      availablePlaceGroups: [],
    };
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const built = buildTimelineWhereParts(filters);
  const dateBounds = getTimelineDateBounds(db, built);
  const anchorInfo = getTimelineAnchorInfo(db, built, sortDesc, opts.anchorDate);
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM timeline_entries e ${built.whereSql}`)
    .get(...built.params);
  const total = totalRow && totalRow.c != null ? Number(totalRow.c) : 0;
  const requestedOffset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const offsetBase = anchorInfo ? Math.floor(anchorInfo.offset / limit) * limit : requestedOffset;
  const offset = Math.max(0, Math.min(offsetBase, Math.max(0, total - 1)));
  const mainRows = db
    .prepare(
      `SELECT id, calendar_date, gps_grid_key, date, title, place, note, visibility, data_version, source_path, updated_at
       FROM timeline_entries e
       ${built.whereSql}
       ${timelineOrderSql(sortDesc)}
       LIMIT ? OFFSET ?`
    )
    .all(...built.params, limit, offset);
  const ids = mainRows.map((row) => String(row.id));
  const maps = loadChildMapsForEntryIds(db, ids);
  const availableTags = listTimelineTagNames(db, filters);
  const availablePlaces = listTimelinePlaces(db, filters, sortDesc);
  const availablePlaceGroups = groupTimelinePlaces(availablePlaces);
  db.close();
  return {
    entries: mainRows.map((row) => assembleClientEntry(row, maps)),
    total,
    offset,
    limit,
    nextOffset: offset + mainRows.length < total ? offset + mainRows.length : null,
    availableTags,
    availablePlaces,
    availablePlaceGroups,
    minDate: dateBounds.minDate,
    maxDate: dateBounds.maxDate,
    anchorEntryId: anchorInfo ? anchorInfo.entryId : "",
    anchorMatchedDate: anchorInfo ? anchorInfo.matchedDate : "",
  };
}

/**
 * 读取地图页需要的轻量点位数据。
 * @param {{ serverDir: string; sortDesc?: boolean }} opts
 */
export function readTimelineMapPoints(opts) {
  const serverDir = opts.serverDir;
  const sortDesc = opts.sortDesc !== false;
  const allowPrivate = opts.allowPrivate === true;
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { points: [], total: 0 };
  }

  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const mainRows = db
    .prepare(
      `SELECT e.id, e.calendar_date, e.gps_grid_key, e.date, e.title, e.place, e.note, e.visibility, e.data_version, e.source_path, e.updated_at
       FROM timeline_entries e
       JOIN entry_gps g ON g.entry_id = e.id
       WHERE g.latitude IS NOT NULL AND g.longitude IS NOT NULL
       ${timelineOrderSql(sortDesc)}`
    )
    .all();
  const ids = mainRows.map((row) => String(row.id));
  const maps = loadChildMapsForEntryIds(db, ids);
  db.close();

  let points = mainRows
    .map((row) => assembleClientEntry(row, maps))
    .map((entry) => {
      const coords = _readGpsCoords(entry.gps);
      if (!coords) return null;
      if (!isEntryVisibleForViewer(entry, allowPrivate)) return null;
      const photos = Array.isArray(entry.photos) ? entry.photos.slice() : [];
      const visiblePhotos = photos.filter((p) => {
        if (!p || typeof p !== "object") return false;
        const v = p.visibility != null ? String(p.visibility).toLowerCase() : "public";
        if (v !== "private") return true;
        return allowPrivate;
      });
      if (!visiblePhotos.length) return null;
      const cover = visiblePhotos.length ? visiblePhotos[0] : null;
      return {
        id: String(entry.id || ""),
        date: entry.date != null ? String(entry.date) : "",
        calendar_date: entry.calendar_date != null ? String(entry.calendar_date) : "",
        title: entry.title != null ? String(entry.title) : "",
        place: entry.place != null ? String(entry.place) : "",
        note: entry.note != null ? String(entry.note) : "",
        gps_grid_key: entry.gps_grid_key != null ? String(entry.gps_grid_key) : "",
        gps: {
          latitude: coords.lat,
          longitude: coords.lng,
          label:
            entry.gps && entry.gps.label != null ? String(entry.gps.label).trim() : "",
        },
        photoCount: visiblePhotos.length,
        cover: cover
          ? {
              thumb: cover.thumb != null ? String(cover.thumb) : "",
              src: cover.src != null ? String(cover.src) : "",
              caption: cover.caption != null ? String(cover.caption) : "",
            }
          : null,
      };
    })
    .filter(Boolean);

  if (!allowPrivate && points.length > GUEST_VISIBLE_PHOTO_LIMIT) {
    points = points.slice(0, GUEST_VISIBLE_PHOTO_LIMIT);
  }

  return { points, total: points.length };
}

function filterEntryPhotosByVisibility(entry, allowPrivate) {
  if (!entry || typeof entry !== "object") return entry;
  const photos = Array.isArray(entry.photos) ? entry.photos : [];
  entry.photos = photos.filter((p) => {
    if (!p || typeof p !== "object") return false;
    const v = p.visibility != null ? String(p.visibility).toLowerCase() : "public";
    if (v !== "private") return true;
    return allowPrivate;
  });
  return entry;
}

function cloneEntryWithVisiblePhotos(entry, allowPrivate) {
  if (!entry || typeof entry !== "object") return null;
  const next = { ...entry };
  return filterEntryPhotosByVisibility(next, allowPrivate);
}

function limitEntriesToPhotoCount(entries, photoLimit) {
  const maxPhotos = Math.max(0, Math.floor(Number(photoLimit) || 0));
  if (!maxPhotos) return { entries: [], photoCount: 0, truncated: Array.isArray(entries) && entries.length > 0 };
  const src = Array.isArray(entries) ? entries : [];
  const out = [];
  let remaining = maxPhotos;
  let count = 0;
  let truncated = false;
  for (const item of src) {
    if (!item || typeof item !== "object") continue;
    const photos = Array.isArray(item.photos) ? item.photos : [];
    if (!photos.length) continue;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (photos.length <= remaining) {
      out.push(item);
      remaining -= photos.length;
      count += photos.length;
      continue;
    }
    out.push({ ...item, photos: photos.slice(0, remaining) });
    count += remaining;
    remaining = 0;
    truncated = true;
    break;
  }
  if (!truncated && out.length < src.filter((item) => item && Array.isArray(item.photos) && item.photos.length).length) {
    truncated = true;
  }
  return { entries: out, photoCount: count, truncated };
}

function isEntryVisibleForViewer(entry, allowPrivate) {
  if (!entry || typeof entry !== "object") return false;
  const v = entry.visibility != null ? String(entry.visibility).trim().toLowerCase() : "public";
  if (v === "private") return allowPrivate;
  return true;
}

/**
 * 后台：分页读取所有照片（平铺结构，便于批量操作）。
 * @param {{ serverDir: string; offset?: number; limit?: number; query?: string; visibility?: string; entryVisibility?: string }} opts
 */
export function readTimelinePhotosPage(opts) {
  const serverDir = opts.serverDir;
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(opts.limit) || 500)));
  const q = String(opts.query || "").trim().toLowerCase();
  const vis = String(opts.visibility || "").trim().toLowerCase();
  const evis = String(opts.entryVisibility || "").trim().toLowerCase();

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { items: [], total: 0, offset, limit, nextOffset: null };
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const where = [];
  const params = [];
  if (q) {
    const like = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    where.push(
      `(LOWER(COALESCE(p.caption, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(e.title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.src, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.thumb, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.video, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(e.id, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.camera_model, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.device_model, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.metadata_json, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.semantic_json, '')) LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  if (vis === "public" || vis === "private") {
    where.push(`LOWER(COALESCE(p.visibility, 'public')) = ?`);
    params.push(vis);
  }
  if (evis === "public" || evis === "private") {
    where.push(`LOWER(COALESCE(e.visibility, 'public')) = ?`);
    params.push(evis);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM timeline_photos p
       JOIN timeline_entries e ON e.id = p.entry_id
       ${whereSql}`
    )
    .get(...params);
  const total = totalRow && totalRow.c != null ? Number(totalRow.c) : 0;

  const rows = db
    .prepare(
      `SELECT
         p.id AS photo_id,
         p.entry_id AS entry_id,
         p.thumb AS thumb,
         p.src AS src,
         p.video AS video,
         p.caption AS caption,
         p.ratio AS ratio,
         p.visibility AS photo_visibility,
         p.sort_index AS sort_index,
         p.captured_at AS captured_at,
         p.camera_make AS camera_make,
         p.camera_model AS camera_model,
         p.lens_model AS lens_model,
         p.device_model AS device_model,
         p.gps_latitude AS gps_latitude,
         p.gps_longitude AS gps_longitude,
         p.metadata_json AS metadata_json,
         p.semantic_json AS semantic_json,
         e.calendar_date AS calendar_date,
         e.date AS date,
         e.title AS title,
         e.place AS place,
         e.visibility AS entry_visibility
       FROM timeline_photos p
       JOIN timeline_entries e ON e.id = p.entry_id
       ${whereSql}
       ORDER BY e.calendar_date DESC, e.id DESC, p.sort_index ASC, p.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  db.close();

  const items = rows.map((r) => ({
    photoId: r.photo_id != null ? Number(r.photo_id) : null,
    entryId: r.entry_id != null ? String(r.entry_id) : "",
    thumb: r.thumb != null ? String(r.thumb) : "",
    src: r.src != null ? String(r.src) : "",
    video: r.video != null ? String(r.video) : "",
    caption: r.caption != null ? String(r.caption) : "",
    ratio: r.ratio != null ? String(r.ratio) : "",
    visibility: r.photo_visibility != null ? String(r.photo_visibility) : "public",
    capturedAt: r.captured_at != null ? String(r.captured_at) : "",
    cameraMake: r.camera_make != null ? String(r.camera_make) : "",
    cameraModel: r.camera_model != null ? String(r.camera_model) : "",
    lensModel: r.lens_model != null ? String(r.lens_model) : "",
    deviceModel: r.device_model != null ? String(r.device_model) : "",
    metadata: materializePhotoMetadataFromRow(r),
    semantic: parseJsonObjectOrNull(r.semantic_json),
    sortIndex: r.sort_index != null ? Number(r.sort_index) : 0,
    calendarDate: r.calendar_date != null ? String(r.calendar_date) : "",
    date: r.date != null ? String(r.date) : "",
    title: r.title != null ? String(r.title) : "",
    place: r.place != null ? String(r.place) : "",
    entryVisibility: r.entry_visibility != null ? String(r.entry_visibility) : "public",
  }));

  const nextOffset = offset + items.length < total ? offset + items.length : null;
  return { items, total, offset, limit, nextOffset };
}

/**
 * 后台：批量更新照片可见性（并写回关联 source JSON）。
 * @param {{ publicDir: string; serverDir: string; photoIds: (number|string)[]; visibility: string }} opts
 */
export function updateTimelinePhotosVisibilityBulk(opts) {
  const { publicDir, serverDir } = opts;
  const idsIn = Array.isArray(opts.photoIds) ? opts.photoIds : [];
  const ids = Array.from(
    new Set(
      idsIn
        .map((x) => Math.floor(Number(x)))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );
  if (!ids.length) throw new Error("photoIds 不能为空");
  const visibility = String(opts.visibility || "").trim().toLowerCase() === "private" ? "private" : "public";

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, entry_id FROM timeline_photos WHERE id IN (${ph})`)
    .all(...ids);
  if (!rows.length) {
    db.close();
    throw new Error("未找到任何照片");
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE timeline_photos SET visibility = ? WHERE id IN (${ph})`).run(
      visibility,
      ...ids
    );
  });
  tx();

  const entryIds = Array.from(new Set(rows.map((r) => String(r.entry_id || "")).filter(Boolean)));
  const sourceByEntry = new Map();
  for (const eid of entryIds) {
    const r = db.prepare(`SELECT source_path FROM timeline_entries WHERE id = ?`).get(eid);
    sourceByEntry.set(eid, r && r.source_path != null ? String(r.source_path) : "");
  }

  const entries = [];
  for (const eid of entryIds) {
    const entry = readOneTimelineEntry(db, eid);
    if (entry) entries.push({ entryId: eid, sourceRel: sourceByEntry.get(eid) || "", entry });
  }
  db.close();

  for (const item of entries) {
    writeEntryToSourceJsonFile(publicDir, serverDir, item.sourceRel, item.entryId, item.entry);
  }
  appendPhotoTimelineWriteLog(
    serverDir,
    `admin-batch-visibility photos=${rows.length} entries=${entryIds.length} visibility=${visibility}`
  );
  return { ok: true, updatedPhotos: rows.length, updatedEntries: entryIds.length, visibility };
}

/**
 * 更新单张照片元数据。
 * @param {{ publicDir: string; serverDir: string; entryId: string; photoId: number|string; patch: { visibility?: string; caption?: string; semantic?: Record<string, unknown> } }} opts
 */
export function updateTimelinePhotoMeta(opts) {
  const { publicDir, serverDir } = opts;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const entryId = String(opts.entryId || "").trim();
  const photoId = Math.floor(Number(opts.photoId));
  const patch = opts.patch && typeof opts.patch === "object" ? opts.patch : {};
  if (!entryId) throw new Error("invalid entryId");
  if (!Number.isFinite(photoId) || photoId <= 0) throw new Error("invalid photoId");

  const rawVis = patch.visibility != null ? String(patch.visibility) : "";
  const vis = rawVis.trim().toLowerCase() === "private" ? "private" : "public";

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const row = db.prepare(`SELECT id, source_path FROM timeline_entries WHERE id = ?`).get(entryId);
  if (!row) {
    db.close();
    throw new Error("条目不存在或未入库");
  }
  const sourceRel = row.source_path != null ? String(row.source_path) : "";

  const pRow = db
    .prepare(`SELECT id, entry_id, caption, metadata_json, semantic_json, visibility FROM timeline_photos WHERE id = ?`)
    .get(photoId);
  if (!pRow || String(pRow.entry_id) !== entryId) {
    db.close();
    throw new Error("照片不存在或不属于该条目");
  }

  const nextCaption =
    patch.caption !== undefined ? String(patch.caption) : pRow.caption != null ? String(pRow.caption) : "";
  const prevSemantic = parseJsonObjectOrNull(pRow.semantic_json);
  const nextSemantic =
    patch.semantic !== undefined
      ? normalizePhotoSemanticInput({ ...(prevSemantic || {}), ...(patch.semantic && typeof patch.semantic === "object" ? patch.semantic : {}) })
      : prevSemantic;

  db.prepare(`UPDATE timeline_photos SET visibility = ?, caption = ?, semantic_json = ? WHERE id = ?`).run(
    patch.visibility !== undefined ? vis : pRow.visibility != null ? String(pRow.visibility) : "public",
    nextCaption,
    nextSemantic ? JSON.stringify(nextSemantic) : null,
    photoId
  );

  const entry = readOneTimelineEntry(db, entryId);
  db.close();
  if (!entry) throw new Error("update failed: entry missing after save");

  // 写回 source json（仅写回媒体与可见性，避免丢数据）
  writeEntryToSourceJsonFile(publicDir, serverDir, sourceRel, entryId, entry);
  appendPhotoTimelineWriteLog(
    serverDir,
    `admin-update-photo entry=${entryId} photo=${photoId} visibility=${patch.visibility !== undefined ? vis : "keep"}`
  );
  return entry;
}

/**
 * 调用视觉模型为单张照片生成“地点 / 场景 / 摘要 / 通用 caption”建议。
 * 不做人物身份识别；people 始终留给人工维护。
 * @param {{ publicDir: string; serverDir: string; entryId: string; photoId: number|string; prompt?: string }} opts
 */
export async function suggestTimelinePhotoSemanticFromAI(opts) {
  const { publicDir, serverDir } = opts;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const entryId = String(opts.entryId || "").trim();
  const photoId = Math.floor(Number(opts.photoId));
  if (!entryId) throw new Error("invalid entryId");
  if (!Number.isFinite(photoId) || photoId <= 0) throw new Error("invalid photoId");

  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("未配置 OPENAI_API_KEY");
  const model = getPhotoTimelineVisionModel();
  if (!model) throw new Error("未配置 PHOTO_TIMELINE_VISION_MODEL");

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const row = db
    .prepare(
      `SELECT
         p.id AS photo_id,
         p.entry_id AS entry_id,
         p.thumb AS thumb,
         p.src AS src,
         p.video AS video,
         p.caption AS caption,
         p.metadata_json AS metadata_json,
         p.semantic_json AS semantic_json,
         e.title AS entry_title,
         e.place AS entry_place,
         e.date AS entry_date,
         e.calendar_date AS calendar_date,
         e.note AS entry_note
       FROM timeline_photos p
       JOIN timeline_entries e ON e.id = p.entry_id
       WHERE p.id = ?`
    )
    .get(photoId);
  db.close();

  if (!row || String(row.entry_id) !== entryId) throw new Error("照片不存在或不属于该条目");
  const asset = pickPhotoAnalysisAsset(publicDir, liveRoot, row);
  const fileBase64 = fs.readFileSync(asset.absPath).toString("base64");
  const imageUrl = `data:${asset.mimeType};base64,${fileBase64}`;
  const metadata = materializePhotoMetadataFromRow(row);
  const semantic = parseJsonObjectOrNull(row.semantic_json);

  const promptOverride = String(opts.prompt || "").trim() || getPhotoTimelineVisionPromptOverride();
  const instruction =
    promptOverride ||
    [
      "请分析这张照片，并生成适合照片时间轴管理后台使用的结构化建议。",
      "只根据可见内容与给定上下文回答，不要编造无法确认的细节。",
      "禁止识别人脸身份、禁止猜测真实姓名，因此 people 必须返回空数组。",
      "优先输出：更自然的 caption、地点名称建议、地点分类、场景主类、场景标签、简短摘要、需要人工复核的备注。",
      "如果无法确认地点，就保持 place_name 为空字符串；如果场景不明确，也保持简洁。",
    ].join("\n");

  const userContext = {
    entry: {
      title: row.entry_title != null ? String(row.entry_title) : "",
      place: row.entry_place != null ? String(row.entry_place) : "",
      date: row.calendar_date != null ? String(row.calendar_date) : row.entry_date != null ? String(row.entry_date) : "",
      note: row.entry_note != null ? String(row.entry_note) : "",
    },
    photo: {
      caption: row.caption != null ? String(row.caption) : "",
      metadata,
      semantic,
      asset_path: asset.relPath,
    },
  };

  const reqBody = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: instruction }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "请根据这张照片和上下文生成结构化 JSON 建议。\n上下文：\n" +
              JSON.stringify(userContext, null, 2),
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "photo_timeline_semantic_suggestion",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            caption: { type: "string" },
            semantic: {
              type: "object",
              additionalProperties: false,
              properties: {
                people: { type: "array", items: { type: "string" } },
                place_name: { type: "string" },
                place_category: { type: "string" },
                scene: { type: "string" },
                scene_tags: { type: "array", items: { type: "string" } },
                summary: { type: "string" },
                source: { type: "string" },
                notes: { type: "string" },
              },
              required: [
                "people",
                "place_name",
                "place_category",
                "scene",
                "scene_tags",
                "summary",
                "source",
                "notes",
              ],
            },
          },
          required: ["caption", "semantic"],
        },
      },
    },
  };

  const response = await fetch(`${getOpenAIBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg =
      payload && payload.error && payload.error.message
        ? String(payload.error.message)
        : response.statusText || `HTTP ${response.status}`;
    throw new Error(`AI 分析失败：${msg}`);
  }

  const text = extractOpenAIResponseText(payload);
  if (!text) throw new Error("AI 未返回可解析的结果");

  let suggestion;
  try {
    suggestion = JSON.parse(text);
  } catch {
    throw new Error("AI 返回结果不是合法 JSON");
  }

  const nextSemantic = normalizePhotoSemanticInput({
    ...(suggestion && suggestion.semantic && typeof suggestion.semantic === "object" ? suggestion.semantic : {}),
    people: [],
    source: `ai:${model}`,
  }) || {
    people: [],
    place_name: "",
    place_category: "",
    scene: "",
    scene_tags: [],
    summary: "",
    source: `ai:${model}`,
    notes: "",
  };

  return {
    entryId,
    photoId,
    model,
    assetPath: asset.relPath,
    caption: suggestion && suggestion.caption != null ? String(suggestion.caption).trim() : "",
    semantic: nextSemantic,
  };
}

function sanitizeAmapKey(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/[0-9a-fA-F]{32}/);
  return m ? m[0] : s;
}

function getAmapWebKey() {
  return sanitizeAmapKey(process.env.AMAP_WEB_KEY || process.env.AMAP_KEY || "");
}

function getAmapJsKey() {
  const jsKey = sanitizeAmapKey(process.env.AMAP_JS_KEY || "");
  if (jsKey) return jsKey;
  return getAmapWebKey();
}

function getAmapSecurityJsCode() {
  return String(process.env.AMAP_SECURITY_JS_CODE || "").trim();
}

function isOsmNominatimFallbackEnabled() {
  const v = String(
    process.env.OSM_NOMINATIM_FALLBACK ||
      process.env.OPENSTREETMAP_FALLBACK ||
      ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function getPhotoTimelineHttpUserAgent() {
  return String(
    process.env.PHOTO_TIMELINE_HTTP_USER_AGENT ||
      "resume-photo-timeline/1.0 (+local reverse geocode fallback)"
  ).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Record<string, unknown>} ac */
function _amapCityName(ac) {
  if (!ac || typeof ac !== "object") return "";
  const c = ac.city;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c) && c.length && typeof c[0] === "string") return c[0].trim();
  return "";
}

/**
 * @param {{ formatted_address?: string; addressComponent?: Record<string, unknown> }} rg
 * @returns {string}
 */
function formatAmapRegeoAddress(rg) {
  const raw = rg.formatted_address != null ? String(rg.formatted_address).trim() : "";
  if (raw) return raw.slice(0, 400);
  const ac = rg.addressComponent || {};
  const province = ac.province != null ? String(ac.province).trim() : "";
  const city = _amapCityName(ac);
  const district = ac.district != null ? String(ac.district).trim() : "";
  const township = ac.township != null ? String(ac.township).trim() : "";
  const parts = [province, city || province, district, township].filter(Boolean);
  const s = parts.length ? parts.join("") : "";
  return (s || "未知").slice(0, 400);
}

/**
 * 高德逆地理：location = 经度,纬度
 * @returns {Promise<{ label: string; adcode: string; cityAdcode: string; cityName: string }>}
 */
async function amapRegeo(lat, lng) {
  const key = getAmapWebKey();
  if (!key) {
    throw new Error("未配置高德 Web 服务 Key：请在 server/.env 设置 AMAP_WEB_KEY（Web 服务类型）");
  }
  const u = new URL("https://restapi.amap.com/v3/geocode/regeo");
  u.searchParams.set("key", key);
  u.searchParams.set("location", `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`);
  u.searchParams.set("radius", "1000");
  u.searchParams.set("extensions", "base");
  const res = await fetch(u.toString());
  const data = await res.json();
  if (String(data.status) !== "1") {
    throw new Error(data.info || `高德逆地理失败（${data.infocode || "?"}）`);
  }
  const rg = data.regeocode;
  if (!rg || typeof rg !== "object") throw new Error("逆地理无结果");
  const ac = rg.addressComponent || {};
  /** 区级等细粒度 adcode，如杭州西湖区 330106 */
  const adcode = ac.adcode != null ? String(ac.adcode).trim() : "";
  /** 地级市/直辖市市级 adcode，天气接口应以该级为主，如杭州市 330100 */
  const cityAdcode = adcode ? normalizeAdcodeForWeather(adcode) : "";
  const cityName = _amapCityName(ac);
  const label = formatAmapRegeoAddress(rg);
  if (!label || label === "未知") throw new Error("逆地理无结果");
  return { label, adcode, cityAdcode, cityName };
}

async function osmNominatimReverse(lat, lng) {
  const now = Date.now();
  const waitMs = lastOsmNominatimRequestAt + OSM_NOMINATIM_MIN_INTERVAL_MS - now;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastOsmNominatimRequestAt = Date.now();

  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("lat", Number(lat).toFixed(6));
  u.searchParams.set("lon", Number(lng).toFixed(6));
  u.searchParams.set("zoom", "16");
  u.searchParams.set("addressdetails", "1");

  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent": getPhotoTimelineHttpUserAgent(),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`OSM 逆地理失败（HTTP ${res.status}）`);
  }
  const data = await res.json();
  const label = data && data.display_name != null ? String(data.display_name).trim() : "";
  if (!label) {
    throw new Error("OSM 逆地理无结果");
  }
  return { label: label.slice(0, 400), provider: "osm" };
}

async function reverseGeocodeInfo(lat, lng) {
  let amapErr = null;
  try {
    const { label } = await amapRegeo(lat, lng);
    return { label, provider: "amap" };
  } catch (err) {
    amapErr = err;
    if (!isOsmNominatimFallbackEnabled()) {
      throw err;
    }
  }

  try {
    return await osmNominatimReverse(lat, lng);
  } catch (osmErr) {
    const amapMsg = String((amapErr && amapErr.message) || amapErr || "unknown");
    const osmMsg = String((osmErr && osmErr.message) || osmErr || "unknown");
    throw new Error(`高德失败: ${amapMsg}; OSM fallback 失败: ${osmMsg}`);
  }
}

/**
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>}
 */
async function reverseGeocodeLabel(lat, lng) {
  const { label } = await reverseGeocodeInfo(lat, lng);
  return label;
}

/**
 * 天气查询需「城市级」adcode；区级编码（如 110105）常导致 lives/forecasts 为空。
 */
function normalizeAdcodeForWeather(adcode) {
  const s = String(adcode).replace(/\D/g, "").padStart(6, "0");
  if (s.length !== 6) return s;
  const p2 = s.slice(0, 2);
  if (p2 === "11") return "110000";
  if (p2 === "12") return "120000";
  if (p2 === "31") return "310000";
  if (p2 === "50") return "500000";
  return s.slice(0, 4) + "00";
}

function _readGpsCoords(gps) {
  if (!gps || typeof gps !== "object") return null;
  const lat = gps.latitude != null ? gps.latitude : gps.lat;
  const lng =
    gps.longitude != null ? gps.longitude : gps.lng != null ? gps.lng : gps.lon;
  if (lat == null || lng == null) return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (Number.isNaN(la) || Number.isNaN(ln)) return null;
  return { lat: la, lng: ln };
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function deriveBusinessEntryIdFromObject(entry) {
  if (!entry || entry.date == null) return null;
  const cal = extractCalendarDate(String(entry.date));
  if (!cal) return null;
  const coords = _readGpsCoords(entry.gps);
  const grid = coords ? gpsGridKeyFromCoords(coords.lat, coords.lng) : "nogps";
  return deriveBusinessEntryId(cal, grid);
}

/**
 * 将天气 / gps 写入规范化表（entry_weather / entry_gps），并可选同步 photo-timeline-entry.json。
 * @param {{ publicDir: string; serverDir: string; id: string; patch: { weather?: object; gps?: object } }} opts
 */
export function patchTimelineEntryOnDisk(opts) {
  const { publicDir, serverDir, id, patch } = opts;
  if (!patch || typeof patch !== "object") {
    throw new Error("invalid patch");
  }
  const hasW = patch.weather != null && typeof patch.weather === "object";
  const hasG = patch.gps != null && typeof patch.gps === "object";
  if (!hasW && !hasG) {
    throw new Error("patch must include weather or gps");
  }

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error("database not found");
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const row = db.prepare("SELECT source_path FROM timeline_entries WHERE id = ?").get(id);
  if (!row) {
    db.close();
    throw new Error(
      "条目未入库：请在项目根目录运行 npm run sync-photo-timeline，或 POST /api/photo-timeline/sync"
    );
  }
  const sourceRel = row.source_path != null ? String(row.source_path) : "";

  const now = new Date().toISOString();

  const updWeather = db.prepare(`
    INSERT INTO entry_weather (
      entry_id, provider, fetched_at, summary, temp_high_c, temp_low_c,
      icon_code, precipitation_mm, wind_max_m_s, amap_detail
    ) VALUES (
      @entry_id, @provider, @fetched_at, @summary, @temp_high_c, @temp_low_c,
      @icon_code, @precipitation_mm, @wind_max_m_s, @amap_detail
    )
    ON CONFLICT(entry_id) DO UPDATE SET
      provider = excluded.provider,
      fetched_at = excluded.fetched_at,
      summary = excluded.summary,
      temp_high_c = excluded.temp_high_c,
      temp_low_c = excluded.temp_low_c,
      icon_code = excluded.icon_code,
      precipitation_mm = excluded.precipitation_mm,
      wind_max_m_s = excluded.wind_max_m_s,
      amap_detail = excluded.amap_detail
  `);

  const updGps = db.prepare(`
    INSERT INTO entry_gps (entry_id, latitude, longitude, altitude_m, label)
    VALUES (@entry_id, @latitude, @longitude, @altitude_m, @label)
    ON CONFLICT(entry_id) DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      altitude_m = excluded.altitude_m,
      label = excluded.label
  `);

  const apply = db.transaction(() => {
    if (hasW) {
      const prev = db.prepare("SELECT * FROM entry_weather WHERE entry_id = ?").get(id);
      const merged = {
        ...weatherFromDbRow(prev || {}),
        ...patch.weather,
      };
      const wr = weatherToDbRow(merged);
      updWeather.run({ entry_id: id, ...wr });
    }
    if (hasG) {
      const prev = db.prepare("SELECT * FROM entry_gps WHERE entry_id = ?").get(id);
      const base = prev
        ? {
            latitude: prev.latitude,
            longitude: prev.longitude,
            altitude_m: prev.altitude_m,
            label: prev.label != null ? prev.label : "",
          }
        : {};
      const merged = { ...base, ...patch.gps };
      const lat =
        merged.latitude != null
          ? Number(merged.latitude)
          : merged.lat != null
            ? Number(merged.lat)
            : null;
      const lng =
        merged.longitude != null
          ? Number(merged.longitude)
          : merged.lng != null
            ? Number(merged.lng)
            : merged.lon != null
              ? Number(merged.lon)
              : null;
      const alt = merged.altitude_m;
      updGps.run({
        entry_id: id,
        latitude: lat != null && Number.isFinite(lat) ? lat : null,
        longitude: lng != null && Number.isFinite(lng) ? lng : null,
        altitude_m:
          alt != null && Number.isFinite(Number(alt)) ? Number(alt) : null,
        label: merged.label != null ? String(merged.label) : "",
      });
    }
    db.prepare("UPDATE timeline_entries SET updated_at = ? WHERE id = ?").run(now, id);
  });

  apply();

  let currentId = String(id);
  const realign = db.transaction(() => {
    const main = db.prepare(`SELECT * FROM timeline_entries WHERE id = ?`).get(currentId);
    if (!main) return;
    const gRow = db.prepare(`SELECT * FROM entry_gps WHERE entry_id = ?`).get(currentId);
    const cal = extractCalendarDate(String(main.date));
    if (!cal) return;
    let newGrid = "nogps";
    if (gRow && gRow.latitude != null && gRow.longitude != null) {
      const la = Number(gRow.latitude);
      const ln = Number(gRow.longitude);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        newGrid = gpsGridKeyFromCoords(la, ln);
      }
    }
    const newId = deriveBusinessEntryId(cal, newGrid);
    db.prepare(
      `UPDATE timeline_entries SET calendar_date = ?, gps_grid_key = ?, updated_at = ? WHERE id = ?`
    ).run(cal, newGrid, new Date().toISOString(), currentId);
    if (newId !== currentId) {
      moveEntryToNewId(db, currentId, newId);
      currentId = newId;
    }
  });
  realign();

  const entry = readOneTimelineEntry(db, currentId);
  db.close();
  if (!entry) {
    throw new Error("patch failed: entry missing after update");
  }
  writeEntryToSourceJsonFile(publicDir, serverDir, sourceRel, currentId, entry);
  return entry;
}

/**
 * 用第一条有坐标的记录做逆地理，将同一 label 写入多条目的 gps.label。
 * @param {{ publicDir: string; serverDir: string; ids: string[] }} opts
 */
export async function resolveLocationLabelsForIds(opts) {
  const { publicDir, serverDir } = opts;
  const ids = [...new Set((opts.ids || []).map(String).filter(Boolean))];
  if (ids.length === 0) throw new Error("no ids");

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error("database not found");
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  let coords = null;
  for (const id of ids) {
    const row = db.prepare("SELECT latitude, longitude FROM entry_gps WHERE entry_id = ?").get(id);
    if (!row) continue;
    const la = row.latitude != null ? Number(row.latitude) : null;
    const ln = row.longitude != null ? Number(row.longitude) : null;
    if (la != null && ln != null && Number.isFinite(la) && Number.isFinite(ln)) {
      coords = { lat: la, lng: ln };
      break;
    }
  }
  db.close();
  if (!coords) throw new Error("无可用 GPS 坐标");

  const label = await reverseGeocodeLabel(coords.lat, coords.lng);
  const updated = [];
  for (const id of ids) {
    try {
      const entry = patchTimelineEntryOnDisk({
        publicDir,
        serverDir,
        id,
        patch: { gps: { label } },
      });
      updated.push(entry);
    } catch (e) {
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-location patch_skip id=${id} err=${String((e && e.message) || e)}`
      );
    }
  }
  if (updated.length === 0) {
    throw new Error(
      "未能写入地名：条目未入库或缺少 GPS，请先运行 npm run sync-photo-timeline"
    );
  }
  return { label, entries: updated };
}

function listEntriesMissingLocationLabels(db) {
  return db
    .prepare(
      `SELECT e.id AS id, e.gps_grid_key AS gps_grid_key, g.latitude AS latitude, g.longitude AS longitude
       FROM timeline_entries e
       JOIN entry_gps g ON g.entry_id = e.id
       WHERE g.latitude IS NOT NULL
         AND g.longitude IS NOT NULL
         AND TRIM(COALESCE(g.label, '')) = ''
       ORDER BY e.calendar_date DESC, e.id DESC`
    )
    .all();
}

function groupMissingLocationRows(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const exactKey =
      row.gps_grid_key && String(row.gps_grid_key).trim()
        ? String(row.gps_grid_key).trim()
        : gpsGridKeyFromCoords(lat, lng);
    const queryKey = reverseGeocodeBucketKeyFromCoords(lat, lng);
    const key = queryKey && queryKey !== "nogps" ? queryKey : `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        queryKey: key,
        lat,
        lng,
        ids: [],
        exactKeys: new Set(),
      });
    }
    const group = map.get(key);
    group.ids.push(String(row.id));
    if (exactKey) group.exactKeys.add(exactKey);
  });
  return Array.from(map.values()).map((group) => ({
    ...group,
    exactKeys: Array.from(group.exactKeys),
  }));
}

function getExistingResolvedLabelForGrid(db, gpsGridKey) {
  if (!gpsGridKey || gpsGridKey === "nogps") return "";
  const row = db
    .prepare(
      `SELECT g.label AS label
       FROM timeline_entries e
       JOIN entry_gps g ON g.entry_id = e.id
       WHERE e.gps_grid_key = ?
         AND TRIM(COALESCE(g.label, '')) <> ''
       ORDER BY e.updated_at DESC
       LIMIT 1`
    )
    .get(gpsGridKey);
  return row && row.label ? String(row.label).trim() : "";
}

function buildResolvedLabelIndexes(db) {
  const rows = db
    .prepare(
      `SELECT e.gps_grid_key AS gps_grid_key, e.updated_at AS updated_at,
              g.latitude AS latitude, g.longitude AS longitude, g.label AS label
       FROM timeline_entries e
       JOIN entry_gps g ON g.entry_id = e.id
       WHERE g.latitude IS NOT NULL
         AND g.longitude IS NOT NULL
         AND TRIM(COALESCE(g.label, '')) <> ''
       ORDER BY e.updated_at DESC, e.id DESC`
    )
    .all();

  const exactLabelByGrid = new Map();
  const nearbyLabelByBucket = new Map();
  rows.forEach((row) => {
    const label = row && row.label != null ? String(row.label).trim() : "";
    if (!label) return;
    const gridKey = row && row.gps_grid_key != null ? String(row.gps_grid_key).trim() : "";
    if (gridKey && !exactLabelByGrid.has(gridKey)) {
      exactLabelByGrid.set(gridKey, label);
    }
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    const bucketKey = reverseGeocodeBucketKeyFromCoords(lat, lng);
    if (bucketKey && bucketKey !== "nogps" && !nearbyLabelByBucket.has(bucketKey)) {
      nearbyLabelByBucket.set(bucketKey, label);
    }
  });
  return { exactLabelByGrid, nearbyLabelByBucket };
}

/**
 * 批量补全缺失 gps.label。
 * - 同一粗网格只请求一次逆地理；
 * - 若同网格已有已解析 label，优先复用，不重复请求高德；
 * - 默认会写回数据库与源 JSON，避免下次 sync 再丢失。
 * @param {{ publicDir: string; serverDir: string; limit?: number; dryRun?: boolean }} opts
 */
export async function resolveMissingLocationLabels(opts) {
  const { publicDir, serverDir } = opts;
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error("database not found");
  }
  const limit = Math.max(0, Math.floor(Number(opts.limit) || 0));
  const dryRun = !!opts.dryRun;
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const missingRows = listEntriesMissingLocationLabels(db);
  const groups = groupMissingLocationRows(missingRows);
  const labelIndexes = buildResolvedLabelIndexes(db);
  const pendingGroups = limit > 0 ? groups.slice(0, limit) : groups;
  const prepared = pendingGroups.map((group) => ({
    ...group,
    label:
      group.exactKeys
        .map((key) => labelIndexes.exactLabelByGrid.get(key) || "")
        .find(Boolean) ||
      labelIndexes.nearbyLabelByBucket.get(group.queryKey) ||
      "",
  }));
  db.close();

  const summary = {
    scannedEntries: missingRows.length,
    totalGroups: groups.length,
    processedGroups: prepared.length,
    updatedEntries: 0,
    reusedGroups: 0,
    reusedNearbyGroups: 0,
    requestedGroups: 0,
    amapRequestedGroups: 0,
    osmRequestedGroups: 0,
    dryRun,
    errors: [],
  };

  if (dryRun) {
    prepared.forEach((group) => {
      if (group.label) {
        const reusedFromNearby = !group.exactKeys.some(
          (key) => (labelIndexes.exactLabelByGrid.get(key) || "") === group.label
        );
        summary.reusedGroups += 1;
        if (reusedFromNearby) summary.reusedNearbyGroups += 1;
      } else {
        summary.requestedGroups += 1;
      }
    });
    return summary;
  }

  for (const group of prepared) {
    let label = group.label;
    if (label) {
      summary.reusedGroups += 1;
      const reusedFromNearby = !group.exactKeys.some(
        (key) => (labelIndexes.exactLabelByGrid.get(key) || "") === label
      );
      if (reusedFromNearby) summary.reusedNearbyGroups += 1;
    } else {
      try {
        const info = await reverseGeocodeInfo(group.lat, group.lng);
        label = info.label;
        summary.requestedGroups += 1;
        if (info.provider === "osm") summary.osmRequestedGroups += 1;
        else summary.amapRequestedGroups += 1;
      } catch (err) {
        summary.errors.push(
          `reverseGeocode ${group.key}: ${String((err && err.message) || err)}`
        );
        continue;
      }
    }
    for (const id of group.ids) {
      try {
        patchTimelineEntryOnDisk({
          publicDir,
          serverDir,
          id,
          patch: { gps: { label } },
        });
        summary.updatedEntries += 1;
      } catch (err) {
        summary.errors.push(`patch ${id}: ${String((err && err.message) || err)}`);
      }
    }
  }
  return summary;
}

/**
 * @param {string} serverDir
 * @param {string} id
 */
export function getTimelineEntryById(serverDir, id) {
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const entry = readOneTimelineEntry(db, id);
  db.close();
  return entry;
}

/**
 * 更新条目元数据（标题、地点、备注、标签、日期、GPS）并写回 JSON。
 * @param {{ publicDir: string; serverDir: string; id: string; patch: { title?: string; place?: string; note?: string; tags?: string[]; date?: string; gps?: Record<string, unknown> } }} opts
 */
export function updateTimelineEntryMeta(opts) {
  const { publicDir, serverDir, id, patch } = opts;
  if (!patch || typeof patch !== "object") throw new Error("invalid patch");
  const has =
    patch.title !== undefined ||
    patch.place !== undefined ||
    patch.note !== undefined ||
    patch.tags !== undefined ||
    patch.date !== undefined ||
    patch.gps !== undefined ||
    patch.visibility !== undefined;
  if (!has) {
    throw new Error("patch must include title, place, note, tags, date, gps, or visibility");
  }

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  let currentId = String(id);
  const row = db
    .prepare(
      `SELECT id, date, title, place, note, visibility, data_version, source_path FROM timeline_entries WHERE id = ?`
    )
    .get(currentId);
  if (!row) {
    db.close();
    throw new Error("条目不存在或未入库");
  }

  const title = patch.title !== undefined ? String(patch.title) : row.title != null ? String(row.title) : "";
  const place = patch.place !== undefined ? String(patch.place) : row.place != null ? String(row.place) : "";
  const note = patch.note !== undefined ? String(patch.note) : row.note != null ? String(row.note) : "";
  const visibility =
    patch.visibility !== undefined
      ? String(patch.visibility).trim().toLowerCase() === "private"
        ? "private"
        : "public"
      : row.visibility != null && String(row.visibility).trim().toLowerCase() === "private"
        ? "private"
        : "public";
  const date = patch.date !== undefined ? String(patch.date) : String(row.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    db.close();
    throw new Error("date 须为 YYYY-MM-DD");
  }

  const calendarDate = date;

  const insTag = db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`);
  const tagIdStmt = db.prepare(`SELECT id FROM tags WHERE name = ?`);
  const linkTag = db.prepare(`INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`);
  const delTags = db.prepare(`DELETE FROM entry_tags WHERE entry_id = ?`);
  const updGps = db.prepare(`
    INSERT INTO entry_gps (entry_id, latitude, longitude, altitude_m, label)
    VALUES (@entry_id, @latitude, @longitude, @altitude_m, @label)
    ON CONFLICT(entry_id) DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      altitude_m = excluded.altitude_m,
      label = excluded.label
  `);
  const delGps = db.prepare(`DELETE FROM entry_gps WHERE entry_id = ?`);
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE timeline_entries SET title = ?, place = ?, note = ?, visibility = ?, date = ?, calendar_date = ?, updated_at = ? WHERE id = ?`
    ).run(title, place, note, visibility, date, calendarDate, now, currentId);

    if (patch.tags !== undefined) {
      delTags.run(currentId);
      const tagList = Array.isArray(patch.tags) ? patch.tags : [];
      for (const raw of tagList) {
        const name = String(raw).trim();
        if (!name) continue;
        insTag.run(name);
        const tid = tagIdStmt.get(name);
        if (tid && tid.id != null) linkTag.run(currentId, tid.id);
      }
    }

    if (patch.gps !== undefined) {
      const prev = db.prepare(`SELECT * FROM entry_gps WHERE entry_id = ?`).get(currentId);
      const base = prev
        ? {
            latitude: prev.latitude,
            longitude: prev.longitude,
            altitude_m: prev.altitude_m,
            label: prev.label != null ? String(prev.label) : "",
          }
        : {};
      const g = patch.gps && typeof patch.gps === "object" ? patch.gps : {};
      const merged = { ...base, ...g };
      const lat =
        merged.latitude != null
          ? Number(merged.latitude)
          : merged.lat != null
            ? Number(merged.lat)
            : null;
      const lng =
        merged.longitude != null
          ? Number(merged.longitude)
          : merged.lng != null
            ? Number(merged.lng)
            : merged.lon != null
              ? Number(merged.lon)
              : null;
      const alt = merged.altitude_m;
      const label = merged.label != null ? String(merged.label) : "";

      const hasAny =
        (lat != null && Number.isFinite(lat)) ||
        (lng != null && Number.isFinite(lng)) ||
        (alt != null && String(alt).trim() !== "") ||
        String(label).trim() !== "";

      if (!hasAny) {
        delGps.run(currentId);
      } else if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        updGps.run({
          entry_id: currentId,
          latitude: lat,
          longitude: lng,
          altitude_m:
            alt != null && String(alt).trim() !== "" && Number.isFinite(Number(alt)) ? Number(alt) : null,
          label,
        });
      } else if (String(label).trim() !== "") {
        updGps.run({
          entry_id: currentId,
          latitude: null,
          longitude: null,
          altitude_m:
            alt != null && String(alt).trim() !== "" && Number.isFinite(Number(alt)) ? Number(alt) : null,
          label,
        });
      } else {
        const partialCoord =
          (lat != null && Number.isFinite(lat) && !(lng != null && Number.isFinite(lng))) ||
          (lng != null && Number.isFinite(lng) && !(lat != null && Number.isFinite(lat)));
        if (partialCoord) {
          throw new Error("GPS：纬度/经度需成对填写（都为数字），或都留空");
        }
        delGps.run(currentId);
      }
    }
  });
  run();

  const realign = db.transaction(() => {
    const main = db.prepare(`SELECT * FROM timeline_entries WHERE id = ?`).get(currentId);
    if (!main) return;
    const gRow2 = db.prepare(`SELECT latitude, longitude FROM entry_gps WHERE entry_id = ?`).get(currentId);
    let newGrid = "nogps";
    if (gRow2 && gRow2.latitude != null && gRow2.longitude != null) {
      const la = Number(gRow2.latitude);
      const ln = Number(gRow2.longitude);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        newGrid = gpsGridKeyFromCoords(la, ln);
      }
    }
    const newId = deriveBusinessEntryId(calendarDate, newGrid);
    db.prepare(
      `UPDATE timeline_entries SET gps_grid_key = ?, updated_at = ? WHERE id = ?`
    ).run(newGrid, new Date().toISOString(), currentId);
    if (newId !== currentId) {
      moveEntryToNewId(db, currentId, newId);
      currentId = newId;
    }
  });
  realign();

  const entry = readOneTimelineEntry(db, currentId);
  const sourceRel = row.source_path != null ? String(row.source_path) : "";
  db.close();
  if (!entry) throw new Error("update failed: entry missing after save");
  writeEntryToSourceJsonFile(publicDir, serverDir, sourceRel, currentId, entry);
  return entry;
}

/**
 * 删除条目（SQLite + 同步移除 photo-timeline-entry.json 中的对应 entry；并尝试删除关联媒体文件）。
 * @param {{ publicDir: string; serverDir: string; id: string }} opts
 */
export function deleteTimelineEntry(opts) {
  const { publicDir, serverDir, id } = opts;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const entryId = String(id || "").trim();
  if (!entryId) throw new Error("invalid id");

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const row = db
    .prepare(`SELECT id, source_path FROM timeline_entries WHERE id = ?`)
    .get(entryId);
  if (!row) {
    db.close();
    throw new Error("条目不存在或未入库");
  }
  const sourceRel = row.source_path != null ? String(row.source_path) : "";

  const photos = db
    .prepare(`SELECT src, thumb, video FROM timeline_photos WHERE entry_id = ?`)
    .all(entryId);

  const del = db.prepare(`DELETE FROM timeline_entries WHERE id = ?`);
  del.run(entryId);
  db.close();

  for (const p of photos) {
    tryUnlinkSiteMedia(publicDir, liveRoot, p && p.video);
    tryUnlinkSiteMedia(publicDir, liveRoot, p && p.src);
    tryUnlinkSiteMedia(publicDir, liveRoot, p && p.thumb);
  }

  removeEntryFromSourceJsonFiles(publicDir, liveRoot, entryId, sourceRel);
  appendPhotoTimelineWriteLog(serverDir, `admin-delete-entry id=${entryId}`);
  return { ok: true, id: entryId };
}

/**
 * 删除条目下的一张照片（SQLite + 同步更新 JSON；并尝试删除媒体文件）。
 * @param {{ publicDir: string; serverDir: string; entryId: string; photoId: number|string }} opts
 */
export function deleteTimelinePhoto(opts) {
  const { publicDir, serverDir } = opts;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const entryId = String(opts.entryId || "").trim();
  const photoId = Math.floor(Number(opts.photoId));
  if (!entryId) throw new Error("invalid entryId");
  if (!Number.isFinite(photoId) || photoId <= 0) throw new Error("invalid photoId");

  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);

  const row = db.prepare(`SELECT id, source_path FROM timeline_entries WHERE id = ?`).get(entryId);
  if (!row) {
    db.close();
    throw new Error("条目不存在或未入库");
  }
  const sourceRel = row.source_path != null ? String(row.source_path) : "";

  const pRow = db
    .prepare(`SELECT id, entry_id, src, thumb, video FROM timeline_photos WHERE id = ?`)
    .get(photoId);
  if (!pRow || String(pRow.entry_id) !== entryId) {
    db.close();
    throw new Error("照片不存在或不属于该条目");
  }

  db.prepare(`DELETE FROM timeline_photos WHERE id = ?`).run(photoId);
  renumberTimelinePhotos(db, entryId);
  db.close();

  tryUnlinkSiteMedia(publicDir, liveRoot, pRow.video);
  tryUnlinkSiteMedia(publicDir, liveRoot, pRow.src);
  tryUnlinkSiteMedia(publicDir, liveRoot, pRow.thumb);

  removePhotoFromSourceJsonFiles(publicDir, liveRoot, entryId, pRow, sourceRel);
  appendPhotoTimelineWriteLog(serverDir, `admin-delete-photo entry=${entryId} photo=${photoId}`);
  return { ok: true, entryId, photoId };
}

const ADMIN_MANUAL_JSON_REL = path.join("assets", "live", "_admin-manual", "photo-timeline-entry.json");

function ensureAdminManualEntryJson(publicDir, serverDir) {
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const absJson = path.join(liveRoot, "_admin-manual", "photo-timeline-entry.json");
  const dir = path.dirname(absJson);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(absJson)) {
    fs.writeFileSync(absJson, JSON.stringify({ entries: [] }, null, 2), "utf8");
  }
  return { absJson, sourceRel: ADMIN_MANUAL_JSON_REL.replace(/\\/g, "/") };
}

/**
 * 后台手动新增一条时间轴 entry（写入 SQLite + 同步写入固定的 photo-timeline-entry.json）。
 * @param {{ publicDir: string; serverDir: string; input: Record<string, unknown> }} opts
 */
export function createTimelineEntryFromAdmin(opts) {
  const { publicDir, serverDir } = opts;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);
  const input = opts.input && typeof opts.input === "object" ? opts.input : {};
  const dateRaw = input.date != null ? String(input.date).trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    throw new Error("date 须为 YYYY-MM-DD");
  }

  const title = input.title != null ? String(input.title) : "";
  const place = input.place != null ? String(input.place) : "";
  const note = input.note != null ? String(input.note) : "";
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const visibility =
    input.visibility != null
      ? String(input.visibility).trim().toLowerCase() === "private"
        ? "private"
        : "public"
      : input.private === true || input.private === 1
        ? "private"
        : "public";

  let gpsObj = {};
  if (input.gps != null && typeof input.gps === "object") {
    gpsObj = { ...input.gps };
  }
  const latRaw =
    gpsObj.latitude != null
      ? gpsObj.latitude
      : gpsObj.lat != null
        ? gpsObj.lat
        : null;
  const lngRaw =
    gpsObj.longitude != null
      ? gpsObj.longitude
      : gpsObj.lng != null
        ? gpsObj.lng
        : gpsObj.lon != null
          ? gpsObj.lon
          : null;
  const latStr = latRaw != null ? String(latRaw).trim() : "";
  const lngStr = lngRaw != null ? String(lngRaw).trim() : "";
  if ((latStr && !lngStr) || (!latStr && lngStr)) {
    throw new Error("GPS：纬度/经度需成对填写，或都留空");
  }
  if (latStr && lngStr) {
    const la = Number(latStr);
    const ln = Number(lngStr);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
      throw new Error("GPS：纬度/经度需为数字");
    }
    gpsObj.latitude = la;
    gpsObj.longitude = ln;
    delete gpsObj.lat;
    delete gpsObj.lng;
    delete gpsObj.lon;
  } else {
    gpsObj = {};
  }

  const photosIn = Array.isArray(input.photos) ? input.photos : [];
  const photos = [];
  for (const p of photosIn) {
    if (!p || typeof p !== "object") continue;
    const pickString = (keys) => {
      for (const k of keys) {
        if (p[k] == null) continue;
        const s = String(p[k]).trim();
        if (s) return s;
      }
      return "";
    };
    const livpRel = pickString(["livp"]);
    const isVideoPath = (rel) => /\.(mov|mp4|webm|m4v)$/i.test(String(rel || ""));

    const caption = p.caption != null ? String(p.caption) : "";
    const ratio = p.ratio != null ? String(p.ratio) : "";
    const metadata = p.metadata && typeof p.metadata === "object" ? p.metadata : null;
    const semantic = p.semantic && typeof p.semantic === "object" ? p.semantic : null;

    if (livpRel) {
      // livp：调用 tool/livp_extractor.py 生成 thumb/preview/mov（并把生成的 JSON 删除，避免重复导入）
      if (!/\.livp$/i.test(livpRel)) throw new Error("livp 需为 .livp 文件路径");

      const livpAbs = resolveVerifiedSiteFilePath(publicDir, liveRoot, livpRel);
      if (!fs.existsSync(livpAbs)) throw new Error("livp 文件不存在: " + livpRel);

      const runId = `livp_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const importAbsRoot = path.join(liveRoot, "_admin-import", runId);
      const importWebPrefix = `assets/live/_admin-import/${runId}`;
      const toolScript = path.join(serverDir, "..", "tool", "livp_extractor.py");
      if (!fs.existsSync(toolScript)) throw new Error("未找到工具脚本: " + toolScript);

      if (!fs.existsSync(path.dirname(importAbsRoot))) {
        fs.mkdirSync(path.dirname(importAbsRoot), { recursive: true });
      }

      const r = spawnSync(
        "python3",
        [
          toolScript,
          "-i",
          livpAbs,
          "-o",
          importAbsRoot,
          "--web-prefix",
          importWebPrefix,
          "--no-db-sync",
          "--on-conflict",
          "unique",
        ],
        { encoding: "utf8" }
      );
      if (r.error) {
        throw new Error(
          "livp 处理失败（无法运行 python3）： " +
            String(r.error && r.error.message ? r.error.message : r.error)
        );
      }
      if (r.status !== 0) {
        const out = String(r.stdout || "").trim();
        const err = String(r.stderr || "").trim();
        throw new Error(
          "livp 处理失败（exit=" +
            String(r.status) +
            "）。请确保已安装工具依赖（tool/requirements.txt）。\n" +
            (err || out || "(no output)")
        );
      }

      // 读取工具生成的 photo-timeline-entry.json，从中提取 photos；随后删除该文件避免被 sync 扫到重复入库
      const createdJsonFiles = [];
      (function walk(dir) {
        let ents = [];
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of ents) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.name === "photo-timeline-entry.json") createdJsonFiles.push(full);
        }
      })(importAbsRoot);

      if (!createdJsonFiles.length) throw new Error("livp 处理完成，但未生成 photo-timeline-entry.json");
      const jsonPath = createdJsonFiles[0];
      let toolJson;
      try {
        toolJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch (e) {
        throw new Error("livp 处理完成，但 JSON 读取失败: " + String(e && e.message));
      }
      const toolEntries = Array.isArray(toolJson.entries) ? toolJson.entries : [];
      const toolPhotos =
        toolEntries.length && Array.isArray(toolEntries[0].photos) ? toolEntries[0].photos : [];
      if (!toolPhotos.length) throw new Error("livp 处理完成，但未生成可用的 photos");

      try {
        fs.unlinkSync(jsonPath);
      } catch {
        // ignore
      }

      for (const tp of toolPhotos) {
        if (!tp || typeof tp !== "object") continue;
        const thumbIn = tp.thumb != null ? String(tp.thumb).trim() : "";
        const srcIn = tp.src != null ? String(tp.src).trim() : "";
        const videoIn = tp.video != null ? String(tp.video).trim() : "";

        let thumbOut = thumbIn;
        let srcOut = srcIn;
        let videoOut = videoIn;
        if (!srcOut && thumbOut) srcOut = thumbOut;
        if (!thumbOut && srcOut) thumbOut = srcOut;
        if (!videoOut) {
          if (srcOut && isVideoPath(srcOut)) videoOut = srcOut;
          else if (thumbOut && isVideoPath(thumbOut)) videoOut = thumbOut;
        }

        // 校验路径只允许落在 public 或 /assets/live 映射目录
        const rels = [thumbOut, srcOut, videoOut].filter(Boolean);
        for (const rel of rels) {
          resolveVerifiedSiteFilePath(publicDir, liveRoot, rel);
        }

        photos.push({
          thumb: thumbOut || null,
          src: srcOut || null,
          video: videoOut || null,
          caption: tp.caption != null ? String(tp.caption) : caption,
          ratio: tp.ratio != null ? String(tp.ratio) : ratio || null,
          metadata: tp.metadata && typeof tp.metadata === "object" ? tp.metadata : metadata,
          semantic: tp.semantic && typeof tp.semantic === "object" ? tp.semantic : semantic,
        });
      }

      continue;
    }

    const thumb = pickString(["thumb", "thum"]);
    const src = pickString(["src", "preview"]);
    const video = pickString(["video", "mov"]);
    if (!thumb && !src && !video) continue;

    let thumbOut = thumb;
    let srcOut = src;
    let videoOut = video;

    // 允许只传一个：缺 thumb 默认用 preview（src）；缺 preview 默认用 thumb
    if (!srcOut && thumbOut) srcOut = thumbOut;
    if (!thumbOut && srcOut) thumbOut = srcOut;

    // mov 不传默认与 preview（src）一致（仅当 preview/thumbnail 本身是视频路径时）
    if (!videoOut) {
      if (srcOut && isVideoPath(srcOut)) videoOut = srcOut;
      else if (thumbOut && isVideoPath(thumbOut)) videoOut = thumbOut;
    }

    // 校验路径只允许落在 public 或 /assets/live 映射目录
    const rels = [thumbOut, srcOut, videoOut].filter(Boolean);
    for (const rel of rels) {
      resolveVerifiedSiteFilePath(publicDir, liveRoot, rel);
    }

    photos.push({
      thumb: thumbOut || null,
      src: srcOut || null,
      video: videoOut || null,
      caption,
      ratio: ratio || null,
      metadata,
      semantic,
    });
  }

  const entry = {
    date: dateRaw,
    title,
    place,
    note,
    visibility,
    tags,
    gps: gpsObj,
    photos,
  };
  if (!photos.length) {
    throw new Error("photos 不能为空：需至少上传 1 张（thumb/preview 或 livp）");
  }

  const { sourceRel } = ensureAdminManualEntryJson(publicDir, serverDir);
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("database not found");
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    upsertNormalizedEntryFromObject(db, entry, sourceRel, now);
  });
  run();

  const coords = _readGpsCoords(entry.gps);
  const grid = coords ? gpsGridKeyFromCoords(coords.lat, coords.lng) : "nogps";
  const id = deriveBusinessEntryId(dateRaw, grid);
  entry.id = id;

  const saved = readOneTimelineEntry(db, id);
  db.close();
  if (!saved) throw new Error("create failed: entry missing after upsert");

  writeEntryToSourceJsonFile(publicDir, serverDir, sourceRel, id, saved);
  appendPhotoTimelineWriteLog(serverDir, `admin-create-entry id=${id}`);
  return saved;
}

/**
 * 服务端请求 Open-Meteo 并写入 entry_weather；同一 calendar_date + gps_grid_key 的条目一并更新（与前端地点簇一致）。
 * 仅在服务端写库，浏览器无需 sync secret。
 * @param {{ publicDir: string; serverDir: string; id: string }} opts
 */
async function fetchWeatherAndPersistForTimelineEntry(opts) {
  const { publicDir, serverDir, id } = opts;
  const dbPath = path.join(serverDir, ".data", "photo-timeline.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error("database not found");
  }
  const db = new Database(dbPath);
  ensurePhotoTimelineSchema(db);
  const entry = readOneTimelineEntry(db, String(id));
  if (!entry) {
    db.close();
    throw new Error("条目不存在或未入库");
  }
  const coords = _readGpsCoords(entry.gps);
  const cal = String(entry.calendar_date || "").trim();
  const grid = String(entry.gps_grid_key || "").trim();
  if (!coords || !cal || !/^\d{4}-\d{2}-\d{2}$/.test(cal)) {
    db.close();
    throw new Error("需要拍摄日与 GPS");
  }
  const rowList = db
    .prepare(
      `SELECT id FROM timeline_entries WHERE calendar_date = ? AND gps_grid_key = ?`
    )
    .all(cal, grid);
  db.close();

  const targetIds =
    rowList.length > 0 ? rowList.map((r) => String(r.id)) : [String(entry.id)];

  const weather = await fetchOpenMeteoWeatherForDate(
    coords.lat,
    coords.lng,
    cal,
    serverDir
  );

  const entries = [];
  for (const eid of targetIds) {
    const ent = patchTimelineEntryOnDisk({
      publicDir,
      serverDir,
      id: eid,
      patch: { weather },
    });
    entries.push(ent);
  }

  const primary =
    entries.find((e) => e && String(e.id) === String(id)) || entries[0] || null;

  return { weather, entries, entry: primary };
}

/** @param {import("express").Application} app */
export function registerPhotoTimelineRoutes(app, opts) {
  const publicDir = opts.publicDir;
  const serverDir = opts.serverDir;
  const rootDir = opts.rootDir;
  const liveRoot = resolvePhotoTimelineLiveRoot(publicDir, serverDir);

  app.get("/api/photo-timeline/session", function (req, res) {
    const auth = getUserAuthConfig();
    const loggedIn = isUserLoggedIn(req);
    res.json({
      ok: true,
      hasSecret: auth.enabled,
      authConfigured: auth.enabled,
      loggedIn,
      username: auth.enabled ? auth.username : "",
      ttlSec: getUserSessionTtlSec(),
      guestVisiblePhotoLimit: GUEST_VISIBLE_PHOTO_LIMIT,
    });
  });

  app.post("/api/photo-timeline/login", function (req, res) {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!assertUserLogin(req, res, body)) return;
    issueUserSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post("/api/photo-timeline/logout", function (req, res) {
    clearUserSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post("/api/photo-timeline/sync", function (req, res) {
    if (!assertPhotoTimelineSyncAuth(req, res)) {
      appendPhotoTimelineWriteLog(
        serverDir,
        `sync AUTH_FAIL ip=${req.socket.remoteAddress} url=${req.originalUrl || req.url}`
      );
      return;
    }
    try {
      const r = syncPhotoTimelineFromDisk({ publicDir, serverDir });
      appendPhotoTimelineWriteLog(
        serverDir,
        `sync OK scanned=${r.scanned} upserted=${r.upserted} errors=${(r.errors && r.errors.length) || 0}`
      );
      res.json({
        ok: true,
        liveRoot: path.relative(rootDir, liveRoot),
        scanned: r.scanned,
        upserted: r.upserted,
        errors: r.errors,
      });
    } catch (err) {
      appendPhotoTimelineWriteLog(
        serverDir,
        `sync FAIL ${String((err && err.stack) || err)}`
      );
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  app.get("/api/photo-timeline/entries", function (req, res) {
    try {
      const sort = String(req.query.sort || "desc").toLowerCase();
      const sortDesc = sort !== "asc";
      const allowPrivate = isUserLoggedIn(req);
      const requestedOffset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
      const limit = Math.max(1, Math.min(1000, Math.floor(Number(req.query.limit) || 5)));
      const tagValues = Array.isArray(req.query.tag)
        ? req.query.tag
        : req.query.tag != null
          ? [req.query.tag]
          : [];
      const pageOffset = allowPrivate ? requestedOffset : 0;
      const pageLimit = allowPrivate ? limit : 2000;
      const page = readTimelineEntriesPage({
        serverDir,
        sortDesc,
        offset: pageOffset,
        limit: pageLimit,
        query: req.query.q,
        tags: tagValues,
        anchorDate: req.query.anchorDate,
      });
      const visibleEntries = Array.isArray(page.entries)
        ? page.entries
            .filter((e) => isEntryVisibleForViewer(e, allowPrivate))
            .map((e) => cloneEntryWithVisiblePhotos(e, allowPrivate))
            .filter((e) => Array.isArray(e.photos) && e.photos.length > 0)
        : [];
      const guestPreview = !allowPrivate
        ? limitEntriesToPhotoCount(visibleEntries, GUEST_VISIBLE_PHOTO_LIMIT)
        : null;
      const entries = guestPreview ? guestPreview.entries : visibleEntries;
      res.json({
        version: "2",
        pageSize: limit,
        entries,
        total: page.total,
        offset: allowPrivate ? page.offset : 0,
        limit: allowPrivate ? page.limit : limit,
        nextOffset: allowPrivate ? page.nextOffset : null,
        availableTags: page.availableTags,
        availablePlaces: page.availablePlaces,
        availablePlaceGroups: page.availablePlaceGroups,
        minDate: page.minDate,
        maxDate: page.maxDate,
        anchorEntryId:
          entries.find((e) => String(e && e.id) === String(page.anchorEntryId || ""))?.id || "",
        anchorMatchedDate: page.anchorMatchedDate,
        loggedIn: allowPrivate,
        guestVisiblePhotoLimit: !allowPrivate ? GUEST_VISIBLE_PHOTO_LIMIT : null,
        guestVisiblePhotoCount: guestPreview ? guestPreview.photoCount : null,
        guestPreviewTruncated: guestPreview ? guestPreview.truncated : false,
      });
    } catch (err) {
      res.status(500).json({ error: String(err && err.message) });
    }
  });

  app.get("/api/photo-timeline/map-config", function (req, res) {
    try {
      const amapJsKey = getAmapJsKey();
      const amapSecurityJsCode = getAmapSecurityJsCode();
      res.json({
        ok: true,
        amapJsKey,
        amapSecurityJsCode,
        hasAmapJsKey: !!amapJsKey,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  app.get("/api/photo-timeline/map-points", function (req, res) {
    try {
      const sort = String(req.query.sort || "desc").toLowerCase();
      const sortDesc = sort !== "asc";
      const allowPrivate = isUserLoggedIn(req);
      const result = readTimelineMapPoints({ serverDir, sortDesc, allowPrivate });
      res.json({
        ok: true,
        total: result.total,
        points: result.points,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  function handleTimelineEntryPatch(req, res) {
    const entryId = String(req.params.id || "");
    const keys = [];
    if (req.body && typeof req.body.weather === "object") keys.push("weather");
    if (req.body && typeof req.body.gps === "object") keys.push("gps");
    if (!assertPhotoTimelineSyncAuth(req, res)) {
      appendPhotoTimelineWriteLog(
        serverDir,
        `entry_update AUTH_FAIL id=${entryId} method=${req.method} keys=${keys.join(",") || "(empty)"} ip=${req.socket.remoteAddress} url=${req.originalUrl || req.url}`
      );
      return;
    }
    appendPhotoTimelineWriteLog(
      serverDir,
      `entry_update BEGIN id=${entryId} method=${req.method} keys=${keys.join(",") || "(empty)"} ip=${req.socket.remoteAddress}`
    );
    try {
      const patch = {};
      if (req.body && typeof req.body.weather === "object") patch.weather = req.body.weather;
      if (req.body && typeof req.body.gps === "object") patch.gps = req.body.gps;
      const entry = patchTimelineEntryOnDisk({
        publicDir,
        serverDir,
        id: entryId,
        patch,
      });
      appendPhotoTimelineWriteLog(
        serverDir,
        `entry_update OK id=${entryId} date_hint=${entry && entry.date ? String(entry.date) : "?"}`
      );
      res.json({ ok: true, entry });
    } catch (err) {
      const msg = String((err && err.message) || err);
      appendPhotoTimelineWriteLog(
        serverDir,
        `entry_update FAIL id=${entryId} httpWillBe=${msg.indexOf("未入库") >= 0 || msg.indexOf("找不到") >= 0 ? 404 : 400}\nmsg=${msg}\n${(err && err.stack) || ""}`
      );
      const code =
        msg.indexOf("未入库") >= 0 ||
        msg.indexOf("找不到") >= 0 ||
        msg.indexOf("not found") >= 0 ||
        msg.indexOf("missing") >= 0
          ? 404
          : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  }

  app.patch("/api/photo-timeline/entry/:id", handleTimelineEntryPatch);
  /** 与 PATCH 相同；部分反向代理对 PATCH 支持差，浏览器写回请用此接口 */
  app.post("/api/photo-timeline/entry/:id/update", handleTimelineEntryPatch);

  app.get("/api/photo-timeline/weather", async function (req, res) {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const date = String(req.query.date || "").trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          ok: false,
          error: "需要有效的 lat、lng 与 date（YYYY-MM-DD）",
        });
      }
      const weather = await fetchOpenMeteoWeatherForDate(lat, lng, date, serverDir);
      res.json({ ok: true, weather });
    } catch (err) {
      const msg = String((err && err.message) || err);
      logOpenMeteoWeather(serverDir, `ROUTE_ERROR ${msg}`);
      const code = 502;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  /** API 模式：服务端拉取天气并写库，浏览器不必带 sync secret */
  app.post("/api/photo-timeline/entry/:id/fetch-weather", async function (req, res) {
    const entryId = String(req.params.id || "").trim();
    if (!entryId) {
      return res.status(400).json({ ok: false, error: "缺少条目 id" });
    }
    try {
      const r = await fetchWeatherAndPersistForTimelineEntry({
        publicDir,
        serverDir,
        id: entryId,
      });
      appendPhotoTimelineWriteLog(
        serverDir,
        `fetch-weather OK id=${entryId} updated=${r.entries.length}`
      );
      res.json({
        ok: true,
        weather: r.weather,
        entries: r.entries,
        entry: r.entry,
      });
    } catch (err) {
      const msg = String((err && err.message) || err);
      appendPhotoTimelineWriteLog(serverDir, `fetch-weather FAIL id=${entryId} msg=${msg}`);
      let code = 502;
      if (msg.indexOf("不存在") >= 0 || msg.indexOf("未入库") >= 0) code = 404;
      else if (msg.indexOf("需要拍摄日") >= 0) code = 400;
      else if (msg.indexOf("database not found") >= 0) code = 503;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  /** API 模式：服务端逆地理（高德）并写 gps.label，浏览器不必带 sync secret（与 fetch-weather 一致） */
  app.post("/api/photo-timeline/entry/:id/resolve-location", async function (req, res) {
    try {
      const also = Array.isArray(req.body?.alsoEntryIds) ? req.body.alsoEntryIds : [];
      const ids = [...new Set([String(req.params.id || ""), ...also.map(String)])].filter(Boolean);
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-location BEGIN ids=${ids.join("|")} ip=${req.socket.remoteAddress}`
      );
      const r = await resolveLocationLabelsForIds({ publicDir, serverDir, ids });
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-location OK label_len=${(r.label && r.label.length) || 0} updated=${r.entries.length}`
      );
      res.json({ ok: true, label: r.label, entries: r.entries });
    } catch (err) {
      const msg = String((err && err.message) || err);
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-location FAIL ${String((err && err.stack) || err)}`
      );
      let code = 502;
      if (msg.indexOf("无可用 GPS") >= 0) code = 400;
      else if (msg.indexOf("未能写入地名") >= 0 || msg.indexOf("no ids") >= 0) code = 404;
      else if (msg.indexOf("database not found") >= 0) code = 503;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.post("/api/photo-timeline/resolve-missing-locations", async function (req, res) {
    if (!assertPhotoTimelineSyncAuth(req, res)) {
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-missing-locations AUTH_FAIL ip=${req.socket.remoteAddress} url=${req.originalUrl || req.url}`
      );
      return;
    }
    try {
      const limit = req.body && req.body.limit != null ? Number(req.body.limit) : 0;
      const dryRun = !!(req.body && req.body.dryRun);
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-missing-locations BEGIN limit=${limit || 0} dryRun=${dryRun ? 1 : 0} ip=${req.socket.remoteAddress}`
      );
      const summary = await resolveMissingLocationLabels({
        publicDir,
        serverDir,
        limit,
        dryRun,
      });
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-missing-locations OK scanned=${summary.scannedEntries} groups=${summary.processedGroups}/${summary.totalGroups} updated=${summary.updatedEntries} reused=${summary.reusedGroups} requested=${summary.requestedGroups} errors=${summary.errors.length}`
      );
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = String((err && err.message) || err);
      appendPhotoTimelineWriteLog(
        serverDir,
        `resolve-missing-locations FAIL ${String((err && err.stack) || err)}`
      );
      let code = 500;
      if (msg.indexOf("database not found") >= 0) code = 503;
      else if (msg.indexOf("未配置高德") >= 0) code = 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  console.log(
    "[photo-timeline] 写回调试日志:",
    getPhotoTimelineWriteLogPath(serverDir)
  );
}
