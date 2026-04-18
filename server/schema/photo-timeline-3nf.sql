-- 照片时间轴 · 规范化表结构（第三范式导向）
-- 定位：JSON（工具导出）→ 导入脚本写入本库；页面与 API 只读库，不依赖 JSON 形态。
-- 后续可迁移 MySQL：表名/列名保持一致，换连接与少量方言即可。
-- 向量检索：见文末 media_embeddings 占位，可接 pgvector / 专用向量库。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1) 时间轴条目（业务 entry）
--    业务键：同一日历日 + GPS 粗网格（与前端 GEO_BUCKET_DECIMALS=3 一致）→ 唯一一条。
--    id 由 calendar_date + gps_grid_key 派生（见 server/photo-timeline.js）。
--    标题 / 地点文案 / 天气摘要在条目级；照片、标签等为子表。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timeline_entries (
  id TEXT PRIMARY KEY,
  calendar_date TEXT NOT NULL,
  gps_grid_key TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT,
  -- 展示用地名；若需强范式「地点维表」，可改为 place_id -> places(id)
  place TEXT,
  note TEXT,
  -- 可见性：public（默认）| private（需登录）
  visibility TEXT NOT NULL DEFAULT 'public',
  data_version TEXT,
  source_path TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_entries_date ON timeline_entries (date DESC);
-- idx_timeline_entries_cal：在 ensureTimelineEntryBusinessColumns 之后由 migrate 创建（兼容旧库无 calendar_date 列）

-- ---------------------------------------------------------------------------
-- 2) 标签：独立实体，避免在条目上重复存储字符串（多对多）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT NOT NULL REFERENCES timeline_entries (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags (tag_id);

-- ---------------------------------------------------------------------------
-- 3) 地理：条目级 GPS（当前 JSON 即一条目一坐标；若将来每张照片独立坐标，可增 photo_gps）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_gps (
  entry_id TEXT PRIMARY KEY REFERENCES timeline_entries (id) ON DELETE CASCADE,
  latitude REAL,
  longitude REAL,
  altitude_m REAL,
  label TEXT
);

CREATE INDEX IF NOT EXISTS idx_entry_gps_lat_lng ON entry_gps (latitude, longitude);

-- ---------------------------------------------------------------------------
-- 4) 天气：条目级快照（与条目 1:1，避免与照片、标签混在同一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_weather (
  entry_id TEXT PRIMARY KEY REFERENCES timeline_entries (id) ON DELETE CASCADE,
  provider TEXT,
  fetched_at TEXT,
  summary TEXT,
  temp_high_c INTEGER,
  temp_low_c INTEGER,
  icon_code TEXT,
  precipitation_mm REAL,
  wind_max_m_s REAL,
  amap_detail TEXT
);

-- ---------------------------------------------------------------------------
-- 5) 照片：多对一归属条目，消除 photos[] 重复组
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timeline_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES timeline_entries (id) ON DELETE CASCADE,
  sort_index INTEGER NOT NULL DEFAULT 0,
  thumb TEXT,
  src TEXT,
  video TEXT,
  caption TEXT,
  ratio TEXT,
  -- 可见性：public（默认）| private（需登录）
  visibility TEXT NOT NULL DEFAULT 'public',
  -- 提取型元数据：优先来自 EXIF / 容器元数据
  captured_at TEXT,
  camera_make TEXT,
  camera_model TEXT,
  lens_model TEXT,
  device_model TEXT,
  gps_latitude REAL,
  gps_longitude REAL,
  -- 完整结构化元数据：拍摄参数、分辨率、软件、GPS、原始 EXIF 摘要等
  metadata_json TEXT,
  -- 语义信息：人物、地点名称/分类、场景、摘要、备注（通常需人工确认/补充）
  semantic_json TEXT,
  UNIQUE (entry_id, sort_index)
);

CREATE INDEX IF NOT EXISTS idx_timeline_photos_entry ON timeline_photos (entry_id);

-- ---------------------------------------------------------------------------
-- 6) 向量 / 语义检索占位（SQLite 存元数据；向量本体可 BLOB 或外链）
--    迁移向量库时保留 entity_type + entity_id + model 即可对齐业务主键。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER,
  -- 可选二进制向量；大表可只填 external_uri
  vector_blob BLOB,
  external_uri TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, model)
);

CREATE INDEX IF NOT EXISTS idx_media_embeddings_entity ON media_embeddings (entity_type, entity_id);
