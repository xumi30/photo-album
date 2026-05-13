## Photo Album (可独立搬走)

这个目录是从当前仓库里“照片时间轴 / 照片地图 / 后台管理 / SQLite 同步”单独抽出来的一份**可独立运行**副本。

- 目标：你后续可以把整个 `photo-album/` 目录直接移动到别的仓库/路径单独维护。
- 约束：不会修改本仓库现有任何文件；这里只新增文件。

### 目录结构

- `public/`: 静态站点（`photo-timeline.html`、`photo-map.html`、`admin-photo-timeline.html`、CSS/JS）
- `server/`: Node API（含同步 CLI、schema）
- `data/`: **运行时数据目录（默认不提交）**：SQLite、写回调试日志、以及默认素材库 **`data/live/`**（`photo-timeline-entry.json` + 媒体）。站点仍通过 **`/assets/live/...`** 提供访问，与物理路径是否在 `public/` 无关。可用 `PHOTO_TIMELINE_LIVE_ROOT`、`PHOTO_TIMELINE_DB_PATH` 改路径。

### 快速开始

在 `photo-album/` 目录内执行：

```bash
npm i
cp server/.env.example server/.env
npm run sync-photo-timeline
npm run start
```

若你曾在旧版本使用默认路径 `public/assets/live/`，可把其中文件整体迁到 **`data/live/`**（保持子目录结构），再执行同步。

然后打开：

- `http://localhost:3000/photo-timeline.html`
- `http://localhost:3000/photo-map.html`
- `http://localhost:3000/admin-photo-timeline.html`

### 素材库路径可配置（不用移动文件）

在 `server/.env` 配置：

- `PHOTO_TIMELINE_LIVE_ROOT`: 素材库目录
  - 不填则默认 **`data/live`**（仓库根下，与代码分离）
  - 支持绝对路径（例如 `/Volumes/Photos/live`）
  - 支持相对路径（相对 `photo-album/` 根目录，例如 `../my-photo-library/live`）

服务端会把该目录挂载到 `GET /assets/live/...`，并在同步时从该目录递归扫描 `photo-timeline-entry.json`。

### 可选：前台登录（用于“需登录可见”的照片）

在 `server/.env` 配置：

- `PHOTO_TIMELINE_USER_USERNAME`: 前台登录用户名
- `PHOTO_TIMELINE_USER_PASSWORD`: 前台登录密码

说明：

- 登录后通过 HttpOnly Cookie 维持会话，20 分钟过期
- 未登录用户最多预览 10 张照片
- 前台鉴权统一以登录 Cookie 为准

### 开发（可选）

两个终端：

```bash
npm run start
```

```bash
npm run dev:client
```

Vite 会把 `/api`、`/assets/live`、`/uploadphotos` 代理到 `server/.env` 里的 `PORT`（后者两处对应 **`data/live`** 与上传目录，请勿删掉代理）。
