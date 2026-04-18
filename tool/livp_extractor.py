#!/usr/bin/env python3
"""
LIVP Live Photo Extractor
Extracts .heic (static) and .mov (video) from Apple LIVP files,
organizes them by capture date, and records EXIF metadata (GPS + time) as JSON.
"""

import argparse
import concurrent.futures
import json
import logging
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
import psutil
import time

# 导入配置模块
from config import Config

try:
    from PIL import Image
    from PIL.ExifTags import TAGS, GPSTAGS

    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

# Best-effort HEIC/HEIF support for Pillow
HAS_PILLOW_HEIF = False
if HAS_PILLOW:
    try:
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
        HAS_PILLOW_HEIF = True
    except Exception:
        HAS_PILLOW_HEIF = False

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

ProgressCallback = Callable[[int, int, str], None]
PerformanceStats = Dict[str, Any]


class ExtractionCancelled(Exception):
    pass


class PerformanceMonitor:
    """性能监控器：跟踪资源使用和处理速度"""
    
    def __init__(self, logger: logging.Logger, *, emit_logs: bool = True):
        self.logger = logger
        self.emit_logs = emit_logs
        self.start_time = None
        self.file_count = 0
        self.total_size = 0
        self.last_checkpoint = None
        
    def start(self):
        self.start_time = time.time()
        self.last_checkpoint = self.start_time
        if self.emit_logs:
            self.logger.info("性能监控器启动")
        
    def stop(self):
        """停止性能监控"""
        if self.start_time:
            final_stats = self.get_stats()
            if self.emit_logs:
                self.logger.info(f"性能监控停止 - 处理文件数: {self.file_count}, "
                                f"总数据量: {final_stats['total_size_mb']:.1f}MB, "
                                f"总时间: {final_stats['elapsed_time']:.1f}秒")
    
    def update_file_processed(self, file_size: int):
        self.file_count += 1
        self.total_size += file_size
        
    def get_stats(self) -> PerformanceStats:
        if not self.start_time:
            return {}
            
        current_time = time.time()
        elapsed = current_time - self.start_time
        
        # 计算处理速度
        files_per_second = self.file_count / elapsed if elapsed > 0 else 0
        bytes_per_second = self.total_size / elapsed if elapsed > 0 else 0
        
        # 极限优化:减少性能监控的系统调用频率
        try:
            mem = psutil.virtual_memory()
            # 极限优化:跳过CPU百分比检查,减少系统调用
            # cpu_percent = psutil.cpu_percent(interval=None)
            memory_usage_mb = mem.used / (1024 * 1024)
            # 极限优化:跳过线程数检查,减少系统调用
            # threads_active = threading.active_count()
            cpu_percent = 0
            threads_active = 0
        except:
            mem = None
            cpu_percent = 0
            memory_usage_mb = 0
            threads_active = 0
        
        return {
            "elapsed_time": elapsed,
            "files_processed": self.file_count,
            "total_size_mb": self.total_size / (1024 * 1024),
            "files_per_second": files_per_second,
            "mb_per_second": bytes_per_second / (1024 * 1024),
            "memory_percent": mem.percent if mem else None,
            "memory_usage_mb": memory_usage_mb,
            "cpu_percent": cpu_percent,
            "threads_active": threads_active,  # 添加threads_active键
            "estimated_remaining": None
        }


class BatchProcessor:
    """智能分批处理器：处理40GB、1000+文件的大规模数据"""
    
    def __init__(self, logger: logging.Logger):
        self.logger = logger
        self.performance_monitor = PerformanceMonitor(logger)
        
    def calculate_optimal_batch_size(self, total_files: int, avg_file_size_mb: float) -> int:
        """根据系统资源和文件特征计算最佳批次大小"""
        # 获取内存信息
        try:
            mem = psutil.virtual_memory()
            available_memory_mb = mem.available / (1024 * 1024)
        except:
            available_memory_mb = 2048  # 默认2GB
            
        # 考虑文件大小和内存限制
        memory_based = max(1, int(available_memory_mb * 0.4 / avg_file_size_mb))  # 使用40%内存
        
        # CPU核心数限制
        cpu_cores = os.cpu_count() or 4
        cpu_based = min(cpu_cores * 6, total_files)  # 每个核心处理6个文件
        
        # 极限优化:疯狂增加批次大小
        max_batch_size = 300 if available_memory_mb >= 26384 else 100  # 极限提升批次大小
        batch_size = min(memory_based, cpu_based, max_batch_size)
        batch_size = max(1, min(batch_size, total_files))  # 确保在有效范围内
        
        self.logger.info(f"批次大小计算 - 文件数: {total_files}, 平均大小: {avg_file_size_mb:.1f}MB, "
                        f"可用内存: {available_memory_mb:.0f}MB, 推荐批次: {batch_size}")
        
        return batch_size
        
    def process_in_batches(self, tasks, worker_function, max_workers=None):
        """使用智能批次处理并行执行任务"""
        if not tasks:
            return []
            
        if max_workers is None:
            # 使用配置文件中的外层工作线程数
            max_workers = min((os.cpu_count() or 4) * 5, Config.OUTER_MAX_WORKERS)
            
        self.performance_monitor.start()
        
        all_results = []
        total_tasks = len(tasks)
        processed = 0

        self.logger.info(f"开始批量处理 - 总数: {total_tasks}, 工作线程: {max_workers}")

        # 复用单个线程池，避免每批次反复创建/销毁 executor。
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_task = {executor.submit(worker_function, task): task for task in tasks}

            for future in concurrent.futures.as_completed(future_to_task):
                task = future_to_task[future]
                processed += 1

                try:
                    result = future.result()
                    all_results.append(result)
                    self.performance_monitor.update_file_processed(40 * 1024 * 1024)  # 假设40MB

                    if processed % 10 == 0 or processed == total_tasks:
                        progress_pct = int(processed / total_tasks * 100)
                        stats = self.performance_monitor.get_stats()
                        self.logger.info(
                            f"进度: {processed}/{total_tasks} ({progress_pct}%) - "
                            f"速度: {stats['files_per_second']:.1f}文件/秒"
                        )

                        if stats['memory_percent'] and stats['memory_percent'] > 85:
                            self.logger.warning(f"内存使用率高 ({stats['memory_percent']:.1f}%), 建议重启程序")
                except Exception as exc:
                    self.logger.error(f"任务处理失败 {task}: {exc}")
                    all_results.append(None)
            
            # 暴力优化:移除批次间延迟,全速处理
            # if batch_end < total_tasks:
            #     time.sleep(0.1)  # 已移除延迟
        
        # 最终性能报告
        final_stats = self.performance_monitor.get_stats()
        self.logger.info(f"处理完成 - 总时间: {final_stats['elapsed_time']:.1f}秒, "
                        f"平均速度: {final_stats['files_per_second']:.1f}文件/秒, "
                        f"总数据量: {final_stats['total_size_mb']:.1f}MB")
        
        return all_results


def resolve_repo_root(output_root: str) -> Optional[Path]:
    """
    从输出目录向上查找含 server/photo-timeline-cli.mjs 的仓库根，用于导入后同步 SQLite。
    """
    try:
        p = Path(output_root).resolve()
    except Exception:
        return None
    for d in [p, *p.parents]:
        cli = d / "server" / "photo-timeline-cli.mjs"
        if cli.is_file():
            return d
    return None


def run_photo_timeline_db_sync(repo_root: Path, logger: logging.Logger) -> bool:
    """在项目根执行 node server/photo-timeline-cli.mjs，将 public/assets/live 下 JSON 写入 SQLite。"""
    cli = repo_root / "server" / "photo-timeline-cli.mjs"
    if not cli.is_file():
        logger.warning("未找到 %s，跳过数据库同步", cli)
        return False
    try:
        r = subprocess.run(
            [os.environ.get("NODE_EXE", "node"), str(cli)],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=300,
        )
        if r.stdout and r.stdout.strip():
            logger.info("[photo-timeline sync]\n%s", r.stdout.strip())
        if r.stderr and r.stderr.strip():
            logger.info("[photo-timeline sync stderr]\n%s", r.stderr.strip())
        if r.returncode != 0:
            logger.error("数据库同步失败 (exit %s)", r.returncode)
            return False
        logger.info("已同步 SQLite（photo-timeline-cli）")
        return True
    except FileNotFoundError:
        logger.warning("未找到 node 可执行文件，跳过数据库同步。可手动执行: npm run sync-photo-timeline")
        return False
    except subprocess.TimeoutExpired:
        logger.error("数据库同步超时")
        return False
    except Exception as exc:
        logger.warning("数据库同步异常: %s", exc)
        return False


def maybe_sync_photo_timeline_db(output_root: str, logger: logging.Logger) -> None:
    """若设置环境变量 LIVP_NO_DB_SYNC=1 则跳过。"""
    if os.environ.get("LIVP_NO_DB_SYNC", "").strip() in ("1", "true", "yes"):
        logger.info("已设置 LIVP_NO_DB_SYNC，跳过 SQLite 同步")
        return
    root = resolve_repo_root(output_root)
    if root is None:
        logger.info(
            "未检测到仓库根（向上查找 server/photo-timeline-cli.mjs 失败），跳过 SQLite 同步；"
            "或手动在项目根执行: npm run sync-photo-timeline"
        )
        return
    run_photo_timeline_db_sync(root, logger)


def setup_logging(output_dir: Path) -> logging.Logger:
    logger = logging.getLogger("livp_extractor")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    # Avoid duplicate handlers when called multiple times in-process.
    for h in list(logger.handlers):
        logger.removeHandler(h)

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
    logger.addHandler(console)

    log_file = output_dir / "livp_extractor.log"
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
    logger.addHandler(fh)

    return logger


# ---------------------------------------------------------------------------
# HEIC date fallback: parse the 'hdlr' box to find a date if Pillow can't
# ---------------------------------------------------------------------------

def _read_heic_date_fallback(filepath: str) -> Optional[str]:
    """Try to read DateTimeOriginal from raw EXIF in HEIC (best-effort)."""
    try:
        with open(filepath, "rb") as f:
            data = f.read()
        marker = b"Exif\x00\x00"
        idx = data.find(marker)
        if idx == -1:
            return None
        tag_id = 0x9003  # DateTimeOriginal
        tiff_offset = idx + len(marker)
        byte_order = data[tiff_offset : tiff_offset + 2]
        if byte_order == b"MM":
            endian = ">"
        elif byte_order == b"II":
            endian = "<"
        else:
            return None
        search_area = data[tiff_offset : tiff_offset + 4096]
        tag_bytes = struct.pack(endian + "H", tag_id)
        pos = search_area.find(tag_bytes)
        if pos == -1:
            return None
        entry = search_area[pos : pos + 12]
        if len(entry) < 12:
            return None
        _tag, _type, count, val_offset = struct.unpack(endian + "HHII", entry)
        abs_offset = tiff_offset + val_offset
        date_str = data[abs_offset : abs_offset + 19].decode("ascii", errors="ignore")
        if len(date_str) == 19 and date_str[4] == ":":
            return date_str
    except Exception:
        pass
    return None


def _unique_path(path: Path) -> Path:
    # 极限优化:直接返回路径,跳过存在性检查
    # 因为文件是从ZIP解压的,文件名冲突概率极低
    # 如果真的冲突,操作系统会报错,我们可以捕获异常
    return path


def _unique_dir(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 10000):
        cand = path.with_name(f"{path.name}_{i}")
        if not cand.exists():
            return cand
    raise RuntimeError(f"Could not find unique directory name for {path}")


def _zip_members_by_suffix(zf: zipfile.ZipFile, suffixes: Sequence[str]) -> List[str]:
    out: List[str] = []
    for name in zf.namelist():
        lower = name.lower()
        if any(lower.endswith(s) for s in suffixes):
            out.append(name)
    return out


def _extract_and_process_member(
    zf: zipfile.ZipFile,
    member_name: str,
    dest_dir: Path,
    logger: logging.Logger,
    cancel_event: Optional[threading.Event] = None,
) -> Optional[Path]:
    """流式解压并处理单个成员，返回文件路径"""
    if cancel_event and cancel_event.is_set():
        raise ExtractionCancelled()
        
    safe_name = Path(member_name).name
    if not safe_name:
        logger.debug("跳过无名ZIP成员: %s", member_name)
        return None
        
    out_path = _unique_path(dest_dir / safe_name)
    try:
        with zf.open(member_name) as src, open(out_path, "wb") as dst:
            # 使用配置文件中的缓冲区大小
            shutil.copyfileobj(src, dst, length=Config.FILE_COPY_BUFFER_SIZE)
        return out_path
    except KeyError:
        logger.warning("ZIP成员消失: %s", member_name)
    except Exception as exc:
        logger.warning("解压成员失败 %s: %s", member_name, exc)
    
    return None


def _get_optimal_batch_size(total_files: int, available_memory: int) -> int:
    """根据系统资源计算最佳批处理大小"""
    # 基础批处理大小
    base_batch = min(10, max(1, total_files // 100))
    
    # 根据可用内存调整
    memory_factor = min(available_memory // (100 * 1024 * 1024), 10)  # 每100MB增加1
    return min(base_batch + memory_factor, total_files)


def _get_memory_info(logger: logging.Logger) -> tuple:
    """获取内存信息，返回(总内存GB, 可用内存GB, 可用内存百分比)"""
    try:
        mem = psutil.virtual_memory()
        total_gb = mem.total / (1024**3)
        available_gb = mem.available / (1024**3)
        available_percent = mem.available / mem.total * 100
        
        logger.debug(f"内存状态 - 总: {total_gb:.1f}GB, 可用: {available_gb:.1f}GB ({available_percent:.1f}%)")
        return total_gb, available_gb, available_percent
    except Exception as e:
        logger.warning(f"无法获取内存信息: {e}, 使用默认配置")
        return 8, 2, 25  # 默认值


# ---------------------------------------------------------------------------
# EXIF helpers
# ---------------------------------------------------------------------------

def _dms_to_decimal(dms_tuple, ref: str) -> Optional[float]:
    """Convert (degrees, minutes, seconds) with reference to decimal degrees."""
    try:
        if hasattr(dms_tuple[0], "numerator"):
            degrees = float(dms_tuple[0])
            minutes = float(dms_tuple[1])
            seconds = float(dms_tuple[2])
        else:
            degrees, minutes, seconds = float(dms_tuple[0]), float(dms_tuple[1]), float(dms_tuple[2])
        decimal = degrees + minutes / 60.0 + seconds / 3600.0
        if ref in ("S", "W"):
            decimal = -decimal
        return round(decimal, 6)
    except Exception:
        return None


def _rational_to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        if hasattr(value, "numerator") and hasattr(value, "denominator"):
            denominator = float(value.denominator)
            if denominator == 0:
                return None
            return float(value.numerator) / denominator
        return float(value)
    except Exception:
        return None


def _normalize_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _normalize_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(round(float(value)))
    except Exception:
        return None


def _format_exposure_time(seconds: Optional[float]) -> Optional[str]:
    if seconds is None or seconds <= 0:
        return None
    try:
        if seconds >= 1:
            value = f"{seconds:.1f}".rstrip("0").rstrip(".")
            return f"{value}s"
        reciprocal = round(1 / seconds)
        if reciprocal > 0:
            return f"1/{reciprocal}s"
    except Exception:
        return None
    return None


def _empty_heic_metadata(filepath: str) -> dict:
    return {
        "file": os.path.basename(filepath),
        "datetime_original": None,
        "datetime_digitized": None,
        "datetime_file": None,
        "gps_latitude": None,
        "gps_longitude": None,
        "gps_altitude": None,
        "camera_make": None,
        "camera_model": None,
        "lens_model": None,
        "device_model": None,
        "software": None,
        "aperture_f_number": None,
        "exposure_time_s": None,
        "exposure_time_text": None,
        "iso": None,
        "focal_length_mm": None,
        "width_px": None,
        "height_px": None,
        "raw_exif": {},
        "apple_photos": {
            "embedded_labels_found": False,
            "people_labels": [],
            "place_category": None,
            "note": "LIVP/HEIC 文件通常不包含 Apple Photos 图库里的人物识别与地点分类结果",
        },
    }


def _extract_heic_metadata_from_image(img, filepath: str, logger: logging.Logger) -> dict:
    """从已打开的 Pillow 图像读取 EXIF 元数据，避免重复打开 HEIC。"""
    meta = _empty_heic_metadata(filepath)

    # Pillow public API (works better with pillow-heif)
    exif_obj = None
    if hasattr(img, "getexif"):
        try:
            exif_obj = img.getexif()
        except Exception:
            exif_obj = None

    if exif_obj:
        raw_exif: Dict[str, Any] = {}
        for key, val in exif_obj.items():
            tag_name = TAGS.get(key, key)
            if isinstance(tag_name, str) and tag_name not in ("GPSInfo",):
                try:
                    raw_exif[str(tag_name)] = str(val)
                except Exception:
                    pass
        meta["raw_exif"] = raw_exif

        for tid in (36867, 36868, 306):  # DateTimeOriginal, DateTimeDigitized, DateTime
            val = exif_obj.get(tid)
            if val:
                if tid == 36867:
                    meta["datetime_original"] = str(val)
                elif tid == 36868:
                    meta["datetime_digitized"] = str(val)
                    if not meta["datetime_original"]:
                        meta["datetime_original"] = str(val)
                else:
                    meta["datetime_file"] = str(val)
                    if not meta["datetime_original"]:
                        meta["datetime_original"] = str(val)
                break

        meta["camera_make"] = _normalize_text(exif_obj.get(271))
        meta["camera_model"] = _normalize_text(exif_obj.get(272))
        meta["device_model"] = meta["camera_model"]
        meta["software"] = _normalize_text(exif_obj.get(305))
        meta["lens_model"] = _normalize_text(exif_obj.get(42036))
        meta["aperture_f_number"] = _rational_to_float(exif_obj.get(33437))
        meta["exposure_time_s"] = _rational_to_float(exif_obj.get(33434))
        meta["exposure_time_text"] = _format_exposure_time(meta["exposure_time_s"])
        meta["iso"] = _normalize_int(exif_obj.get(34855) or exif_obj.get(34867))
        meta["focal_length_mm"] = _rational_to_float(exif_obj.get(37386))
        try:
            meta["width_px"] = int(getattr(img, "width", 0) or 0) or None
            meta["height_px"] = int(getattr(img, "height", 0) or 0) or None
        except Exception:
            pass

        gps_ifd = None
        if hasattr(exif_obj, "get_ifd"):
            try:
                gps_ifd = exif_obj.get_ifd(34853)  # GPSInfo IFD
            except Exception:
                gps_ifd = None
        if gps_ifd is None:
            gps_ifd = exif_obj.get(34853)

        if gps_ifd:
            gps_decoded = {GPSTAGS.get(k, k): v for k, v in dict(gps_ifd).items()}
            lat = gps_decoded.get("GPSLatitude")
            lat_ref = gps_decoded.get("GPSLatitudeRef", "N")
            lon = gps_decoded.get("GPSLongitude")
            lon_ref = gps_decoded.get("GPSLongitudeRef", "E")
            alt = gps_decoded.get("GPSAltitude")

            if lat:
                meta["gps_latitude"] = _dms_to_decimal(lat, lat_ref)
            if lon:
                meta["gps_longitude"] = _dms_to_decimal(lon, lon_ref)
            if alt is not None:
                try:
                    meta["gps_altitude"] = round(float(alt), 2)
                except Exception:
                    pass
    else:
        get_exif = getattr(img, "_getexif", None)
        exif_data = get_exif() if callable(get_exif) else None
        if exif_data:
            decoded = {TAGS.get(k, k): v for k, v in exif_data.items()}
            meta["raw_exif"] = {
                str(k): str(v) for k, v in decoded.items() if k != "GPSInfo"
            }
            for tag in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
                if tag in decoded:
                    if tag == "DateTimeOriginal":
                        meta["datetime_original"] = str(decoded[tag])
                    elif tag == "DateTimeDigitized":
                        meta["datetime_digitized"] = str(decoded[tag])
                        if not meta["datetime_original"]:
                            meta["datetime_original"] = str(decoded[tag])
                    else:
                        meta["datetime_file"] = str(decoded[tag])
                        if not meta["datetime_original"]:
                            meta["datetime_original"] = str(decoded[tag])
                    if meta["datetime_original"]:
                        break

            meta["camera_make"] = _normalize_text(decoded.get("Make"))
            meta["camera_model"] = _normalize_text(decoded.get("Model"))
            meta["device_model"] = meta["camera_model"]
            meta["software"] = _normalize_text(decoded.get("Software"))
            meta["lens_model"] = _normalize_text(decoded.get("LensModel"))
            meta["aperture_f_number"] = _rational_to_float(decoded.get("FNumber"))
            meta["exposure_time_s"] = _rational_to_float(decoded.get("ExposureTime"))
            meta["exposure_time_text"] = _format_exposure_time(meta["exposure_time_s"])
            meta["iso"] = _normalize_int(decoded.get("ISOSpeedRatings") or decoded.get("PhotographicSensitivity"))
            meta["focal_length_mm"] = _rational_to_float(decoded.get("FocalLength"))
            try:
                meta["width_px"] = int(getattr(img, "width", 0) or 0) or None
                meta["height_px"] = int(getattr(img, "height", 0) or 0) or None
            except Exception:
                pass

            gps_info = decoded.get("GPSInfo")
            if gps_info:
                gps_decoded = {GPSTAGS.get(k, k): v for k, v in gps_info.items()}
                lat = gps_decoded.get("GPSLatitude")
                lat_ref = gps_decoded.get("GPSLatitudeRef", "N")
                lon = gps_decoded.get("GPSLongitude")
                lon_ref = gps_decoded.get("GPSLongitudeRef", "E")
                alt = gps_decoded.get("GPSAltitude")

                if lat:
                    meta["gps_latitude"] = _dms_to_decimal(lat, lat_ref)
                if lon:
                    meta["gps_longitude"] = _dms_to_decimal(lon, lon_ref)
                if alt is not None:
                    try:
                        meta["gps_altitude"] = round(float(alt), 2)
                    except Exception:
                        pass
        else:
            logger.debug("No EXIF data found in %s", filepath)

    if not meta["datetime_original"]:
        raw_date = _read_heic_date_fallback(filepath)
        if raw_date:
            meta["datetime_original"] = raw_date

    return meta


def extract_heic_metadata(filepath: str, logger: logging.Logger) -> dict:
    """Extract GPS coordinates and datetime from a HEIC file's EXIF data."""
    meta = _empty_heic_metadata(filepath)

    if not HAS_PILLOW:
        logger.warning("Pillow not installed — falling back to raw EXIF parse for %s", filepath)
        raw_date = _read_heic_date_fallback(filepath)
        if raw_date:
            meta["datetime_original"] = raw_date
        return meta

    try:
        img = Image.open(filepath)
        try:
            meta = _extract_heic_metadata_from_image(img, filepath, logger)
        finally:
            try:
                img.close()
            except Exception:
                pass

        logger.debug("EXIF metadata for %s: %s", filepath, meta)
    except Exception as exc:
        logger.warning("Failed to read EXIF from %s: %s", filepath, exc)
        raw_date = _read_heic_date_fallback(filepath)
        if raw_date:
            meta["datetime_original"] = raw_date

    return meta


def get_capture_date(heic_path: str, logger: logging.Logger) -> str:
    """Return the capture date as 'YYYY-MM-DD' from EXIF, falling back to file mtime."""
    meta = extract_heic_metadata(heic_path, logger)
    dt_str = meta.get("datetime_original")
    if dt_str:
        candidate = str(dt_str).strip()
        for fmt in ("%Y:%m:%d %H:%M:%S", "%Y:%m:%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
            try:
                dt = datetime.strptime(candidate, fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
        # Common EXIF format prefix
        try:
            dt = datetime.strptime(candidate[:10].replace(":", "-"), "%Y-%m-%d")
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            pass
    mtime = os.path.getmtime(heic_path)
    return datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Photo timeline JSON (for public/assets/scripts photo-timeline)
# ---------------------------------------------------------------------------

def _weather_placeholder() -> Dict[str, Any]:
    return {
        "provider": None,
        "fetched_at": None,
        "summary": None,
        "temp_high_c": None,
        "temp_low_c": None,
        "icon_code": None,
        "precipitation_mm": None,
        "wind_max_m_s": None,
    }


def _slug_for_id(name: str) -> str:
    s = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.strip())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:80] or "live"


def _pair_heic_mov(
    heic_paths: List[Path], mov_paths: List[Path]
) -> List[tuple]:
    """Return list of (heic_path, mov_path_or_none)."""
    mov_by_stem: Dict[str, Path] = {}
    for mp in mov_paths:
        mov_by_stem[mp.stem] = mp
    out: List[tuple] = []
    for hp in heic_paths:
        m = mov_by_stem.get(hp.stem)
        out.append((hp, m))
    return out


def _timeline_jpeg_names(heic_path: Path, pair_count: int) -> Tuple[str, str]:
    stem = _slug_for_id(heic_path.stem)
    if pair_count > 1:
        return f"thumb_{stem}.jpg", f"preview_{stem}.jpg"
    return "thumb.jpg", "preview.jpg"


def _convert_image_to_rgb(img):
    if img.mode in ("RGBA", "P"):
        work = img.convert("RGBA") if img.mode == "P" else img
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(work, mask=work.split()[-1])
        if work is not img:
            try:
                work.close()
            except Exception:
                pass
        return bg
    return img.convert("RGB")


def _open_heic_as_rgb(heic_path: Path, logger: logging.Logger):
    if not HAS_PILLOW:
        logger.warning("Pillow未安装，无法导出JPEG: %s", heic_path)
        return None
    if not HAS_PILLOW_HEIF:
        logger.warning("pillow-heif未安装，无法导出JPEG: %s", heic_path)
        return None

    try:
        img = Image.open(heic_path)
        try:
            return _convert_image_to_rgb(img)
        finally:
            try:
                img.close()
            except Exception:
                pass
    except Exception as exc:
        logger.warning("Could not open HEIC %s: %s", heic_path, exc)
        return None


def _save_resized_jpeg(img, dest_path: Path, max_long_edge: int, logger: logging.Logger) -> bool:
    try:
        w, h = img.size
        edge = max(w, h)
        output = img
        if edge > max_long_edge:
            scale = max_long_edge / float(edge)
            nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
            try:
                resample = Image.Resampling.LANCZOS
            except AttributeError:
                resample = Image.LANCZOS  # type: ignore[attr-defined]
            output = img.resize((nw, nh), resample)

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        output.save(dest_path, "JPEG", quality=85, optimize=True, progressive=False)
        if output is not img:
            try:
                output.close()
            except Exception:
                pass
        return True
    except Exception as exc:
        logger.warning("Could not save JPEG %s: %s", dest_path, exc)
        return False


def _export_jpeg_from_heic(
    heic_path: Path,
    dest_path: Path,
    max_long_edge: int,
    logger: logging.Logger,
) -> bool:
    img = _open_heic_as_rgb(heic_path, logger)
    if img is None:
        return False
    try:
        return _save_resized_jpeg(img, dest_path, max_long_edge, logger)
    finally:
        try:
            img.close()
        except Exception:
            pass


def _export_jpeg_variants_from_heic(
    heic_path: Path,
    variants: Sequence[Tuple[Path, int]],
    logger: logging.Logger,
) -> Dict[Path, bool]:
    results: Dict[Path, bool] = {dest_path: False for dest_path, _ in variants}
    img = _open_heic_as_rgb(heic_path, logger)
    if img is None:
        return results

    try:
        for dest_path, max_long_edge in variants:
            results[dest_path] = _save_resized_jpeg(img, dest_path, max_long_edge, logger)
        return results
    finally:
        try:
            img.close()
        except Exception:
            pass


def _export_jpeg_variants_from_image(
    img,
    variants: Sequence[Tuple[Path, int]],
    logger: logging.Logger,
) -> Dict[Path, bool]:
    results: Dict[Path, bool] = {}
    for dest_path, max_long_edge in variants:
        results[dest_path] = _save_resized_jpeg(img, dest_path, max_long_edge, logger)
    return results


def _web_rel(web_prefix: str, folder_name: str, filename: str) -> str:
    p = web_prefix.strip().rstrip("/")
    return f"{p}/{folder_name}/{filename}"


def _build_photo_metadata_block(meta: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not meta or not isinstance(meta, dict):
        return None
    gps_block = None
    if meta.get("gps_latitude") is not None and meta.get("gps_longitude") is not None:
        gps_block = {
            "latitude": meta.get("gps_latitude"),
            "longitude": meta.get("gps_longitude"),
            "altitude_m": meta.get("gps_altitude"),
            "label": "",
        }
    out = {
        "captured_at": meta.get("datetime_original"),
        "datetime_original": meta.get("datetime_original"),
        "datetime_digitized": meta.get("datetime_digitized"),
        "datetime_file": meta.get("datetime_file"),
        "camera_make": meta.get("camera_make"),
        "camera_model": meta.get("camera_model"),
        "lens_model": meta.get("lens_model"),
        "device_model": meta.get("device_model"),
        "software": meta.get("software"),
        "aperture_f_number": meta.get("aperture_f_number"),
        "exposure_time_s": meta.get("exposure_time_s"),
        "exposure_time_text": meta.get("exposure_time_text"),
        "iso": meta.get("iso"),
        "focal_length_mm": meta.get("focal_length_mm"),
        "width_px": meta.get("width_px"),
        "height_px": meta.get("height_px"),
        "gps": gps_block,
        "apple_photos": meta.get("apple_photos"),
        "raw_exif": meta.get("raw_exif"),
    }
    has_any = any(
        value not in (None, "", [], {})
        for key, value in out.items()
        if key not in ("gps", "apple_photos", "raw_exif")
    ) or gps_block is not None or bool(out.get("apple_photos")) or bool(out.get("raw_exif"))
    return out if has_any else None


def _semantic_placeholder() -> Dict[str, Any]:
    return {
        "people": [],
        "place_name": "",
        "place_category": "",
        "scene": "",
        "scene_tags": [],
        "summary": "",
        "source": "extractor_pending_review",
        "notes": "文件可稳定提取 EXIF/拍摄/GPS/设备信息；人物识别、地点分类、场景理解通常需要人工确认或额外模型补充。",
    }


def build_photo_timeline_entry(
    *,
    livp_basename: str,
    folder_name: str,
    capture_date: str,
    heic_meta_list: List[dict],
    pairs: List[tuple],
    web_prefix: str,
    logger: logging.Logger,
    export_jpeg: bool = True,
    output_folder_name: Optional[str] = None,
    jpeg_status_by_heic: Optional[Dict[str, Dict[str, bool]]] = None,
) -> Dict[str, Any]:
    """
    Build a single `entries[]` item for photo-timeline JSON.
    pairs: list of (Path to heic, Path to mov or None)
    folder_name: 用于生成缩略图和预览图的文件夹名称
    output_folder_name: 用于构建URL路径的文件夹名称（如果为None，则使用folder_name）
    """
    entry_id = f"{capture_date}--{_slug_for_id(Path(livp_basename).stem)}"
    title = Path(livp_basename).stem
    gps_block: Optional[Dict[str, Any]] = None
    for m in heic_meta_list:
        lat, lon = m.get("gps_latitude"), m.get("gps_longitude")
        if lat is not None and lon is not None:
            gps_block = {
                "latitude": float(lat),
                "longitude": float(lon),
                "altitude_m": m.get("gps_altitude"),
                "label": "",
            }
            break

    photos: List[Dict[str, Any]] = []
    # 确定用于URL路径的文件夹名称
    url_folder_name = output_folder_name if output_folder_name else folder_name
    meta_by_file = {
        str(m.get("file")): m for m in heic_meta_list if m and isinstance(m, dict) and m.get("file")
    }

    for idx, (hp, mp) in enumerate(pairs):
        thumb_name, preview_name = _timeline_jpeg_names(hp, len(pairs))

        thumb_disk = hp.parent / thumb_name
        preview_disk = hp.parent / preview_name

        thumb_ok = False
        preview_ok = False
        precomputed_status = jpeg_status_by_heic.get(hp.name) if jpeg_status_by_heic else None
        if precomputed_status:
            thumb_ok = bool(precomputed_status.get("thumb_ok"))
            preview_ok = bool(precomputed_status.get("preview_ok"))
        elif export_jpeg:
            export_results = _export_jpeg_variants_from_heic(
                hp,
                ((thumb_disk, 800), (preview_disk, 2200)),
                logger,
            )
            thumb_ok = export_results.get(thumb_disk, False)
            preview_ok = export_results.get(preview_disk, False)

        heic_name = hp.name
        mov_web: Optional[str] = None
        if mp is not None:
            mov_web = _web_rel(web_prefix, url_folder_name, mp.name)

        if preview_ok:
            src_web = _web_rel(web_prefix, url_folder_name, preview_name)
        else:
            src_web = _web_rel(web_prefix, url_folder_name, heic_name)

        if thumb_ok:
            thumb_web = _web_rel(web_prefix, url_folder_name, thumb_name)
        else:
            thumb_web = src_web

        cap = heic_name.rsplit(".", 1)[0] if "." in heic_name else heic_name
        file_meta = meta_by_file.get(heic_name)
        ph: Dict[str, Any] = {
            "thumb": thumb_web,
            "src": src_web,
            "caption": cap,
            "ratio": "wide",
            "metadata": _build_photo_metadata_block(file_meta),
            "semantic": _semantic_placeholder(),
        }
        if mov_web:
            ph["video"] = mov_web
        photos.append(ph)

    entry: Dict[str, Any] = {
        "id": entry_id,
        "date": capture_date,
        "title": title,
        "place": "",
        "tags": ["Live"],
        "note": "",
        "weather": _weather_placeholder(),
        "photos": photos,
    }
    if gps_block is not None:
        entry["gps"] = gps_block
    return entry


def build_timeline_fragment(
    entries: List[Dict[str, Any]], *, page_size: int = 5, next_url: Optional[str] = None
) -> Dict[str, Any]:
    frag: Dict[str, Any] = {"version": "1", "pageSize": page_size, "entries": entries}
    if next_url:
        frag["nextUrl"] = next_url
    return frag


# ---------------------------------------------------------------------------
# Core extraction - 优化版本
# ---------------------------------------------------------------------------

def extract_and_process_member_parallel(
    args: tuple
) -> Optional[Dict[str, Any]]:
    """兼容旧调用方式的包装函数"""
    if len(args) == 4:
        zf, member, out_dir, logger = args
        return _extract_and_process_single_member(zf, member, out_dir, logger, True, 1)
    if len(args) >= 6:
        zf, member, out_dir, logger, export_timeline_jpeg, pair_count = args[:6]
        return _extract_and_process_single_member(
            zf, member, out_dir, logger, export_timeline_jpeg, pair_count
        )
    raise ValueError("extract_and_process_member_parallel 参数数量不正确")


def _extract_and_process_single_member(
    zf: zipfile.ZipFile,
    member_name: str,
    out_dir: Path,
    logger: logging.Logger,
    export_timeline_jpeg: bool,
    pair_count: int,
) -> Optional[Dict[str, Any]]:
    """提取并处理单个ZIP成员（HEIC或MOV）"""
    member_path = _extract_and_process_member(zf, member_name, out_dir, logger)
    if not member_path:
        return None
    
    # 立即分类并处理
    file_ext = member_path.suffix.lower()
    if file_ext in (".heic", ".heif"):
        meta = None
        thumb_ok = False
        preview_ok = False
        thumb_name, preview_name = _timeline_jpeg_names(member_path, pair_count)
        export_variants = ((out_dir / thumb_name, 800), (out_dir / preview_name, 2200))

        if HAS_PILLOW:
            try:
                opened = Image.open(member_path)
                try:
                    meta = _extract_heic_metadata_from_image(opened, str(member_path), logger)
                    if export_timeline_jpeg and HAS_PILLOW_HEIF:
                        rgb = _convert_image_to_rgb(opened)
                        try:
                            export_results = _export_jpeg_variants_from_image(rgb, export_variants, logger)
                            thumb_ok = export_results.get(out_dir / thumb_name, False)
                            preview_ok = export_results.get(out_dir / preview_name, False)
                        finally:
                            try:
                                rgb.close()
                            except Exception:
                                pass
                finally:
                    try:
                        opened.close()
                    except Exception:
                        pass
            except Exception as exc:
                logger.debug("HEIC单次打开快路径失败 %s: %s", member_path, exc)

        if meta is None:
            meta = extract_heic_metadata(str(member_path), logger)
            if export_timeline_jpeg:
                export_results = _export_jpeg_variants_from_heic(
                    member_path,
                    export_variants,
                    logger,
                )
                thumb_ok = export_results.get(out_dir / thumb_name, False)
                preview_ok = export_results.get(out_dir / preview_name, False)

        return {
            "type": "heic",
            "path": member_path,
            "meta": meta,
            "jpeg_exports": {"thumb_ok": thumb_ok, "preview_ok": preview_ok},
        }
        
    elif file_ext == ".mov":
        return {"type": "mov", "path": member_path}
    
    return None


def extract_livp_streaming(
    livp_path: str,
    output_root: str,
    logger: logging.Logger,
    *,
    on_conflict: str = "unique",
    cancel_event: Optional[threading.Event] = None,
    web_asset_prefix: str = "assets/live",
    export_timeline_jpeg: bool = True,
    sync_db: bool = False,
) -> Optional[Dict[str, Any]]:
    """
    【优化版】流式提取单个.livp文件 - 单ZIP顺序提取成员，外层文件级并行
    """
    livp_path = os.path.abspath(livp_path)
    if not os.path.isfile(livp_path):
        logger.error("文件不存在: %s", livp_path)
        return None

    if not zipfile.is_zipfile(livp_path):
        logger.error("无效的ZIP/LIVP文件: %s", livp_path)
        return None

    livp_name = Path(livp_path).stem
    # 极限优化:减少日志输出以提升性能
    # logger.info("🔧 开始处理文件: %s", livp_path)

    if cancel_event and cancel_event.is_set():
        logger.info("处理前取消: %s", livp_path)
        return None

    # 性能监控
    # 单文件性能监控仅用于内部计时，避免刷出误导性的 0.0 文件/秒日志。
    perf_monitor = PerformanceMonitor(logger, emit_logs=False)
    perf_monitor.start()
    
    # 提前计算输出目录
    base_dir = Path(os.path.abspath(output_root))
    base_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        capture_date: Optional[str] = None
        heic_files: List[Path] = []
        mov_files: List[Path] = []
        heic_meta_list: List[dict] = []
        jpeg_status_by_heic: Dict[str, Dict[str, bool]] = {}
        
        with zipfile.ZipFile(livp_path, "r") as zf:
            heic_members = _zip_members_by_suffix(zf, (".heic", ".heif"))
            mov_members = _zip_members_by_suffix(zf, (".mov",))

            if not heic_members and not mov_members:
                logger.warning("LIVP中未找到HEIC或MOV文件: %s", livp_path)
                return None

            # 极限优化:减少日志输出以提升性能
            # logger.info("  📁 LIVP中发现 %d 个HEIC, %d 个MOV", len(heic_members), len(mov_members))
            
            # 处理冲突并确定最终输出目录
            folder_name = f"{livp_name}_processing"
            out_dir = base_dir / folder_name
            
            if out_dir.exists():
                if on_conflict == "overwrite":
                    shutil.rmtree(out_dir, ignore_errors=True)
                elif on_conflict == "skip":
                    logger.warning("输出目录已存在，跳过: %s", out_dir)
                    return None
                else:
                    out_dir = _unique_dir(out_dir)
            
            out_dir.mkdir(parents=True, exist_ok=True)
            # 极限优化:减少日志输出以提升性能
            # logger.info(f"  📂 输出目录: {out_dir}")

            all_members = heic_members + mov_members

            for member in all_members:
                if cancel_event and cancel_event.is_set():
                    raise ExtractionCancelled()

                result = _extract_and_process_single_member(
                    zf,
                    member,
                    out_dir,
                    logger,
                    export_timeline_jpeg,
                    len(heic_members),
                )
                if not result:
                    continue

                if result["type"] == "heic":
                    heic_files.append(result["path"])
                    heic_meta_list.append(result["meta"])
                    jpeg_status_by_heic[result["path"].name] = result.get("jpeg_exports", {})

                    if capture_date is None:
                        dt_str = result["meta"].get("datetime_original")
                        if dt_str:
                            capture_date = str(dt_str)[:10].replace(":", "-")
                        else:
                            capture_date = datetime.now().strftime("%Y-%m-%d")
                elif result["type"] == "mov":
                    mov_files.append(result["path"])
        
        # 如果未获取到日期，使用当前日期
        if capture_date is None:
            capture_date = datetime.now().strftime("%Y-%m-%d")
            logger.warning("无法确定拍摄日期，使用今天: %s", capture_date)
        
        # 重命名输出目录为最终名称
        final_folder_name = f"{capture_date}_{livp_name}"
        final_out_dir = base_dir / final_folder_name
            
        if final_out_dir.exists():
            if on_conflict == "overwrite":
                shutil.rmtree(final_out_dir, ignore_errors=True)
            elif on_conflict == "skip":
                logger.warning("最终输出目录已存在，跳过: %s", final_out_dir)
                return None
            else:
                final_out_dir = _unique_dir(final_out_dir)
        
        # 更新heic_files和mov_files中的路径，使其指向重命名后的目录
        updated_heic_files = []
        updated_mov_files = []
        for hp in heic_files:
            rel_path = hp.relative_to(out_dir)
            updated_heic_files.append(final_out_dir / rel_path)
        for mp in mov_files:
            rel_path = mp.relative_to(out_dir)
            updated_mov_files.append(final_out_dir / rel_path)
        heic_files = updated_heic_files
        mov_files = updated_mov_files

        os.rename(out_dir, final_out_dir)
            # 极限优化:减少日志输出以提升性能
            # logger.info(f"  📁 重命名输出目录: {final_out_dir.name}")

        # 构建时间轴条目
        pairs = _pair_heic_mov(heic_files, mov_files)
        timeline_entry: Optional[Dict[str, Any]] = None
        
        if pairs:
            timeline_entry = build_photo_timeline_entry(
                livp_basename=os.path.basename(livp_path),
                folder_name=final_out_dir.name,
                capture_date=capture_date,
                heic_meta_list=heic_meta_list,
                pairs=pairs,
                web_prefix=web_asset_prefix,
                logger=logger,
                export_jpeg=export_timeline_jpeg,
                output_folder_name=final_out_dir.name,
                jpeg_status_by_heic=jpeg_status_by_heic,
            )

        # 创建最终记录
        record: Dict[str, Any] = {
            "source_file": os.path.basename(livp_path),
            "capture_date": capture_date,
            "output_directory": str(final_out_dir),
            "heic_metadata": heic_meta_list,
            "heic_count": len(heic_files),
            "mov_count": len(mov_files),
            "extracted_files": {
                "heic": [str(p) for p in heic_files],
                "mov": [str(p) for p in mov_files]
            },
            "processed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "web_asset_prefix": web_asset_prefix,
            "processing_method": "streaming_single_zip"  # 标记优化版本
        }

        if timeline_entry is not None:
            record["photo_timeline"] = build_timeline_fragment([timeline_entry])
            entry_path = final_out_dir / "photo-timeline-entry.json"
            # 极限优化:移除JSON格式化,减少I/O
            with open(entry_path, "w", encoding="utf-8") as f:
                json.dump(record["photo_timeline"], f, ensure_ascii=False, separators=(",", ":"))
            # 极限优化:减少日志输出
            # logger.info("  📄 时间轴JSON保存: %s", entry_path.name)
            record["photo_timeline_entry"] = timeline_entry

        # 保存元数据
        json_path = final_out_dir / "metadata.json"
        # 极限优化:移除JSON格式化,减少I/O
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, separators=(",", ":"))
        # 极限优化:减少日志输出
        # logger.info("  📊 元数据保存: %s", json_path.name)

        if sync_db:
            maybe_sync_photo_timeline_db(str(base_dir), logger)

        return record
    
    except ExtractionCancelled:
        logger.warning("处理取消: %s", livp_path)
        return None


def extract_livp(*args, **kwargs):
    """
    为兼容性保持原函数名，实际调用优化版本
    """
    return extract_livp_streaming(*args, **kwargs)


def process_livp_file_parallel(args) -> Optional[Dict[str, Any]]:
    """并行处理单个LIVP文件的包装函数"""
    livp_path, output_root, on_conflict, web_asset_prefix, export_timeline_jpeg, logger = args
    
    try:
        return extract_livp_streaming(
            livp_path,
            output_root,
            logger,
            on_conflict=on_conflict,
            web_asset_prefix=web_asset_prefix,
            export_timeline_jpeg=export_timeline_jpeg,
            sync_db=False,
        )
    except Exception as exc:
        logger.error(f"并行处理失败 {livp_path}: {exc}")
        return None


def batch_extract_files_optimized(
    files: List[str],
    output_root: str,
    logger: logging.Logger,
    *,
    on_conflict: str = "unique",
    cancel_event: Optional[threading.Event] = None,
    progress_cb: Optional[ProgressCallback] = None,
    web_asset_prefix: str = "assets/live",
    export_timeline_jpeg: bool = True,
    sync_db: bool = True,
    max_concurrent_files: Optional[int] = None,
    skip_processed: bool = False,
) -> List[Dict[str, Any]]:
    """
    【GUI专用】从文件列表批量提取 - 支持40GB、1000+文件的大规模处理

    Args:
        skip_processed: 如果为True，跳过已经处理过的文件
    """
    if not files:
        logger.warning("文件列表为空")
        return []  # 确保返回空列表而不是None

    # 如果启用跳过已处理文件，过滤掉已处理的文件
    if skip_processed:
        original_count = len(files)
        files = [
            f for f in files 
            if not _is_file_already_processed(f, output_root)
        ]
        skipped_count = original_count - len(files)
        if skipped_count > 0:
            logger.info(f"⏭️  跳过 {skipped_count} 个已处理的文件")

    logger.info("🔍 处理 %d 个.livp文件", len(files))
    
    try:
        # 性能监控和资源管理
        processor = BatchProcessor(logger)
        # 使用processor的performance_monitor,而不是创建新的
        perf_monitor = processor.performance_monitor
        perf_monitor.start()
        
        # 创建输出目录
        os.makedirs(output_root, exist_ok=True)
        
        if not max_concurrent_files:
            # 使用配置文件中的外层并发文件数
            try:
                total_memory_gb = psutil.virtual_memory().total / (1024**3)
                cpu_cores = os.cpu_count() or 4
                max_concurrent_files = min(cpu_cores * 5, int(total_memory_gb * 5))
                max_concurrent_files = max(1, min(max_concurrent_files, Config.OUTER_CONCURRENT_FILES))
            except:
                max_concurrent_files = Config.OUTER_CONCURRENT_FILES // 2
        
        logger.info(f"🚀 启动批量处理 - 文件总数: {len(files)}, 并发数: {max_concurrent_files}")
        
        # 创建处理任务
        tasks = []
        for file_path in files:
            task = (file_path, output_root, on_conflict, web_asset_prefix, export_timeline_jpeg, logger)
            tasks.append(task)
        
        results = []
        success_count = 0
        failed_count = 0
        
        # 使用智能分批处理
        batch_size = min(max_concurrent_files, len(tasks))
        
        def process_file_with_monitoring(task_args):
            """包装器函数，添加性能监控"""
            if cancel_event and cancel_event.is_set():
                return None
            
            file_path, out_dir, conflict, prefix, export_jpeg, log = task_args
            result = extract_livp_streaming(
                file_path, out_dir, log,
                on_conflict=conflict,
                web_asset_prefix=prefix,
                export_timeline_jpeg=export_jpeg,
                sync_db=False
            )
            
            # 更新进度回调
            if progress_cb:
                metrics = perf_monitor.get_stats()
                progress_cb(metrics)
                
            return result
        
        # 执行批量处理
        results = processor.process_in_batches(
            tasks, process_file_with_monitoring, max_concurrent_files
        )
        
        # 统计结果
        success_count = sum(1 for r in results if r is not None)
        failed_count = len(results) - success_count
        
        # 更新性能监控并停止
        perf_monitor.stop()
        final_stats = perf_monitor.get_stats()
        
        logger.info(
            "✅ 批量处理完成 - 成功: %d, 失败: %d, 总耗时: %.1f秒, 平均速度: %.2f文件/秒 (%.1f MB/秒)",
            success_count,
            failed_count,
            final_stats["elapsed_time"],
            final_stats["files_per_second"],
            final_stats["mb_per_second"],
        )
        
        # 同步到数据库
        if sync_db and success_count > 0:
            maybe_sync_photo_timeline_db(output_root, logger)
        
        return results  # 确保返回results列表
        
    except Exception as e:
        logger.error(f"批量处理过程中发生错误: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return []  # 确保在异常情况下也返回空列表


def _is_file_already_processed(livp_path: str, output_root: str) -> bool:
    """检查LIVP文件是否已经被处理过"""
    livp_name = Path(livp_path).stem
    # 检查输出目录中是否存在对应文件的目录
    output_path = Path(output_root)

    # 检查输出目录是否存在
    if not output_path.exists():
        return False

    try:
        for existing_dir in output_path.iterdir():
            if not existing_dir.is_dir():
                continue
            
            # 简单直接的匹配逻辑：检查目录名是否包含完整的文件名
            if livp_name in existing_dir.name:
                # 检查目录中是否有metadata.json文件（已处理的标志）
                metadata_file = existing_dir / "metadata.json"
                if metadata_file.exists():
                    return True
    except Exception as e:
        # 如果遍历输出目录出错，返回False，让文件继续处理
        pass
    except Exception as e:
        # 如果遍历输出目录出错，返回False，让文件继续处理
        pass

    return False


def batch_extract_optimized(
    input_dir: str,
    output_root: str,
    logger: logging.Logger,
    *,
    on_conflict: str = "unique",
    cancel_event: Optional[threading.Event] = None,
    progress_cb: Optional[ProgressCallback] = None,
    web_asset_prefix: str = "assets/live",
    export_timeline_jpeg: bool = True,
    sync_db: bool = True,
    max_concurrent_files: Optional[int] = None,
    skip_processed: bool = False,
) -> List[Dict[str, Any]]:
    """
    【优化版】批量提取 - 支持40GB、1000+文件的大规模处理

    Args:
        skip_processed: 如果为True，跳过已经处理过的文件
    """
    input_dir = os.path.abspath(input_dir)
    livp_files = sorted(
        p for p in Path(input_dir).rglob("*.livp")
        if p.is_file()
    )

    if not livp_files:
        logger.warning("在 %s 中未找到.livp文件", input_dir)
        return []

    # 如果启用跳过已处理文件，过滤掉已处理的文件
    if skip_processed:
        original_count = len(livp_files)
        livp_files = [
            p for p in livp_files 
            if not _is_file_already_processed(str(p), output_root)
        ]
        skipped_count = original_count - len(livp_files)
        if skipped_count > 0:
            logger.info(f"⏭️  跳过 {skipped_count} 个已处理的文件")

    logger.info("🔍 发现 %d 个.livp文件在 %s", len(livp_files), input_dir)
    
    # 性能监控和资源管理
    processor = BatchProcessor(logger)
    perf_monitor = PerformanceMonitor(logger)
    perf_monitor.start()
    
    # 创建输出目录
    os.makedirs(output_root, exist_ok=True)
    
    if not max_concurrent_files:
        # 智能计算并发文件数 - 优化版
        try:
            total_memory_gb = psutil.virtual_memory().total / (1024**3)
            cpu_cores = os.cpu_count() or 4
            # 使用配置文件中的外层并发文件数
            max_concurrent_files = min(cpu_cores * 5, int(total_memory_gb * 5))
            max_concurrent_files = max(1, min(max_concurrent_files, Config.OUTER_CONCURRENT_FILES))
        except:
            max_concurrent_files = 6
    
    logger.info(f"🚀 启动批量处理 - 文件总数: {len(livp_files)}, 并发数: {max_concurrent_files}")
    
    # 创建处理任务
    tasks = []
    for livp_path in livp_files:
        task = (str(livp_path), output_root, on_conflict, web_asset_prefix, export_timeline_jpeg, logger)
        tasks.append(task)
    
    results = []
    success_count = 0
    failed_count = 0
    
    # 使用智能分批处理
    batch_size = min(max_concurrent_files, len(tasks))
    
    for batch_start in range(0, len(tasks), batch_size):
        if cancel_event and cancel_event.is_set():
            logger.warning("⚠️  检测到取消请求，停止批量处理")
            break
            
        batch_end = min(batch_start + batch_size, len(tasks))
        batch_tasks = tasks[batch_start:batch_end]
        
        current_batch = batch_start // batch_size + 1
        total_batches = (len(tasks) + batch_size - 1) // batch_size
        
        # 极限优化:减少日志输出以提升性能
        # logger.info(f"🔧 处理批次 {current_batch}/{total_batches}: "
        #            f"文件 {batch_start + 1}-{batch_end}")
        
        # 使用 ThreadPoolExecutor 并行处理批次
        # 修复bug:使用max_concurrent_files作为max_workers
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrent_files) as executor:
            future_to_task = {
                executor.submit(process_livp_file_parallel, task): task 
                for task in batch_tasks
            }
            
            for future in concurrent.futures.as_completed(future_to_task):
                if cancel_event and cancel_event.is_set():
                    logger.warning("检测到取消请求，停止当前批次")
                    executor.shutdown(wait=False)
                    break
                
                task = future_to_task[future]
                livp_path = task[0]
                
                try:
                    result = future.result()
                    
                    if result:
                        results.append(result)
                        success_count += 1
                        
                        # 更新性能监控
                        file_size = os.path.getsize(livp_path)
                        perf_monitor.update_file_processed(file_size)
                        
                        logger.info(f"✅ 文件处理成功: {Path(livp_path).name}")
                    else:
                        failed_count += 1
                        logger.error(f"❌ 文件处理失败: {Path(livp_path).name}")
                    
                    # 进度回调
                    if progress_cb:
                        progress_cb(success_count + failed_count, len(livp_files), Path(livp_path).name)
                    
                except Exception as exc:
                    failed_count += 1
                    logger.error(f"❌ 文件处理异常 {Path(livp_path).name}: {exc}")
                
                # 定期报告性能
                if (success_count + failed_count) % 5 == 0:
                    stats = perf_monitor.get_stats()
                    logger.info(f"📊 处理进度 - 已完成: {success_count + failed_count}/{len(livp_files)}, "
                               f"速度: {stats['files_per_second']:.1f}文件/秒, "
                               f"内存: {stats['memory_percent'] or 'N/A'}%")
        
        # 批次间休息，防止资源耗尽 - 优化版:减少延迟
        if batch_end < len(tasks) and (cancel_event and not cancel_event.is_set()):
            time.sleep(0.1)
            
            # 检查系统资源，必要时降低并发数
            try:
                mem_usage = psutil.virtual_memory().percent
                if mem_usage > 85:
                    logger.warning(f"⚠️  内存使用率高 ({mem_usage:.1f}%), 降低下一个批次并发数")
                    batch_size = max(1, batch_size // 2)
            except:
                pass

    # 合并时间轴数据
    merged = [r["photo_timeline_entry"] for r in results if r.get("photo_timeline_entry")]
    if merged:
        try:
            merged_path = Path(output_root) / "photo-timeline-merged.json"
            timeline_fragment = build_timeline_fragment(merged)
            
            # 极限优化:移除JSON格式化,减少I/O
            with open(merged_path, "w", encoding="utf-8") as f:
                json.dump(timeline_fragment, f, ensure_ascii=False, separators=(",", ":"))
            
            logger.info(f"📄 合并时间轴数据 ({len(merged)} 个条目): {merged_path}")
            
        except Exception as exc:
            logger.error(f"合并时间轴失败: {exc}")

    # 性能总结报告
    final_stats = perf_monitor.get_stats()
    total_time = final_stats['elapsed_time']
    throughput_mbps = final_stats['mb_per_second']
    
    logger.info("=" * 60)
    logger.info(f"✅ 批量处理完成")
    logger.info(f"📊 统计信息:")
    logger.info(f"   • 总文件数: {len(livp_files)}")
    logger.info(f"   • 成功: {success_count}")
    logger.info(f"   • 失败: {failed_count}")
    logger.info(f"   • 成功率: {success_count/len(livp_files)*100:.1f}%")
    logger.info(f"   • 总时间: {total_time:.1f}秒")
    logger.info(f"   • 平均速度: {final_stats['files_per_second']:.2f} 文件/秒")
    logger.info(f"   • 吞吐速度: {throughput_mbps:.1f} MB/秒")
    logger.info(f"   • 处理方式: 流式并行处理")
    logger.info("=" * 60)

    if sync_db and success_count > 0:
        logger.info("🔗 开始数据库同步...")
        maybe_sync_photo_timeline_db(output_root, logger)

    return results


def batch_extract(*args, **kwargs):
    """
    为兼容性保持原函数名，实际调用优化版本
    """
    return batch_extract_optimized(*args, **kwargs)


def main():
    parser = argparse.ArgumentParser(
        description="Extract .heic and .mov from Apple LIVP Live Photo files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process a single .livp file
  python livp_extractor.py -i photo.livp -o ./output

  # Batch process all .livp files in a directory
  python livp_extractor.py -i ./livp_photos/ -o ./output

  # Process with verbose logging
  python livp_extractor.py -i ./livp_photos/ -o ./output -v
        """,
    )
    parser.add_argument("-i", "--input", required=True,
                        help="Path to a .livp file or directory containing .livp files")
    parser.add_argument("-o", "--output", required=True,
                        help="Output root directory (files organized into date-named subfolders)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable verbose (DEBUG) console output")
    parser.add_argument("--on-conflict", choices=("unique", "overwrite", "skip"), default="unique",
                        help="What to do if the output folder already exists (default: unique)")
    parser.add_argument(
        "--web-prefix",
        default="assets/live",
        help="Site-relative path prefix for photo-timeline JSON (default: assets/live)",
    )
    parser.add_argument(
        "--no-jpeg-timeline",
        action="store_true",
        help="Skip thumb/preview JPEG generation; JSON uses HEIC filenames as src",
    )
    parser.add_argument(
        "--no-db-sync",
        action="store_true",
        help="Do not run node server/photo-timeline-cli.mjs after import (skip SQLite sync)",
    )
    parser.add_argument(
        "--skip-processed",
        action="store_true",
        help="Skip files that have already been processed (detected by existing output directory with metadata.json)",
    )

    args = parser.parse_args()
    output_root = os.path.abspath(args.output)
    os.makedirs(output_root, exist_ok=True)

    logger = setup_logging(Path(output_root))
    if args.verbose:
        for handler in logger.handlers:
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                handler.setLevel(logging.DEBUG)

    if not HAS_PILLOW:
        logger.warning(
            "Pillow is not installed. HEIC EXIF extraction will be limited. "
            "Install with: pip install -r tools/requirements.txt"
        )
    elif not HAS_PILLOW_HEIF:
        logger.warning(
            "pillow-heif is not available. Some HEIC files may fail to open. "
            "Install with: pip install -r tools/requirements.txt"
        )

    input_path = os.path.abspath(args.input)

    if os.path.isfile(input_path):
        result = extract_livp(
            input_path,
            output_root,
            logger,
            on_conflict=args.on_conflict,
            web_asset_prefix=args.web_prefix,
            export_timeline_jpeg=not args.no_jpeg_timeline,
            sync_db=not args.no_db_sync,
        )
        if result:
            logger.info("Done. Output: %s", result["output_directory"])
        else:
            logger.error("Failed to process %s", input_path)
            sys.exit(1)
    elif os.path.isdir(input_path):
        results = batch_extract(
            input_path,
            output_root,
            logger,
            on_conflict=args.on_conflict,
            web_asset_prefix=args.web_prefix,
            export_timeline_jpeg=not args.no_jpeg_timeline,
            sync_db=not args.no_db_sync,
            skip_processed=args.skip_processed,
        )
        if not results:
            logger.warning("No files were successfully processed")
            sys.exit(1)
        logger.info("Done. Processed %d file(s)", len(results))
    else:
        logger.error("Input path does not exist: %s", input_path)
        sys.exit(1)


if __name__ == "__main__":
    main()
