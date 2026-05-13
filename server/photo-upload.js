/**
 * 管理端：上传照片到 uploadphotos 目录并创建时间轴条目
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import exifr from "exifr";
import { assertAdminBearerAuth } from "./admin-auth.js";
import { createTimelineEntryFromAdmin, resolvePhotoTimelineUploadRoot } from "./photo-timeline.js";

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 48 * 1024 * 1024, files: 24 },
  fileFilter: function (_req, file, cb) {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(String(file.mimetype || ""));
    cb(null, ok);
  },
});

function isValidGps(la, ln) {
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === -180 && ln === -180) return false;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return false;
  return true;
}

/**
 * @param {unknown} d
 * @returns {{ ymd: string; hm: string }}
 */
function ymdHmFromExifDate(d) {
  if (!d) return { ymd: "", hm: "" };
  if (d instanceof Date && !isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return { ymd: `${y}-${m}-${day}`, hm: `${hh}:${mm}` };
  }
  if (typeof d === "string") {
    const m = d.match(/(\d{4})[^\d]?(\d{1,2})[^\d]?(\d{1,2})[^\d]?(\d{1,2})[^\d]?(\d{1,2})/);
    if (m) {
      const y = m[1];
      const mo = m[2].padStart(2, "0");
      const da = m[3].padStart(2, "0");
      const hh = (m[4] || "12").padStart(2, "0");
      const mm = (m[5] || "00").padStart(2, "0");
      return { ymd: `${y}-${mo}-${da}`, hm: `${hh}:${mm}` };
    }
  }
  return { ymd: "", hm: "" };
}

async function readImageExif(buf) {
  try {
    return await exifr.parse(buf, {
      gps: true,
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "ModifyDate",
        "latitude",
        "longitude",
        "GPSAltitude",
      ],
    });
  } catch {
    return null;
  }
}

function safeBasename(name) {
  const base = path.basename(String(name || "photo")).replace(/[^\w.\-()\u4e00-\u9fff]+/g, "_");
  return base.slice(0, 96) || "photo";
}

function pickField(body, keys) {
  if (!body || typeof body !== "object") return "";
  for (const k of keys) {
    if (body[k] == null) continue;
    const s = String(body[k]).trim();
    if (s) return s;
  }
  return "";
}

/**
 * @param {import("express").Application} app
 * @param {{ publicDir: string; serverDir: string; uploadPhotosRoot?: string | null }} opts
 */
export function registerAdminPhotoUploadRoutes(app, opts) {
  const { publicDir, serverDir } = opts;
  const uploadRoot = resolvePhotoTimelineUploadRoot(serverDir, {
    uploadPhotosRoot: opts.uploadPhotosRoot,
  });

  app.post(
    "/api/admin/photo-timeline/upload",
    function (req, res, next) {
      if (!assertAdminBearerAuth(req, res)) return;
      next();
    },
    uploadMem.array("files", 24),
    async function (req, res) {
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        res.status(400).json({ ok: false, error: "请选择至少一张图片" });
        return;
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const manualDate = pickField(body, ["date", "calendarDate"]);
      const manualTime = pickField(body, ["time", "shotTime"]);
      const manualLat = pickField(body, ["lat", "latitude"]);
      const manualLng = pickField(body, ["lng", "longitude", "lon"]);
      const place = pickField(body, ["place", "placeText"]);
      const note = String(body.note != null ? body.note : "").trim();
      const titleIn = pickField(body, ["title"]);
      const tagsRaw = pickField(body, ["tags"]);
      const gpsLabel = pickField(body, ["gpsLabel", "locationLabel"]);
      const visibilityRaw = String(body.visibility != null ? body.visibility : "").trim().toLowerCase();
      const visibility = visibilityRaw === "private" ? "private" : "public";

      const tags = tagsRaw
        ? tagsRaw
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      let manualGps = null;
      if (manualLat && manualLng) {
        const la = Number(manualLat);
        const ln = Number(manualLng);
        if (!Number.isFinite(la) || !Number.isFinite(ln)) {
          res.status(400).json({ ok: false, error: "经纬度需为数字" });
          return;
        }
        manualGps = { latitude: la, longitude: ln };
        if (gpsLabel) manualGps.label = gpsLabel;
      }

      const photosOut = [];
      let firstYmd = "";
      let firstHm = "";
      let anyExifGps = null;

      try {
        fs.mkdirSync(uploadRoot, { recursive: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: "无法创建上传目录: " + String(e && e.message) });
        return;
      }

      for (const f of files) {
        const buf = f.buffer;
        if (!buf || !buf.length) continue;

        const exif = await readImageExif(buf);
        let exifYmd = "";
        let exifHm = "";
        if (exif) {
          const d = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
          const picked = ymdHmFromExifDate(d);
          exifYmd = picked.ymd;
          exifHm = picked.hm;
        }

        let la = exif && exif.latitude != null ? Number(exif.latitude) : NaN;
        let ln = exif && exif.longitude != null ? Number(exif.longitude) : NaN;
        let alt = null;
        if (exif && exif.GPSAltitude != null && Number.isFinite(Number(exif.GPSAltitude))) {
          alt = Number(exif.GPSAltitude);
        }

        let photoMetaGps = null;
        if (isValidGps(la, ln)) {
          photoMetaGps = { latitude: la, longitude: ln, altitude_m: alt };
          if (!anyExifGps) anyExifGps = { latitude: la, longitude: ln, altitude_m: alt };
        }

        if (exifYmd && !firstYmd) {
          firstYmd = exifYmd;
          firstHm = exifHm;
        }

        const ymdForPath = /^\d{4}-\d{2}-\d{2}$/.test(manualDate)
          ? manualDate
          : exifYmd || new Date().toISOString().slice(0, 10);
        const [yy, mm] = ymdForPath.split("-");
        const relDir = path.posix.join(yy, mm);
        const diskDir = path.join(uploadRoot, yy, mm);
        try {
          fs.mkdirSync(diskDir, { recursive: true });
        } catch (e) {
          res.status(500).json({ ok: false, error: "写入目录失败: " + String(e && e.message) });
          return;
        }

        const ext = path.extname(f.originalname || "") || ".jpg";
        const idPart = crypto.randomBytes(6).toString("hex");
        const base = safeBasename(path.basename(f.originalname || "photo", ext));
        const filename = `${Date.now()}-${idPart}-${base}${ext}`;
        const absFile = path.join(diskDir, filename);
        const webRel = path.posix.join("uploadphotos", relDir, filename);

        try {
          fs.writeFileSync(absFile, buf);
        } catch (e) {
          res.status(500).json({ ok: false, error: "保存文件失败: " + String(e && e.message) });
          return;
        }

        const cap = f.originalname ? String(f.originalname) : filename;
        photosOut.push({
          thumb: webRel,
          src: webRel,
          caption: cap,
          ratio: null,
          metadata: photoMetaGps ? { gps: photoMetaGps } : null,
        });
      }

      if (!photosOut.length) {
        res.status(400).json({ ok: false, error: "没有可保存的图片" });
        return;
      }

      let dateStr = /^\d{4}-\d{2}-\d{2}$/.test(manualDate) ? manualDate : "";
      if (!dateStr && firstYmd) dateStr = firstYmd;
      if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);

      let timePart = manualTime;
      if (timePart && !/^\d{1,2}:\d{2}/.test(timePart)) timePart = "";
      if (!timePart && firstHm) timePart = firstHm;

      let title = titleIn;
      if (!title) {
        title = timePart ? `${dateStr} ${timePart}` : dateStr;
      }

      let entryGps = {};
      if (manualGps) {
        entryGps = manualGps;
      } else if (anyExifGps) {
        entryGps = {
          latitude: anyExifGps.latitude,
          longitude: anyExifGps.longitude,
          altitude_m: anyExifGps.altitude_m,
        };
        if (gpsLabel) entryGps.label = gpsLabel;
      }

      try {
        const entry = createTimelineEntryFromAdmin({
          publicDir,
          serverDir,
          input: {
            date: dateStr,
            title,
            place,
            note,
            tags,
            visibility,
            gps: entryGps,
            photos: photosOut,
          },
        });
        res.json({ ok: true, entry });
      } catch (err) {
        const msg = String((err && err.message) || err);
        const code = msg.indexOf("database not found") >= 0 ? 503 : 400;
        res.status(code).json({ ok: false, error: msg });
      }
    }
  );
}
