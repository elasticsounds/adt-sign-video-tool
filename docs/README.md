# ADT Sign Video Tool — browser edition

This folder is a self-contained static web app. It has no server, database, build step, or external JavaScript dependency. Its bundled FFmpeg WebAssembly engine performs video optimization locally in the browser.

**Live app:** <https://elasticsounds.github.io/adt-sign-video-tool/>

## Publish on GitHub Pages

1. Push the repository to GitHub's `main` branch.
2. Open the repository's **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Open **Actions → Deploy ADT Sign Video Tool** to follow the first deployment.
5. Open the resulting GitHub Pages URL in Chrome or Edge for direct folder read/write access.

The included workflow publishes this `docs/` folder after every push to `main`. The `.nojekyll` file keeps it as a plain static site.

## Test locally

### macOS — easiest method

Double-click **`Open ADT Sign Video Tool.command`** in this folder. Keep the Terminal window open while using the tool.

Do not double-click `index.html`: Chrome blocks WebAssembly workers and JavaScript modules loaded through a `file://` address.

### Terminal method

From the `adt-video-tool` folder, run:

```sh
python3 -m http.server 8080 --directory docs
```

Then open <http://localhost:8080>.

## Local-file behavior

- **Open local ADT folder** uses the browser's File System Access API. In supported browsers, the app can write changes back after the user grants permission.
- **Choose folder (compatible mode)** works without direct filesystem access. The ADT is edited in memory and returned with **Download ADT ZIP**.
- Files remain local to the browser. This app does not upload the ADT or videos.
- The center panel runs the selected project's actual ADT Reader, including its page navigation, language, text-to-speech, accessibility, and sign-language controls.
- **Optimize all incoming** converts a complete batch to H.264 MP4, maximum 960 px, 30 fps, CRF 24 and browser-compatible `yuv420p` video.
- Audio is kept by default as lightweight mono AAC. The user can explicitly choose **Remove audio** before optimizing.
- **Add folder + auto-assign** matches unique pages using previous import records, section IDs, video/page indexes, and page titles. **Auto-assign all** can rerun the matcher after videos were added manually. Uncertain or conflicting matches remain unassigned for review.
- Every video row has its own trash action. A linked ADT video must be unlinked first, then its file can be deleted; **Delete all videos** clears all links and stages all video files for removal in one operation.
- Page assignment is staged in the selected-video panel. The page selected on the left is preselected, and **Save to folder** or **Download ADT ZIP** automatically applies every staged assignment.
- Optimization, incoming videos, existing videos, and selected-video controls can be collapsed to keep long projects manageable.
- The conversion engine is downloaded from the same site on first use and is then eligible for the browser's normal HTTP cache.

The browser edition accepts MP4, WebM, MOV, M4V, AVI and MKV inputs. Use the Python edition in the parent folder when frame-accurate trimming or optional Whisper voice-over transcription is needed.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the bundled FFmpeg package versions and licensing information.
