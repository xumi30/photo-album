/**
 * 照片时间轴 · 后台管理 API（元数据编辑）
 */
import { assertAdminBearerAuth, clearAdminAuthCookies } from "./admin-auth.js";
import {
  createTimelineEntryFromAdmin,
  deleteTimelineEntry,
  deleteTimelinePhoto,
  getTimelineEntryById,
  readAllTimelineEntries,
  readTimelinePhotosPage,
  resolveMissingLocationLabels,
  suggestTimelinePhotoSemanticFromAI,
  updateTimelinePhotosVisibilityBulk,
  updateTimelinePhotoMeta,
  updateTimelineEntryMeta,
} from "./photo-timeline.js";

/** @param {import("express").Application} app */
export function registerAdminPhotoTimelineRoutes(app, opts) {
  const publicDir = opts.publicDir;
  const serverDir = opts.serverDir;

  app.post("/api/admin/logout", function (req, res) {
    clearAdminAuthCookies(req, res);
    res.json({ ok: true });
  });

  app.get("/api/admin/photo-timeline/entries", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    try {
      const sort = String(req.query.sort || "desc").toLowerCase();
      const sortDesc = sort !== "asc";
      const entries = readAllTimelineEntries({ serverDir, sortDesc });
      res.json({ ok: true, entries, total: entries.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  app.post("/api/admin/photo-timeline/entry", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const entry = createTimelineEntryFromAdmin({ publicDir, serverDir, input: body });
      res.json({ ok: true, entry });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("database not found") >= 0 ? 503 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.get("/api/admin/photo-timeline/entry/:id", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    try {
      const id = String(req.params.id || "");
      const entry = getTimelineEntryById(serverDir, id);
      if (!entry) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  app.put("/api/admin/photo-timeline/entry/:id", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const id = String(req.params.id || "");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const patch = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.place !== undefined) patch.place = body.place;
      if (body.note !== undefined) patch.note = body.note;
      if (body.date !== undefined) patch.date = body.date;
      if (body.gps !== undefined && typeof body.gps === "object") {
        patch.gps = body.gps;
      }
      if (body.tags !== undefined) {
        patch.tags = Array.isArray(body.tags) ? body.tags : [];
      }
      if (body.visibility !== undefined) patch.visibility = body.visibility;
      const entry = updateTimelineEntryMeta({ publicDir, serverDir, id, patch });
      res.json({ ok: true, entry });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("不存在") >= 0 || msg.indexOf("not found") >= 0 ? 404 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.delete("/api/admin/photo-timeline/entry/:id", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const id = String(req.params.id || "");
    try {
      const out = deleteTimelineEntry({ publicDir, serverDir, id });
      res.json({ ok: true, ...out });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("不存在") >= 0 || msg.indexOf("not found") >= 0 ? 404 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.delete("/api/admin/photo-timeline/entry/:entryId/photo/:photoId", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const entryId = String(req.params.entryId || "");
    const photoId = req.params.photoId;
    try {
      const out = deleteTimelinePhoto({ publicDir, serverDir, entryId, photoId });
      res.json({ ok: true, ...out });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("不存在") >= 0 || msg.indexOf("not found") >= 0 ? 404 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.put("/api/admin/photo-timeline/entry/:entryId/photo/:photoId", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const entryId = String(req.params.entryId || "");
    const photoId = req.params.photoId;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const patch = {};
      if (body.visibility !== undefined) patch.visibility = body.visibility;
      if (body.caption !== undefined) patch.caption = body.caption;
      if (body.semantic !== undefined && typeof body.semantic === "object") patch.semantic = body.semantic;
      const entry = updateTimelinePhotoMeta({ publicDir, serverDir, entryId, photoId, patch });
      res.json({ ok: true, entry });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("不存在") >= 0 || msg.indexOf("not found") >= 0 ? 404 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.post("/api/admin/photo-timeline/entry/:entryId/photo/:photoId/ai-suggest", async function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const entryId = String(req.params.entryId || "");
    const photoId = req.params.photoId;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const suggestion = await suggestTimelinePhotoSemanticFromAI({
        publicDir,
        serverDir,
        entryId,
        photoId,
        prompt: body.prompt,
      });
      res.json({ ok: true, suggestion });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("未配置 OPENAI_API_KEY") >= 0 ? 503 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });

  app.get("/api/admin/photo-timeline/photos", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    try {
      const page = readTimelinePhotosPage({
        serverDir,
        offset: req.query.offset,
        limit: req.query.limit,
        query: req.query.q,
        visibility: req.query.vis,
        entryVisibility: req.query.entryVis,
      });
      res.json({ ok: true, ...page });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message) });
    }
  });

  app.post("/api/admin/photo-timeline/photos/batch-visibility", function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const photoIds = Array.isArray(body.photoIds) ? body.photoIds : [];
      const visibility = body.visibility;
      const out = updateTimelinePhotosVisibilityBulk({ publicDir, serverDir, photoIds, visibility });
      res.json({ ok: true, ...out });
    } catch (err) {
      const msg = String((err && err.message) || err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  app.post("/api/admin/photo-timeline/resolve-missing-locations", async function (req, res) {
    if (!assertAdminBearerAuth(req, res)) return;
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const summary = await resolveMissingLocationLabels({
        publicDir,
        serverDir,
        limit: body.limit,
        dryRun: body.dryRun,
      });
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = msg.indexOf("database not found") >= 0 ? 503 : 400;
      res.status(code).json({ ok: false, error: msg });
    }
  });
}
