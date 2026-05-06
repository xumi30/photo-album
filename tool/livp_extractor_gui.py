#!/usr/bin/env python3
"""
LIVP Live Photo Extractor — Web GUI
Browser-based interface using Python's built-in http.server.
No external dependencies required.
"""

import json
import logging
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Optional, Set
from urllib.parse import urlparse
import pickle

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import livp_extractor as core

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_PUBLIC_LIVE = _REPO_ROOT / "public" / "assets" / "live"
_EXTERNAL_LIVE_LINK = "_livp-external"

# ---------------------------------------------------------------------------
# State shared between the HTTP handler and the extraction thread
# ---------------------------------------------------------------------------

state = {
    "output_dir": str(_DEFAULT_PUBLIC_LIVE),
    "is_running": False,
    "progress": 0,
    "status": "Ready",
    "results": [],
    "logs": [],
    "cancel_requested": False,
    "processed_files": set(),  # 记录已成功处理的文件路径
    "current_session_files": set(),  # 当前会话要处理的文件
    "resume_from_saved": False,  # 是否从保存的状态恢复
    "performance": {
        "files_processed": 0,
        "total_files": 0,
        "files_per_second": 0.0,
        "memory_usage_mb": 0.0,
        "cpu_usage_percent": 0.0,
        "batch_size": 10,
        "threads_active": 0
    }
}
state_lock = threading.Lock()
cancel_event: Optional[threading.Event] = None

# 仅允许转发到本机 Node 的同步接口，避免滥用
_SYNC_PROXY_URL = re.compile(
    r"^https?://(127\.0\.0\.1|localhost)(:\d+)?/api/photo-timeline/sync/?$"
)


def _parse_env_file_keys(path: Path) -> dict:
    """解析 ADMIN_SECRET（及旧名 PHOTO_TIMELINE_SYNC_SECRET），与 Node getWriteSecret 一致。"""
    out: dict = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        logging.debug(f"读取环境文件 {path}，大小: {len(text)} 字节")
    except OSError as e:
        logging.debug(f"无法读取环境文件 {path}: {e}")
        return out
    
    key_count = 0
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        k, _, rest = s.partition("=")
        key = k.strip()
        if key not in ("ADMIN_SECRET", "PHOTO_TIMELINE_SYNC_SECRET"):
            continue
        v = rest.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" and v[-1] == v[0]:
            v = v[1:-1]
        out[key] = v
        key_count += 1
    
    if key_count > 0:
        logging.debug(f"从环境文件解析到 {key_count} 个密钥配置")
    return out


def save_processing_state():
    """保存当前处理状态到文件"""
    try:
        state_file = _REPO_ROOT / "tools" / "livp_processing_state.pkl"
        with state_lock:
            data_to_save = {
                "processed_files": list(state["processed_files"]),
                "last_output_dir": state["output_dir"],
                "timestamp": time.time()
            }
        with open(state_file, 'wb') as f:
            pickle.dump(data_to_save, f)
        logging.debug(f"处理状态已保存到 {state_file}")
    except Exception as e:
        logging.warning(f"保存处理状态失败: {e}")


def load_processing_state():
    """从文件加载处理状态"""
    try:
        state_file = _REPO_ROOT / "tools" / "livp_processing_state.pkl"
        if state_file.exists():
            with open(state_file, 'rb') as f:
                saved_state = pickle.load(f)
            
            with state_lock:
                state["processed_files"] = set(saved_state.get("processed_files", []))
                state["resume_from_saved"] = True
            
            logging.info(f"从保存的状态中恢复了 {len(state['processed_files'])} 个已处理文件记录")
            return True
        else:
            logging.debug("没有找到保存的处理状态文件")
            return False
    except Exception as e:
        logging.warning(f"加载处理状态失败: {e}")
        return False


def clear_processing_state():
    """清除保存的处理状态"""
    try:
        state_file = _REPO_ROOT / "tools" / "livp_processing_state.pkl"
        if state_file.exists():
            state_file.unlink()
        with state_lock:
            state["processed_files"] = set()
            state["resume_from_saved"] = False
        logging.info("处理状态已清除")
    except Exception as e:
        logging.warning(f"清除处理状态失败: {e}")


def is_file_already_processed(file_path: str, output_dir: str) -> bool:
    """检查文件是否已处理过"""
    try:
        # 检查内存中的处理记录
        with state_lock:
            if file_path in state["processed_files"]:
                return True

        # 与 core._is_file_already_processed 保持一致：
        # 以“输出目录中存在包含 livp 文件名的子目录，并且子目录内有 metadata.json”为已处理标志。
        livp_name = Path(file_path).stem
        out_root = Path(output_dir)
        if not out_root.exists():
            return False

        for existing_dir in out_root.iterdir():
            if not existing_dir.is_dir():
                continue
            if livp_name in existing_dir.name:
                if (existing_dir / "metadata.json").exists():
                    return True
        return False
    except Exception as e:
        logging.warning(f"检查文件是否已处理失败: {file_path} - {e}")
        return False


def _is_subpath(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


def _ensure_live_symlink_for_external_output(output_dir: Path, logger: logging.Logger) -> Optional[str]:
    """
    外部输出目录场景：在 public/assets/live 下创建软链接，前端通过 /assets/live/<link>/... 访问。
    返回 web_prefix 覆盖值（如 assets/live/_livp-external）或 None（不需要覆盖）。
    """
    if _is_subpath(output_dir, _DEFAULT_PUBLIC_LIVE):
        return None

    _DEFAULT_PUBLIC_LIVE.mkdir(parents=True, exist_ok=True)
    link_path = _DEFAULT_PUBLIC_LIVE / _EXTERNAL_LIVE_LINK
    try:
        if link_path.exists() or link_path.is_symlink():
            if link_path.is_symlink() or link_path.is_file():
                link_path.unlink()
            else:
                logger.warning("软链接目标路径已存在且不是文件/软链接: %s", link_path)
                return None
        os.symlink(str(output_dir), str(link_path))
        logger.info("已创建软链接: %s -> %s", link_path, output_dir)
        return f"assets/live/{_EXTERNAL_LIVE_LINK}"
    except Exception as exc:
        logger.warning("创建软链接失败，保持原 web_prefix: %s", exc)
        return None


def _suggest_output_dir_for_scan_folder(folder_path: str) -> str:
    """
    扫描目录平级创建输出目录:
    /a/b/input -> /a/b/input_livp_output
    """
    p = Path(folder_path).resolve()
    return str((p.parent / f"{p.name}_livp_output").resolve())


def _cleanup_extracted_heic_files(result: dict, logger: logging.Logger) -> int:
    """
    GUI 侧策略：提取完成后不保留 .heic/.heif 文件。
    仍会保留 thumb/preview JPEG、MOV、metadata.json、photo-timeline-entry.json 等产物。
    返回删除的 HEIC/HEIF 文件数量。
    """
    deleted = 0
    out_dir = result.get("output_directory")
    if not out_dir:
        return 0

    # 优先使用 result 里记录的具体文件路径
    extracted = (result.get("extracted_files") or {}).get("heic") or []
    for p in extracted:
        try:
            path = Path(p)
            if path.suffix.lower() in (".heic", ".heif") and path.exists():
                path.unlink()
                deleted += 1
        except Exception as exc:
            logger.debug("删除 HEIC 失败 %s: %s", p, exc)

    # 兜底：扫描目录，删掉残留的 .heic/.heif
    try:
        for p in Path(out_dir).rglob("*"):
            if p.is_file() and p.suffix.lower() in (".heic", ".heif"):
                try:
                    p.unlink()
                    deleted += 1
                except Exception as exc:
                    logger.debug("删除残留 HEIC 失败 %s: %s", p, exc)
    except Exception as exc:
        logger.debug("扫描输出目录以清理 HEIC 失败 %s: %s", out_dir, exc)

    if deleted:
        logger.info("🧹 已清理 HEIC/HEIF 文件: %s 个（不保存原始 HEIC）", deleted)
    return deleted


def get_timeline_sync_secret_for_proxy() -> str:
    """
    与 Node 相同：统一用 ADMIN_SECRET；无则兼容旧名。
    先读进程环境变量；若无则只读 server/.env。
    """
    # 先检查进程环境变量
    a = os.environ.get("ADMIN_SECRET", "").strip()
    b = os.environ.get("PHOTO_TIMELINE_SYNC_SECRET", "").strip()
    
    if a:
        logging.debug("从进程环境变量 ADMIN_SECRET 获取密钥（已隐藏敏感内容）")
        return a
    if b:
        logging.debug("从进程环境变量 PHOTO_TIMELINE_SYNC_SECRET 获取密钥（已隐藏敏感内容）")
        return b
    
    # 再检查服务器环境文件
    server_env_path = _REPO_ROOT / "server" / ".env"
    logging.debug(f"检查服务器环境文件: {server_env_path}")
    server_env = _parse_env_file_keys(server_env_path)
    
    secret = server_env.get("ADMIN_SECRET", "").strip() or server_env.get(
        "PHOTO_TIMELINE_SYNC_SECRET", ""
    ).strip()
    
    if secret:
        logging.debug("从服务器环境文件获取密钥（已隐藏敏感内容）")
    else:
        logging.warning("未找到同步密钥配置，HTTP 同步可能失败")
    
    return secret


class QueueHandler(logging.Handler):
    def __init__(self):
        super().__init__()

    def emit(self, record):
        try:
            msg = self.format(record)
            with state_lock:
                state["logs"].append(msg)
                # 限制日志数量避免内存溢出
                if len(state["logs"]) > 800:
                    state["logs"] = state["logs"][-400:]
                    logging.debug("日志队列已修剪，保留最近400条")
        except Exception as e:
            # 避免日志处理错误导致整个程序崩溃
            print(f"队列日志处理错误: {e}")


# ---------------------------------------------------------------------------
# Extraction in background thread
# ---------------------------------------------------------------------------

def run_extraction(
    files,
    output_dir,
    *,
    on_conflict: str = "unique",
    cancel_event: Optional[threading.Event] = None,
    web_asset_prefix: str = "assets/live",
    export_timeline_jpeg: bool = True,
    skip_processed: bool = True,
    sync_live_root: Optional[str] = None,
    repo_root_hint: Optional[str] = None,
):
    # 初始化变量，避免作用域问题
    success = 0
    failed = 0
    timeline_entries = []
    total = len(files)
    
    # 初始化状态
    with state_lock:
        state["is_running"] = True
        state["progress"] = 0
        state["status"] = "正在初始化优化处理引擎…"
        state["results"] = []
        state["logs"] = []
        state["cancel_requested"] = False
        state["performance"] = {
            "files_processed": 0,
            "files_per_second": 0.0,
            "memory_usage_mb": 0.0,
            "cpu_usage_percent": 0.0,
            "batch_size": 10,
            "threads_active": 0,
            "total_files": total
        }

    # 配置日志系统
    logger = logging.getLogger("livp_extractor")
    logger.handlers.clear()
    logger.setLevel(logging.DEBUG)
    logger.propagate = False  # 防止日志传播到根记录器

    # 配置队列处理器（用于Web界面显示）
    qh = QueueHandler()
    qh.setLevel(logging.DEBUG)
    qh.setFormatter(logging.Formatter(core.LOG_FORMAT, datefmt=core.DATE_FORMAT))
    logger.addHandler(qh)

    # 创建输出目录
    os.makedirs(output_dir, exist_ok=True)
    logging.info(f"创建输出目录: {output_dir}")

    # 配置文件日志处理器
    log_file = Path(output_dir) / "livp_extractor.log"
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(core.LOG_FORMAT, datefmt=core.DATE_FORMAT))
    logger.addHandler(fh)
    
    # 记录提取开始信息
    logger.info("=" * 60)
    logger.info(f"开始 LIVP 提取 - 文件数量: {len(files)}, 输出目录: {output_dir}")
    logger.info(f"配置 - 冲突处理: {on_conflict}, 输出前缀: {web_asset_prefix}, 导出JPEG: {export_timeline_jpeg}")
    logger.info("=" * 60)

    # 使用优化后的批处理函数
    try:
        total = len(files)
        logger.info(f"使用优化批处理架构处理 {total} 个文件")
        
        # 定义性能监控回调函数
        def performance_callback(metrics: dict):
            with state_lock:
                # 保留total_files字段
                metrics["total_files"] = total
                state["performance"] = metrics
                # 基于性能数据更新进度显示
                files_processed = metrics["files_processed"]
                if total > 0:
                    state["progress"] = int(files_processed / total * 100)
                    state["status"] = (
                        f"已处理: {files_processed}/{total} | "
                        f"速度: {metrics['files_per_second']:.1f} 文件/秒 | "
                        f"内存: {metrics['memory_usage_mb']:.1f} MB | "
                        f"线程: {metrics['threads_active']}"
                    )
        
        # 执行批处理提取
        results = core.batch_extract_files_optimized(
            files,
            output_dir,
            logger,
            on_conflict=on_conflict,
            cancel_event=cancel_event,
            web_asset_prefix=web_asset_prefix,
            export_timeline_jpeg=export_timeline_jpeg,
            progress_cb=performance_callback,
            skip_processed=skip_processed
        )
        
        # 处理结果
        success = sum(1 for r in results if r is not None)
        failed = len(results) - success
        timeline_entries = []
        
        processed_files = []
        for result in results:
            if result:
                # 提取完成后：不保存 HEIC/HEIF（删除原始图片文件，仅保留 JPEG 预览/缩略图、MOV、JSON 等）
                heic_deleted = _cleanup_extracted_heic_files(result, logger)

                gps = "—"
                for m in result.get("heic_metadata", []):
                    lat, lon = m.get("gps_latitude"), m.get("gps_longitude")
                    if lat is not None and lon is not None:
                        gps = f"{lat:.5f}, {lon:.5f}"
                        logger.debug(f"提取到GPS坐标: {gps}")
                        break
                
                ent = result.get("photo_timeline_entry")
                if ent:
                    timeline_entries.append(ent)
                    logger.debug(f"创建时间轴条目: {ent.get('id', '未知ID')}")
                
                # 记录成功处理的文件
                processed_files.append(result["source_file"])
                
                with state_lock:
                    state["results"].append({
                        "file": result["source_file"],
                        "date": result["capture_date"],
                        # 不保留 HEIC 文件时，这里显示 0（原始 HEIC 已删除）
                        "heic": 0,
                        "mov": result["mov_count"],
                        "gps": gps,
                        "entry_id": (ent or {}).get("id", "—"),
                        "timeline": "✓" if ent else "—",
                    })
                logger.info(
                    "✓ 成功处理: %s (HEIC: %s -> 已删除 %s, MOV: %s)",
                    Path(result["source_file"]).name,
                    result.get("heic_count", 0),
                    heic_deleted,
                    result.get("mov_count", 0),
                )
        
        # 更新已处理的文件记录
        if processed_files:
            with state_lock:
                state["processed_files"].update(processed_files)
            # 保存处理状态到文件
            save_processing_state()
        
        logger.info(f"文件处理完成 - 成功: {success}, 失败: {failed}")
        
        # 合并时间轴数据（多个文件时）
        if len(timeline_entries) > 1:
            try:
                merged_path = Path(output_dir) / "photo-timeline-merged.json"
                timeline_fragment = core.build_timeline_fragment(timeline_entries)
                with open(merged_path, "w", encoding="utf-8") as f:
                    json.dump(timeline_fragment, f, ensure_ascii=False, indent=2)
                logger.info(f"合并时间轴数据 -> {merged_path} (条目数: {len(timeline_entries)})")
            except Exception as exc:
                logger.error(f"合并时间轴失败: {exc}", exc_info=True)
    
    except Exception as e:
        logger.error(f"批处理过程中发生错误: {e}", exc_info=True)
        # 检查是否取消
        cancelled = cancel_event and cancel_event.is_set()
        if cancelled:
            logger.warning("检测到用户取消请求")
    
    # 同步到数据库
    cancelled = cancel_event and cancel_event.is_set()
    if not cancelled and success > 0:
        logger.info("尝试同步到SQLite数据库...")
        try:
            core.maybe_sync_photo_timeline_db(
                output_dir,
                logger,
                repo_root_hint=repo_root_hint,
                live_root=sync_live_root,
            )
            logger.info("数据库同步完成")
        except Exception as exc:
            logger.warning(f"数据库同步异常: {exc}", exc_info=True)

    # 生成总结信息
    if cancelled:
        summary = f"已取消 — 成功: {success}, 失败: {failed}"
        logger.warning(summary)
    else:
        summary = f"完成 — 成功: {success}, 失败: {failed}"
        logger.info(summary)
    
    # 记录详细统计信息
    logger.info("=" * 60)
    logger.info(f"提取统计 - 总数: {total}, 成功: {success}, 失败: {failed}, 完成率: {int(success/total*100) if total > 0 else 0}%")
    if timeline_entries:
        logger.info(f"时间轴条目创建: {len(timeline_entries)}")
    logger.info("=" * 60)
    
    # 清理资源
    fh.close()

    # 更新最终状态
    with state_lock:
        state["is_running"] = False
        if not cancelled:
            state["progress"] = 100
        state["status"] = summary
    
    # 最终保存处理状态（即使在失败或取消的情况下也要保存）
    if not cancelled or success > 0:
        save_processing_state()


# ---------------------------------------------------------------------------
# HTML page
# ---------------------------------------------------------------------------

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LIVP 提取 · Live Photo</title>
<style>
  :root {
    --bg: #12141c;
    --surface: #1b1e28;
    --elevated: #222632;
    --border: #2e3240;
    --text: #eceef4;
    --dim: #8b90a1;
    --accent: #7c9cff;
    --accent-soft: rgba(124, 156, 255, 0.14);
    --green: #5ee9a0;
    --yellow: #f5c84c;
    --red: #ff8b8b;
    --radius: 12px;
    --font: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font);
    background: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(124, 156, 255, 0.12), transparent),
      var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 28px 20px 48px;
    line-height: 1.45;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 6px;
  }
  h1 span { color: var(--accent); font-weight: 700; }
  .subtitle { color: var(--dim); font-size: 0.88rem; margin-bottom: 22px; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 18px;
    margin-bottom: 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,.22);
  }
  .card-title {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--dim);
    margin-bottom: 14px;
  }

  /* folder select zone */
  .folder-zone {
    border: 2px dashed var(--border);
    border-radius: var(--radius);
    padding: 32px 20px;
    text-align: center;
    cursor: pointer;
    transition: border-color .2s, background .2s, box-shadow .2s;
    background: var(--elevated);
  }
  .folder-zone:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px rgba(124, 156, 255, 0.2);
  }
  .folder-zone .icon { font-size: 32px; margin-bottom: 6px; opacity: 0.9; }
  .folder-zone .label { font-size: 0.95rem; font-weight: 500; }
  .folder-zone .hint { color: var(--dim); font-size: 0.78rem; margin-top: 6px; }
  .folder-zone.selected { border-color: var(--green); border-style: solid; background: rgba(94, 233, 160, 0.06); }
  .folder-zone.selected .label { color: var(--green); }

  .file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .chip {
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid rgba(124, 156, 255, 0.25);
  }

  .timeline-note {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--elevated);
    border: 1px solid var(--border);
    font-size: 0.78rem;
    color: var(--dim);
    line-height: 1.55;
  }
  .timeline-note code {
    color: var(--accent);
    font-size: 0.76rem;
    word-break: break-all;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    font-size: 0.85rem;
    color: var(--dim);
  }
  .check-row input { width: 16px; height: 16px; accent-color: var(--accent); }

  /* controls */
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button {
    background: linear-gradient(180deg, #8aaaff 0%, var(--accent) 100%);
    color: #0b0d12;
    border: none;
    padding: 9px 22px;
    border-radius: 8px;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    transition: transform .12s, filter .15s, box-shadow .15s;
    white-space: nowrap;
    box-shadow: 0 2px 12px rgba(124, 156, 255, 0.35);
  }
  button:hover { filter: brightness(1.06); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button:disabled { opacity: .45; cursor: not-allowed; transform: none; filter: none; box-shadow: none; }
  .btn-secondary {
    background: var(--elevated);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: none;
    font-weight: 600;
  }
  .btn-secondary:hover {
    border-color: var(--accent);
    color: var(--accent);
    filter: none;
  }

  input.text {
    flex: 1;
    min-width: 160px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
  }
  input.text:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .hint-line { color: var(--dim); font-size: 0.78rem; margin-top: 8px; line-height: 1.5; }

  /* progress */
  .progress-wrap { flex: 1; }
  .progress-bar {
    height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: var(--accent); border-radius: 3px;
    transition: width .3s ease; width: 0%;
  }
  .progress-label { font-size: 12px; color: var(--dim); margin-top: 4px; }

  /* results table */
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th {
    text-align: left;
    padding: 8px 8px;
    border-bottom: 1px solid var(--border);
    color: var(--dim);
    font-weight: 600;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td { padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: top; }
  tr:hover td { background: rgba(124, 156, 255, 0.04); }
  .center { text-align: center; }
  .col-id { font-size: 0.72rem; color: var(--accent); word-break: break-all; max-width: 200px; }
  .empty-msg { text-align: center; color: var(--dim); padding: 28px; font-size: 0.85rem; }

  /* performance monitor */
  .perf-box {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 100px;
    text-align: center;
  }
  .perf-label {
    font-size: 0.7rem;
    color: var(--dim);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .perf-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--accent);
  }

  /* log console */
  .log-console {
    background: #0a0c11;
    border-radius: 8px;
    padding: 12px 14px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72rem;
    line-height: 1.55;
    max-height: 240px;
    overflow-y: auto;
    color: var(--dim);
    border: 1px solid var(--border);
  }
  .log-console .info { color: var(--green); }
  .log-console .warn { color: var(--yellow); }
  .log-console .error { color: var(--red); }
  .log-console .debug { color: #555; }
</style>
</head>
<body>
<div class="wrap">

<h1><span>LIVP</span> 提取器</h1>
<p class="subtitle">解压 Apple Live Photo（.livp）→ HEIC / MOV，并生成与「照片时间轴」页面兼容的 JSON 与缩略图。</p>

<!-- Input Folder -->
<div class="card">
  <div class="card-title">输入 · 选择含 .livp 的文件夹</div>
  <div class="row">
    <input id="folderPath" class="text" type="text" spellcheck="false" placeholder="输入包含 .livp 文件的文件夹路径">
    <button type="button" onclick="scanFolder()">扫描文件夹</button>
  </div>
  <div class="hint-line">输入文件夹的完整路径（如 E:\resume\tools\livp_files），然后点击"扫描文件夹"按钮。</div>
  <div class="file-chips" id="fileChips"></div>
</div>

<!-- Output Folder -->
<div class="card">
  <div class="card-title">输出 · 保存目录</div>
  <div class="row">
    <input id="outputDir" class="text" type="text" spellcheck="false" placeholder="仓库内 public/assets/live">
    <button type="button" class="btn-secondary" onclick="useDefaultOutput()">默认</button>
    <button type="button" class="btn-secondary" onclick="openOutput()">打开目录</button>
  </div>
  <div class="hint-line" id="outputHint">支持绝对路径与 <code>~</code>；相对路径会在桌面下创建。</div>
</div>

<!-- Timeline web paths -->
<div class="card">
  <div class="card-title">网站路径 · 写入 JSON 的 URL 前缀</div>
  <div class="row">
    <input id="webPrefix" class="text" type="text" spellcheck="false" value="assets/live" placeholder="assets/live">
  </div>
<div class="hint-line" id="prefixHint">assets/live</div>.
  <div class="check-row">
    <input type="checkbox" id="exportJpeg" checked>
    <label for="exportJpeg">生成 JPEG 缩略图（thumb）与预览图（preview），Chrome 等浏览器可正常显示列表</label>
  </div>
  <div class="check-row">
    <input type="checkbox" id="skipProcessed" checked>
    <label for="skipProcessed">跳过已处理的文件（支持重启恢复）</label>
  </div>
  <div class="check-row">
    <button type="button" onclick="clearProcessedRecords()" style="margin-left: 0; padding: 4px 8px; font-size: 0.7rem;">清除处理记录</button>
  </div>

  <div class="timeline-note">
    默认已指向仓库内 <code>public/assets/live/</code>，与站点静态路径一致。提取结束后会<strong>自动</strong>在本机执行 <code>node server/photo-timeline-cli.mjs</code> 写入 SQLite（需已安装 Node，且输出目录在仓库内以便找到脚本）。输出到桌面等目录时不会自动同步，可手动点下方「同步数据库」或运行 <code>npm run sync-photo-timeline</code>。
  </div>
</div>

<!-- Sync DB -->
<div class="card">
  <div class="card-title">同步 · 写入站点 SQLite（可选）</div>
  <div class="row">
    <input id="syncUrl" class="text" type="text" spellcheck="false" value="http://127.0.0.1:3000/api/photo-timeline/sync" placeholder="http://127.0.0.1:端口/api/photo-timeline/sync">
    <button type="button" id="syncBtn" onclick="syncDatabase()">HTTP 同步</button>
  </div>
  <div class="hint-line">提取完成后已尽量自动跑 CLI 同步；若未成功（例如未检测到仓库根），可用本按钮通过<strong>同源代理</strong>转发到已运行的 <code>npm start</code>。请在 <code>server/.env</code> 配置 <code>ADMIN_SECRET</code>，代理会<strong>自动从仓库内 .env 读取</strong>并带上请求头；也可在启动 GUI 前 <code>export ADMIN_SECRET=…</code>。跳过自动同步可设 <code>LIVP_NO_DB_SYNC=1</code>。</div>
  <div id="syncResult" class="hint-line" style="margin-top:10px;min-height:1.2em;"></div>
</div>

<!-- Performance Monitor -->
<div class="card" id="performanceCard" style="display:none;">
  <div class="card-title">性能监控</div>
  <div class="row" style="gap: 20px; align-items: start;">
    <div class="perf-box">
      <div class="perf-label">处理速度</div>
      <div class="perf-value" id="perfSpeed">0.0 文件/秒</div>
    </div>
    <div class="perf-box">
      <div class="perf-label">内存使用</div>
      <div class="perf-value" id="perfMemory">0.0 MB</div>
    </div>
    <div class="perf-box">
      <div class="perf-label">活跃线程</div>
      <div class="perf-value" id="perfThreads">0</div>
    </div>
    <div class="perf-box">
      <div class="perf-label">批次大小</div>
      <div class="perf-value" id="perfBatch">10</div>
    </div>
    <div class="perf-box">
      <div class="perf-label">已处理</div>
      <div class="perf-value" id="perfProcessed">0</div>
    </div>
  </div>
</div>

<!-- Action -->
<div class="card">
  <div class="row" style="align-items: stretch;">
    <div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-label" id="statusLabel">就绪</div>
      <div class="progress-label" id="processedLabel" style="display:none;">已处理: 0/0</div>
    </div>
    <button type="button" class="btn-secondary" id="resetBtn" onclick="resetAll()">重置</button>
    <button type="button" class="btn-secondary" id="cancelBtn" onclick="cancelExtraction()" disabled>取消</button>
    <button type="button" id="startBtn" onclick="startExtraction()">开始提取</button>
  </div>
</div>

<!-- Results -->
<div class="card">
  <div class="card-title">结果</div>
  <table>
    <thead><tr>
      <th>源文件</th><th>拍摄日</th>
      <th class="center">HEIC</th><th class="center">MOV</th><th>GPS</th>
      <th>时间轴条目 id</th>
    </tr></thead>
    <tbody id="resultsBody">
      <tr><td colspan="6" class="empty-msg">尚无结果</td></tr>
    </tbody>
  </table>
</div>

<!-- Log -->
<div class="card">
  <div class="card-title">日志</div>
  <div class="log-console" id="logConsole">等待开始…</div>
</div>

</div>

<script>
const livpFiles = new Map();
let isRunning = false;

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// --- Scan folder function ---
async function scanFolder() {
  const folderPath = document.getElementById('folderPath').value.trim();
  const outputDir = document.getElementById('outputDir').value.trim();
  const skipProcessed = document.getElementById('skipProcessed')?.checked || true;

  if (!folderPath) {
    alert('请输入文件夹路径');
    return;
  }

  try {
    const resp = await fetch('/api/scan-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        folder_path: folderPath,
        output_dir: outputDir,
        skip_processed: skipProcessed
      })
    });

    if (!resp.ok) {
      const error = await resp.text();
      alert('扫描文件夹失败: ' + error);
      return;
    }

    const data = await resp.json();
    livpFiles.clear();
    if (data.output_dir) {
      document.getElementById('outputDir').value = data.output_dir;
    }

    if (data.files && data.files.length > 0) {
      data.files.forEach(file => {
        livpFiles.set(file, file);
      });

      let chipsHtml = Array.from(livpFiles.keys()).slice(0, 80).map(n => `<span class="chip">${esc(n.split(/[/\\]/).pop())}</span>`).join('');
      if (livpFiles.size > 80) {
        chipsHtml += `<span class="chip">… +${livpFiles.size - 80}</span>`;
      }

      // 显示被跳过的文件
      if (data.skipped_files && data.skipped_files.length > 0) {
        const skippedHtml = data.skipped_files.slice(0, 30).map(n => `<span class="chip" style="background:var(--elevated);color:var(--dim);border-color:var(--border);">${esc(n.split(/[/\\]/).pop())}</span>`).join('');
        const moreSkipped = data.skipped_files.length > 30 ? `<span class="chip" style="background:var(--elevated);color:var(--dim);border-color:var(--border);">… +${data.skipped_files.length - 30}</span>` : '';
        chipsHtml += `<div style="margin-top:12px;color:var(--dim);font-size:0.78rem;">已跳过 ${data.skipped_count} 个已处理文件：</div>` + skippedHtml + moreSkipped;
      }

      document.getElementById('fileChips').innerHTML = chipsHtml;

      let message = `成功扫描到 ${livpFiles.size} 个 .livp 文件`;
      if (data.skipped_count > 0) {
        message += `，跳过 ${data.skipped_count} 个已处理文件`;
      }
      alert(message);
    } else {
      document.getElementById('fileChips').innerHTML = '';
      let message = '该文件夹内没有找到 .livp 文件';
      if (data.skipped_count > 0) {
        message = `所有 ${data.skipped_count} 个 .livp 文件都已处理过`;
      }
      alert(message);
    }
  } catch (error) {
    alert('请求失败: ' + error.message);
  }
}

async function clearProcessedRecords() {
  if (confirm('确定要清除所有已处理的文件记录吗？这将允许重新处理之前已经处理过的文件。')) {
    try {
      const resp = await fetch('/api/clear-records', { method: 'POST' });
      if (resp.ok) {
        alert('已处理记录已清除');
      } else {
        const error = await resp.text();
        alert('清除失败: ' + error);
      }
    } catch (error) {
      alert('请求失败: ' + error.message);
    }
  }
}

function useDefaultOutput() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(d) {
    document.getElementById('outputDir').value = d.output_dir || '';
  }).catch(function() {});
}

async function openOutput() {
  try { await fetch('/api/open_output', { method: 'POST' }); } catch (e) {}
}

async function syncDatabase() {
  const url = document.getElementById('syncUrl').value.trim();
  const el = document.getElementById('syncResult');
  const btn = document.getElementById('syncBtn');
  if (!url) { el.textContent = '请填写同步接口 URL'; el.style.color = 'var(--red)'; return; }
  el.style.color = 'var(--dim)';
  el.textContent = '同步中…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/sync-timeline-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
    const j = await r.json().catch(function() { return {}; });
    if (!r.ok) throw new Error(j.error || j.message || r.statusText || String(r.status));
    el.style.color = 'var(--green)';
    var msg = '完成：扫描 ' + (j.scanned || 0) + ' 个 JSON，写入 ' + (j.upserted || 0) + ' 条。';
    if (j.errors && j.errors.length) msg += ' ' + j.errors.slice(0, 4).join('；');
    el.textContent = msg;
  } catch (e) {
    el.style.color = 'var(--red)';
    var extra = '（确认已 npm start、URL 端口与 server/.env 的 PORT 一致；若配置了 ADMIN_SECRET，401 多为密钥与 .env 不一致或 Node 未重启）';
    el.textContent = '失败：' + (e && e.message ? e.message : e) + extra;
  }
  btn.disabled = false;
}

function resetAll() {
  livpFiles.clear();
  if (polling) { clearInterval(polling); polling = null; }
  document.getElementById('fileChips').innerHTML = '';
  document.getElementById('folderPath').value = '';
  document.getElementById('resultsBody').innerHTML = '<tr><td colspan="6" class="empty-msg">尚无结果</td></tr>';
  document.getElementById('logConsole').textContent = '等待开始…';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('statusLabel').textContent = '就绪';
  document.getElementById('processedLabel').style.display = 'none';
  document.getElementById('performanceCard').style.display = 'none';
  document.getElementById('startBtn').disabled = false;
  document.getElementById('cancelBtn').disabled = true;
  document.getElementById('resetBtn').disabled = false;
}

// --- extraction ---
let polling = null;

async function startExtraction() {
  if (livpFiles.size === 0) { alert('请先选择包含 .livp 的文件夹。'); return; }
  const outDir = document.getElementById('outputDir').value.trim();
  if (!outDir) { alert('请填写输出目录。'); return; }

  // 获取文件路径列表
  const filePaths = Array.from(livpFiles.keys());

  const requestData = {
    files: filePaths,
    output_dir: outDir,
    web_prefix: (document.getElementById('webPrefix').value || 'assets/live').trim() || 'assets/live',
    export_timeline_jpeg: document.getElementById('exportJpeg').checked,
    skip_processed: document.getElementById('skipProcessed').checked,
    on_conflict: 'overwrite'  // 覆盖已存在的文件
  };

  document.getElementById('startBtn').disabled = true;
  document.getElementById('cancelBtn').disabled = false;
  document.getElementById('resetBtn').disabled = true;
  document.getElementById('resultsBody').innerHTML = '<tr><td colspan="6" class="empty-msg">处理中…</td></tr>';
  document.getElementById('logConsole').textContent = '';

  try {
    const resp = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });
    
    if (!resp.ok) {
      const txt = await resp.text();
      alert('启动失败: ' + txt);
      document.getElementById('startBtn').disabled = false;
      document.getElementById('cancelBtn').disabled = true;
      document.getElementById('resetBtn').disabled = false;
      return;
    }
    
    polling = setInterval(pollStatus, 300);
  } catch (error) {
    alert('请求失败: ' + error.message);
    document.getElementById('startBtn').disabled = false;
    document.getElementById('cancelBtn').disabled = true;
    document.getElementById('resetBtn').disabled = false;
  }
}

async function cancelExtraction() {
  document.getElementById('cancelBtn').disabled = true;
  try { await fetch('/api/cancel', { method: 'POST' }); } catch (e) {}
}

async function pollStatus() {
  let d = null;
  try {
    const r = await fetch('/api/status');
    d = await r.json();
  } catch (e) {
    return;
  }

  document.getElementById('progressFill').style.width = d.progress + '%';
  document.getElementById('statusLabel').textContent = d.status;
  isRunning = !!d.is_running;

  // 更新已处理数量显示
  if (d.performance && d.is_running) {
    const perf = d.performance;
    const processedLabel = document.getElementById('processedLabel');
    processedLabel.style.display = 'block';
    processedLabel.textContent = `已处理: ${perf.files_processed}/${perf.total_files || 0}`;
  } else if (!d.is_running) {
    document.getElementById('processedLabel').style.display = 'none';
  }

  // 更新性能监控数据
  if (d.performance && d.is_running) {
    const perf = d.performance;
    const perfCard = document.getElementById('performanceCard');
    if (perfCard.style.display === 'none') {
      perfCard.style.display = 'block';
    }
    
    document.getElementById('perfSpeed').textContent = perf.files_per_second.toFixed(1) + ' 文件/秒';
    document.getElementById('perfMemory').textContent = perf.memory_usage_mb.toFixed(1) + ' MB';
    document.getElementById('perfThreads').textContent = perf.threads_active;
    document.getElementById('perfBatch').textContent = perf.batch_size;
    document.getElementById('perfProcessed').textContent = perf.files_processed;
  } else if (d.performance && !d.is_running && document.getElementById('performanceCard').style.display !== 'none') {
    document.getElementById('performanceCard').style.display = 'none';
  }

  if (d.results.length) {
    document.getElementById('resultsBody').innerHTML = d.results.map(r => `<tr>
      <td>${esc(r.file)}</td><td>${esc(r.date)}</td>
      <td class="center">${r.heic}</td><td class="center">${r.mov}</td>
      <td>${esc(r.gps)}</td>
      <td class="col-id">${esc(r.entry_id || '—')}</td></tr>`).join('');
  }

  if (d.logs.length) {
    const logEl = document.getElementById('logConsole');
    logEl.innerHTML = d.logs.map(l => {
      let cls = '';
      if (l.includes('[INFO]')) cls = 'info';
      else if (l.includes('[WARNING]')) cls = 'warn';
      else if (l.includes('[ERROR]')) cls = 'error';
      else if (l.includes('[DEBUG]')) cls = 'debug';
      return `<div class="${cls}">${esc(l)}</div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (!d.is_running) {
    clearInterval(polling);
    document.getElementById('startBtn').disabled = false;
    document.getElementById('cancelBtn').disabled = true;
    document.getElementById('resetBtn').disabled = false;
  }
}

document.getElementById('webPrefix').addEventListener('input', function() {
  const p = (this.value || 'assets/live').trim() || 'assets/live';
  document.getElementById('prefixHint').textContent = p;
});

// init output dir
(async function init() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const el = document.getElementById('outputDir');
    el.value = d.output_dir || '';
  } catch (e) {}
  document.getElementById('prefixHint').textContent = (document.getElementById('webPrefix').value || 'assets/live').trim() || 'assets/live';
})();
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# HTTP Request Handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass

    def _respond(self, code, content_type, body):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._respond(200, "text/html; charset=utf-8", HTML_PAGE)
        elif path == "/api/status":
            with state_lock:
                payload = {
                    "is_running": state["is_running"],
                    "progress": state["progress"],
                    "status": state["status"],
                    "results": list(state["results"]),
                    "logs": list(state["logs"]),
                    "output_dir": state["output_dir"],
                    "cancel_requested": state["cancel_requested"],
                }
            self._respond(200, "application/json", json.dumps(payload))
        else:
            self._respond(404, "text/plain", "Not Found")

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/start":
            self._handle_start()
        elif path == "/api/cancel":
            self._handle_cancel()
        elif path == "/api/open_output":
            self._handle_open_output()
        elif path == "/api/sync-timeline-proxy":
            self._handle_sync_timeline_proxy()
        elif path == "/api/scan-folder":
            self._handle_scan_folder()
        elif path == "/api/clear-records":
            self._handle_clear_records()
        else:
            self._respond(404, "text/plain", "Not Found")

    def _handle_scan_folder(self):
        """处理扫描文件夹请求，返回文件夹中的所有.livp文件"""
        logging.info("处理扫描文件夹请求")

        try:
            # 解析请求体
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode("utf-8"))

            folder_path = data.get("folder_path", "").strip()
            output_dir = data.get("output_dir", "").strip()
            skip_processed = data.get("skip_processed", True)

            logging.info(f"扫描参数 - 文件夹: {folder_path}, 输出目录: {output_dir}, 跳过已处理: {skip_processed}")

            if not folder_path:
                self._respond(400, "application/json", '{"error":"folder_path is required"}')
                return

            # 确保路径是绝对路径
            if not os.path.isabs(folder_path):
                folder_path = os.path.abspath(folder_path)

            # 检查文件夹是否存在
            if not os.path.isdir(folder_path):
                self._respond(400, "application/json", f'{{"error":"文件夹不存在: {folder_path}"}}')
                return

            # 扫描时始终按扫描目录重算平级输出目录，并回填到页面。
            # 这样不会被输入框里旧值（如 public/assets/live）阻断。
            output_dir = _suggest_output_dir_for_scan_folder(folder_path)
            logging.info(f"扫描自动输出目录(平级): {output_dir}")

            # 扫描文件夹中的所有.livp文件
            all_files = []
            valid_files = []
            skipped_files = []
            
            try:
                for root, dirs, files in os.walk(folder_path):
                    for file in files:
                        if file.lower().endswith('.livp'):
                            file_path = os.path.join(root, file)
                            all_files.append(file_path)
                
                if skip_processed:
                    for file_path in all_files:
                        if is_file_already_processed(file_path, output_dir):
                            skipped_files.append(file_path)
                        else:
                            valid_files.append(file_path)
                else:
                    valid_files = all_files

                logging.info(f"扫描完成 - 总共找到 {len(all_files)} 个.livp 文件")
                logging.info(f"待处理: {len(valid_files)} 个，跳过: {len(skipped_files)} 个")

                # 设置当前会话的文件列表
                with state_lock:
                    state["current_session_files"] = set(valid_files)
                    state["output_dir"] = output_dir
                
                # 返回文件列表
                response_data = {
                    "folder_path": folder_path,
                    "output_dir": output_dir,
                    "count": len(valid_files),
                    "files": valid_files,
                    "total_found": len(all_files),
                    "skipped_count": len(skipped_files),
                    "skipped_files": skipped_files
                }
                self._respond(200, "application/json", json.dumps(response_data, ensure_ascii=False))

            except Exception as e:
                logging.error(f"扫描文件夹时出错: {e}", exc_info=True)
                self._respond(500, "application/json", f'{{"error":"扫描文件夹失败: {str(e)}"}}')

        except json.JSONDecodeError as e:
            logging.error(f"JSON解析失败: {e}")
            self._respond(400, "application/json", '{"error":"invalid json"}')
        except Exception as e:
            logging.error(f"处理扫描文件夹请求时出错: {e}", exc_info=True)
            self._respond(500, "application/json", f'{{"error":"服务器错误: {str(e)}"}}')

    def _handle_clear_records(self):
        """清除已处理的文件记录"""
        try:
            clear_processing_state()
            self._respond(200, "application/json", '{"message":"已处理记录已清除"}')
        except Exception as e:
            logging.error(f"清除处理记录失败: {e}")
            self._respond(500, "application/json", f'{{"error":"清除记录失败: {str(e)}"}}')

    def _handle_sync_timeline_proxy(self):
        """浏览器同源请求本接口，由 Python 转发 POST 到 Node，避免跨域 Failed to fetch。"""
        logging.debug("处理HTTP同步代理请求")
        
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        
        try:
            data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
            logging.debug(f"解析请求数据，URL字段: {data.get('url', '未指定')}")
        except json.JSONDecodeError as e:
            logging.error(f"JSON解析失败: {e}")
            self._respond(400, "application/json", '{"error":"invalid json"}')
            return
        url = (data.get("url") or "").strip()
        if not url or not _SYNC_PROXY_URL.match(url):
            self._respond(
                400,
                "application/json",
                json.dumps(
                    {
                        "ok": False,
                        "error": "invalid url: only http(s)://127.0.0.1 or localhost .../api/photo-timeline/sync",
                    },
                    ensure_ascii=False,
                ),
            )
            return
        try:
            headers = {"Content-Type": "application/json"}
            secret = get_timeline_sync_secret_for_proxy()
            if secret:
                headers["X-Photo-Timeline-Sync-Secret"] = secret
            req = urllib.request.Request(
                url,
                data=b"{}",
                method="POST",
                headers=headers,
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                out = resp.read().decode("utf-8", errors="replace")
                code = resp.status
            self._respond(code, "application/json; charset=utf-8", out)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            logging.error(f"HTTP 同步代理错误 {e.code}: {err_body}")
            self._respond(e.code, "application/json; charset=utf-8", err_body)
        except Exception as e:
            logging.error(f"同步代理发生异常: {e}", exc_info=True)
            self._respond(
                502,
                "application/json",
                json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False),
            )

    def _handle_start(self):
        global cancel_event
        with state_lock:
            if state["is_running"]:
                self._respond(409, "application/json", '{"error":"already running"}')
                return

        # 直接解析JSON请求体
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body.decode("utf-8"))

        # 获取文件路径列表
        file_paths = data.get("files", [])
        output_dir_raw = data.get("output_dir", state["output_dir"]).strip()
        on_conflict = data.get("on_conflict", "unique")
        web_prefix = data.get("web_prefix", "assets/live")
        export_jpeg = data.get("export_timeline_jpeg", True)
        skip_processed = data.get("skip_processed", True)

        # 不保存 HEIC/HEIF 的前提下，必须确保生成 preview/thumb JPEG，
        # 否则 photo-timeline JSON 可能回退引用 HEIC 文件导致前端无法展示。
        if not export_jpeg:
            logging.info("检测到 export_timeline_jpeg=false，但已启用「不保存 HEIC」策略，将强制改为 true")
            export_jpeg = True

        if not file_paths:
            self._respond(400, "application/json", '{"error":"no files"}')
            return

        # 验证文件路径
        valid_paths = []
        for path in file_paths:
            # 现在前端传递的已经是完整的绝对路径
            if os.path.isfile(path) and path.lower().endswith('.livp'):
                valid_paths.append(path)
            else:
                logging.warning(f"跳过无效文件: {path}")

        if not valid_paths:
            self._respond(400, "application/json", '{"error":"no valid files"}')
            return

        # 处理输出目录
        output_dir = os.path.expanduser(os.path.expandvars(output_dir_raw))
        if not os.path.isabs(output_dir):
            output_dir = os.path.join(os.path.expanduser("~"), "Desktop", output_dir)
        output_dir = os.path.abspath(output_dir)
        output_path = Path(output_dir)

        # 外部目录自动软链接到 public/assets/live，避免移动媒体文件。
        live_prefix_override = _ensure_live_symlink_for_external_output(output_path, logging.getLogger("livp_extractor"))
        if live_prefix_override:
            web_prefix = live_prefix_override
            logging.info("检测到外部输出目录，已切换 web_prefix -> %s", web_prefix)

        with state_lock:
            state["output_dir"] = output_dir

        logging.info(f"启动提取任务 - 文件数: {len(valid_paths)}, 输出目录: {output_dir}")
        logging.debug(f"任务参数 - web_prefix: {web_prefix}, export_jpeg: {export_jpeg}, on_conflict: {on_conflict}")

        cancel_event = threading.Event()
        t = threading.Thread(
            target=self._extraction_thread,
            args=(
                valid_paths,
                output_dir,
                cancel_event,
                on_conflict,
                web_prefix,
                export_jpeg,
                skip_processed,
                output_dir,
                str(_REPO_ROOT),
            ),
            daemon=True,
        )
        t.start()
        
        logging.info("后台提取线程已启动")
        self._respond(200, "application/json", json.dumps({"ok": True, "output_dir": output_dir}))

    @staticmethod
    def _extraction_thread(
        files,
        output_dir,
        cancel_event,
        on_conflict,
        web_asset_prefix,
        export_timeline_jpeg,
        skip_processed,
        sync_live_root,
        repo_root_hint,
    ):
        logger = logging.getLogger("livp_extractor")
        
        try:
            logger.info(f"提取线程启动 - 文件数: {len(files)}")
            logger.debug(f"线程配置: on_conflict={on_conflict}, web_prefix={web_asset_prefix}, export_jpeg={export_timeline_jpeg}")
            
            run_extraction(
                files,
                output_dir,
                cancel_event=cancel_event,
                on_conflict=on_conflict,
                web_asset_prefix=web_asset_prefix,
                export_timeline_jpeg=export_timeline_jpeg,
                skip_processed=skip_processed,
                sync_live_root=sync_live_root,
                repo_root_hint=repo_root_hint,
            )
            
            logger.info("提取线程正常完成")
            
        except Exception as exc:
            logger.error(f"提取线程发生未捕获异常: {exc}", exc_info=True)
            with state_lock:
                state["status"] = f"错误: {exc}"
                state["is_running"] = False
        finally:
            logger.info("提取线程结束")

    def _handle_cancel(self):
        global cancel_event
        logging.info("收到取消请求")
        with state_lock:
            if not state["is_running"]:
                logging.debug("取消请求但当前无运行任务")
                self._respond(200, "application/json", json.dumps({"ok": True, "is_running": False}))
                return
            state["cancel_requested"] = True
            logging.info("已标记取消请求，等待任务停止")
        
        if cancel_event is not None:
            cancel_event.set()
            logging.debug("已设置取消事件")
        else:
            logging.warning("取消事件为None，可能任务已结束")
            
        self._respond(200, "application/json", json.dumps({"ok": True, "cancel_requested": True}))

    def _handle_open_output(self):
        with state_lock:
            out_dir = state["output_dir"]
        
        logging.info(f"请求打开输出目录: {out_dir}")
        
        try:
            webbrowser.open(f"file://{out_dir}")
            logging.info("成功打开输出目录")
            self._respond(200, "application/json", json.dumps({"ok": True}))
        except Exception as exc:
            logging.error(f"打开输出目录失败: {exc}")
            self._respond(500, "application/json", json.dumps({"ok": False, "error": str(exc)}))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # 解析命令行参数
    import argparse
    parser = argparse.ArgumentParser(description='LIVP Extractor GUI - Web界面版LIVP文件提取器')
    parser.add_argument('-p', '--port', type=int, default=8765, 
                       help='服务器端口号 (默认: 8765)')
    parser.add_argument('--no-browser', action='store_true', 
                       help='不自动打开浏览器')
    
    args = parser.parse_args()
    
    # 启动时加载处理状态
    if load_processing_state():
        logging.info("已从保存的状态中恢复处理进度，重启后支持跳过已处理文件")
    else:
        logging.info("未找到保存的处理状态，开始新的处理会话")
    
    # 配置根日志记录器用于程序启动日志
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    logger = logging.getLogger(__name__)
    
    logger.info("启动 LIVP 提取器 GUI")
    logger.info(f"仓库根目录: {_REPO_ROOT}")
    
    # 尝试获取可用端口
    base_port = args.port
    for p in range(base_port, base_port + 15):
        try:
            server = HTTPServer(("127.0.0.1", p), Handler)
            port = p
            logger.info(f"成功绑定到端口 {p}")
            break
        except OSError as e:
            logger.debug(f"端口 {p} 不可用: {e}")
            continue
    else:
        logger.error(f"无法在端口范围 {base_port}-{base_port+14} 中找到可用端口")
        print(f"ERROR: Could not find an open port in range {base_port}-{base_port+14}")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"
    logger.info(f"GUI 服务运行在: {url}")
    print(f"LIVP Extractor GUI running at {url}")
    print("Press Ctrl+C to stop.\n")

    # 尝试打开浏览器
    if not args.no_browser:
        try:
            webbrowser.open(url)
            logger.info("已尝试在浏览器中打开应用")
        except Exception as e:
            logger.warning(f"打开浏览器失败: {e}")
    else:
        logger.info("跳过浏览器自动打开")

    # 启动服务器
    try:
        logger.info("服务器开始监听请求...")
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("收到键盘中断信号，正在关闭服务器...")
        print("\nShutting down.")
        server.shutdown()
        logger.info("服务器已关闭")
    except Exception as e:
        logger.error(f"服务器运行异常: {e}", exc_info=True)
        
    logger.info("LIVP 提取器 GUI 已停止")


if __name__ == "__main__":
    main()
