from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

from adt_video_tool import (  # noqa: E402
    AdtVideoError,
    VideoAssignment,
    build_assignments,
    detect_section_id,
    find_adt_root,
    import_videos,
    load_pages,
)


class AdtVideoToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "sample-adt"
        (self.root / "assets").mkdir(parents=True)
        (self.root / "content" / "i18n" / "en").mkdir(parents=True)
        (self.root / "content" / "i18n" / "sw").mkdir(parents=True)
        self.write_json("assets/config.json", {
            "title": "Test Book",
            "bundleVersion": "3",
            "languages": {"available": ["en", "sw"], "default": "en"},
            "features": {"signLanguage": False},
        })
        self.write_json("content/pages.json", [
            {"section_id": "pg001_sec001", "href": "index.html"},
            {"section_id": "qz001", "href": "qz001.html"},
            {"section_id": "pg002_sec001", "href": "pg002_sec001.html", "page_number": 1},
        ])
        self.write_json("content/toc.json", [
            {"section_id": "pg001_sec001", "href": "index.html", "title": "Cover"},
            {"section_id": "pg002_sec001", "href": "pg002_sec001.html", "title": "Lesson"},
        ])
        for language in ("en", "sw"):
            self.write_json(f"content/i18n/{language}/videos.json", {})
            self.write_json(f"content/i18n/{language}/texts.json", {"pg001_t1": "Cover"})
            self.write_json(f"content/i18n/{language}/audios.json", {})
            self.write_json(f"content/i18n/{language}/images.json", {})
            self.write_json(f"content/i18n/{language}/glossary.json", {})
            self.write_json(f"content/i18n/{language}/timecode/timecode_output.json", {})
        (self.root / "index.html").write_text('<p data-id="pg001_t1">Cover</p>', encoding="utf-8")
        (self.root / "qz001.html").write_text('<p>Quiz</p>', encoding="utf-8")
        (self.root / "pg002_sec001.html").write_text('<p>Lesson</p>', encoding="utf-8")
        (self.root / "assets" / "offline-preloader.js").write_text("old", encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_json(self, relative: str, data: object) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def make_video(self, name: str, contents: bytes = b"fake-mp4") -> Path:
        path = Path(self.temporary.name) / name
        path.write_bytes(contents)
        return path

    def test_find_root_accepts_parent_with_adt_subfolder(self) -> None:
        parent = Path(self.temporary.name) / "parent"
        parent.mkdir()
        moved = parent / "adt"
        self.root.rename(moved)
        self.root = moved
        self.assertEqual(find_adt_root(parent), moved.resolve())

    def test_detects_stable_section_and_video_position_names(self) -> None:
        pages = load_pages(self.root)
        self.assertEqual(detect_section_id("SL_pg002_sec001.MOV", pages), "pg002_sec001")
        self.assertEqual(detect_section_id("video-3.mp4", pages), "pg002_sec001")
        self.assertEqual(detect_section_id("recording_pg002.mp4", pages), "pg002_sec001")
        self.assertIsNone(detect_section_id("mystery.mp4", pages))

    def test_sequential_assignment_skips_quizzes_by_default(self) -> None:
        pages = load_pages(self.root)
        first = self.make_video("alpha.mp4")
        second = self.make_video("beta.mp4")
        assignments, unresolved = build_assignments([first, second], pages, sequential=True)
        self.assertFalse(unresolved)
        self.assertEqual([row.section_id for row in assignments], ["pg001_sec001", "pg002_sec001"])

    def test_import_updates_all_languages_config_and_preloader(self) -> None:
        source = self.make_video("sl_pg002_sec001.mp4", b"video-data")
        result = import_videos(
            self.root,
            [VideoAssignment(source=source, section_id="pg002_sec001", transcript="A short lesson")],
            preset="copy",
        )
        self.assertEqual(result.languages, ("en", "sw"))
        for language in ("en", "sw"):
            manifest = json.loads((self.root / f"content/i18n/{language}/videos.json").read_text())
            self.assertEqual(manifest, {"video-3": "sl_pg002_sec001.mp4"})
            self.assertEqual(
                (self.root / f"content/i18n/{language}/video/sl_pg002_sec001.mp4").read_bytes(),
                b"video-data",
            )
            transcripts = json.loads(
                (self.root / f"content/i18n/{language}/video-transcripts.json").read_text()
            )
            self.assertEqual(transcripts["video-3"]["text"], "A short lesson")
        config = json.loads((self.root / "assets/config.json").read_text())
        self.assertTrue(config["features"]["signLanguage"])
        self.assertEqual(config["bundleVersion"], "4")
        import_metadata = json.loads((self.root / "content/video-import-metadata.json").read_text())
        import_record = import_metadata["videos"]["video-3"]
        self.assertEqual(import_record["filename"], "sl_pg002_sec001.mp4")
        self.assertEqual(import_record["preset"], "copy")
        self.assertEqual(import_record["audio_mode"], "keep")
        self.assertEqual(import_record["languages"], ["en", "sw"])
        self.assertIn("imported_at", import_record)
        preloader = (self.root / "assets/offline-preloader.js").read_text()
        self.assertIn('"./content/i18n/en/videos.json":{"video-3":"sl_pg002_sec001.mp4"}', preloader)

    def test_existing_mapping_requires_explicit_replace(self) -> None:
        self.write_json("content/i18n/en/videos.json", {"video-1": "old.mp4"})
        source = self.make_video("new.mp4")
        with self.assertRaisesRegex(AdtVideoError, "already has"):
            import_videos(
                self.root,
                [VideoAssignment(source=source, section_id="pg001_sec001")],
                languages=["en"],
                preset="copy",
            )


if __name__ == "__main__":
    unittest.main()
