/**
 * 照片时间轴引导配置。
 *
 * 方式 A — SQLite 接口（推荐，与 tools 输出 + 同步一致）：
 *   dataSource: "api", entriesUrl: "/api/photo-timeline/entries", entries: []
 *   先 npm run sync-photo-timeline 或 POST /api/photo-timeline/sync
 *
 * 方式 B — 分片静态 JSON：dataUrl + entries: []
 * 方式 C — 内联：仅填 entries
 *
 * 照片项可选 thumb：列表懒加载用小图，灯箱仍用 src 原图。
 */
window.PHOTO_TIMELINE_CONFIG = {
  pageSize: 5,
  dataSource: "api",
  entriesUrl: "/api/photo-timeline/entries",
  entries: [],
};

