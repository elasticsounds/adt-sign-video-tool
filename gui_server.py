#!/usr/bin/env python3
"""Local browser interface for the ADT sign-language video importer."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import urllib.parse
import uuid
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Sequence

from adt_video_tool import (
    AdtVideoError,
    VIDEO_EXTENSIONS,
    VideoAssignment,
    _probe_video,
    available_languages,
    detect_section_id,
    find_adt_root,
    import_videos,
    load_config,
    load_pages,
    load_video_manifest,
    transcribe_with_whisper,
    whisper_command,
)


TOOL_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = TOOL_ROOT / "static"
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
SAFE_STAGING_ID = re.compile(r"^[a-f0-9-]+$")


class VideoToolServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], adt_root: Path):
        super().__init__(address, VideoToolHandler)
        self.adt_root = adt_root
        self.staging_root = Path(tempfile.mkdtemp(prefix="adt-video-gui-"))
        self.staged: dict[str, dict[str, Any]] = {}
        self.media_cache: dict[tuple[str, int, int], dict[str, Any]] = {}

    def server_close(self) -> None:
        super().server_close()
        shutil.rmtree(self.staging_root, ignore_errors=True)


class VideoToolHandler(BaseHTTPRequestHandler):
    server: VideoToolServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/project":
            self._send_json(self._project_payload())
            return
        if parsed.path == "/api/health":
            self._send_json({"ok": True})
            return
        if parsed.path.startswith("/staging/"):
            staging_id = parsed.path.removeprefix("/staging/")
            row = self.server.staged.get(staging_id)
            if not row:
                self._send_error(HTTPStatus.NOT_FOUND, "Unknown staged video")
                return
            self._serve_file(Path(row["path"]))
            return
        if parsed.path.startswith("/adt/"):
            relative = urllib.parse.unquote(parsed.path.removeprefix("/adt/")) or "index.html"
            target = self._safe_child(self.server.adt_root, relative)
            if target is None or not target.is_file():
                self._send_error(HTTPStatus.NOT_FOUND, "ADT file not found")
                return
            self._serve_file(target, no_cache=True)
            return
        if parsed.path in {"/", "/index.html"}:
            self._serve_file(STATIC_ROOT / "index.html", no_cache=True)
            return
        if parsed.path.startswith("/static/"):
            target = self._safe_child(STATIC_ROOT, urllib.parse.unquote(parsed.path.removeprefix("/static/")))
            if target is None or not target.is_file():
                self._send_error(HTTPStatus.NOT_FOUND, "Static file not found")
                return
            self._serve_file(target, no_cache=True)
            return
        self._send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            self._serve_file(STATIC_ROOT / "index.html", head_only=True, no_cache=True)
            return
        if parsed.path.startswith("/static/"):
            target = self._safe_child(STATIC_ROOT, urllib.parse.unquote(parsed.path.removeprefix("/static/")))
            if target and target.is_file():
                self._serve_file(target, head_only=True, no_cache=True)
                return
        if parsed.path.startswith("/staging/"):
            staging_id = parsed.path.removeprefix("/staging/")
            row = self.server.staged.get(staging_id)
            if row:
                self._serve_file(Path(row["path"]), head_only=True)
                return
        if parsed.path.startswith("/adt/"):
            relative = urllib.parse.unquote(parsed.path.removeprefix("/adt/")) or "index.html"
            target = self._safe_child(self.server.adt_root, relative)
            if target and target.is_file():
                self._serve_file(target, head_only=True, no_cache=True)
                return
        self._send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/upload":
                self._handle_upload(parsed)
                return
            if parsed.path == "/api/import":
                self._handle_import()
                return
            if parsed.path == "/api/transcribe":
                self._handle_transcribe()
                return
            if parsed.path == "/api/remove-staged":
                self._handle_remove_staged()
                return
            self._send_error(HTTPStatus.NOT_FOUND, "Not found")
        except AdtVideoError as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
        except (ValueError, KeyError, TypeError) as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, f"Invalid request: {exc}")
        except Exception as exc:  # pragma: no cover - defensive boundary
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Unexpected error: {exc}")

    def _project_payload(self) -> dict[str, Any]:
        adt_root = self.server.adt_root
        config = load_config(adt_root)
        languages = available_languages(adt_root)
        pages = load_pages(adt_root)
        manifests = {language: load_video_manifest(adt_root, language) for language in languages}
        default_language = str(config.get("languages", {}).get("default") or languages[0])
        if default_language not in languages:
            default_language = languages[0]

        page_rows: list[dict[str, Any]] = []
        for page in pages:
            existing: dict[str, Any] = {}
            key = f"video-{page.position}"
            for language in languages:
                filename = manifests[language].get(key)
                if filename:
                    existing[language] = {
                        "filename": filename,
                        "url": f"/adt/content/i18n/{urllib.parse.quote(language)}/video/{urllib.parse.quote(filename)}",
                    }
            page_rows.append({
                "position": page.position,
                "video_id": key,
                "section_id": page.section_id,
                "href": page.href,
                "page_number": page.page_number,
                "title": page.title,
                "text": self._page_text(page.href, default_language),
                "existing": existing,
            })

        adt_videos = self._adt_video_inventory(languages, pages, manifests)

        staged_rows = []
        for staging_id, row in self.server.staged.items():
            public = dict(row)
            public.pop("path", None)
            public["id"] = staging_id
            public["url"] = f"/staging/{staging_id}"
            staged_rows.append(public)

        return {
            "adt_root": str(adt_root),
            "title": str(config.get("title") or adt_root.name),
            "languages": languages,
            "default_language": default_language,
            "pages": page_rows,
            "adt_videos": adt_videos,
            "staged": staged_rows,
            "capabilities": {
                "ffmpeg": bool(shutil.which("ffmpeg")),
                "ffprobe": bool(shutil.which("ffprobe")),
                "whisper": bool(whisper_command()),
            },
        }

    def _adt_video_inventory(
        self,
        languages: list[str],
        pages: list[Any],
        manifests: dict[str, dict[str, str]],
    ) -> list[dict[str, Any]]:
        """List referenced and unreferenced video files across all ADT languages."""
        pages_by_position = {page.position: page for page in pages}
        inventory: dict[tuple[str, str], dict[str, Any]] = {}
        referenced: dict[str, set[str]] = {language: set() for language in languages}
        import_history = self._load_video_import_history()

        def ensure_row(group: str, filename: str, **values: Any) -> dict[str, Any]:
            key = (group, filename)
            if key not in inventory:
                inventory[key] = {
                    "id": f"adt:{group}:{filename}",
                    "filename": filename,
                    "languages": [],
                    "urls": {},
                    "sizes": {},
                    "files": {},
                    "missing_languages": [],
                    "linked": False,
                    "position": None,
                    "video_id": None,
                    "section_id": None,
                    "title": "",
                    **values,
                }
            return inventory[key]

        for language in languages:
            for video_id, filename in manifests[language].items():
                referenced[language].add(filename)
                match = re.fullmatch(r"video-(\d+)", video_id)
                position = int(match.group(1)) if match else None
                page = pages_by_position.get(position) if position is not None else None
                group = str(position) if page else f"mapping-{video_id}"
                row = ensure_row(
                    group,
                    filename,
                    linked=page is not None,
                    position=page.position if page else None,
                    video_id=video_id,
                    section_id=page.section_id if page else None,
                    title=page.title if page else "",
                )
                if language not in row["languages"]:
                    row["languages"].append(language)
                media_path = self.server.adt_root / "content" / "i18n" / language / "video" / filename
                if media_path.is_file():
                    import_record = import_history.get(video_id)
                    if import_record and import_record.get("filename") not in {None, filename}:
                        import_record = None
                    row["urls"][language] = (
                        f"/adt/content/i18n/{urllib.parse.quote(language)}/video/"
                        f"{urllib.parse.quote(filename)}"
                    )
                    row["sizes"][language] = media_path.stat().st_size
                    row["files"][language] = self._media_record(
                        media_path,
                        import_record,
                    )
                else:
                    row["missing_languages"].append(language)

        for language in languages:
            media_dir = self.server.adt_root / "content" / "i18n" / language / "video"
            if not media_dir.is_dir():
                continue
            for media_path in sorted(media_dir.iterdir(), key=lambda path: path.name.casefold()):
                if not media_path.is_file() or media_path.suffix.lower() not in VIDEO_EXTENSIONS:
                    continue
                if media_path.name in referenced[language]:
                    continue
                row = ensure_row("unlinked", media_path.name)
                if language not in row["languages"]:
                    row["languages"].append(language)
                row["urls"][language] = (
                    f"/adt/content/i18n/{urllib.parse.quote(language)}/video/"
                    f"{urllib.parse.quote(media_path.name)}"
                )
                row["sizes"][language] = media_path.stat().st_size
                row["files"][language] = self._media_record(media_path, None)

        rows = list(inventory.values())
        for row in rows:
            row["languages"].sort()
            row["missing_languages"].sort()
        rows.sort(key=lambda row: (
            0 if row["linked"] else 1,
            row["position"] if row["position"] is not None else 10**9,
            row["filename"].casefold(),
        ))
        return rows

    def _load_video_import_history(self) -> dict[str, dict[str, Any]]:
        path = self.server.adt_root / "content" / "video-import-metadata.json"
        if not path.is_file():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        videos = payload.get("videos") if isinstance(payload, dict) else None
        if not isinstance(videos, dict):
            return {}
        return {str(key): value for key, value in videos.items() if isinstance(value, dict)}

    def _media_record(self, path: Path, import_record: dict[str, Any] | None) -> dict[str, Any]:
        stat = path.stat()
        cache_key = (str(path.resolve()), stat.st_mtime_ns, stat.st_size)
        cached = self.server.media_cache.get(cache_key)
        if cached is None:
            birth_timestamp = getattr(stat, "st_birthtime", stat.st_ctime)
            cached = {
                "size": stat.st_size,
                "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "extension": path.suffix.lower().lstrip("."),
                "file_created_at": _iso_from_timestamp(birth_timestamp),
                "file_modified_at": _iso_from_timestamp(stat.st_mtime),
                "probe": _probe_video(path),
            }
            self.server.media_cache[cache_key] = cached
        record = dict(cached)
        record["import"] = dict(import_record) if import_record else None
        return record

    def _page_text(self, href: str, language: str) -> str:
        html_path = self.server.adt_root / href
        texts_path = self.server.adt_root / "content" / "i18n" / language / "texts.json"
        if not html_path.is_file() or not texts_path.is_file():
            return ""
        try:
            html = html_path.read_text(encoding="utf-8")
            texts = json.loads(texts_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        ids = re.findall(r"\bdata-id=[\"']([^\"']+)[\"']", html)
        seen: set[str] = set()
        values: list[str] = []
        for text_id in ids:
            if text_id in seen or text_id.endswith("_easy_read"):
                continue
            seen.add(text_id)
            value = texts.get(text_id) if isinstance(texts, dict) else None
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
        return "\n\n".join(values)

    def _handle_upload(self, parsed: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed.query)
        original_name = Path(query.get("name", [""])[0]).name
        if not original_name:
            raise AdtVideoError("Upload filename is missing")
        suffix = Path(original_name).suffix.lower()
        if suffix not in {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"}:
            raise AdtVideoError(f"Unsupported video type: {suffix or '(none)'}")
        length = self._content_length(MAX_UPLOAD_BYTES)
        staging_id = str(uuid.uuid4())
        destination = self.server.staging_root / f"{staging_id}{suffix}"
        remaining = length
        with destination.open("wb") as handle:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    destination.unlink(missing_ok=True)
                    raise AdtVideoError("Upload ended before the complete video was received")
                handle.write(chunk)
                remaining -= len(chunk)

        pages = load_pages(self.server.adt_root)
        detected_section = detect_section_id(original_name, pages)
        media = self._media_record(destination, None)
        row = {
            "path": str(destination),
            "original_name": original_name,
            "size": length,
            "detected_section_id": detected_section,
            "probe": media["probe"],
            "media": media,
            "uploaded_at": _iso_from_timestamp(destination.stat().st_mtime),
        }
        self.server.staged[staging_id] = row
        public = dict(row)
        public.pop("path")
        public.update({"id": staging_id, "url": f"/staging/{staging_id}"})
        self._send_json(public, status=HTTPStatus.CREATED)

    def _handle_import(self) -> None:
        payload = self._read_json_body()
        jobs = payload.get("jobs")
        if not isinstance(jobs, list) or not jobs:
            raise AdtVideoError("Select at least one video clip to import")
        assignments: list[VideoAssignment] = []
        for job in jobs:
            if not isinstance(job, dict):
                raise AdtVideoError("Every import job must be an object")
            staging_id = str(job.get("staging_id", ""))
            row = self.server.staged.get(staging_id)
            if not row:
                raise AdtVideoError(f"Unknown staged video: {staging_id}")
            assignments.append(VideoAssignment(
                source=Path(row["path"]),
                section_id=str(job.get("section_id", "")),
                start=_number_or_none(job.get("start")),
                end=_number_or_none(job.get("end")),
                transcript=str(job.get("transcript", "")),
                transcript_language=str(job.get("transcript_language", "")),
                metadata={"staging_id": staging_id, "original_name": row["original_name"]},
            ))
        languages = payload.get("languages")
        if not isinstance(languages, list) or not languages:
            raise AdtVideoError("Choose at least one ADT language destination")
        result = import_videos(
            self.server.adt_root,
            assignments,
            languages=[str(language) for language in languages],
            preset=str(payload.get("preset", "balanced")),
            audio=str(payload.get("audio", "keep")),
            replace=bool(payload.get("replace", False)),
        )
        self._send_json({
            "ok": True,
            "imported": list(result.imported),
            "languages": list(result.languages),
            "offline_preloader_updated": result.offline_preloader_updated,
        })

    def _handle_transcribe(self) -> None:
        payload = self._read_json_body()
        staging_id = str(payload.get("staging_id", ""))
        row = self.server.staged.get(staging_id)
        if not row:
            raise AdtVideoError("Unknown staged video")
        transcript = transcribe_with_whisper(
            row["path"],
            language=str(payload.get("language") or "") or None,
            model=str(payload.get("model") or "small"),
        )
        self._send_json({
            "text": str(transcript.get("text", "")).strip(),
            "language": transcript.get("language"),
            "segments": transcript.get("segments", []),
        })

    def _handle_remove_staged(self) -> None:
        payload = self._read_json_body()
        staging_id = str(payload.get("staging_id", ""))
        if not SAFE_STAGING_ID.fullmatch(staging_id):
            raise AdtVideoError("Invalid staged video id")
        row = self.server.staged.pop(staging_id, None)
        if row:
            Path(row["path"]).unlink(missing_ok=True)
        self._send_json({"ok": True})

    def _read_json_body(self) -> dict[str, Any]:
        length = self._content_length(MAX_JSON_BYTES)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdtVideoError("Request body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise AdtVideoError("Request body must be a JSON object")
        return payload

    def _content_length(self, maximum: int) -> int:
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as exc:
            raise AdtVideoError("Content-Length is required") from exc
        if length <= 0:
            raise AdtVideoError("Request body is empty")
        if length > maximum:
            raise AdtVideoError(f"Request body is too large ({length} bytes)")
        return length

    def _serve_file(self, path: Path, *, head_only: bool = False, no_cache: bool = False) -> None:
        size = path.stat().st_size
        start = 0
        end = size - 1
        status = HTTPStatus.OK
        range_header = self.headers.get("Range", "")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = int(last) if last else end
            elif last:
                suffix_size = min(int(last), size)
                start = size - suffix_size
            if start >= size or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = HTTPStatus.PARTIAL_CONTENT

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if no_cache:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if head_only or length == 0:
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _send_json(self, payload: Any, *, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    @staticmethod
    def _safe_child(root: Path, relative: str) -> Path | None:
        target = (root / relative).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            return None
        return target


def _number_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _iso_from_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Open the ADT sign-language video post-production GUI")
    parser.add_argument("adt", help="Exported ADT folder or parent folder containing adt/")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="Local port; default chooses a free port")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        adt_root = find_adt_root(args.adt)
    except AdtVideoError as exc:
        print(f"Error: {exc}")
        return 2

    server = VideoToolServer((args.host, args.port), adt_root)
    host, port = server.server_address[:2]
    display_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{display_host}:{port}/"
    print(f"ADT Sign Video Tool: {url}")
    print(f"ADT: {adt_root}")
    print("Press Control-C to stop.")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
