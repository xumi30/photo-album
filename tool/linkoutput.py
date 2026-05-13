#!/usr/bin/env python3
"""
将外部 LIVP / live 输出目录接到默认素材根：在 data/live/<链接名> 创建指向目标目录的软链接，
前端仍通过 /assets/live/<链接名>/... 访问（Express 将 /assets/live 映射到该素材根）。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_LIVE_ROOT = _REPO_ROOT / "data" / "live"
_DEFAULT_LINK_NAME = "_livp-external"


def _is_subpath(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


def _symlink(target: Path, link_path: Path) -> None:
    if os.name == "nt":
        os.symlink(target, link_path, target_is_directory=True)
    else:
        os.symlink(target, link_path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="在 data/live 下创建软链接，指向外部素材输出目录（站点 URL 仍为 /assets/live/…）。"
    )
    parser.add_argument(
        "target",
        help="外部输出目录路径（相对当前工作目录或绝对路径）",
    )
    parser.add_argument(
        "-n",
        "--name",
        default=_DEFAULT_LINK_NAME,
        metavar="LINK_NAME",
        help=f"链接在素材根下的目录名（默认 {_DEFAULT_LINK_NAME}）",
    )
    args = parser.parse_args(argv)

    target = Path(args.target).expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()

    if not target.exists():
        print(f"错误: 目标不存在: {target}", file=sys.stderr)
        return 1
    if not target.is_dir():
        print(f"错误: 目标不是目录: {target}", file=sys.stderr)
        return 1

    _DEFAULT_LIVE_ROOT.mkdir(parents=True, exist_ok=True)

    if _is_subpath(target, _DEFAULT_LIVE_ROOT):
        print(f"目标已在 {_DEFAULT_LIVE_ROOT} 下，无需软链接:\n  {target}")
        return 0

    link_name = str(args.name).strip().strip("/\\") or _DEFAULT_LINK_NAME
    if "/" in link_name or "\\" in link_name or link_name in (".", ".."):
        print("错误: --name 只能是单层目录名", file=sys.stderr)
        return 1

    link_path = _DEFAULT_LIVE_ROOT / link_name

    if link_path.exists() or link_path.is_symlink():
        if link_path.is_symlink() or link_path.is_file():
            link_path.unlink()
        else:
            print(
                f"错误: 已存在同名真实目录（非软链接），请先改名或删除:\n  {link_path}",
                file=sys.stderr,
            )
            return 1

    try:
        _symlink(target, link_path)
    except OSError as e:
        print(f"错误: 创建软链接失败: {e}", file=sys.stderr)
        return 1

    web_prefix = f"assets/live/{link_name}"
    print(f"已创建软链接:\n  {link_path}\n-> {target}")
    print(f"站点 URL 前缀: /{web_prefix}/…")
    print("若尚未入库，请在仓库根执行: npm run sync-photo-timeline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
