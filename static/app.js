(() => {
  const state = {
    project: null,
    pages: [],
    stagedById: new Map(),
    clips: [],
    adtVideos: [],
    selectedPagePosition: null,
    selectedClipId: null,
    selectedExistingId: null,
    selectionType: null,
    libraryFilter: 'all',
    pageFilter: 'all',
    previewContext: null,
    busy: false,
  };

  const el = Object.fromEntries([
    'project-title', 'project-path', 'page-count', 'page-search', 'page-list',
    'page-map-summary', 'page-map-filters', 'current-page-mapping',
    'current-page-title', 'current-page-meta', 'assign-current-page', 'adt-frame',
    'adt-empty', 'open-page', 'video-preview', 'video-empty', 'video-source-label',
    'video-source-badge', 'video-origin-callout', 'video-preview-title',
    'video-duration', 'page-text', 'clip-count', 'clip-list', 'clip-editor',
    'library-summary', 'library-filters', 'incoming-count', 'adt-video-count',
    'existing-video-details', 'existing-video-name', 'existing-video-page',
    'existing-video-languages', 'existing-video-status',
    'media-info-dialog', 'media-info-title', 'media-info-subtitle',
    'media-info-source', 'media-info-notice', 'media-info-highlights',
    'media-info-sections', 'media-info-close',
    'current-media-info', 'alignment-page', 'alignment-video', 'alignment-status',
    'alignment-duration', 'alignment-size', 'alignment-dimensions', 'alignment-audio',
    'clip-name', 'duplicate-clip', 'remove-clip', 'section-select', 'trim-start',
    'trim-end', 'mark-start', 'mark-end', 'transcript', 'transcript-language',
    'transcribe', 'compression-preset', 'language-options', 'import-selected',
    'import-all', 'video-files', 'video-folder', 'upload-progress', 'upload-label',
    'upload-percent', 'upload-meter', 'toast-region',
  ].map((id) => [id, document.getElementById(id)]));

  const videoExtensions = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let payload;
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function loadProject({ preserveClips = false } = {}) {
    const project = await api('/api/project');
    state.project = project;
    state.pages = project.pages;
    state.adtVideos = combineAdtVideoInventory(project);
    state.stagedById = new Map(project.staged.map((row) => [row.id, row]));
    if (!preserveClips) {
      state.clips = project.staged.map(makeClip);
      state.selectedClipId = state.clips[0]?.id || null;
      state.selectedExistingId = null;
      state.selectionType = state.selectedClipId ? 'incoming' : null;
    }
    el['project-title'].textContent = project.title;
    el['project-path'].textContent = project.adt_root;
    el['page-count'].textContent = project.pages.length;
    configureLanguages();
    configureCapabilities();
    buildSectionOptions();
    renderPages();
    renderVideoLibrary();
    if (state.selectedPagePosition == null && project.pages.length) selectPage(project.pages[0].position);
    else if (state.selectedPagePosition != null) selectPage(state.selectedPagePosition);
    if (state.selectedClipId) selectClip(state.selectedClipId, { followPage: false });
    updateButtons();
    hydrateFallbackMedia().catch(() => {});
  }

  function makeClip(row) {
    return {
      id: localId(),
      staging_id: row.id,
      original_name: row.original_name,
      source_url: row.url,
      section_id: row.detected_section_id || '',
      start: null,
      end: null,
      transcript: '',
      transcript_language: '',
      imported: false,
      size: row.size ?? row.media?.size ?? null,
      probe: row.probe || row.media?.probe || {},
      media: row.media || null,
      uploaded_at: row.uploaded_at || null,
    };
  }

  function combineAdtVideoInventory(project) {
    const inventory = new Map();
    (project.adt_videos || []).forEach((video) => {
      inventory.set(`${video.video_id || 'unlinked'}:${video.filename}`, video);
    });
    project.pages.forEach((page) => {
      Object.entries(page.existing || {}).forEach(([language, mapping]) => {
        const key = `${page.video_id}:${mapping.filename}`;
        let video = inventory.get(key);
        if (!video) {
          video = {
            id: `adt:fallback:${page.video_id}:${mapping.filename}`,
            filename: mapping.filename,
            languages: [],
            urls: {},
            sizes: {},
            files: {},
            missing_languages: [],
            linked: true,
            position: page.position,
            video_id: page.video_id,
            section_id: page.section_id,
            title: page.title,
          };
          inventory.set(key, video);
        }
        if (!video.languages.includes(language)) video.languages.push(language);
        if (mapping.url) video.urls[language] = mapping.url;
      });
    });
    return [...inventory.values()].sort((a, b) => {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
        || a.filename.localeCompare(b.filename);
    });
  }

  function localId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function configureLanguages() {
    const existing = new Set(
      [...el['language-options'].querySelectorAll('input:checked')].map((input) => input.value),
    );
    el['language-options'].replaceChildren();
    state.project.languages.forEach((language) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = language;
      input.checked = existing.size ? existing.has(language) : true;
      label.append(input, document.createTextNode(language));
      el['language-options'].append(label);
    });
  }

  function configureCapabilities() {
    const whisperAvailable = state.project.capabilities.whisper;
    el.transcribe.disabled = !whisperAvailable;
    el.transcribe.textContent = whisperAvailable ? 'Transcribe audio' : 'Whisper not installed';
    el.transcribe.title = whisperAvailable
      ? 'Create a draft transcript from the video voice-over'
      : 'Install the open-source Whisper CLI or set ADT_WHISPER_COMMAND to enable transcription';
    if (!state.project.capabilities.ffmpeg) {
      el['compression-preset'].value = 'copy';
      [...el['compression-preset'].options].forEach((option) => {
        if (option.value !== 'copy') option.disabled = true;
      });
    }
  }

  function buildSectionOptions() {
    const currentValue = el['section-select'].value;
    el['section-select'].replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a page…';
    el['section-select'].append(placeholder);
    state.pages.forEach((page) => {
      const option = document.createElement('option');
      option.value = page.section_id;
      option.textContent = `${page.video_id} · ${page.title || page.section_id}`;
      el['section-select'].append(option);
    });
    el['section-select'].value = currentValue;
  }

  function renderPages() {
    const query = el['page-search'].value.trim().toLowerCase();
    const existingCount = state.pages.filter((page) => Object.keys(page.existing || {}).length).length;
    const incomingCount = state.pages.filter((page) => state.clips.some((clip) => clip.section_id === page.section_id)).length;
    const missingCount = state.pages.filter((page) => !Object.keys(page.existing || {}).length && !state.clips.some((clip) => clip.section_id === page.section_id)).length;
    el['page-map-summary'].textContent = `${existingCount} linked in ADT · ${incomingCount} incoming · ${missingCount} without video`;
    [...el['page-map-filters'].querySelectorAll('button')].forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.pageFilter === state.pageFilter));
    });
    el['page-list'].replaceChildren();
    state.pages
      .filter((page) => {
        const hasExisting = Object.keys(page.existing || {}).length > 0;
        const incoming = state.clips.filter((clip) => clip.section_id === page.section_id);
        const matchesFilter = state.pageFilter === 'all'
          || (state.pageFilter === 'adt' && hasExisting)
          || (state.pageFilter === 'incoming' && incoming.length > 0)
          || (state.pageFilter === 'missing' && !hasExisting && !incoming.length);
        const filenames = [
          ...Object.values(page.existing || {}).map((mapping) => mapping.filename),
          ...incoming.map((clip) => clip.original_name),
        ];
        const searchText = `${page.title} ${page.section_id} ${page.video_id} ${page.page_number ?? ''} ${filenames.join(' ')}`.toLowerCase();
        return matchesFilter && (!query || searchText.includes(query));
      })
      .forEach((page) => {
        const existingFiles = uniqueExistingMappings(page);
        const incoming = state.clips.filter((clip) => clip.section_id === page.section_id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'page-item';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(page.position === state.selectedPagePosition));

        const position = document.createElement('span');
        position.className = 'page-position';
        position.textContent = page.position;
        const copy = document.createElement('span');
        copy.className = 'page-copy';
        const title = document.createElement('strong');
        title.textContent = page.title || (page.section_id.startsWith('qz') ? 'Activity' : page.section_id);
        const id = document.createElement('small');
        id.textContent = page.page_number != null
          ? `${page.video_id} · ${page.section_id} · print p. ${page.page_number}`
          : `${page.video_id} · ${page.section_id}`;
        const mappings = document.createElement('span');
        mappings.className = 'page-video-links';
        existingFiles.forEach((mapping) => {
          mappings.append(makePageVideoLine('In ADT', mapping.filename, 'existing'));
        });
        incoming.forEach((clip) => {
          mappings.append(makePageVideoLine('Incoming', clip.original_name, 'incoming', existingFiles.length ? 'will replace' : 'will add'));
        });
        if (!existingFiles.length && !incoming.length) {
          mappings.append(makePageVideoLine('No video', 'Nothing attached', 'missing'));
        }
        copy.append(title, id, mappings);
        button.append(position, copy);
        button.addEventListener('click', () => selectPage(page.position));
        el['page-list'].append(button);
      });
    refreshCurrentPageMapping();
  }

  function refreshCurrentPageMapping() {
    const page = state.pages.find((row) => row.position === state.selectedPagePosition);
    if (page) renderCurrentPageMapping(page);
  }

  function uniqueExistingMappings(page) {
    const mappings = new Map();
    Object.entries(page.existing || {}).forEach(([language, mapping]) => {
      if (!mappings.has(mapping.filename)) mappings.set(mapping.filename, { filename: mapping.filename, languages: [] });
      mappings.get(mapping.filename).languages.push(language);
    });
    return [...mappings.values()];
  }

  function makePageVideoLine(label, filename, tone, note = '') {
    const line = document.createElement('span');
    line.className = `page-video-line ${tone}`;
    const badge = document.createElement('b');
    badge.textContent = label;
    const name = document.createElement('span');
    name.textContent = filename;
    if (note) name.dataset.note = `· ${note}`;
    line.append(badge, name);
    return line;
  }

  function selectPage(position, { keepLibrarySelection = false } = {}) {
    const page = state.pages.find((row) => row.position === Number(position));
    if (!page) return;
    if (!keepLibrarySelection && state.selectionType === 'adt') {
      state.selectionType = null;
      state.selectedExistingId = null;
      el['existing-video-details'].hidden = true;
    }
    state.selectedPagePosition = page.position;
    el['current-page-title'].textContent = page.title || page.section_id;
    const metadata = [`${page.video_id}`, page.section_id];
    if (page.page_number != null) metadata.push(`print page ${page.page_number}`);
    el['current-page-meta'].textContent = metadata.join(' · ');
    renderCurrentPageMapping(page);
    el['page-text'].textContent = page.text || 'No localized page text was found.';
    const pageUrl = `/adt/${encodePath(page.href)}`;
    el['adt-frame'].src = pageUrl;
    el['adt-frame'].hidden = false;
    el['adt-empty'].hidden = true;
    el['open-page'].href = pageUrl;
    el['open-page'].hidden = false;
    el['assign-current-page'].disabled = !selectedClip();
    if (!selectedClip() && state.selectionType !== 'adt') showExistingVideo(page);
    renderPages();
    renderVideoLibrary();
    resetReviewScroll();
  }

  function renderCurrentPageMapping(page) {
    el['current-page-mapping'].replaceChildren();
    const existing = uniqueExistingMappings(page);
    const incoming = state.clips.filter((clip) => clip.section_id === page.section_id);
    existing.forEach((mapping) => {
      el['current-page-mapping'].append(makeCurrentMapItem('In ADT', mapping.filename, 'existing'));
    });
    incoming.forEach((clip) => {
      el['current-page-mapping'].append(makeCurrentMapItem(
        'Incoming',
        `${clip.original_name}${existing.length ? ' · will replace' : ' · will add'}`,
        'incoming',
      ));
    });
    if (!existing.length && !incoming.length) {
      el['current-page-mapping'].append(makeCurrentMapItem('No video', 'Nothing attached to this page', 'missing'));
    }
    refreshAlignmentPanel();
  }

  function makeCurrentMapItem(label, filename, tone) {
    const item = document.createElement('span');
    item.className = `current-map-item ${tone}`;
    const badge = document.createElement('strong');
    badge.textContent = label;
    const name = document.createElement('span');
    name.textContent = filename;
    item.append(badge, name);
    return item;
  }

  function resetReviewScroll() {
    const review = document.querySelector('.review-panel');
    if (!review) return;
    review.scrollTop = 0;
    requestAnimationFrame(() => {
      review.scrollTop = 0;
      requestAnimationFrame(() => { review.scrollTop = 0; });
    });
  }

  function showExistingVideo(page) {
    const preferred = page.existing[state.project.default_language] || Object.values(page.existing)[0];
    if (!preferred) {
      clearVideo('No video selected', 'Add videos or choose a page with an existing video.');
      return;
    }
    const video = state.adtVideos.find((row) => row.position === page.position && row.filename === preferred.filename)
      || state.adtVideos.find((row) => row.position === page.position);
    setPreviewContext(video ? { type: 'existing', video } : null);
    setVideo(preferred.url, preferred.filename, {
      type: 'existing',
      label: 'Already saved in this project',
      detail: `ALREADY IN ADT · Linked to ${page.video_id}`,
    });
  }

  function renderVideoLibrary() {
    const filter = state.libraryFilter;
    const total = state.clips.length + state.adtVideos.length;
    const unlinkedIncoming = state.clips.filter((clip) => !clip.section_id).length;
    const unlinkedExisting = state.adtVideos.filter((video) => !video.linked).length;
    const unlinkedTotal = unlinkedIncoming + unlinkedExisting;
    el['clip-count'].textContent = total;
    el['incoming-count'].textContent = state.clips.length;
    el['adt-video-count'].textContent = state.adtVideos.length;
    el['library-summary'].textContent = `${state.adtVideos.length} in ADT · ${state.clips.length} incoming${unlinkedTotal ? ` · ${unlinkedTotal} unlinked` : ''}`;
    [...el['library-filters'].querySelectorAll('button')].forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    });
    el['clip-list'].replaceChildren();

    const showIncoming = filter === 'all' || filter === 'incoming';
    const showExisting = filter === 'all' || filter === 'adt';
    if (showIncoming && state.clips.length) {
      appendLibraryHeading('Incoming to import', state.clips.length);
      state.clips.forEach((clip, index) => appendIncomingRow(clip, index));
    }
    if (showExisting && state.adtVideos.length) {
      appendLibraryHeading('Already in ADT', state.adtVideos.length);
      state.adtVideos.forEach((video, index) => appendExistingRow(video, index));
    }

    const visibleCount = (showIncoming ? state.clips.length : 0) + (showExisting ? state.adtVideos.length : 0);
    if (!visibleCount) appendLibraryEmpty(filter);
    el['clip-editor'].hidden = !showIncoming || state.selectionType !== 'incoming' || !selectedClip();
    el['existing-video-details'].hidden = !showExisting || state.selectionType !== 'adt' || !selectedExistingVideo();
  }

  function appendLibraryHeading(label, count) {
    const heading = document.createElement('div');
    heading.className = 'library-section-title';
    heading.textContent = label;
    const badge = document.createElement('span');
    badge.textContent = count;
    heading.append(badge);
    el['clip-list'].append(heading);
  }

  function appendIncomingRow(clip, index) {
    const page = state.pages.find((row) => row.section_id === clip.section_id);
    const replaces = page && Object.keys(page.existing).length > 0;
    const media = mediaForClip(clip);
    const button = createLibraryRow({
      number: index + 1,
      name: clip.original_name,
      assignment: page ? `${page.video_id} · ${page.title || page.section_id}` : 'Choose a page before importing',
      selected: state.selectionType === 'incoming' && clip.id === state.selectedClipId,
      sourceClass: 'incoming',
      media,
      info: { type: 'incoming', clip, page, media },
    });
    const meta = button.querySelector('.library-row-meta');
    meta.append(makePill(page ? 'Linked' : 'Unlinked', page ? 'linked' : 'unlinked'));
    if (replaces) meta.append(makePill('Will replace', 'replace'));
    button.title = page
      ? `${replaces ? 'Will replace' : 'Will add'} ${page.video_id} when imported`
      : 'Incoming video is not linked to an ADT page';
    button.querySelector('.library-select').addEventListener('click', () => selectClip(clip.id));
    el['clip-list'].append(button);
  }

  function appendExistingRow(video, index) {
    const assignment = video.linked
      ? `${video.video_id} · ${video.title || video.section_id}`
      : 'File is in the ADT folder but not linked';
    const media = mediaForExisting(video);
    const button = createLibraryRow({
      number: index + 1,
      name: video.filename,
      assignment,
      selected: state.selectionType === 'adt' && video.id === state.selectedExistingId,
      sourceClass: 'existing',
      media,
      info: { type: 'existing', video, media },
    });
    const meta = button.querySelector('.library-row-meta');
    meta.append(makePill(video.linked ? 'Linked' : 'Unlinked', video.linked ? 'linked' : 'unlinked'));
    if (video.missing_languages?.length) meta.append(makePill('File missing', 'missing'));
    const languages = document.createElement('span');
    languages.className = 'library-languages';
    languages.textContent = video.languages.length ? video.languages.join(', ') : 'no language';
    meta.append(languages);
    button.title = video.linked ? `Already in the ADT and linked to ${video.video_id}` : 'Already in the ADT folder, but not used by videos.json';
    button.querySelector('.library-select').addEventListener('click', () => selectExistingVideo(video.id));
    el['clip-list'].append(button);
  }

  function createLibraryRow({ number, name, assignment, selected, sourceClass, media, info }) {
    const row = document.createElement('div');
    row.className = `clip-item library-row ${sourceClass}-row`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-select';
    const numberNode = document.createElement('span');
    numberNode.className = `clip-number ${sourceClass}`;
    numberNode.textContent = number;
    const copy = document.createElement('span');
    copy.className = 'clip-copy';
    const nameNode = document.createElement('strong');
    nameNode.textContent = name;
    const assignmentNode = document.createElement('small');
    assignmentNode.textContent = assignment;
    const mediaSummary = makeMediaSummary(media);
    const meta = document.createElement('span');
    meta.className = 'library-row-meta';
    copy.append(nameNode, assignmentNode, mediaSummary, meta);
    button.append(numberNode, copy);
    const infoButton = document.createElement('button');
    infoButton.type = 'button';
    infoButton.className = 'media-info-button';
    infoButton.textContent = 'i';
    infoButton.setAttribute('aria-label', `Media information for ${name}`);
    infoButton.title = 'View complete media information';
    infoButton.addEventListener('click', () => showMediaInfo(info));
    row.append(button, infoButton);
    return row;
  }

  function makeMediaSummary(media) {
    const summary = document.createElement('span');
    summary.className = 'library-media-summary';
    const facts = mediaFacts(media);
    const duration = document.createElement('span');
    duration.textContent = facts.duration == null ? 'Length —' : formatDuration(facts.duration);
    const size = document.createElement('span');
    size.textContent = facts.size == null ? 'Size —' : formatBytes(facts.size);
    const audio = document.createElement('span');
    audio.className = facts.hasAudio === true ? 'has-audio' : facts.hasAudio === false ? 'no-audio' : '';
    audio.textContent = facts.hasAudio === true ? 'Audio' : facts.hasAudio === false ? 'No audio' : 'Audio unknown';
    summary.append(duration, size, audio);
    return summary;
  }

  function mediaForClip(clip) {
    return {
      ...(clip.media || {}),
      size: clip.media?.size ?? clip.size ?? clip.probe?.format?.size ?? null,
      probe: clip.media?.probe || clip.probe || {},
      staged_at: clip.uploaded_at || clip.media?.file_created_at || null,
      source_name: clip.original_name,
    };
  }

  function mediaForExisting(video) {
    const preferredLanguage = state.project.default_language;
    const language = video.files?.[preferredLanguage]
      ? preferredLanguage
      : Object.keys(video.files || {})[0] || preferredLanguage;
    const file = video.files?.[language];
    if (file) return { ...file, language, source_name: video.filename };
    return {
      size: video.sizes?.[language] ?? Object.values(video.sizes || {})[0] ?? null,
      probe: {},
      language,
      source_name: video.filename,
      browser_fallback: true,
    };
  }

  function mediaFacts(media = {}) {
    const probe = media.probe || {};
    const format = probe.format || {};
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video') || {};
    const audioStream = streams.find((stream) => stream.codec_type === 'audio') || null;
    const duration = finiteNumber(format.duration) ?? finiteNumber(videoStream.duration);
    const size = finiteNumber(media.size) ?? finiteNumber(format.size);
    let hasAudio = media.audio_presence;
    if (hasAudio == null && streams.length && !media.browser_fallback) hasAudio = Boolean(audioStream);
    const overallBitrate = finiteNumber(format.bit_rate)
      ?? (duration && size ? (size * 8) / duration : null);
    return { probe, format, streams, videoStream, audioStream, duration, size, hasAudio, overallBitrate };
  }

  function showMediaInfo(info) {
    const media = info.media || {};
    const facts = mediaFacts(media);
    const isIncoming = info.type === 'incoming';
    const name = isIncoming ? info.clip.original_name : info.video.filename;
    const source = isIncoming ? 'Incoming' : 'In ADT';
    el['media-info-source'].className = `source-badge ${isIncoming ? 'incoming' : 'existing'}`;
    el['media-info-source'].textContent = source;
    el['media-info-title'].textContent = name;
    el['media-info-subtitle'].textContent = isIncoming
      ? (info.page ? `${info.page.video_id} · ${info.page.section_id} · staged for import` : 'Not assigned to an ADT page')
      : (info.video.linked ? `${info.video.video_id} · ${info.video.section_id}` : 'Unlinked file in the ADT video folder');
    el['media-info-notice'].hidden = !media.browser_fallback;
    el['media-info-notice'].textContent = media.browser_fallback
      ? 'Basic size, length, and dimensions were read in the browser. Restart the tool after finishing any staged imports to inspect authoritative audio, codec, bitrate, and file-date metadata.'
      : '';

    el['media-info-highlights'].replaceChildren(
      makeMediaHighlight('Length', facts.duration == null ? 'Unknown' : formatDuration(facts.duration)),
      makeMediaHighlight('File size', facts.size == null ? 'Unknown' : formatBytes(facts.size)),
      makeMediaHighlight('Dimensions', facts.videoStream.width && facts.videoStream.height ? `${facts.videoStream.width} × ${facts.videoStream.height}` : 'Unknown'),
      makeMediaHighlight('Audio', facts.hasAudio === true ? 'Included' : facts.hasAudio === false ? 'None' : 'Unknown'),
    );

    const videoCreated = facts.format.tags?.creation_time || facts.videoStream.tags?.creation_time;
    const importRecord = media.import || {};
    const frameRate = parseRate(facts.videoStream.avg_frame_rate || facts.videoStream.r_frame_rate);
    const codec = [facts.videoStream.codec_long_name || facts.videoStream.codec_name, facts.videoStream.profile]
      .filter(Boolean).join(' · ');
    const audioCodec = facts.audioStream
      ? [facts.audioStream.codec_long_name || facts.audioStream.codec_name, facts.audioStream.profile].filter(Boolean).join(' · ')
      : null;
    const segmentDuration = isIncoming ? effectiveClipDuration(info.clip, facts.duration) : null;
    const sections = [
      ['File', [
        ['Type', media.mime_type || extensionLabel(name)],
        ['Container', facts.format.format_long_name || facts.format.format_name],
        ['Extension', (media.extension || name.split('.').pop() || '').toUpperCase()],
        ['File size', facts.size == null ? null : `${formatBytes(facts.size)} (${Math.round(facts.size).toLocaleString()} bytes)`],
        ['Language copy', media.language],
        ['Filename', name],
      ]],
      ['Video encoding', [
        ['Compression / codec', codec],
        ['Codec tag', facts.videoStream.codec_tag_string],
        ['Dimensions', facts.videoStream.width && facts.videoStream.height ? `${facts.videoStream.width} × ${facts.videoStream.height} pixels` : null],
        ['Pixel format', facts.videoStream.pix_fmt],
        ['Frame rate', frameRate == null ? null : `${formatDecimal(frameRate)} fps`],
        ['Video bitrate', formatBitrate(finiteNumber(facts.videoStream.bit_rate))],
        ['Overall data rate', formatBitrate(facts.overallBitrate)],
        ['Duration', facts.duration == null ? null : `${formatDuration(facts.duration)} (${formatDecimal(facts.duration)} seconds)`],
      ]],
      ['Audio', [
        ['Audio present', facts.hasAudio === true ? 'Yes' : facts.hasAudio === false ? 'No' : 'Unknown'],
        ['Compression / codec', audioCodec],
        ['Channels', facts.audioStream?.channels],
        ['Channel layout', facts.audioStream?.channel_layout],
        ['Sample rate', facts.audioStream?.sample_rate ? `${Number(facts.audioStream.sample_rate).toLocaleString()} Hz` : null],
        ['Audio bitrate', formatBitrate(finiteNumber(facts.audioStream?.bit_rate))],
      ]],
      ['Dates', [
        ['Media created', formatDate(videoCreated)],
        ['File created', formatDate(media.file_created_at)],
        ['File modified', formatDate(media.file_modified_at)],
        ['Imported into ADT', formatDate(importRecord.imported_at)],
        ['Staged for import', formatDate(media.staged_at)],
      ]],
      ['ADT and import record', isIncoming ? [
        ['Status', info.page ? (Object.keys(info.page.existing || {}).length ? 'Will replace existing video' : 'Will add a new video') : 'Needs page assignment'],
        ['Page video ID', info.page?.video_id],
        ['Section ID', info.page?.section_id],
        ['Source duration', facts.duration == null ? null : formatDuration(facts.duration)],
        ['Selected segment', segmentDuration == null ? 'Full source' : formatDuration(segmentDuration)],
        ['Trim start', info.clip.start == null ? 'Beginning' : `${info.clip.start} seconds`],
        ['Trim end', info.clip.end == null ? 'End of file' : `${info.clip.end} seconds`],
      ] : [
        ['Mapping status', info.video.linked ? 'Linked in videos.json' : 'Not linked in videos.json'],
        ['Page video ID', info.video.video_id],
        ['Section ID', info.video.section_id],
        ['Languages', info.video.languages?.join(', ')],
        ['Imported source', importRecord.source_name],
        ['Compression preset', importRecord.preset],
        ['Import audio setting', importRecord.audio_mode],
        ['Imported by this tool', importRecord.imported_at ? 'Yes' : 'Not recorded (predates tracking)'],
      ]],
    ];
    el['media-info-sections'].replaceChildren(...sections.map(([title, rows]) => makeMediaSection(title, rows)));
    if (typeof el['media-info-dialog'].showModal === 'function') el['media-info-dialog'].showModal();
    else el['media-info-dialog'].setAttribute('open', '');
  }

  function makeMediaHighlight(label, value) {
    const item = document.createElement('div');
    item.className = 'media-highlight';
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    const valueNode = document.createElement('strong');
    valueNode.textContent = value;
    item.append(labelNode, valueNode);
    return item;
  }

  function makeMediaSection(title, rows) {
    const section = document.createElement('section');
    section.className = 'media-info-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('dl');
    rows.forEach(([label, value]) => {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value == null || value === '' ? 'Not available' : String(value);
      item.append(term, description);
      list.append(item);
    });
    section.append(heading, list);
    return section;
  }

  function effectiveClipDuration(clip, sourceDuration) {
    const start = clip.start ?? 0;
    const end = clip.end ?? sourceDuration;
    if (end == null) return null;
    return Math.max(0, end - start);
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function parseRate(value) {
    if (!value) return null;
    const [numerator, denominator = '1'] = String(value).split('/').map(Number);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }

  function formatDecimal(value) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: amount >= 10 || unit === 0 ? 0 : 1 })} ${units[unit]}`;
  }

  function formatBitrate(bitsPerSecond) {
    if (!Number.isFinite(bitsPerSecond)) return null;
    if (bitsPerSecond >= 1_000_000) return `${formatDecimal(bitsPerSecond / 1_000_000)} Mbps`;
    if (bitsPerSecond >= 1_000) return `${formatDecimal(bitsPerSecond / 1_000)} kbps`;
    return `${formatDecimal(bitsPerSecond)} bps`;
  }

  function formatDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function extensionLabel(filename) {
    const extension = filename.split('.').pop();
    return extension ? `${extension.toUpperCase()} video` : null;
  }

  async function hydrateFallbackMedia() {
    const candidates = state.adtVideos.filter((video) => !Object.keys(video.files || {}).length && Object.keys(video.urls || {}).length);
    if (!candidates.length) return;
    await Promise.allSettled(candidates.map(async (video) => {
      const language = video.urls[state.project.default_language]
        ? state.project.default_language
        : Object.keys(video.urls)[0];
      const url = video.urls[language];
      const [head, browserMedia] = await Promise.all([
        fetch(url, { method: 'HEAD' }).catch(() => null),
        readBrowserMediaMetadata(url),
      ]);
      const size = finiteNumber(head?.headers.get('content-length'));
      const mimeType = head?.headers.get('content-type')?.split(';')[0] || null;
      const media = {
        size,
        mime_type: mimeType,
        extension: video.filename.split('.').pop()?.toLowerCase() || null,
        probe: {
          format: { duration: browserMedia.duration, size },
          streams: browserMedia.width && browserMedia.height
            ? [{ codec_type: 'video', width: browserMedia.width, height: browserMedia.height }]
            : [],
        },
        audio_presence: browserMedia.audioPresence,
        browser_fallback: true,
        import: null,
      };
      video.files = { ...(video.files || {}), [language]: media };
      if (size != null) video.sizes = { ...(video.sizes || {}), [language]: size };
    }));
    renderVideoLibrary();
    refreshAlignmentPanel();
  }

  function readBrowserMediaMetadata(url) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      let settled = false;
      const finish = (metadata = {}) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        video.removeAttribute('src');
        video.load();
        resolve(metadata);
      };
      const timeout = window.setTimeout(() => finish(), 8000);
      video.preload = 'metadata';
      video.muted = true;
      video.addEventListener('loadedmetadata', () => {
        let audioPresence = null;
        if (typeof video.mozHasAudio === 'boolean') audioPresence = video.mozHasAudio;
        else if (video.audioTracks && typeof video.audioTracks.length === 'number') audioPresence = video.audioTracks.length > 0;
        finish({
          duration: Number.isFinite(video.duration) ? video.duration : null,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          audioPresence,
        });
      }, { once: true });
      video.addEventListener('error', () => finish(), { once: true });
      video.src = url;
    });
  }

  function makePill(label, tone) {
    const pill = document.createElement('span');
    pill.className = `library-pill ${tone}`;
    pill.textContent = label;
    return pill;
  }

  function appendLibraryEmpty(filter) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    const title = document.createElement('strong');
    const help = document.createElement('p');
    title.textContent = filter === 'incoming' ? 'No incoming videos' : filter === 'adt' ? 'No videos in this ADT' : 'No videos yet';
    help.textContent = filter === 'incoming'
      ? 'Use Add video files or Import a folder to stage videos.'
      : filter === 'adt'
        ? 'Videos already saved in the ADT will appear here.'
        : 'Add pre-chopped videos or import a folder to get started.';
    empty.append(title, help);
    el['clip-list'].append(empty);
  }

  function selectedClip() {
    if (state.selectionType !== 'incoming') return null;
    return state.clips.find((clip) => clip.id === state.selectedClipId) || null;
  }

  function selectedExistingVideo() {
    return state.adtVideos.find((video) => video.id === state.selectedExistingId) || null;
  }

  function selectClip(clipId, { followPage = true } = {}) {
    const clip = state.clips.find((row) => row.id === clipId);
    if (!clip) return;
    saveEditorToClip();
    state.selectionType = 'incoming';
    state.selectedClipId = clip.id;
    state.selectedExistingId = null;
    el['existing-video-details'].hidden = true;
    el['clip-editor'].hidden = false;
    el['clip-editor'].dataset.clipId = clip.id;
    el['clip-name'].textContent = clip.original_name;
    el['section-select'].value = clip.section_id;
    el['trim-start'].value = clip.start ?? '';
    el['trim-end'].value = clip.end ?? '';
    el.transcript.value = clip.transcript;
    el['transcript-language'].value = clip.transcript_language;
    showIncomingVideo(clip);
    if (followPage && clip.section_id) {
      const page = state.pages.find((row) => row.section_id === clip.section_id);
      if (page) selectPage(page.position);
    }
    el['assign-current-page'].disabled = state.selectedPagePosition == null;
    renderVideoLibrary();
    renderPages();
    updateButtons();
  }

  function showIncomingVideo(clip) {
    const page = state.pages.find((row) => row.section_id === clip.section_id);
    setPreviewContext({ type: 'incoming', clip });
    setVideo(clip.source_url, clip.original_name, {
      type: 'incoming',
      label: 'Not yet imported into this project',
      detail: page ? `INCOMING VIDEO · Assigned to ${page.video_id}` : 'INCOMING VIDEO · Not linked to a page yet',
    });
  }

  function selectExistingVideo(videoId) {
    saveEditorToClip();
    const video = state.adtVideos.find((row) => row.id === videoId);
    if (!video) return;
    state.selectionType = 'adt';
    state.selectedExistingId = video.id;
    state.selectedClipId = null;
    el['clip-editor'].hidden = true;
    el['clip-editor'].dataset.clipId = '';
    el['existing-video-details'].hidden = false;
    el['existing-video-name'].textContent = video.filename;
    el['existing-video-page'].textContent = video.linked
      ? `${video.video_id} · ${video.title || video.section_id}`
      : 'Not linked in videos.json';
    el['existing-video-languages'].textContent = video.languages.length ? video.languages.join(', ') : 'None';
    el['existing-video-status'].textContent = video.missing_languages?.length
      ? `Mapped, but missing in: ${video.missing_languages.join(', ')}`
      : video.linked ? 'Linked and available' : 'Unlinked file in the ADT folder';

    if (video.linked) selectPage(video.position, { keepLibrarySelection: true });
    const url = video.urls[state.project.default_language] || Object.values(video.urls)[0];
    setPreviewContext({ type: 'existing', video });
    if (url) {
      setVideo(url, video.filename, {
        type: 'existing',
        label: 'Already saved in this project',
        detail: video.linked ? `ALREADY IN ADT · Linked to ${video.video_id}` : 'ALREADY IN ADT · File is not linked in videos.json',
      });
    } else {
      clearVideo('Video file is missing', 'This videos.json entry points to a file that could not be found.');
      setPreviewContext({ type: 'existing', video });
      setVideoOrigin({
        type: 'existing',
        label: 'ADT mapping with a missing file',
        detail: `ALREADY IN ADT · Missing in ${video.missing_languages.join(', ') || 'the video folder'}`,
      });
    }
    renderVideoLibrary();
    renderPages();
    updateButtons();
  }

  function saveEditorToClip() {
    const editingId = el['clip-editor'].dataset.clipId;
    const clip = state.clips.find((row) => row.id === editingId);
    if (!clip || el['clip-editor'].hidden) return;
    clip.section_id = el['section-select'].value;
    clip.start = numberOrNull(el['trim-start'].value);
    clip.end = numberOrNull(el['trim-end'].value);
    clip.transcript = el.transcript.value;
    clip.transcript_language = el['transcript-language'].value.trim();
    if (state.previewContext?.type === 'incoming' && state.previewContext.clip.id === clip.id) {
      refreshAlignmentPanel();
    }
  }

  function setVideo(url, name, origin) {
    if (el['video-preview'].getAttribute('src') !== url) {
      el['video-preview'].src = url;
      el['video-duration'].textContent = '…';
    }
    el['video-preview'].hidden = false;
    el['video-empty'].hidden = true;
    el['video-preview-title'].textContent = name || 'Video preview';
    setVideoOrigin(origin);
  }

  function setVideoOrigin(origin) {
    const type = origin?.type || 'neutral';
    const badgeText = type === 'incoming' ? 'Incoming' : type === 'existing' ? 'In ADT' : 'No video';
    el['video-source-badge'].className = `source-badge ${type}`;
    el['video-source-badge'].textContent = badgeText;
    el['video-source-label'].textContent = origin?.label || 'Sign language';
    el['video-origin-callout'].textContent = origin?.detail || '';
    el['video-origin-callout'].className = `video-origin-callout ${type}`;
    el['video-origin-callout'].hidden = !origin?.detail;
    const card = document.querySelector('.video-card');
    card?.classList.toggle('source-incoming', type === 'incoming');
    card?.classList.toggle('source-existing', type === 'existing');
  }

  function setPreviewContext(context) {
    state.previewContext = context;
    el['current-media-info'].disabled = !context;
    refreshAlignmentPanel();
  }

  function currentPreviewInfo() {
    const context = state.previewContext;
    if (!context) return null;
    if (context.type === 'incoming') {
      const clip = state.clips.find((row) => row.id === context.clip.id) || context.clip;
      const page = state.pages.find((row) => row.section_id === clip.section_id) || null;
      return { type: 'incoming', clip, page, media: mediaForClip(clip) };
    }
    const video = state.adtVideos.find((row) => row.id === context.video.id) || context.video;
    return { type: 'existing', video, media: mediaForExisting(video) };
  }

  function refreshAlignmentPanel() {
    if (!el['alignment-page']) return;
    const selectedPage = state.pages.find((row) => row.position === state.selectedPagePosition) || null;
    const info = currentPreviewInfo();
    el['alignment-page'].textContent = selectedPage
      ? `${selectedPage.video_id} · ${selectedPage.title || selectedPage.section_id}`
      : 'No page selected';
    el['alignment-video'].textContent = info
      ? `${info.type === 'incoming' ? 'Incoming' : 'In ADT'} · ${info.type === 'incoming' ? info.clip.original_name : info.video.filename}`
      : 'No video selected';
    el['current-media-info'].disabled = !info;

    let status = 'Choose a page and video to review their alignment.';
    let tone = '';
    if (info?.type === 'incoming') {
      if (!info.page) {
        status = 'This incoming video is not linked yet. Select a page, then use “Assign selected clip here.”';
        tone = 'warning';
      } else if (selectedPage?.position === info.page.position) {
        status = Object.keys(selectedPage.existing || {}).length
          ? `Aligned to ${selectedPage.video_id}; importing will replace the existing ADT video.`
          : `Aligned to ${selectedPage.video_id}; importing will add a new ADT video.`;
        tone = 'match';
      } else {
        status = `This video is assigned to ${info.page.video_id}, while the selected page is ${selectedPage?.video_id || 'none'}.`;
        tone = 'warning';
      }
    } else if (info?.type === 'existing') {
      if (!info.video.linked) {
        status = 'This file is stored in the ADT but is not linked to a page in videos.json.';
        tone = 'warning';
      } else if (selectedPage?.position === info.video.position) {
        status = `Existing ADT video correctly linked to ${info.video.video_id}.`;
        tone = 'match';
      } else {
        status = `This ADT video is linked to ${info.video.video_id}, not the currently selected page.`;
        tone = 'warning';
      }
    }
    el['alignment-status'].textContent = status;
    el['alignment-status'].className = tone;

    const facts = info ? mediaFacts(info.media) : null;
    const displayedDuration = info?.type === 'incoming'
      ? effectiveClipDuration(info.clip, facts?.duration) ?? facts?.duration
      : facts?.duration;
    el['alignment-duration'].textContent = displayedDuration == null ? '—' : formatDuration(displayedDuration);
    el['alignment-size'].textContent = facts?.size == null ? '—' : formatBytes(facts.size);
    el['alignment-dimensions'].textContent = facts?.videoStream.width && facts?.videoStream.height
      ? `${facts.videoStream.width} × ${facts.videoStream.height}`
      : '—';
    el['alignment-audio'].textContent = facts?.hasAudio === true ? 'Yes' : facts?.hasAudio === false ? 'No' : 'Unknown';
  }

  function clearVideo(title, help) {
    state.previewContext = null;
    el['current-media-info'].disabled = true;
    el['video-preview'].pause();
    el['video-preview'].removeAttribute('src');
    el['video-preview'].load();
    el['video-preview'].hidden = true;
    el['video-empty'].querySelector('strong').textContent = title;
    el['video-empty'].querySelector('p').textContent = help;
    el['video-empty'].hidden = false;
    el['video-preview-title'].textContent = 'Video preview';
    el['video-duration'].textContent = '—';
    setVideoOrigin(null);
    refreshAlignmentPanel();
  }

  function duplicateSelectedClip() {
    saveEditorToClip();
    const clip = selectedClip();
    if (!clip) return;
    const duplicates = state.clips.filter((row) => row.staging_id === clip.staging_id).length + 1;
    const duplicate = {
      ...clip,
      id: localId(),
      section_id: '',
      transcript: '',
      original_name: `${clip.original_name} · segment ${duplicates}`,
    };
    state.clips.push(duplicate);
    state.selectedClipId = duplicate.id;
    state.selectionType = 'incoming';
    renderVideoLibrary();
    selectClip(duplicate.id, { followPage: false });
    toast('Segment duplicated. Set new trim points and choose another page.');
  }

  async function removeSelectedClip() {
    const clip = selectedClip();
    if (!clip) return;
    const remainingForSource = state.clips.filter((row) => row.staging_id === clip.staging_id && row.id !== clip.id);
    state.clips = state.clips.filter((row) => row.id !== clip.id);
    if (!remainingForSource.length) {
      try {
        await api('/api/remove-staged', { method: 'POST', body: JSON.stringify({ staging_id: clip.staging_id }) });
        state.stagedById.delete(clip.staging_id);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    state.selectedClipId = state.clips[0]?.id || null;
    state.selectionType = state.selectedClipId ? 'incoming' : null;
    renderVideoLibrary();
    renderPages();
    if (state.selectedClipId) selectClip(state.selectedClipId, { followPage: false });
    else {
      el['clip-editor'].hidden = true;
      const page = state.pages.find((row) => row.position === state.selectedPagePosition);
      if (page) showExistingVideo(page);
    }
    updateButtons();
  }

  function assignSelectedClipToCurrentPage() {
    const clip = selectedClip();
    const page = state.pages.find((row) => row.position === state.selectedPagePosition);
    if (!clip || !page) return;
    clip.section_id = page.section_id;
    el['section-select'].value = page.section_id;
    showIncomingVideo(clip);
    renderVideoLibrary();
    renderPages();
    updateButtons();
    toast(`Assigned ${clip.original_name} to ${page.video_id}.`);
  }

  async function uploadFiles(fileList) {
    const files = [...fileList].filter((file) => videoExtensions.has(file.name.split('.').pop().toLowerCase()));
    if (!files.length) {
      toast('No supported video files were selected.', 'error');
      return;
    }
    setBusy(true);
    el['upload-progress'].hidden = false;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        el['upload-label'].textContent = `Uploading ${file.name} (${index + 1} of ${files.length})`;
        const row = await uploadOne(file, (fraction) => {
          const overall = ((index + fraction) / files.length) * 100;
          el['upload-meter'].value = overall;
          el['upload-percent'].textContent = `${Math.round(overall)}%`;
        });
        state.stagedById.set(row.id, row);
        const clip = makeClip(row);
        state.clips.push(clip);
        state.selectedClipId = clip.id;
        state.selectionType = 'incoming';
      }
      renderVideoLibrary();
      renderPages();
      selectClip(state.selectedClipId);
      toast(`${files.length} video${files.length === 1 ? '' : 's'} added to the import queue.`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
      el['upload-progress'].hidden = true;
      el['upload-meter'].value = 0;
      el['video-files'].value = '';
      el['video-folder'].value = '';
    }
  }

  function uploadOne(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try { payload = JSON.parse(xhr.responseText); } catch (_) { /* handled below */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(new Error(payload.error || `Upload failed (${xhr.status})`));
      });
      xhr.addEventListener('error', () => reject(new Error(`Could not upload ${file.name}`)));
      xhr.send(file);
    });
  }

  async function importClips(clips) {
    saveEditorToClip();
    if (!clips.length) return;
    const invalid = clips.find((clip) => !state.pages.some((page) => page.section_id === clip.section_id));
    if (invalid) {
      toast(`Choose an ADT page for ${invalid.original_name}.`, 'error');
      selectClip(invalid.id, { followPage: false });
      el['section-select'].focus();
      return;
    }
    const sectionIds = clips.map((clip) => clip.section_id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      toast('Two clips are assigned to the same page. Each page can have one sign-language video.', 'error');
      return;
    }
    const badTrim = clips.find((clip) => clip.start != null && clip.end != null && clip.end <= clip.start);
    if (badTrim) {
      toast(`The trim end must be after the start for ${badTrim.original_name}.`, 'error');
      selectClip(badTrim.id, { followPage: false });
      return;
    }
    const languages = [...el['language-options'].querySelectorAll('input:checked')].map((input) => input.value);
    if (!languages.length) {
      toast('Choose at least one ADT language destination.', 'error');
      return;
    }
    const replacements = clips.filter((clip) => {
      const page = state.pages.find((row) => row.section_id === clip.section_id);
      return page && languages.some((language) => page.existing[language]);
    });
    let replace = false;
    if (replacements.length) {
      replace = window.confirm(
        `${replacements.length} selected page${replacements.length === 1 ? ' already has' : 's already have'} a video. Replace the existing mapping${replacements.length === 1 ? '' : 's'}?`,
      );
      if (!replace) return;
    }
    const audio = document.querySelector('input[name="audio"]:checked').value;
    const payload = {
      jobs: clips.map((clip) => ({
        staging_id: clip.staging_id,
        section_id: clip.section_id,
        start: clip.start,
        end: clip.end,
        transcript: clip.transcript,
        transcript_language: clip.transcript_language,
      })),
      languages,
      preset: el['compression-preset'].value,
      audio,
      replace,
    };
    setBusy(true);
    try {
      const result = await api('/api/import', { method: 'POST', body: JSON.stringify(payload) });
      const importedIds = new Set(clips.map((clip) => clip.id));
      const potentiallyUnusedSources = new Set(clips.map((clip) => clip.staging_id));
      state.clips = state.clips.filter((clip) => !importedIds.has(clip.id));
      for (const stagingId of potentiallyUnusedSources) {
        if (!state.clips.some((clip) => clip.staging_id === stagingId)) {
          await api('/api/remove-staged', { method: 'POST', body: JSON.stringify({ staging_id: stagingId }) }).catch(() => {});
        }
      }
      state.selectedClipId = state.clips[0]?.id || null;
      state.selectionType = state.selectedClipId ? 'incoming' : null;
      await loadProject({ preserveClips: true });
      if (state.selectedClipId) selectClip(state.selectedClipId, { followPage: false });
      else {
        renderVideoLibrary();
        const page = state.pages.find((row) => row.position === state.selectedPagePosition);
        if (page) showExistingVideo(page);
      }
      toast(`${result.imported.length} video${result.imported.length === 1 ? '' : 's'} imported and the ADT cache was refreshed.`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function transcribeSelected() {
    const clip = selectedClip();
    if (!clip) return;
    saveEditorToClip();
    el.transcribe.disabled = true;
    el.transcribe.textContent = 'Transcribing…';
    try {
      const result = await api('/api/transcribe', {
        method: 'POST',
        body: JSON.stringify({
          staging_id: clip.staging_id,
          language: clip.transcript_language,
          model: 'small',
        }),
      });
      clip.transcript = result.text || '';
      clip.transcript_language = result.language || clip.transcript_language;
      el.transcript.value = clip.transcript;
      el['transcript-language'].value = clip.transcript_language;
      toast('Draft voice-over transcript created. Please review it before importing.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      el.transcribe.disabled = !state.project.capabilities.whisper;
      el.transcribe.textContent = state.project.capabilities.whisper ? 'Transcribe audio' : 'Whisper not installed';
    }
  }

  function setBusy(value) {
    state.busy = value;
    document.body.setAttribute('aria-busy', String(value));
    updateButtons();
  }

  function updateButtons() {
    const clip = selectedClip();
    el['import-selected'].disabled = state.busy || !clip || !clip.section_id;
    el['import-all'].disabled = state.busy || !state.clips.length || state.clips.some((row) => !row.section_id);
    el['assign-current-page'].disabled = state.busy || !clip || state.selectedPagePosition == null;
    el['duplicate-clip'].disabled = state.busy || !clip;
    el['remove-clip'].disabled = state.busy || !clip;
  }

  function numberOrNull(value) {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = String(total % 60).padStart(2, '0');
    return `${minutes}:${remainder}`;
  }

  function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  function toast(message, tone = '') {
    const node = document.createElement('div');
    node.className = `toast ${tone}`.trim();
    node.textContent = message;
    el['toast-region'].append(node);
    window.setTimeout(() => node.remove(), tone === 'error' ? 6500 : 4200);
  }

  el['page-search'].addEventListener('input', renderPages);
  el['current-media-info'].addEventListener('click', () => {
    const info = currentPreviewInfo();
    if (info) showMediaInfo(info);
  });
  el['media-info-close'].addEventListener('click', () => el['media-info-dialog'].close());
  el['media-info-dialog'].addEventListener('click', (event) => {
    if (event.target === el['media-info-dialog']) el['media-info-dialog'].close();
  });
  el['page-map-filters'].addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page-filter]');
    if (!button) return;
    state.pageFilter = button.dataset.pageFilter;
    renderPages();
  });
  el['library-filters'].addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.libraryFilter = button.dataset.filter;
    if (state.libraryFilter === 'incoming' && state.clips.length && state.selectionType !== 'incoming') {
      selectClip(state.clips[0].id, { followPage: false });
    } else if (state.libraryFilter === 'adt' && state.adtVideos.length && state.selectionType !== 'adt') {
      selectExistingVideo(state.adtVideos[0].id);
    } else {
      renderVideoLibrary();
    }
  });
  el['video-files'].addEventListener('change', (event) => uploadFiles(event.target.files));
  el['video-folder'].addEventListener('change', (event) => uploadFiles(event.target.files));
  el['assign-current-page'].addEventListener('click', assignSelectedClipToCurrentPage);
  el['duplicate-clip'].addEventListener('click', duplicateSelectedClip);
  el['remove-clip'].addEventListener('click', removeSelectedClip);
  el['section-select'].addEventListener('change', () => {
    const clip = selectedClip();
    if (!clip) return;
    clip.section_id = el['section-select'].value;
    const page = state.pages.find((row) => row.section_id === clip.section_id);
    showIncomingVideo(clip);
    renderVideoLibrary();
    renderPages();
    updateButtons();
    if (page) selectPage(page.position);
  });
  ['trim-start', 'trim-end', 'transcript', 'transcript-language'].forEach((id) => {
    el[id].addEventListener('input', saveEditorToClip);
  });
  el['mark-start'].addEventListener('click', () => {
    const time = el['video-preview'].currentTime;
    if (Number.isFinite(time)) {
      el['trim-start'].value = time.toFixed(2);
      saveEditorToClip();
    }
  });
  el['mark-end'].addEventListener('click', () => {
    const time = el['video-preview'].currentTime;
    if (Number.isFinite(time)) {
      el['trim-end'].value = time.toFixed(2);
      saveEditorToClip();
    }
  });
  el['video-preview'].addEventListener('loadedmetadata', () => {
    el['video-duration'].textContent = formatDuration(el['video-preview'].duration);
    resetReviewScroll();
  });
  el['adt-frame'].addEventListener('load', () => {
    resetReviewScroll();
  });
  el.transcribe.addEventListener('click', transcribeSelected);
  el['import-selected'].addEventListener('click', () => {
    saveEditorToClip();
    const clip = selectedClip();
    if (clip) importClips([clip]);
  });
  el['import-all'].addEventListener('click', () => {
    saveEditorToClip();
    importClips([...state.clips]);
  });

  loadProject().catch((error) => {
    el['project-title'].textContent = 'Could not load this ADT';
    el['project-path'].textContent = error.message;
    toast(error.message, 'error');
  });
})();
