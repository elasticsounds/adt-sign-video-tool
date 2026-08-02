# ADT Sign Video Tool

Add page-aligned sign-language videos to an ADT **after** the ADT has been edited with Codex.

**Use the browser app:** <https://elasticsounds.github.io/adt-sign-video-tool/>

## Browser / GitHub Pages edition

The self-contained static app is in [`docs/`](docs/). It adds a project home screen where a user can choose a local ADT folder, batch-optimize incoming videos with FFmpeg WebAssembly, match them to pages, save back to the connected folder in a supported browser, or download the complete updated ADT as a ZIP.

No ADT files are uploaded. To test it locally:

On macOS, the easiest method is to double-click [`docs/Open ADT Sign Video Tool.command`](docs/Open%20ADT%20Sign%20Video%20Tool.command). Keep its Terminal window open while using the browser tool.

Alternatively, run:

```sh
python3 -m http.server 8080 --directory adt-video-tool/docs
```

Then open <http://localhost:8080>. GitHub Pages deployment is automated by [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml); detailed setup notes are in [`docs/README.md`](docs/README.md).

The static edition uses one sign-language preset: H.264 MP4, maximum 960 px, 30 fps, CRF 24, with voice-over audio kept by default as mono AAC. Users can choose to remove audio. Use the Python app when frame-accurate trimming or Whisper transcription is needed.

The tool understands the exported ADT format used by the included *Weather and Climate Reader* sample:

- `content/pages.json` defines the ordered sections.
- `content/i18n/<language>/videos.json` maps `video-N` to a media filename.
- Video files live in `content/i18n/<language>/video/`.
- `assets/offline-preloader.js` contains an embedded copy of `videos.json` and must be refreshed for double-click/file-based ADTs.

## Use the visual tool

Run:

```sh
python3 adt-video-tool/gui_server.py "Weather and Climate Reader-adt (2)"
```

Or double-click `open_gui.command` and paste or drag the ADT folder path into the Terminal prompt.

The browser interface can:

- Add several pre-chopped videos or a folder of videos.
- Preview the ADT page and sign-language video side by side.
- Assign videos to ADT pages.
- Mark start and end trim points.
- Duplicate a source recording into several page clips.
- Keep or remove audio.
- Apply small, balanced, quality, or copy-only output settings.
- Preview existing ADT video assignments.
- Review size, duration, audio presence, dimensions, codecs, frame rate, bitrate, container, and file dates for every video.
- Preserve an import record with the import date, source filename, compression preset, audio choice, languages, and trim settings.
- Create an optional spoken-audio transcript when the Whisper CLI is installed.

Imported videos are automatically renamed to the stable convention `sl_<section_id>.mp4`, such as `sl_pg008_sec001.mp4`.

## Basic folder importer

For already chopped and compressed MP4/WebM files, include the ADT section ID in each filename:

```text
incoming-videos/
├── sl_pg001_sec001.mp4
├── sl_pg002_sec001.mp4
└── sl_pg003_sec001.mp4
```

Preview the mapping without changing the ADT:

```sh
python3 adt-video-tool/adt_video_tool.py import \
  "/path/to/completed-adt" \
  "/path/to/incoming-videos" \
  --dry-run
```

Import the videos:

```sh
python3 adt-video-tool/adt_video_tool.py import \
  "/path/to/completed-adt" \
  "/path/to/incoming-videos"
```

If filenames are arbitrary but already follow the ADT reading order, opt into sequential assignment:

```sh
python3 adt-video-tool/adt_video_tool.py import ADT_FOLDER VIDEO_FOLDER --sequential
```

Sequential assignment skips quiz/activity pages unless `--include-activities` is supplied. Always run it once with `--dry-run` before importing.

### Explicit mapping file

For complete control, create a JSON file keyed by source filename:

```json
{
  "recording-01.mp4": "pg001_sec001",
  "long-recording.mp4": {
    "section_id": "pg002_sec001",
    "start": 12.5,
    "end": 38.2,
    "transcript": "Optional spoken-audio transcript",
    "transcript_language": "en"
  }
}
```

Then run:

```sh
python3 adt-video-tool/adt_video_tool.py import ADT_FOLDER VIDEO_FOLDER \
  --map video-map.json \
  --preset balanced \
  --audio keep
```

## Compression presets

| Preset | Intended use | Output |
|---|---|---|
| `copy` | Videos already prepared for the web | Copies MP4/WebM without changing video quality |
| `small` | Tight storage or bandwidth limits | H.264, CRF 28, maximum dimension 720 px |
| `balanced` | Default for sign-language video | H.264, CRF 24, maximum dimension 960 px |
| `quality` | Smaller hand or facial details need more clarity | H.264, CRF 20, maximum dimension 1280 px |

Processed MP4 files use a broadly compatible H.264/yuv420p format and fast-start metadata. Kept voice-over audio is converted to mono AAC. FFmpeg and FFprobe must be available for processing; copy-only imports do not require FFmpeg.

## Spoken-audio transcription

Transcription applies to **spoken voice-over audio**, not directly to the signing. The tool detects the open-source `whisper` command automatically. It can also use a custom executable:

```sh
export ADT_WHISPER_COMMAND=/path/to/whisper
```

Draft transcripts should be reviewed by a person. When imported, they are stored in:

```text
content/i18n/<language>/video-transcripts.json
```

The current ADT reader does not display this sidecar automatically; it preserves the transcript for later caption or alignment work.

## Exactly what an import changes

For each selected ADT language, the tool:

1. Writes the processed media to `content/i18n/<language>/video/`.
2. Updates `content/i18n/<language>/videos.json` using the real position from `pages.json`.
3. Enables `features.signLanguage` and increments `bundleVersion` in `assets/config.json`.
4. Regenerates `assets/offline-preloader.js` when it is present.
5. Writes `video-transcripts.json` only when a transcript was supplied.
6. Updates `content/video-import-metadata.json` with tool-managed provenance and import settings.

Videos that were already in an ADT before import tracking was added still show their file and encoding metadata. Their import date is reported as “not recorded” rather than inferred from an unreliable filesystem timestamp.

The import is transactional: if processing or metadata generation fails, changed files are restored. Existing page mappings require explicit replacement.

## Inspect or test

Show the page/video positions and current mappings:

```sh
python3 adt-video-tool/adt_video_tool.py inspect ADT_FOLDER
```

Run the automated tests:

```sh
python3 -m unittest discover -s adt-video-tool/tests -v
```

## Current scope

- One sign-language video is mapped to each ADT page/section per language.
- The tool works with an unpacked ADT folder, not a ZIP file.
- It intentionally does not edit ADT runtime bundles.
- AI sign-to-text prediction is not part of this local importer yet; it can be added later as a suggested-assignment service using reviewed TSL video/text pairs.
