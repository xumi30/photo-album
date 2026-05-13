#!/usr/bin/env python3
"""
Android JPG GPS Parser — Web GUI
Browser-based interface using Python's built-in http.server.
No external dependencies required.
"""

import json
import os
import re
import subprocess
import struct
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse


_REPO_ROOT = Path(__file__).resolve().parent.parent

state = {
    "is_running": False,
    "progress": 0,
    "status": "Ready",
    "results": [],
    "logs": [],
    "last_sync": None,
    "source_root": "",
}
state_lock = threading.Lock()


def _log(message: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    with state_lock:
        state["logs"].append(f"[{ts}] {message}")
        if len(state["logs"]) > 400:
            state["logs"] = state["logs"][-200:]


def _find_sync_project_root(start_path: Path) -> Optional[Path]:
    for candidate in [start_path] + list(start_path.parents):
        package_json = candidate / "package.json"
        if not package_json.exists():
            continue
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = pkg.get("scripts", {})
            if isinstance(scripts, dict) and "sync-photo-timeline" in scripts:
                return candidate
        except Exception:
            continue
    return None


def run_sync_photo_timeline(live_root: Optional[str] = None) -> Dict[str, object]:
    root = _find_sync_project_root(Path(__file__).resolve().parent)
    if root is None:
        return {"ok": False, "error": "未找到包含 sync-photo-timeline 的 package.json"}

    try:
        proc = subprocess.run(
            ["npm", "run", "sync-photo-timeline"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        merged = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        lines = [line for line in merged.splitlines() if line.strip()]
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "cwd": str(root),
            "live_root": live_root or "",
            "output_tail": lines[-40:] if len(lines) > 40 else lines,
        }
    except FileNotFoundError:
        return {"ok": False, "error": "未找到 npm，请先安装 Node.js"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "运行超时（600秒）"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _slug_text(text: str) -> str:
    cleaned = []
    for ch in text.lower():
        if ch.isalnum():
            cleaned.append(ch)
        else:
            cleaned.append("-")
    slug = "".join(cleaned).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "item"


def _derive_capture_date(result_item: Dict[str, object]) -> str:
    ts = result_item.get("gps_timestamp_utc")
    if isinstance(ts, str) and len(ts) >= 10:
        return ts[:10]
    file_path = Path(str(result_item.get("file", "")))
    parsed = _extract_date_from_filename(file_path.stem)
    if parsed:
        return parsed
    return "0000-00-00"


def _extract_date_from_filename(stem: str) -> Optional[str]:
    patterns = [
        r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)",
        r"(19\d{2})[-_]?([01]\d)[-_]?([0-3]\d)",
    ]
    for pattern in patterns:
        m = re.search(pattern, stem)
        if not m:
            continue
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime(y, mo, d).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def export_entries_for_sync(parsed_results: List[Dict[str, object]], source_root: Optional[str] = None) -> Dict[str, object]:
    root = _find_sync_project_root(Path(__file__).resolve().parent)
    if root is None:
        return {"ok": False, "error": "未找到 photo-album 项目根目录（缺少 sync-photo-timeline 脚本）"}

    live_data_root = root / "data" / "live"
    live_data_root.mkdir(parents=True, exist_ok=True)
    import_root = live_data_root / "_android-jpg-import"
    import_root.mkdir(parents=True, exist_ok=True)

    if source_root:
        source_root_path = Path(source_root).resolve()
    else:
        first = next(
            (Path(str(x.get("file", ""))).resolve().parent for x in parsed_results if x.get("file")),
            None,
        )
        if first is None:
            return {"ok": False, "error": "未找到可用的 JPG 源目录"}
        source_root_path = first

    link_dir_name = "_android-jpg-source"
    link_path = live_data_root / link_dir_name
    try:
        if link_path.exists() or link_path.is_symlink():
            if link_path.is_symlink() or link_path.is_file():
                link_path.unlink()
            else:
                return {"ok": False, "error": f"路径已存在且不是软链接: {link_path}"}
        os.symlink(str(source_root_path), str(link_path))
    except Exception as exc:
        return {"ok": False, "error": f"创建软链接失败: {exc}"}

    entries = []
    total_entries = 0
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    entry_id_base = f"android-jpg-{run_id}"
    import_folder = import_root / entry_id_base
    import_folder.mkdir(parents=True, exist_ok=True)

    for idx, item in enumerate(parsed_results, start=1):
        src_file = Path(str(item.get("file", "")))
        if not src_file.exists():
            continue
        lat = item.get("latitude")
        lon = item.get("longitude")
        if lat is None or lon is None:
            # 无GPS时按需求兜底为北极
            lat = 90.0
            lon = 0.0

        capture_date = _derive_capture_date(item)
        stem_slug = _slug_text(src_file.stem)
        entry_id = f"{capture_date}--android-jpg-{stem_slug}-{idx}"
        try:
            rel_path = os.path.relpath(str(src_file.resolve()), str(source_root_path)).replace("\\", "/")
        except Exception:
            rel_path = src_file.name
        web_path = f"assets/live/{link_dir_name}/{rel_path.lstrip('/')}"
        entry = {
            "id": entry_id,
            "date": capture_date,
            "title": src_file.stem,
            "place": "",
            "tags": ["Android", "JPG"],
            "note": "",
            "photos": [
                {
                    "thumb": web_path,
                    "src": web_path,
                    "caption": src_file.name,
                    "ratio": "wide",
                    "metadata": {
                        "gps": {
                            "latitude": float(lat),
                            "longitude": float(lon),
                            "altitude_m": item.get("altitude_m"),
                        }
                    },
                }
            ],
            "gps": {
                "latitude": float(lat),
                "longitude": float(lon),
                "altitude_m": item.get("altitude_m"),
                "label": "",
            },
        }
        entries.append(entry)
        total_entries += 1

    if total_entries == 0:
        return {"ok": False, "error": "没有可入库的照片"}

    out_json = import_folder / "photo-timeline-entry.json"
    payload = {"version": "1", "pageSize": 5, "entries": entries}
    out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "ok": True,
        "entries": total_entries,
        "written_json_files": [str(out_json)],
        "live_root": str(live_data_root),
        "source_root": str(source_root_path),
        "source_link": str(link_path),
    }


def _read_u16(data: bytes, offset: int, little: bool) -> int:
    if offset < 0 or offset + 2 > len(data):
        raise ValueError("invalid u16 offset")
    return struct.unpack("<H" if little else ">H", data[offset:offset + 2])[0]


def _read_u32(data: bytes, offset: int, little: bool) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise ValueError("invalid u32 offset")
    return struct.unpack("<I" if little else ">I", data[offset:offset + 4])[0]


def _parse_ifd_entries(
    tiff_data: bytes,
    ifd_offset: int,
    little: bool,
) -> List[Tuple[int, int, int, int]]:
    if ifd_offset < 0 or ifd_offset + 2 > len(tiff_data):
        return []
    count = _read_u16(tiff_data, ifd_offset, little)
    entries = []
    cursor = ifd_offset + 2
    for _ in range(count):
        if cursor + 12 > len(tiff_data):
            break
        tag = _read_u16(tiff_data, cursor, little)
        typ = _read_u16(tiff_data, cursor + 2, little)
        cnt = _read_u32(tiff_data, cursor + 4, little)
        val = _read_u32(tiff_data, cursor + 8, little)
        entries.append((tag, typ, cnt, val))
        cursor += 12
    return entries


def _type_size(typ: int) -> int:
    sizes = {
        1: 1,   # BYTE
        2: 1,   # ASCII
        3: 2,   # SHORT
        4: 4,   # LONG
        5: 8,   # RATIONAL
        7: 1,   # UNDEFINED
        9: 4,   # SLONG
        10: 8,  # SRATIONAL
    }
    return sizes.get(typ, 0)


def _entry_data_slice(
    tiff_data: bytes,
    typ: int,
    cnt: int,
    value_or_offset: int,
    little: bool,
) -> bytes:
    size = _type_size(typ) * cnt
    if size <= 0:
        return b""
    if size <= 4:
        raw = struct.pack("<I" if little else ">I", value_or_offset)
        return raw[:size]
    start = value_or_offset
    end = start + size
    if start < 0 or end > len(tiff_data):
        return b""
    return tiff_data[start:end]


def _decode_ascii(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()


def _decode_rational_list(raw: bytes, little: bool, signed: bool = False) -> List[Fraction]:
    out: List[Fraction] = []
    if len(raw) % 8 != 0:
        return out
    for i in range(0, len(raw), 8):
        num_raw = raw[i:i + 4]
        den_raw = raw[i + 4:i + 8]
        if signed:
            num = struct.unpack("<i" if little else ">i", num_raw)[0]
            den = struct.unpack("<i" if little else ">i", den_raw)[0]
        else:
            num = struct.unpack("<I" if little else ">I", num_raw)[0]
            den = struct.unpack("<I" if little else ">I", den_raw)[0]
        if den == 0:
            continue
        out.append(Fraction(num, den))
    return out


def _extract_exif_block(jpeg_data: bytes) -> Optional[bytes]:
    if len(jpeg_data) < 4 or jpeg_data[0:2] != b"\xFF\xD8":
        return None

    i = 2
    while i + 4 <= len(jpeg_data):
        if jpeg_data[i] != 0xFF:
            i += 1
            continue
        marker = jpeg_data[i + 1]
        i += 2

        if marker in (0xD9, 0xDA):  # EOI or SOS
            break
        if i + 2 > len(jpeg_data):
            break

        seg_len = struct.unpack(">H", jpeg_data[i:i + 2])[0]
        seg_start = i + 2
        seg_end = i + seg_len
        if seg_len < 2 or seg_end > len(jpeg_data):
            break

        if marker == 0xE1:
            segment = jpeg_data[seg_start:seg_end]
            if segment.startswith(b"Exif\x00\x00"):
                return segment[6:]

        i = seg_end
    return None


def parse_jpg_gps(file_path: Path) -> Dict[str, object]:
    result: Dict[str, object] = {
        "file": str(file_path),
        "has_exif": False,
        "has_gps": False,
        "latitude": None,
        "longitude": None,
        "altitude_m": None,
        "gps_timestamp_utc": None,
        "map_url": None,
        "error": None,
    }

    try:
        data = file_path.read_bytes()
        exif = _extract_exif_block(data)
        if not exif:
            return result

        result["has_exif"] = True
        if len(exif) < 8:
            return result

        bo = exif[0:2]
        if bo == b"II":
            little = True
        elif bo == b"MM":
            little = False
        else:
            return result

        if _read_u16(exif, 2, little) != 42:
            return result

        ifd0_offset = _read_u32(exif, 4, little)
        ifd0_entries = _parse_ifd_entries(exif, ifd0_offset, little)

        gps_ifd_offset = None
        for tag, typ, cnt, val in ifd0_entries:
            if tag == 0x8825 and typ == 4 and cnt == 1:
                gps_ifd_offset = val
                break
        if gps_ifd_offset is None:
            return result

        gps_entries = _parse_ifd_entries(exif, gps_ifd_offset, little)
        if not gps_entries:
            return result

        result["has_gps"] = True
        gps_data: Dict[int, Tuple[int, int, int]] = {tag: (typ, cnt, val) for tag, typ, cnt, val in gps_entries}

        lat_ref = None
        lon_ref = None
        lat = None
        lon = None

        if 0x0001 in gps_data:
            typ, cnt, val = gps_data[0x0001]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            lat_ref = _decode_ascii(raw).upper()

        if 0x0003 in gps_data:
            typ, cnt, val = gps_data[0x0003]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            lon_ref = _decode_ascii(raw).upper()

        if 0x0002 in gps_data:
            typ, cnt, val = gps_data[0x0002]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            dms = _decode_rational_list(raw, little)
            if len(dms) >= 3:
                lat = float(dms[0] + dms[1] / 60 + dms[2] / 3600)

        if 0x0004 in gps_data:
            typ, cnt, val = gps_data[0x0004]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            dms = _decode_rational_list(raw, little)
            if len(dms) >= 3:
                lon = float(dms[0] + dms[1] / 60 + dms[2] / 3600)

        if lat is not None and lat_ref == "S":
            lat = -lat
        if lon is not None and lon_ref == "W":
            lon = -lon

        if lat is not None:
            result["latitude"] = round(lat, 7)
        if lon is not None:
            result["longitude"] = round(lon, 7)

        if 0x0005 in gps_data and 0x0006 in gps_data:
            ref_typ, ref_cnt, ref_val = gps_data[0x0005]
            alt_typ, alt_cnt, alt_val = gps_data[0x0006]
            ref_raw = _entry_data_slice(exif, ref_typ, ref_cnt, ref_val, little)
            alt_raw = _entry_data_slice(exif, alt_typ, alt_cnt, alt_val, little)
            alt_list = _decode_rational_list(alt_raw, little)
            if ref_raw and alt_list:
                altitude = float(alt_list[0])
                if ref_raw[0] == 1:
                    altitude = -altitude
                result["altitude_m"] = round(altitude, 2)

        gps_date = None
        gps_time = None
        if 0x001D in gps_data:
            typ, cnt, val = gps_data[0x001D]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            gps_date = _decode_ascii(raw)

        if 0x0007 in gps_data:
            typ, cnt, val = gps_data[0x0007]
            raw = _entry_data_slice(exif, typ, cnt, val, little)
            hms = _decode_rational_list(raw, little)
            if len(hms) >= 3:
                gps_time = (
                    int(hms[0]),
                    int(hms[1]),
                    int(hms[2]),
                )

        if gps_date and gps_time:
            try:
                y, m, d = [int(x) for x in gps_date.split(":")]
                dt = datetime(y, m, d, gps_time[0], gps_time[1], gps_time[2], tzinfo=timezone.utc)
                result["gps_timestamp_utc"] = dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass

        if result["latitude"] is not None and result["longitude"] is not None:
            result["map_url"] = (
                f"https://maps.google.com/?q={result['latitude']},{result['longitude']}"
            )

        return result
    except Exception as exc:
        result["error"] = str(exc)
        return result


def scan_jpg_files(folder_path: str) -> List[Path]:
    out: List[Path] = []
    for root, _, files in os.walk(folder_path):
        for name in files:
            if name.lower().endswith((".jpg", ".jpeg")):
                out.append(Path(root) / name)
    out.sort(key=lambda p: str(p).lower())
    return out


HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Android JPG GPS 解析器</title>
<style>
  :root {
    --bg: #12141c;
    --surface: #1b1e28;
    --elevated: #222632;
    --border: #2e3240;
    --text: #eceef4;
    --dim: #8b90a1;
    --accent: #7c9cff;
    --green: #5ee9a0;
    --yellow: #f5c84c;
    --red: #ff8b8b;
    --radius: 12px;
    --font: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 28px 20px 48px;
    line-height: 1.45;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: var(--dim); font-size: 0.88rem; margin-bottom: 18px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 12px;
  }
  .row { display: flex; gap: 10px; align-items: center; }
  input.text {
    flex: 1;
    min-width: 180px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 0.86rem;
  }
  input.text:focus {
    outline: none;
    border-color: var(--accent);
  }
  button {
    background: var(--accent);
    color: #0b0d12;
    border: none;
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: var(--elevated);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .hint { color: var(--dim); font-size: 0.78rem; margin-top: 8px; }
  .progress-bar { height: 6px; background: var(--bg); border-radius: 6px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width .2s; }
  .status { color: var(--dim); font-size: 0.8rem; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,.08); }
  th { color: var(--dim); font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; }
  .empty { color: var(--dim); text-align: center; padding: 20px 0; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.72rem; word-break: break-all; }
  .ok { color: var(--green); }
  .warn { color: var(--yellow); }
  .err { color: var(--red); }
  .log-console {
    background: #0a0c11;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    max-height: 220px;
    overflow-y: auto;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.72rem;
    color: var(--dim);
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Android JPG GPS 解析器</h1>
  <p class="subtitle">扫描文件夹中的 .jpg/.jpeg，读取 EXIF GPS（经纬度、海拔、GPS 时间）并支持导出 JSON。</p>

  <div class="card">
    <div class="row">
      <input id="folderPath" class="text" type="text" spellcheck="false" placeholder="输入安卓照片目录绝对路径">
      <button type="button" onclick="scanFolder()">扫描</button>
      <button type="button" class="btn-secondary" onclick="startParse()">开始解析</button>
      <button type="button" class="btn-secondary" onclick="exportJson()">导出 JSON</button>
      <button type="button" class="btn-secondary" onclick="syncDatabase()">同步相册库</button>
    </div>
    <div class="hint"><label><input id="autoSync" type="checkbox" checked> 解析完成后自动运行 <code>npm run sync-photo-timeline</code></label></div>
    <div class="hint" id="folderHint">请先输入目录，再点“扫描”。</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="status" id="statusText">Ready</div>
  </div>

  <div class="card">
    <table>
      <thead>
      <tr>
        <th>文件</th>
        <th>EXIF</th>
        <th>GPS</th>
        <th>坐标</th>
        <th>海拔(m)</th>
        <th>GPS时间(UTC)</th>
      </tr>
      </thead>
      <tbody id="resultBody">
        <tr><td colspan="6" class="empty">尚无数据</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <div class="log-console" id="logConsole">等待开始…</div>
  </div>
</div>

<script>
function esc(s) { const d=document.createElement('div'); d.textContent=String(s ?? ''); return d.innerHTML; }

async function scanFolder() {
  const folderPath = document.getElementById('folderPath').value.trim();
  if (!folderPath) { alert('请输入目录路径'); return; }
  const resp = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_path: folderPath })
  });
  const data = await resp.json();
  if (!resp.ok) { alert(data.error || '扫描失败'); return; }
  document.getElementById('folderHint').textContent = `扫描到 ${data.count} 个 JPG 文件`;
  document.getElementById('statusText').textContent = 'Ready';
}

async function startParse() {
  const folderPath = document.getElementById('folderPath').value.trim();
  if (!folderPath) { alert('请输入目录路径'); return; }
  const resp = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder_path: folderPath,
      auto_sync: document.getElementById('autoSync').checked
    })
  });
  const data = await resp.json();
  if (!resp.ok) { alert(data.error || '启动失败'); return; }
  poll();
}

async function poll() {
  const r = await fetch('/api/status');
  const d = await r.json();
  document.getElementById('progressFill').style.width = d.progress + '%';
  document.getElementById('statusText').textContent = d.status;

  const body = document.getElementById('resultBody');
  if (d.results && d.results.length) {
    body.innerHTML = d.results.map(item => {
      const coord = (item.latitude !== null && item.longitude !== null)
        ? `${item.latitude}, ${item.longitude}`
        : '—';
      const exifCls = item.has_exif ? 'ok' : 'warn';
      const gpsCls = item.has_gps ? 'ok' : 'warn';
      const ts = item.gps_timestamp_utc || '—';
      return `<tr>
        <td class="mono">${esc(item.file)}</td>
        <td class="${exifCls}">${item.has_exif ? 'Yes' : 'No'}</td>
        <td class="${gpsCls}">${item.has_gps ? 'Yes' : 'No'}</td>
        <td>${esc(coord)}</td>
        <td>${item.altitude_m ?? '—'}</td>
        <td>${esc(ts)}</td>
      </tr>`;
    }).join('');
  } else {
    body.innerHTML = '<tr><td colspan="6" class="empty">尚无数据</td></tr>';
  }

  const log = document.getElementById('logConsole');
  log.innerHTML = (d.logs || []).map(line => `<div>${esc(line)}</div>`).join('');
  log.scrollTop = log.scrollHeight;

  if (d.is_running) {
    setTimeout(poll, 300);
  }
}

async function exportJson() {
  const r = await fetch('/api/export', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error || '导出失败'); return; }
  alert('导出成功: ' + d.path);
}

async function syncDatabase() {
  const r = await fetch('/api/sync', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) {
    const tail = (d.output_tail && d.output_tail.length)
      ? ('\n\n' + d.output_tail.slice(-10).join('\n'))
      : '';
    alert((d.error || ('返回码: ' + (d.returncode ?? 'unknown'))) + tail);
    return;
  }
  alert(d.ok ? '同步成功' : ('同步失败: ' + (d.error || '未知错误')));
  poll();
}
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _respond(self, code: int, content_type: str, body):
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
            return
        if path == "/api/status":
            with state_lock:
                payload = {
                    "is_running": state["is_running"],
                    "progress": state["progress"],
                    "status": state["status"],
                    "results": list(state["results"]),
                    "logs": list(state["logs"]),
                    "last_sync": state["last_sync"],
                }
            self._respond(200, "application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False))
            return
        self._respond(404, "text/plain; charset=utf-8", "Not Found")

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/scan":
            self._handle_scan()
            return
        if path == "/api/start":
            self._handle_start()
            return
        if path == "/api/sync":
            self._handle_sync()
            return
        if path == "/api/export":
            self._handle_export()
            return
        self._respond(404, "application/json", '{"error":"Not Found"}')

    def _read_json(self) -> Dict[str, object]:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(body.decode("utf-8", errors="replace"))

    def _handle_scan(self):
        try:
            data = self._read_json()
            folder_path = str(data.get("folder_path", "")).strip()
            if not folder_path:
                self._respond(400, "application/json", '{"error":"folder_path is required"}')
                return
            if not os.path.isdir(folder_path):
                self._respond(400, "application/json", json.dumps({"error": f"目录不存在: {folder_path}"}, ensure_ascii=False))
                return
            files = scan_jpg_files(folder_path)
            _log(f"扫描目录: {folder_path}")
            _log(f"发现 JPG 文件: {len(files)}")
            self._respond(200, "application/json; charset=utf-8", json.dumps({"count": len(files)}, ensure_ascii=False))
        except Exception as exc:
            self._respond(500, "application/json; charset=utf-8", json.dumps({"error": str(exc)}, ensure_ascii=False))

    def _handle_start(self):
        with state_lock:
            if state["is_running"]:
                self._respond(409, "application/json", '{"error":"already running"}')
                return
        try:
            data = self._read_json()
            folder_path = str(data.get("folder_path", "")).strip()
            auto_sync = bool(data.get("auto_sync", True))
            if not folder_path:
                self._respond(400, "application/json", '{"error":"folder_path is required"}')
                return
            if not os.path.isdir(folder_path):
                self._respond(400, "application/json", json.dumps({"error": f"目录不存在: {folder_path}"}, ensure_ascii=False))
                return

            files = scan_jpg_files(folder_path)
            if not files:
                self._respond(400, "application/json", '{"error":"no jpg/jpeg files found"}')
                return

            with state_lock:
                state["is_running"] = True
                state["progress"] = 0
                state["results"] = []
                state["status"] = "解析中..."
                state["logs"] = []
                state["source_root"] = folder_path
            _log(f"开始解析，共 {len(files)} 个文件")
            thread = threading.Thread(
                target=self._parse_worker,
                args=(files, auto_sync),
                daemon=True,
            )
            thread.start()
            self._respond(200, "application/json; charset=utf-8", json.dumps({"ok": True}, ensure_ascii=False))
        except Exception as exc:
            with state_lock:
                state["is_running"] = False
                state["status"] = f"错误: {exc}"
            _log(state["status"])
            self._respond(500, "application/json; charset=utf-8", json.dumps({"error": str(exc)}, ensure_ascii=False))

    @staticmethod
    def _parse_worker(files: List[Path], auto_sync: bool):
        try:
            total = len(files)
            parsed: List[Dict[str, object]] = []
            gps_count = 0
            for idx, path in enumerate(files, start=1):
                item = parse_jpg_gps(path)
                parsed.append(item)
                if item.get("has_gps"):
                    gps_count += 1
                with state_lock:
                    state["results"] = list(parsed)
                    state["progress"] = int(idx * 100 / total)
                    state["status"] = f"处理中 {idx}/{total}"
                if idx % 20 == 0 or idx == total:
                    _log(f"进度: {idx}/{total}")

            with state_lock:
                state["status"] = f"完成: {total} 张，含 GPS {gps_count} 张"
                state["is_running"] = False
                state["progress"] = 100
            _log(state["status"])

            if auto_sync:
                with state_lock:
                    results_for_sync = list(state["results"])
                with state_lock:
                    source_root = state.get("source_root", "")
                prep = export_entries_for_sync(results_for_sync, source_root)
                if prep.get("ok"):
                    _log(
                        "已生成同步输入: entries=%s copied=%s"
                        % (prep.get("entries", 0), prep.get("copied", 0))
                    )
                else:
                    _log(f"同步前准备失败: {prep.get('error')}")
                    return

                _log("开始同步相册数据库（npm run sync-photo-timeline）")
                sync_res = run_sync_photo_timeline(prep.get("live_root"))
                with state_lock:
                    state["last_sync"] = {
                        **sync_res,
                        "prepared": prep,
                    }
                if sync_res.get("ok"):
                    _log("相册数据库同步成功")
                else:
                    _log(f"相册数据库同步失败: {sync_res.get('error') or sync_res.get('returncode')}")
                for line in sync_res.get("output_tail", [])[-10:]:
                    _log(f"[sync] {line}")
        except Exception as exc:
            with state_lock:
                state["status"] = f"错误: {exc}"
                state["is_running"] = False
            _log(state["status"])

    def _handle_sync(self):
        try:
            _log("手动触发同步（npm run sync-photo-timeline）")
            with state_lock:
                results_for_sync = list(state["results"])
                source_root = state.get("source_root", "")
            prep = export_entries_for_sync(results_for_sync, source_root)
            if not prep.get("ok"):
                self._respond(400, "application/json; charset=utf-8", json.dumps(prep, ensure_ascii=False))
                return
            _log(
                "已生成同步输入: entries=%s json=%s"
                % (prep.get("entries", 0), len(prep.get("written_json_files", [])))
            )

            result = run_sync_photo_timeline(prep.get("live_root"))
            with state_lock:
                state["last_sync"] = {
                    **result,
                    "prepared": prep,
                }
            if result.get("ok"):
                _log("手动同步成功")
            else:
                _log(f"手动同步失败: {result.get('error') or result.get('returncode')}")
            for line in result.get("output_tail", [])[-10:]:
                _log(f"[sync] {line}")
            code = 200 if result.get("ok") else 500
            self._respond(code, "application/json; charset=utf-8", json.dumps(result, ensure_ascii=False))
        except Exception as exc:
            self._respond(500, "application/json; charset=utf-8", json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))

    def _handle_export(self):
        try:
            with state_lock:
                results = list(state["results"])
            if not results:
                self._respond(400, "application/json", '{"error":"no results to export"}')
                return
            out_path = Path(__file__).resolve().parent / "android_jpg_gps_results.json"
            payload = {
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "total": len(results),
                "with_gps": sum(1 for x in results if x.get("has_gps")),
                "results": results,
            }
            out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            _log(f"已导出: {out_path}")
            self._respond(
                200,
                "application/json; charset=utf-8",
                json.dumps({"ok": True, "path": str(out_path)}, ensure_ascii=False),
            )
        except Exception as exc:
            self._respond(500, "application/json; charset=utf-8", json.dumps({"error": str(exc)}, ensure_ascii=False))


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Android JPG GPS Parser GUI")
    parser.add_argument("-p", "--port", type=int, default=8776, help="Server port (default: 8776)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    args = parser.parse_args()

    base_port = args.port
    for p in range(base_port, base_port + 20):
        try:
            server = HTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    else:
        print(f"ERROR: Could not find an open port in range {base_port}-{base_port + 19}")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"
    print(f"Android JPG GPS Parser running at {url}")
    print("Press Ctrl+C to stop.\n")

    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
