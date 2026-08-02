#!/usr/bin/env python3
"""Import, process, and map sign-language videos into an exported ADT folder.

The module has no Python package dependencies. Video processing is delegated to
FFmpeg when trimming, transcoding, or removing audio is requested.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence


VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"}
WEB_COPY_EXTENSIONS = {".mp4", ".webm"}
SECTION_ID_RE = re.compile(r"^(?:pg\d+_sec\d+|qz\d+)$", re.IGNORECASE)
VIDEO_POSITION_RE = re.compile(r"(?:^|[^a-z0-9])video[-_ ]?(\d+)(?:[^a-z0-9]|$)", re.IGNORECASE)
PAGE_SECTION_RE = re.compile(r"pg\d+_sec\d+", re.IGNORECASE)
PAGE_ID_RE = re.compile(r"(?:^|[^a-z0-9])(pg\d+)(?:[^a-z0-9]|$)", re.IGNORECASE)


class AdtVideoError(RuntimeError):
    """Expected, user-facing tool error."""


@dataclass(frozen=True)
class AdtPage:
    position: int
    section_id: str
    href: str
    page_number: int | None = None
    title: str = ""


@dataclass
class VideoAssignment:
    source: Path
    section_id: str
    start: float | None = None
    end: float | None = None
    transcript: str = ""
    transcript_language: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if not self.source.is_file():
            raise AdtVideoError(f"Video file does not exist: {self.source}")
        if self.source.suffix.lower() not in VIDEO_EXTENSIONS:
            raise AdtVideoError(f"Unsupported video type: {self.source.name}")
        if self.start is not None and self.start < 0:
            raise AdtVideoError(f"Trim start must be zero or greater: {self.source.name}")
        if self.end is not None and self.end <= 0:
            raise AdtVideoError(f"Trim end must be greater than zero: {self.source.name}")
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise AdtVideoError(f"Trim end must be after trim start: {self.source.name}")


@dataclass(frozen=True)
class ImportResult:
    adt_root: Path
    languages: tuple[str, ...]
    imported: tuple[dict[str, Any], ...]
    manifest_paths: tuple[Path, ...]
    offline_preloader_updated: bool


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AdtVideoError(f"Required ADT file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise AdtVideoError(f"Invalid JSON in {path}: {exc}") from exc


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_json(path: Path, data: Any) -> None:
    _atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def find_adt_root(candidate: str | Path) -> Path:
    """Resolve either an ADT root or a parent folder containing an ``adt`` root."""
    supplied = Path(candidate).expanduser().resolve()
    if not supplied.is_dir():
        raise AdtVideoError(f"ADT folder does not exist: {supplied}")

    direct_candidates = [supplied, supplied / "adt"]
    for root in direct_candidates:
        if (root / "content" / "pages.json").is_file() and (root / "assets" / "config.json").is_file():
            return root

    matches: list[Path] = []
    for pages_path in supplied.glob("*/*/pages.json"):
        if pages_path.parent.name != "content":
            continue
        root = pages_path.parent.parent
        if (root / "assets" / "config.json").is_file():
            matches.append(root)
    unique = sorted(set(matches))
    if len(unique) == 1:
        return unique[0]
    if len(unique) > 1:
        options = "\n".join(f"  - {path}" for path in unique)
        raise AdtVideoError(f"More than one ADT was found. Choose one explicitly:\n{options}")
    raise AdtVideoError(
        f"No exported ADT found in {supplied}. Expected content/pages.json and assets/config.json."
    )


def load_config(adt_root: Path) -> dict[str, Any]:
    config = _read_json(adt_root / "assets" / "config.json")
    if not isinstance(config, dict):
        raise AdtVideoError("assets/config.json must contain a JSON object")
    return config


def available_languages(adt_root: Path) -> list[str]:
    config = load_config(adt_root)
    configured = config.get("languages", {}).get("available", [])
    languages = [str(value) for value in configured if str(value).strip()]
    i18n_root = adt_root / "content" / "i18n"
    disk_languages = sorted(
        path.name for path in i18n_root.iterdir() if path.is_dir()
    ) if i18n_root.is_dir() else []
    for language in disk_languages:
        if language not in languages:
            languages.append(language)
    if not languages:
        raise AdtVideoError("No languages were found in the ADT")
    return languages


def load_pages(adt_root: Path) -> list[AdtPage]:
    raw_pages = _read_json(adt_root / "content" / "pages.json")
    if not isinstance(raw_pages, list):
        raise AdtVideoError("content/pages.json must contain a JSON array")

    titles: dict[str, str] = {}
    toc_path = adt_root / "content" / "toc.json"
    if toc_path.is_file():
        raw_toc = _read_json(toc_path)
        if isinstance(raw_toc, list):
            titles = {
                str(row.get("section_id")): str(row.get("title", ""))
                for row in raw_toc
                if isinstance(row, dict) and row.get("section_id")
            }

    pages: list[AdtPage] = []
    for position, row in enumerate(raw_pages, start=1):
        if not isinstance(row, dict) or not row.get("section_id") or not row.get("href"):
            raise AdtVideoError(f"Invalid pages.json entry at position {position}")
        section_id = str(row["section_id"])
        pages.append(
            AdtPage(
                position=position,
                section_id=section_id,
                href=str(row["href"]),
                page_number=row.get("page_number") if isinstance(row.get("page_number"), int) else None,
                title=titles.get(section_id, ""),
            )
        )
    if not pages:
        raise AdtVideoError("content/pages.json contains no pages")
    return pages


def load_video_manifest(adt_root: Path, language: str) -> dict[str, str]:
    path = adt_root / "content" / "i18n" / language / "videos.json"
    if not path.exists():
        return {}
    raw = _read_json(path)
    if not isinstance(raw, dict):
        raise AdtVideoError(f"{path} must contain a JSON object")
    return {str(key): str(value) for key, value in raw.items()}


def discover_video_files(source_folder: str | Path) -> list[Path]:
    source = Path(source_folder).expanduser().resolve()
    if not source.is_dir():
        raise AdtVideoError(f"Video folder does not exist: {source}")
    files = [path for path in source.iterdir() if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS]
    return sorted(files, key=lambda path: natural_sort_key(path.name))


def natural_sort_key(value: str) -> list[str | int]:
    return [int(piece) if piece.isdigit() else piece.casefold() for piece in re.split(r"(\d+)", value)]


def detect_section_id(filename: str, pages: Sequence[AdtPage]) -> str | None:
    """Detect a page assignment from a stable section id or ``video-N`` filename."""
    lower_name = Path(filename).stem.casefold()
    by_lower_id = {page.section_id.casefold(): page.section_id for page in pages}

    explicit = PAGE_SECTION_RE.search(lower_name)
    if explicit and explicit.group(0).casefold() in by_lower_id:
        return by_lower_id[explicit.group(0).casefold()]

    for normalized, section_id in sorted(by_lower_id.items(), key=lambda pair: len(pair[0]), reverse=True):
        if normalized in lower_name:
            return section_id

    video_position = VIDEO_POSITION_RE.search(lower_name)
    if video_position:
        position = int(video_position.group(1))
        if 1 <= position <= len(pages):
            return pages[position - 1].section_id

    page_match = PAGE_ID_RE.search(lower_name)
    if page_match:
        prefix = page_match.group(1).casefold() + "_"
        candidates = [page.section_id for page in pages if page.section_id.casefold().startswith(prefix)]
        if len(candidates) == 1:
            return candidates[0]
    return None


def build_assignments(
    video_files: Sequence[Path],
    pages: Sequence[AdtPage],
    mapping: dict[str, Any] | None = None,
    sequential: bool = False,
    start_position: int = 1,
    include_activities: bool = False,
) -> tuple[list[VideoAssignment], list[Path]]:
    """Build assignments from a mapping file, filenames, and optional sequential fallback."""
    explicit_mapping = mapping or {}
    page_ids = {page.section_id for page in pages}
    page_by_position = {page.position: page for page in pages}
    assigned: list[VideoAssignment] = []
    unresolved: list[Path] = []
    used_sections: set[str] = set()

    for video_file in video_files:
        raw_value = explicit_mapping.get(video_file.name)
        section_id: str | None = None
        kwargs: dict[str, Any] = {}
        if isinstance(raw_value, str):
            section_id = raw_value
        elif isinstance(raw_value, dict):
            section_id = raw_value.get("section_id") or raw_value.get("sectionId")
            kwargs = {
                "start": _optional_float(raw_value.get("start")),
                "end": _optional_float(raw_value.get("end")),
                "transcript": str(raw_value.get("transcript", "")),
                "transcript_language": str(raw_value.get("transcript_language", "")),
            }
        elif raw_value is not None:
            raise AdtVideoError(f"Invalid mapping for {video_file.name}")

        section_id = section_id or detect_section_id(video_file.name, pages)
        if section_id is None:
            unresolved.append(video_file)
            continue
        if section_id not in page_ids:
            raise AdtVideoError(f"Unknown section id {section_id!r} for {video_file.name}")
        if section_id in used_sections:
            raise AdtVideoError(f"More than one input video maps to {section_id}")
        used_sections.add(section_id)
        assigned.append(VideoAssignment(video_file, section_id, **kwargs))

    if sequential and unresolved:
        eligible = [
            page
            for page in pages
            if page.position >= start_position
            and page.section_id not in used_sections
            and (include_activities or not page.section_id.casefold().startswith("qz"))
        ]
        if len(unresolved) > len(eligible):
            raise AdtVideoError(
                f"There are {len(unresolved)} unmapped videos but only {len(eligible)} eligible ADT pages"
            )
        for video_file, page in zip(unresolved, eligible):
            assigned.append(VideoAssignment(video_file, page.section_id))
            used_sections.add(page.section_id)
        unresolved = unresolved[len(eligible):]

    assigned.sort(key=lambda assignment: next(
        page.position for page in pages if page.section_id == assignment.section_id
    ))
    return assigned, unresolved


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise AdtVideoError(f"Expected a numeric trim time, got {value!r}") from exc


def _probe_video(source: Path) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {}
    command = [
        ffprobe,
        "-v", "error",
        "-show_entries", (
            "format=duration,size,bit_rate,format_name,format_long_name,start_time,nb_streams:"
            "format_tags=creation_time,encoder:"
            "stream=index,codec_type,codec_name,codec_long_name,profile,codec_tag_string,"
            "width,height,pix_fmt,r_frame_rate,avg_frame_rate,bit_rate,bits_per_raw_sample,"
            "sample_rate,channels,channel_layout,duration:"
            "stream_tags=creation_time,language,handler_name,encoder"
        ),
        "-of", "json",
        str(source),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return {}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _video_dimensions(probe: dict[str, Any]) -> tuple[int, int]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            return int(stream.get("width") or 0), int(stream.get("height") or 0)
    return 0, 0


def _run_ffmpeg(
    assignment: VideoAssignment,
    output: Path,
    preset: str,
    audio: str,
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AdtVideoError("FFmpeg is required for trimming, compression, or audio removal")

    assignment.validate()
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if assignment.start is not None:
        command.extend(["-ss", f"{assignment.start:.3f}"])
    command.extend(["-i", str(assignment.source)])
    if assignment.end is not None:
        duration = assignment.end - (assignment.start or 0.0)
        command.extend(["-t", f"{duration:.3f}"])
    command.extend(["-map", "0:v:0"])
    if audio == "keep":
        command.extend(["-map", "0:a?"])

    copy_video = preset == "copy"
    if copy_video:
        command.extend(["-c:v", "copy"])
    else:
        settings = {
            "small": {"crf": "28", "max_dimension": 720, "audio_rate": "64k"},
            "balanced": {"crf": "24", "max_dimension": 960, "audio_rate": "96k"},
            "quality": {"crf": "20", "max_dimension": 1280, "audio_rate": "128k"},
        }[preset]
        width, height = _video_dimensions(_probe_video(assignment.source))
        command.extend([
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", settings["crf"],
            "-pix_fmt", "yuv420p",
        ])
        if max(width, height) > settings["max_dimension"]:
            bound = settings["max_dimension"]
            command.extend([
                "-vf",
                f"scale={bound}:{bound}:force_original_aspect_ratio=decrease:force_divisible_by=2",
            ])

    if audio == "remove":
        command.append("-an")
    elif copy_video:
        command.extend(["-c:a", "copy"])
    else:
        audio_rate = {
            "small": "64k",
            "balanced": "96k",
            "quality": "128k",
        }[preset]
        command.extend(["-c:a", "aac", "-b:a", audio_rate, "-ac", "1"])

    if output.suffix.lower() == ".mp4":
        command.extend(["-movflags", "+faststart"])
    command.append(str(output))

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or "unknown FFmpeg error"
        raise AdtVideoError(f"Could not process {assignment.source.name}: {detail}")


def _manifest_sort_key(item: tuple[str, str]) -> tuple[int, str]:
    match = re.fullmatch(r"video-(\d+)", item[0])
    return (int(match.group(1)), item[0]) if match else (10**9, item[0])


def _next_bundle_version(value: Any) -> str:
    text = str(value or "").strip()
    if text.isdigit():
        return str(int(text) + 1)
    return f"{text or '1'}-sl-{int(time.time())}"


def import_videos(
    adt: str | Path,
    assignments: Sequence[VideoAssignment],
    *,
    languages: Sequence[str] | None = None,
    preset: str = "copy",
    audio: str = "keep",
    replace: bool = False,
    dry_run: bool = False,
) -> ImportResult:
    """Import assigned videos transactionally and update all ADT sidecars."""
    if preset not in {"copy", "small", "balanced", "quality"}:
        raise AdtVideoError(f"Unknown compression preset: {preset}")
    if audio not in {"keep", "remove"}:
        raise AdtVideoError(f"Unknown audio mode: {audio}")
    if not assignments:
        raise AdtVideoError("No videos were assigned")

    adt_root = find_adt_root(adt)
    pages = load_pages(adt_root)
    positions = {page.section_id: page.position for page in pages}
    all_languages = available_languages(adt_root)
    selected_languages = list(languages or all_languages)
    invalid_languages = sorted(set(selected_languages) - set(all_languages))
    if invalid_languages:
        raise AdtVideoError(f"Languages are not present in this ADT: {', '.join(invalid_languages)}")

    seen_sections: set[str] = set()
    for assignment in assignments:
        assignment.validate()
        if assignment.section_id not in positions:
            raise AdtVideoError(f"Unknown ADT section id: {assignment.section_id}")
        if assignment.section_id in seen_sections:
            raise AdtVideoError(f"More than one video is assigned to {assignment.section_id}")
        seen_sections.add(assignment.section_id)
        if preset == "copy" and assignment.source.suffix.lower() not in WEB_COPY_EXTENSIONS:
            raise AdtVideoError(
                f"{assignment.source.name} is not an MP4 or WebM. Choose a compression preset to convert it."
            )

    manifests = {
        language: load_video_manifest(adt_root, language)
        for language in selected_languages
    }
    for assignment in assignments:
        key = f"video-{positions[assignment.section_id]}"
        for language, manifest in manifests.items():
            if key in manifest and not replace:
                raise AdtVideoError(
                    f"{assignment.section_id} already has {manifest[key]!r} in {language}; use --replace to replace it"
                )

    imported: list[dict[str, Any]] = []
    if dry_run:
        for assignment in assignments:
            extension = assignment.source.suffix.lower() if preset == "copy" else ".mp4"
            imported.append({
                "source": str(assignment.source),
                "section_id": assignment.section_id,
                "position": positions[assignment.section_id],
                "filename": f"sl_{assignment.section_id}{extension}",
            })
        return ImportResult(adt_root, tuple(selected_languages), tuple(imported), tuple(), False)

    staging_root = Path(tempfile.mkdtemp(prefix="adt-sign-video-import-"))
    staged_outputs: list[tuple[VideoAssignment, Path, str]] = []
    backup_root = staging_root / "backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    backups: dict[Path, Path | None] = {}

    def snapshot(path: Path) -> None:
        resolved = path.resolve()
        if resolved in backups:
            return
        if path.is_file():
            backup = backup_root / f"{len(backups):05d}-{path.name}"
            shutil.copy2(path, backup)
            backups[resolved] = backup
        else:
            backups[resolved] = None

    try:
        for assignment in assignments:
            extension = assignment.source.suffix.lower() if preset == "copy" else ".mp4"
            filename = f"sl_{assignment.section_id}{extension}"
            staged = staging_root / filename
            needs_ffmpeg = (
                preset != "copy"
                or audio == "remove"
                or assignment.start is not None
                or assignment.end is not None
            )
            if needs_ffmpeg:
                _run_ffmpeg(assignment, staged, preset, audio)
            else:
                shutil.copy2(assignment.source, staged)
            staged_outputs.append((assignment, staged, filename))

        for assignment, staged, filename in staged_outputs:
            position = positions[assignment.section_id]
            key = f"video-{position}"
            for language in selected_languages:
                destination_dir = adt_root / "content" / "i18n" / language / "video"
                destination_dir.mkdir(parents=True, exist_ok=True)
                destination = destination_dir / filename
                snapshot(destination)
                temporary_destination = destination.with_name(f".{destination.name}.importing")
                shutil.copy2(staged, temporary_destination)
                os.replace(temporary_destination, destination)
                manifests[language][key] = filename
            imported.append({
                "source": str(assignment.source),
                "section_id": assignment.section_id,
                "position": position,
                "filename": filename,
                "start": assignment.start,
                "end": assignment.end,
                "probe": _probe_video(staged),
            })

        import_metadata_path = adt_root / "content" / "video-import-metadata.json"
        try:
            import_metadata = json.loads(import_metadata_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            import_metadata = {"version": 1, "videos": {}}
        except json.JSONDecodeError as exc:
            raise AdtVideoError(f"Invalid JSON in {import_metadata_path}: {exc}") from exc
        if not isinstance(import_metadata, dict):
            import_metadata = {"version": 1, "videos": {}}
        video_history = import_metadata.setdefault("videos", {})
        if not isinstance(video_history, dict):
            video_history = {}
            import_metadata["videos"] = video_history
        imported_at = _utc_now_iso()
        for assignment, imported_row in zip(assignments, imported, strict=True):
            video_id = f"video-{imported_row['position']}"
            imported_row["imported_at"] = imported_at
            source_stat = assignment.source.stat()
            video_history[video_id] = {
                "imported_at": imported_at,
                "filename": imported_row["filename"],
                "section_id": assignment.section_id,
                "languages": list(selected_languages),
                "source_name": str(assignment.metadata.get("original_name") or assignment.source.name),
                "source_size": source_stat.st_size,
                "preset": preset,
                "audio_mode": audio,
                "trim_start": assignment.start,
                "trim_end": assignment.end,
            }
        import_metadata["version"] = 1
        snapshot(import_metadata_path)
        _write_json(import_metadata_path, import_metadata)

        manifest_paths: list[Path] = []
        for language, manifest in manifests.items():
            ordered = dict(sorted(manifest.items(), key=_manifest_sort_key))
            manifest_path = adt_root / "content" / "i18n" / language / "videos.json"
            snapshot(manifest_path)
            _write_json(manifest_path, ordered)
            manifest_paths.append(manifest_path)
            if any(assignment.transcript.strip() for assignment in assignments):
                snapshot(adt_root / "content" / "i18n" / language / "video-transcripts.json")
            _write_transcripts(adt_root, language, assignments, positions, ordered)

        config_path = adt_root / "assets" / "config.json"
        snapshot(config_path)
        config = load_config(adt_root)
        features = config.setdefault("features", {})
        if isinstance(features, dict):
            features["signLanguage"] = True
        config["bundleVersion"] = _next_bundle_version(config.get("bundleVersion"))
        _write_json(config_path, config)

        preloader_path = adt_root / "assets" / "offline-preloader.js"
        if preloader_path.exists():
            snapshot(preloader_path)
        preloader_updated = regenerate_offline_preloader(adt_root)
        return ImportResult(
            adt_root=adt_root,
            languages=tuple(selected_languages),
            imported=tuple(imported),
            manifest_paths=tuple(manifest_paths),
            offline_preloader_updated=preloader_updated,
        )
    except Exception:
        for target, backup in reversed(list(backups.items())):
            if backup is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
        raise
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def _write_transcripts(
    adt_root: Path,
    language: str,
    assignments: Sequence[VideoAssignment],
    positions: dict[str, int],
    manifest: dict[str, str],
) -> None:
    with_text = [assignment for assignment in assignments if assignment.transcript.strip()]
    if not with_text:
        return
    path = adt_root / "content" / "i18n" / language / "video-transcripts.json"
    current: dict[str, Any] = {}
    if path.is_file():
        raw = _read_json(path)
        if isinstance(raw, dict):
            current = raw
    for assignment in with_text:
        key = f"video-{positions[assignment.section_id]}"
        current[key] = {
            "section_id": assignment.section_id,
            "filename": manifest[key],
            "text": assignment.transcript.strip(),
            "language": assignment.transcript_language or None,
        }
    _write_json(path, dict(sorted(current.items(), key=lambda item: _manifest_sort_key((item[0], "")))))


def regenerate_offline_preloader(adt_root: Path) -> bool:
    """Rebuild the generated file:// fetch shim from the current ADT files."""
    preloader_path = adt_root / "assets" / "offline-preloader.js"
    if not preloader_path.exists():
        return False

    inline: dict[str, Any] = {}

    def add_json(relative: str) -> None:
        path = adt_root / relative
        if path.is_file():
            inline[f"./{relative}"] = _read_json(path)

    def add_text(relative: str) -> None:
        path = adt_root / relative
        if path.is_file():
            inline[f"./{relative}"] = path.read_text(encoding="utf-8")

    for relative in ("assets/config.json", "content/pages.json", "content/toc.json"):
        add_json(relative)
    add_text("content/navigation/nav.html")
    for html_path in sorted(adt_root.glob("*.html"), key=lambda path: natural_sort_key(path.name)):
        add_text(html_path.name)
    for language in available_languages(adt_root):
        add_json(f"assets/interface_translations/{language}/interface_translations.json")
        for filename in (
            "texts.json",
            "audios.json",
            "videos.json",
            "images.json",
            "glossary.json",
            "timecode/timecode_output.json",
        ):
            add_json(f"content/i18n/{language}/{filename}")

    compact_json = json.dumps(inline, ensure_ascii=False, separators=(",", ":"))
    javascript = f'''// offline-preloader.js — auto-generated, do not edit by hand
(function () {{
  var INLINE = {compact_json};
  var BASE_DIR = (function () {{
    var href = location.href.split("?")[0].split("#")[0];
    return href.slice(0, href.lastIndexOf("/") + 1);
  }})();
  function lookup(url) {{
    var clean = String(url).split("?")[0].split("#")[0];
    if (BASE_DIR && clean.indexOf(BASE_DIR) === 0) clean = clean.slice(BASE_DIR.length);
    if (clean.indexOf("./") === 0) clean = clean.slice(2);
    var withDot = "./" + clean;
    if (Object.prototype.hasOwnProperty.call(INLINE, withDot)) return withDot;
    if (Object.prototype.hasOwnProperty.call(INLINE, clean)) return clean;
    return null;
  }}
  var _realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {{
    // Normalize Request objects to their URL string.
    var raw = (url && typeof url === "object" && typeof url.url === "string") ? url.url : url;
    var key = lookup(raw);
    if (key !== null) {{
      var data = INLINE[key];
      var isJson = key.slice(-5) === ".json";
      var body = isJson ? JSON.stringify(data) : data;
      var ct = isJson ? "application/json" : "text/html; charset=utf-8";
      return Promise.resolve(
        new Response(body, {{ status: 200, headers: {{ "Content-Type": ct }} }})
      );
    }}
    return _realFetch(url, opts);
  }};
  if (location.protocol === 'file:') {{
    new MutationObserver(function (mutations) {{
      mutations.forEach(function (m) {{
        m.addedNodes.forEach(function (node) {{
          if (node.nodeType === 1 && node.tagName === 'LINK' && node.rel === 'manifest') {{
            node.parentNode.removeChild(node);
          }}
        }});
      }});
    }}).observe(document.documentElement, {{ childList: true, subtree: true }});
  }}
}})();
'''
    _atomic_write_text(preloader_path, javascript)
    return True


def whisper_command() -> str | None:
    configured = os.environ.get("ADT_WHISPER_COMMAND", "").strip()
    if configured:
        return shutil.which(configured) or (configured if Path(configured).is_file() else None)
    return shutil.which("whisper")


def transcribe_with_whisper(
    source: str | Path,
    *,
    language: str | None = None,
    model: str = "small",
) -> dict[str, Any]:
    """Run the optional open-source Whisper CLI and return its JSON output."""
    command_path = whisper_command()
    if not command_path:
        raise AdtVideoError(
            "Local Whisper is not installed. Install openai-whisper or set ADT_WHISPER_COMMAND."
        )
    source_path = Path(source).resolve()
    output_dir = Path(tempfile.mkdtemp(prefix="adt-whisper-"))
    try:
        command = [
            command_path,
            str(source_path),
            "--model", model,
            "--output_format", "json",
            "--output_dir", str(output_dir),
            "--verbose", "False",
        ]
        if language:
            command.extend(["--language", language])
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise AdtVideoError(result.stderr.strip() or "Whisper transcription failed")
        candidates = list(output_dir.glob("*.json"))
        if not candidates:
            raise AdtVideoError("Whisper did not produce a JSON transcript")
        raw = _read_json(candidates[0])
        if not isinstance(raw, dict):
            raise AdtVideoError("Whisper returned an invalid transcript")
        return raw
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


def _load_mapping(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    mapping_path = Path(path).expanduser().resolve()
    raw = _read_json(mapping_path)
    if not isinstance(raw, dict):
        raise AdtVideoError("Mapping file must contain a JSON object keyed by video filename")
    return raw


def _parse_languages(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [piece.strip() for piece in value.split(",") if piece.strip()]


def _print_inspection(adt_root: Path) -> None:
    pages = load_pages(adt_root)
    languages = available_languages(adt_root)
    config = load_config(adt_root)
    print(f"ADT: {adt_root}")
    print(f"Title: {config.get('title', '(untitled)')}")
    print(f"Languages: {', '.join(languages)}")
    print(f"Pages/sections: {len(pages)}")
    for language in languages:
        manifest = load_video_manifest(adt_root, language)
        print(f"  {language}: {len(manifest)} mapped sign-language video(s)")
    print("\nPage positions:")
    for page in pages:
        label = f" — {page.title}" if page.title else ""
        print(f"  video-{page.position:<3} {page.section_id:<18} {page.href}{label}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="adt-video-tool",
        description="Add page-aligned sign-language videos to an exported ADT folder.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="Show pages, languages, and existing mappings")
    inspect_parser.add_argument("adt", help="ADT folder or a parent folder containing adt/")

    import_parser = subparsers.add_parser("import", help="Import a folder of pre-chopped videos")
    import_parser.add_argument("adt", help="ADT folder or a parent folder containing adt/")
    import_parser.add_argument("videos", help="Folder containing the input videos")
    import_parser.add_argument("--map", dest="mapping", help="JSON filename-to-section mapping")
    import_parser.add_argument(
        "--sequential",
        action="store_true",
        help="Assign otherwise-unmapped videos to pages in natural filename order",
    )
    import_parser.add_argument("--start-position", type=int, default=1)
    import_parser.add_argument("--include-activities", action="store_true")
    import_parser.add_argument("--languages", help="Comma-separated ADT language codes; default: all")
    import_parser.add_argument(
        "--preset",
        choices=("copy", "small", "balanced", "quality"),
        default="copy",
        help="Compression preset; copy keeps compatible MP4/WebM files unchanged",
    )
    import_parser.add_argument("--audio", choices=("keep", "remove"), default="keep")
    import_parser.add_argument("--replace", action="store_true")
    import_parser.add_argument("--dry-run", action="store_true")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            _print_inspection(find_adt_root(args.adt))
            return 0

        adt_root = find_adt_root(args.adt)
        pages = load_pages(adt_root)
        videos = discover_video_files(args.videos)
        if not videos:
            raise AdtVideoError(f"No supported videos found in {Path(args.videos).resolve()}")
        assignments, unresolved = build_assignments(
            videos,
            pages,
            mapping=_load_mapping(args.mapping),
            sequential=args.sequential,
            start_position=args.start_position,
            include_activities=args.include_activities,
        )
        if unresolved:
            names = "\n".join(f"  - {path.name}" for path in unresolved)
            raise AdtVideoError(
                "These videos could not be matched to an ADT section. Rename them with a section id "
                f"(for example pg004_sec001), provide --map, or use --sequential:\n{names}"
            )
        result = import_videos(
            adt_root,
            assignments,
            languages=_parse_languages(args.languages),
            preset=args.preset,
            audio=args.audio,
            replace=args.replace,
            dry_run=args.dry_run,
        )
        verb = "Would import" if args.dry_run else "Imported"
        print(f"{verb} {len(result.imported)} sign-language video(s) into {result.adt_root}")
        for row in result.imported:
            print(f"  video-{row['position']} -> {row['filename']} ({row['section_id']})")
        if not args.dry_run:
            print(f"Languages: {', '.join(result.languages)}")
            print(f"Offline preload cache refreshed: {'yes' if result.offline_preloader_updated else 'not present'}")
        return 0
    except AdtVideoError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
