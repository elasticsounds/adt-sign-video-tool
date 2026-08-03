const $ = (selector) => document.querySelector(selector);
const els = {
  home: $('#home-view'), workspace: $('#workspace-view'), projectHeading: $('#project-heading'),
  headerActions: $('#header-actions'), projectTitle: $('#project-title'), projectLocation: $('#project-location'),
  openFolder: $('#open-local-folder'), fallback: $('#folder-fallback'), compatibility: $('#compatibility-note'),
  pageCount: $('#page-count'), pageSummary: $('#page-summary'), pageFilters: $('#page-filters'),
  pageSearch: $('#page-search'), pageList: $('#page-list'), selectedPageTitle: $('#selected-page-title'),
  selectedPageMeta: $('#selected-page-meta'), pagePaper: $('#page-paper'), pageNavTitle: $('#page-nav-title'),
  pagePosition: $('#page-position'), previousPage: $('#previous-page'), nextPage: $('#next-page'),
  mediaCount: $('#media-count'), mediaSummary: $('#media-summary'),
  mediaPanel: $('#media-panel'), mediaFilters: $('#media-filters'), incomingMediaList: $('#incoming-media-list'),
  existingMediaList: $('#existing-media-list'), mediaEmpty: $('#media-empty'), optimizerPanel: $('#optimizer-panel'), videoPlayer: $('#video-player'),
  videoEmpty: $('#video-empty'), videoEmptyText: $('#video-empty-text'), previewStatus: $('#preview-status'), previewName: $('#preview-name'),
  previewDuration: $('#preview-duration'), addVideos: $('#add-videos'), addVideoFolder: $('#add-video-folder'),
  engineState: $('#engine-state'), optimizeSelected: $('#optimize-selected'), optimizeAll: $('#optimize-all'),
  batchProgress: $('#batch-progress'), batchProgressTitle: $('#batch-progress-title'),
  batchProgressValue: $('#batch-progress-value'), batchProgressBar: $('#batch-progress-bar'),
  batchProgressDetail: $('#batch-progress-detail'),
  editorName: $('#editor-name'), assignmentSelect: $('#assignment-select'), assignmentAction: $('#assignment-action'),
  assignmentContext: $('#assignment-context'), assignmentSummary: $('#assignment-summary'), editorHelp: $('#editor-help'),
  removeIncoming: $('#remove-incoming'), languageOptions: $('#language-options'),
  saveProject: $('#save-project'), downloadProject: $('#download-project'), changeProject: $('#change-project'),
  brandHome: $('#brand-home'), infoDialog: $('#media-info-dialog'), infoTitle: $('#info-title'),
  mediaInfo: $('#media-info'), busy: $('#busy-overlay'), busyTitle: $('#busy-title'),
  busyDetail: $('#busy-detail'), toastRegion: $('#toast-region')
};

const state = {
  mode: null,
  rootHandle: null,
  rootName: '',
  files: new Map(),
  overrides: new Map(),
  config: {},
  pages: [],
  languages: [],
  selectedLanguages: new Set(),
  manifests: new Map(),
  texts: {},
  importMetadata: { version: 1, videos: {} },
  existing: [],
  incoming: [],
  selectedPageId: '',
  selectedMediaId: '',
  pageFilter: 'all',
  mediaFilter: 'all',
  openMediaGroups: new Set(['incoming', 'existing']),
  pageImageUrl: '',
  previewUrl: '',
  previewToken: 0,
  audioMode: 'keep',
  optimizing: false,
  batchProgress: null,
  dirty: false
};

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);
const VIDEO_INPUT_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let optimizerEngine = null;
let optimizerLoadPromise = null;
let activeOptimization = null;
let optimizerRenderPending = false;
let optimizerLastLog = '';
let optimizerLoadError = '';

function normalizePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[character]);
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function fileExtension(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function formatDate(timestamp) {
  if (!timestamp) return 'Not recorded';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)); }
  catch { return String(timestamp); }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function setBusy(visible, title = 'Working…', detail = '') {
  els.busy.classList.toggle('hidden', !visible);
  els.busyTitle.textContent = title;
  els.busyDetail.textContent = detail;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = message;
  els.toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
}

function setDirty(value = true) {
  state.dirty = value;
  document.title = `${value ? '• ' : ''}${state.config.title || 'ADT Sign Video Tool'} — ADT Sign Video Tool`;
}

function currentPage() {
  return state.pages.find((page) => page.sectionId === state.selectedPageId) || state.pages[0] || null;
}

function currentMedia() {
  return [...state.incoming, ...state.existing].find((media) => media.id === state.selectedMediaId) || null;
}

function listProjectPaths() {
  return [...new Set([...state.files.keys(), ...state.overrides.keys()])].sort(naturalCompare);
}

async function getProjectBlob(path) {
  const normalized = normalizePath(path);
  if (state.overrides.has(normalized)) return state.overrides.get(normalized);
  const entry = state.files.get(normalized);
  if (!entry) throw new Error(`Project file is missing: ${normalized}`);
  if (entry.file) return entry.file;
  return entry.handle.getFile();
}

async function getProjectText(path, optional = false) {
  try { return await (await getProjectBlob(path)).text(); }
  catch (error) {
    if (optional) return '';
    throw error;
  }
}

async function getProjectJson(path, fallback) {
  const text = await getProjectText(path, fallback !== undefined);
  if (!text && fallback !== undefined) return structuredClone(fallback);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON in ${path}: ${error.message}`); }
}

function setOverride(path, value, type = 'application/octet-stream') {
  const normalized = normalizePath(path);
  const blob = value instanceof Blob ? value : new Blob([value], { type });
  state.overrides.set(normalized, blob);
  setDirty(true);
}

async function isAdtDirectory(handle) {
  try {
    const content = await handle.getDirectoryHandle('content');
    await content.getFileHandle('pages.json');
    const assets = await handle.getDirectoryHandle('assets');
    await assets.getFileHandle('config.json');
    return true;
  } catch { return false; }
}

async function locateAdtDirectory(selected) {
  if (await isAdtDirectory(selected)) return selected;
  const matches = [];
  for await (const [, child] of selected.entries()) {
    if (child.kind !== 'directory') continue;
    if (await isAdtDirectory(child)) matches.push(child);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('More than one ADT was found. Choose the ADT folder itself.');
  throw new Error('This is not an exported ADT. Choose a folder containing content/pages.json and assets/config.json.');
}

async function indexDirectory(handle, prefix = '') {
  for await (const [name, entry] of handle.entries()) {
    const path = normalizePath(`${prefix}/${name}`);
    if (entry.kind === 'directory') await indexDirectory(entry, path);
    else state.files.set(path, { handle: entry });
  }
}

async function openDirectFolder() {
  if (!window.showDirectoryPicker) {
    els.fallback.click();
    return;
  }
  try {
    const selected = await window.showDirectoryPicker({ mode: 'readwrite', id: 'adt-sign-video-project' });
    setBusy(true, 'Opening ADT…', 'Checking the selected folder');
    const root = await locateAdtDirectory(selected);
    resetProjectState();
    state.mode = 'direct';
    state.rootHandle = root;
    state.rootName = root.name;
    els.busyDetail.textContent = 'Indexing local project files';
    await indexDirectory(root);
    await loadProject();
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  } finally { setBusy(false); }
}

function commonAdtPrefix(files) {
  const candidates = [];
  for (const file of files) {
    const path = normalizePath(file.webkitRelativePath || file.name);
    if (path.endsWith('content/pages.json')) {
      const prefix = path.slice(0, -'content/pages.json'.length);
      const hasConfig = files.some((other) => normalizePath(other.webkitRelativePath || other.name) === `${prefix}assets/config.json`);
      if (hasConfig) candidates.push(prefix);
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) throw new Error('More than one ADT was found. Choose the ADT folder itself.');
  throw new Error('This is not an exported ADT. Choose a folder containing content/pages.json and assets/config.json.');
}

async function openFallbackFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try {
    setBusy(true, 'Opening ADT…', 'Reading the selected folder');
    const prefix = commonAdtPrefix(files);
    resetProjectState();
    state.mode = 'memory';
    state.rootName = prefix.replace(/\/$/, '').split('/').pop() || 'ADT project';
    for (const file of files) {
      const original = normalizePath(file.webkitRelativePath || file.name);
      if (!original.startsWith(prefix)) continue;
      const path = normalizePath(original.slice(prefix.length));
      if (path) state.files.set(path, { file });
    }
    await loadProject();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(false); els.fallback.value = ''; }
}

function resetProjectState() {
  if (state.pageImageUrl) URL.revokeObjectURL(state.pageImageUrl);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  Object.assign(state, {
    mode: null, rootHandle: null, rootName: '', files: new Map(), overrides: new Map(),
    config: {}, pages: [], languages: [], selectedLanguages: new Set(), manifests: new Map(),
    texts: {}, importMetadata: { version: 1, videos: {} }, existing: [], incoming: [],
    selectedPageId: '', selectedMediaId: '', pageFilter: 'all', mediaFilter: 'all',
    openMediaGroups: new Set(['incoming', 'existing']),
    pageImageUrl: '', previewUrl: '', previewToken: 0, audioMode: 'keep', optimizing: false,
    batchProgress: null, dirty: false
  });
  for (const input of document.querySelectorAll('input[name="optimize-audio"]')) input.checked = input.value === 'keep';
}

async function loadProject() {
  const config = await getProjectJson('assets/config.json');
  const rawPages = await getProjectJson('content/pages.json');
  const toc = await getProjectJson('content/toc.json', []);
  if (!Array.isArray(rawPages) || !rawPages.length) throw new Error('content/pages.json contains no pages.');
  const titleBySection = new Map(Array.isArray(toc) ? toc.map((row) => [String(row.section_id), String(row.title || '')]) : []);
  state.config = config;
  state.languages = [...new Set([
    ...((config.languages && Array.isArray(config.languages.available)) ? config.languages.available.map(String) : []),
    ...listProjectPaths().map((path) => path.match(/^content\/i18n\/([^/]+)\//)?.[1]).filter(Boolean)
  ])];
  if (!state.languages.length) throw new Error('No ADT language folders were found.');
  state.selectedLanguages = new Set(state.languages);
  const defaultLanguage = state.languages.includes(config.languages?.default) ? config.languages.default : state.languages[0];
  state.texts = await getProjectJson(`content/i18n/${defaultLanguage}/texts.json`, {});
  state.pages = rawPages.map((row, index) => ({
    position: index + 1,
    sectionId: String(row.section_id || ''),
    href: String(row.href || ''),
    pageNumber: Number.isInteger(row.page_number) ? row.page_number : null,
    title: titleBySection.get(String(row.section_id)) || String(row.title || row.section_id || `Page ${index + 1}`)
  }));
  state.manifests = new Map();
  for (const language of state.languages) {
    const manifest = await getProjectJson(`content/i18n/${language}/videos.json`, {});
    state.manifests.set(language, manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {});
  }
  state.importMetadata = await getProjectJson('content/video-import-metadata.json', { version: 1, videos: {} });
  if (!state.importMetadata || typeof state.importMetadata !== 'object') state.importMetadata = { version: 1, videos: {} };
  if (!state.importMetadata.videos || typeof state.importMetadata.videos !== 'object') state.importMetadata.videos = {};
  await rebuildExistingMedia();
  state.selectedPageId = state.selectedPageId && state.pages.some((page) => page.sectionId === state.selectedPageId)
    ? state.selectedPageId : state.pages[0].sectionId;
  showWorkspace();
  renderAll();
  setDirty(state.overrides.size > 0);
}

async function rebuildExistingMedia() {
  const byFilename = new Map();
  const defaultLanguage = state.languages.includes(state.config.languages?.default) ? state.config.languages.default : state.languages[0];
  for (const language of state.languages) {
    const manifest = state.manifests.get(language) || {};
    for (const [videoId, filename] of Object.entries(manifest)) {
      const position = Number(String(videoId).match(/(\d+)$/)?.[1]);
      const page = state.pages[position - 1] || null;
      const key = String(filename);
      if (!byFilename.has(key)) byFilename.set(key, { filename: key, languages: new Set(), pages: new Set(), ids: new Set() });
      const row = byFilename.get(key);
      row.languages.add(language);
      if (page) row.pages.add(page.sectionId);
      row.ids.add(videoId);
    }
  }
  for (const path of listProjectPaths()) {
    const match = path.match(/^content\/i18n\/([^/]+)\/video\/([^/]+)$/);
    if (!match || !VIDEO_EXTENSIONS.has(fileExtension(match[2]))) continue;
    const [, language, filename] = match;
    if (!byFilename.has(filename)) byFilename.set(filename, { filename, languages: new Set(), pages: new Set(), ids: new Set() });
    byFilename.get(filename).languages.add(language);
  }
  const rows = [];
  let index = 0;
  for (const data of [...byFilename.values()].sort((a, b) => naturalCompare(a.filename, b.filename))) {
    index += 1;
    const preferred = data.languages.has(defaultLanguage) ? defaultLanguage : [...data.languages][0];
    const path = `content/i18n/${preferred}/video/${data.filename}`;
    let file = null;
    try { file = await getProjectBlob(path); } catch { /* Manifest can refer to a missing file. */ }
    const firstVideoId = [...data.ids].sort(naturalCompare)[0] || '';
    const importRow = state.importMetadata.videos[firstVideoId] || {};
    const pageIds = [...data.pages];
    const media = {
      id: `existing:${data.filename}:${index}`,
      kind: 'existing', filename: data.filename, path, file,
      pageId: pageIds[0] || '', pageIds, languages: [...data.languages], videoId: firstVideoId,
      size: file?.size ?? null, modified: file?.lastModified ?? null,
      importedAt: importRow.imported_at || '', sourceName: importRow.source_name || '',
      preset: importRow.preset || '', audioMode: importRow.audio_mode || '', metadata: null,
      missing: !file
    };
    rows.push(media);
    if (file) probeMedia(media).then(() => renderMediaList()).catch(() => {});
  }
  state.existing = rows;
}

function showWorkspace() {
  els.home.classList.add('hidden');
  els.workspace.classList.remove('hidden');
  els.projectHeading.classList.remove('hidden');
  els.headerActions.classList.remove('hidden');
  els.projectTitle.textContent = state.config.title || state.rootName || 'Untitled ADT';
  els.projectLocation.textContent = state.mode === 'direct' ? `${state.rootName} · direct folder access` : `${state.rootName} · compatible mode`;
  els.saveProject.disabled = state.mode !== 'direct';
  els.saveProject.title = state.mode === 'direct' ? 'Write changes to the connected folder' : 'Direct save requires Chrome or Edge folder access; use Download ADT ZIP.';
}

function goHome() {
  if (state.dirty && !confirm('Leave this project? Unsaved in-browser changes will be discarded.')) return;
  resetProjectState();
  els.home.classList.remove('hidden');
  els.workspace.classList.add('hidden');
  els.projectHeading.classList.add('hidden');
  els.headerActions.classList.add('hidden');
  document.title = 'ADT Sign Video Tool';
}

function pageStatus(page) {
  const incoming = state.incoming.find((video) => video.pageId === page.sectionId);
  if (incoming) return { type: 'incoming', label: 'Incoming', filename: incoming.filename };
  const existing = state.existing.find((video) => video.pageIds.includes(page.sectionId));
  if (existing) return { type: 'linked', label: 'In ADT', filename: existing.filename };
  return { type: 'missing', label: 'No video', filename: 'Nothing attached' };
}

function renderAll() {
  renderPageList();
  renderSelectedPage();
  renderMediaList();
  renderEditor();
  renderLanguageOptions();
  renderOptimizer();
}

function renderPageList() {
  const linked = state.pages.filter((page) => pageStatus(page).type === 'linked').length;
  const incoming = state.pages.filter((page) => pageStatus(page).type === 'incoming').length;
  const missing = state.pages.length - linked - incoming;
  els.pageCount.textContent = state.pages.length;
  els.pageSummary.textContent = `${linked} linked in ADT · ${incoming} incoming · ${missing} without video`;
  const query = els.pageSearch.value.trim().toLowerCase();
  const rows = state.pages.filter((page) => {
    const status = pageStatus(page);
    const filterMatches = state.pageFilter === 'all'
      || (state.pageFilter === 'linked' && status.type === 'linked')
      || (state.pageFilter === 'incoming' && status.type === 'incoming')
      || (state.pageFilter === 'missing' && status.type === 'missing');
    const searchMatches = !query || `${page.title} ${page.sectionId} ${status.filename}`.toLowerCase().includes(query);
    return filterMatches && searchMatches;
  });
  els.pageList.innerHTML = rows.map((page) => {
    const status = pageStatus(page);
    const printPage = page.pageNumber === null ? '' : ` · print p. ${page.pageNumber}`;
    return `<button class="page-row ${page.sectionId === state.selectedPageId ? 'active' : ''}" data-page-id="${escapeHtml(page.sectionId)}">
      <span class="page-number">${page.position}</span>
      <span class="page-row-main"><strong>${escapeHtml(page.title)}</strong><small>${escapeHtml(page.sectionId)}${printPage}</small>
      <span class="page-row-status"><span class="status-chip ${status.type}">${status.label}</span><span>${escapeHtml(status.filename)}</span></span></span>
    </button>`;
  }).join('') || '<p class="panel-summary">No pages match this filter.</p>';
}

async function renderSelectedPage() {
  const page = currentPage();
  if (!page) return;
  els.selectedPageTitle.textContent = page.title;
  els.selectedPageMeta.textContent = `video-${page.position} · ${page.sectionId}${page.pageNumber === null ? '' : ` · print page ${page.pageNumber}`}`;
  els.pageNavTitle.textContent = page.title;
  els.pagePosition.textContent = `${page.position}/${state.pages.length}`;
  els.previousPage.disabled = page.position === 1;
  els.nextPage.disabled = page.position === state.pages.length;
  if (state.pageImageUrl) { URL.revokeObjectURL(state.pageImageUrl); state.pageImageUrl = ''; }
  const token = ++state.previewToken;
  els.pagePaper.innerHTML = '<div class="page-copy"><h2>Loading page…</h2></div>';
  try {
    const html = await getProjectText(page.href);
    const documentNode = new DOMParser().parseFromString(html, 'text/html');
    const blocks = [];
    const seen = new Set();
    for (const node of documentNode.querySelectorAll('h1, h2, h3, h4, p, figcaption')) {
      const pieces = [];
      for (const translatable of node.querySelectorAll('[data-id]')) {
        const id = translatable.dataset.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const value = state.texts[id] ?? translatable.textContent;
        if (String(value).trim()) pieces.push(String(value).trim());
      }
      if (node.dataset.id && !seen.has(node.dataset.id)) {
        seen.add(node.dataset.id);
        const value = state.texts[node.dataset.id] ?? node.textContent;
        if (String(value).trim()) pieces.push(String(value).trim());
      }
      const text = pieces.join(' ');
      if (text) blocks.push({ heading: /^H/.test(node.tagName), text });
    }
    const headingIndex = blocks.findIndex((block) => block.heading);
    const heading = headingIndex >= 0 ? blocks.splice(headingIndex, 1)[0].text : page.title;
    const copy = document.createElement('div');
    copy.className = 'page-copy';
    const title = document.createElement('h2');
    title.textContent = heading;
    copy.append(title);
    for (const block of blocks.slice(0, 14)) {
      const paragraph = document.createElement('p');
      paragraph.textContent = block.text;
      copy.append(paragraph);
    }
    const firstImage = documentNode.querySelector('main img, #content img');
    if (firstImage?.getAttribute('src')) {
      const imagePath = normalizePath(new URL(firstImage.getAttribute('src'), `https://adt.local/${page.href}`).pathname);
      try {
        const imageBlob = await getProjectBlob(imagePath);
        state.pageImageUrl = URL.createObjectURL(imageBlob);
        const image = document.createElement('img');
        image.className = 'page-image';
        image.alt = firstImage.alt || '';
        image.src = state.pageImageUrl;
        copy.append(image);
      } catch { /* Text preview remains useful if an image is missing. */ }
    }
    if (token === state.previewToken) {
      els.pagePaper.replaceChildren(copy);
      els.pagePaper.scrollTop = 0;
    }
  } catch (error) {
    if (token === state.previewToken) els.pagePaper.innerHTML = `<div class="page-copy"><h2>${escapeHtml(page.title)}</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
  const incomingForPage = state.incoming.find((media) => media.pageId === page.sectionId);
  const existingForPage = state.existing.find((media) => media.pageIds.includes(page.sectionId));
  if (incomingForPage && state.selectedMediaId !== incomingForPage.id) selectMedia(incomingForPage.id);
  else if (!currentMedia() && existingForPage) selectMedia(existingForPage.id);
  else if (!incomingForPage && !existingForPage && !currentMedia()) selectMedia('', false);
}

function mediaNeedsOptimization(media) {
  return media?.kind === 'incoming'
    && (!media.optimization || media.optimization.status !== 'done' || media.optimization.audioMode !== state.audioMode);
}

function optimizationSavings(media) {
  const original = media.sourceFile?.size;
  if (!original || !media.file?.size) return null;
  return Math.round((1 - (media.file.size / original)) * 100);
}

function optimizationStatus(media) {
  if (media.kind !== 'incoming') return null;
  const optimization = media.optimization;
  if (optimization?.status === 'optimizing') return { type: 'optimizing', label: `Optimizing ${Math.round(optimization.progress || 0)}%` };
  if (optimization?.status === 'queued') return { type: 'pending', label: 'Queued' };
  if (optimization?.status === 'error') return { type: 'missing', label: 'Optimize failed' };
  if (optimization?.status === 'done' && optimization.audioMode === state.audioMode) return { type: 'optimized', label: 'Optimized' };
  if (optimization?.status === 'done') return { type: 'pending', label: 'Audio changed' };
  return { type: 'pending', label: 'Not optimized' };
}

function renderMediaList() {
  const items = [...state.incoming, ...state.existing];
  const unlinked = state.incoming.filter((item) => !item.pageId).length + state.existing.filter((item) => !item.pageIds.length).length;
  els.mediaCount.textContent = items.length;
  els.mediaSummary.textContent = `${state.existing.length} in ADT · ${state.incoming.length} incoming · ${unlinked} unlinked`;
  const filtered = items.filter((item) => state.mediaFilter === 'all'
    || (state.mediaFilter === 'incoming' && item.kind === 'incoming')
    || (state.mediaFilter === 'existing' && item.kind === 'existing'));
  const renderGroup = (kind, title, rows) => {
    if (!rows.length) return '';
    const content = rows.map((media) => {
      const globalIndex = items.indexOf(media) + 1;
      const pageIds = media.kind === 'incoming' ? (media.pageId ? [media.pageId] : []) : media.pageIds;
      const page = state.pages.find((candidate) => candidate.sectionId === pageIds[0]);
      const linked = pageIds.length > 0;
      const linkLabel = media.kind === 'incoming' && media.assignmentMethod === 'auto' ? 'Auto-assigned' : linked ? 'Linked' : 'Unlinked';
      const assignmentTitle = media.kind === 'incoming' && media.assignmentReason ? ` title="${escapeHtml(media.assignmentReason)}"` : '';
      const facts = [
        media.metadata?.duration ? formatDuration(media.metadata.duration) : 'duration…',
        formatBytes(media.size),
        media.metadata?.width ? `${media.metadata.width}×${media.metadata.height}` : 'dimensions…',
        media.metadata?.audio === true ? 'Audio' : media.metadata?.audio === false ? 'No audio' : 'audio…'
      ];
      const optimizeStatus = optimizationStatus(media);
      let optimizationRow = '';
      if (media.kind === 'incoming' && media.optimization) {
        const progress = Math.max(0, Math.min(100, media.optimization.progress || 0));
        const savings = optimizationSavings(media);
        const detail = media.optimization.status === 'done'
          ? `${formatBytes(media.sourceFile?.size)} → ${formatBytes(media.file?.size)}${savings === null ? '' : ` · ${savings >= 0 ? `${savings}% smaller` : `${Math.abs(savings)}% larger`}`}`
          : media.optimization.status === 'error' ? media.optimization.error || 'Conversion failed'
            : media.optimization.status === 'queued' ? 'Waiting in batch queue' : `${Math.round(progress)}% complete`;
        const audioDetail = media.optimization.audioMode === 'remove' ? 'Audio removed'
          : media.optimization.status === 'done' && media.metadata?.audio === false ? 'Source had no audio' : 'Audio kept';
        optimizationRow = `<span class="media-optimization"><small><span>${escapeHtml(detail)}</span><span>${escapeHtml(audioDetail)}</span></small>${media.optimization.status === 'optimizing' ? `<span class="progress-track"><span style="width:${progress}%"></span></span>` : ''}</span>`;
      }
      return `<div class="media-row ${kind} ${media.id === state.selectedMediaId ? 'active' : ''}" data-media-id="${escapeHtml(media.id)}" tabindex="0">
        <span class="media-index">${globalIndex}</span>
        <span class="media-main"><strong>${escapeHtml(media.filename)}</strong><small>${linked ? escapeHtml(`${page?.title || pageIds[0]}${pageIds.length > 1 ? ` +${pageIds.length - 1}` : ''}`) : 'Not linked to a page'}</small>
        <span class="media-facts">${facts.map((fact) => `<span>• ${escapeHtml(fact)}</span>`).join('')}</span>
        <span class="status-chip ${linked ? 'linked' : 'unlinked'}"${assignmentTitle}>${linkLabel}</span>${optimizeStatus ? ` <span class="status-chip ${optimizeStatus.type}">${optimizeStatus.label}</span>` : ''}</span>
        <button class="info-button" data-info-id="${escapeHtml(media.id)}" title="Media information" aria-label="Media information for ${escapeHtml(media.filename)}">i</button>
        ${optimizationRow}
      </div>`;
    }).join('');
    const open = state.openMediaGroups.has(kind) ? ' open' : '';
    return `<details class="media-group" data-media-group="${kind}"${open}><summary class="media-group-title"><span>${title} (${rows.length})</span><span class="disclosure" aria-hidden="true">⌄</span></summary><div class="media-group-content">${content}</div></details>`;
  };
  const incomingRows = filtered.filter((item) => item.kind === 'incoming');
  const existingRows = filtered.filter((item) => item.kind === 'existing');
  els.incomingMediaList.innerHTML = renderGroup('incoming', 'Incoming to import', incomingRows);
  els.existingMediaList.innerHTML = renderGroup('existing', 'Existing in ADT', existingRows);
  els.mediaEmpty.classList.toggle('hidden', Boolean(incomingRows.length || existingRows.length));
  els.optimizerPanel.classList.toggle('hidden', state.mediaFilter === 'existing' || !state.incoming.length);
}

function updateAssignmentAction() {
  const media = currentMedia();
  const editable = media?.kind === 'incoming';
  const targetId = els.assignmentSelect.value;
  els.assignmentAction.disabled = !editable || state.optimizing || targetId === (media?.pageId || '');
  if (!editable) {
    els.assignmentAction.textContent = media ? 'Existing ADT video is read-only' : 'Select an incoming video';
  } else if (!targetId) {
    els.assignmentAction.textContent = media.pageId ? 'Remove page assignment' : 'Leave video unassigned';
  } else if (targetId === media.pageId) {
    els.assignmentAction.textContent = 'Selected video assigned to page';
  } else {
    els.assignmentAction.textContent = 'Assign selected video to page';
  }
}

function renderEditor() {
  const media = currentMedia();
  const page = currentPage();
  const editable = media?.kind === 'incoming';
  const targetId = editable
    ? (media.assignmentTarget !== undefined ? media.assignmentTarget : (media.pageId || page?.sectionId || ''))
    : '';
  els.editorName.textContent = media?.filename || 'No video selected';
  els.removeIncoming.classList.toggle('hidden', !editable);
  els.removeIncoming.disabled = state.optimizing;
  els.assignmentSelect.disabled = !editable;
  els.assignmentContext.textContent = page
    ? `Selected on the left: ${page.position}. ${page.title} · ${page.sectionId}`
    : 'Select a page on the left, then choose an incoming video.';
  els.assignmentSelect.innerHTML = '<option value="">Leave unassigned</option>' + state.pages.map((candidate) => {
    const print = candidate.pageNumber === null ? '' : ` · print p. ${candidate.pageNumber}`;
    return `<option value="${escapeHtml(candidate.sectionId)}" ${targetId === candidate.sectionId ? 'selected' : ''}>${candidate.position}. ${escapeHtml(candidate.title)}${print}</option>`;
  }).join('');
  if (editable && media.pageId) {
    els.editorHelp.textContent = media.assignmentMethod === 'auto'
      ? `Automatically matched using ${media.assignmentReason || 'the video filename'}. Choose another page above if the match is wrong.`
      : 'This page assignment is staged. Choose another page above if it needs to change.';
  } else if (editable) {
    els.editorHelp.textContent = 'The page selected on the left is preselected. Confirm the assignment with the button above.';
  } else {
    els.editorHelp.textContent = media
      ? 'Existing ADT media is read-only here. Select an incoming video to replace or add a page video.'
      : 'Select an incoming video from the browser above.';
  }
  const assigned = state.incoming.filter((item) => item.pageId);
  const pendingOptimization = assigned.filter(mediaNeedsOptimization).length;
  els.assignmentSummary.textContent = assigned.length
    ? `${assigned.length} video assignment${assigned.length === 1 ? '' : 's'} staged${pendingOptimization ? ` · ${pendingOptimization} still need optimization` : ''}. Save to folder or Download ADT ZIP when ready.`
    : 'No staged video assignments. Save and Download automatically include every staged assignment.';
  updateAssignmentAction();
  renderOptimizer();
}

function renderOptimizer() {
  const selected = currentMedia();
  const candidates = state.incoming.filter(mediaNeedsOptimization);
  const selectedCanOptimize = selected?.kind === 'incoming' && mediaNeedsOptimization(selected);
  els.optimizeSelected.disabled = state.optimizing || !selectedCanOptimize;
  els.optimizeAll.disabled = state.optimizing || !candidates.length;
  els.optimizeSelected.textContent = selected?.kind === 'incoming' && selected.optimization?.status === 'done'
    && selected.optimization.audioMode !== state.audioMode ? 'Re-optimize selected' : 'Optimize selected';
  els.optimizeAll.textContent = candidates.length ? `Optimize all incoming (${candidates.length})` : 'All incoming optimized';
  for (const input of document.querySelectorAll('input[name="optimize-audio"]')) input.disabled = state.optimizing;
  const engineClass = optimizerEngine?.loaded ? 'ready' : optimizerLoadPromise ? 'loading' : optimizerLoadError ? 'error' : '';
  els.engineState.className = `engine-state ${engineClass}`.trim();
  els.engineState.textContent = optimizerEngine?.loaded ? 'Optimizer ready' : optimizerLoadPromise ? 'Loading engine…' : optimizerLoadError ? 'Load failed' : 'Loads when needed';
  const progress = state.batchProgress;
  els.batchProgress.classList.toggle('hidden', !progress);
  if (progress) {
    const value = Math.max(0, Math.min(100, progress.percent || 0));
    els.batchProgressTitle.textContent = progress.title;
    els.batchProgressValue.textContent = `${Math.round(value)}%`;
    els.batchProgressBar.style.width = `${value}%`;
    els.batchProgressDetail.textContent = progress.detail;
  }
}

function renderLanguageOptions() {
  els.languageOptions.innerHTML = state.languages.map((language) => `<label><input type="checkbox" value="${escapeHtml(language)}" ${state.selectedLanguages.has(language) ? 'checked' : ''}>${escapeHtml(language)}</label>`).join('');
}

async function selectMedia(id, rerender = true) {
  state.selectedMediaId = id;
  const media = currentMedia();
  if (media) state.openMediaGroups.add(media.kind);
  if (rerender) { renderMediaList(); renderEditor(); }
  if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = ''; }
  els.videoPlayer.pause();
  els.videoPlayer.removeAttribute('src');
  els.videoPlayer.load();
  if (!media || media.missing || !media.file) {
    els.videoPlayer.classList.remove('ready');
    els.videoEmpty.classList.remove('hidden');
    els.previewStatus.className = 'status-chip missing';
    els.previewStatus.textContent = media?.missing ? 'Missing file' : 'No video';
    const page = currentPage();
    els.previewName.textContent = media?.filename || (page ? 'No video attached' : 'Choose a video below');
    els.videoEmptyText.textContent = media?.missing
      ? 'The ADT references this video, but the file could not be found.'
      : page ? `No video is attached to ${page.title}. Select an incoming video below to preview it.`
        : 'Select an existing or incoming video to preview it.';
    els.previewDuration.textContent = '—';
    return;
  }
  state.previewUrl = URL.createObjectURL(media.file);
  els.videoPlayer.src = state.previewUrl;
  els.videoPlayer.classList.add('ready');
  els.videoEmpty.classList.add('hidden');
  els.previewStatus.className = `status-chip ${media.kind === 'incoming' ? 'incoming' : 'existing'}`;
  els.previewStatus.textContent = media.kind === 'incoming' ? 'Incoming' : 'In ADT';
  els.previewName.textContent = media.filename;
  els.previewDuration.textContent = media.metadata?.duration ? formatDuration(media.metadata.duration) : '…';
  await probeMedia(media);
  els.previewDuration.textContent = formatDuration(media.metadata?.duration);
  renderMediaList();
}

async function probeMedia(media) {
  if (media.metadata || !media.file) return media.metadata;
  if (media.probePromise) return media.probePromise;
  media.probePromise = (async () => {
    const url = URL.createObjectURL(media.file);
    let dimensions = {};
    try {
      dimensions = await new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const timeout = setTimeout(() => reject(new Error('Video metadata timed out')), 12000);
        video.preload = 'metadata';
        video.onloadedmetadata = () => { clearTimeout(timeout); resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }); };
        video.onerror = () => { clearTimeout(timeout); reject(new Error('Video metadata is unavailable')); };
        video.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
    const technical = await inspectContainer(media.file, media.filename);
    media.metadata = {
      ...dimensions, ...technical,
      dataRate: dimensions.duration ? (media.file.size * 8 / dimensions.duration) : null
    };
    return media.metadata;
  })().catch(() => {
    media.metadata = { container: fileExtension(media.filename).toUpperCase(), audio: null };
    return media.metadata;
  });
  return media.probePromise;
}

async function inspectContainer(file, filename) {
  const extension = fileExtension(filename);
  const startSize = Math.min(file.size, 4 * 1024 * 1024);
  const endStart = Math.max(startSize, file.size - 8 * 1024 * 1024);
  const chunks = [await file.slice(0, startSize).arrayBuffer()];
  if (endStart < file.size) chunks.push(await file.slice(endStart).arrayBuffer());
  let signature = '';
  for (const chunk of chunks) signature += new TextDecoder('latin1').decode(chunk);
  const videoCodecs = [
    ['avc1', 'H.264 / AVC'], ['avc3', 'H.264 / AVC'], ['hvc1', 'H.265 / HEVC'], ['hev1', 'H.265 / HEVC'],
    ['vp09', 'VP9'], ['V_VP9', 'VP9'], ['vp08', 'VP8'], ['V_VP8', 'VP8'], ['av01', 'AV1']
  ];
  const audioCodecs = [
    ['mp4a', 'AAC'], ['A_OPUS', 'Opus'], ['OpusHead', 'Opus'], ['ac-3', 'AC-3'], ['ec-3', 'E-AC-3'], ['A_VORBIS', 'Vorbis']
  ];
  const videoCodec = videoCodecs.find(([needle]) => signature.includes(needle))?.[1] || 'Not identified';
  const audioCodec = audioCodecs.find(([needle]) => signature.includes(needle))?.[1] || '';
  const inspectedTrackTable = signature.includes('moov') || signature.includes('matroska') || signature.includes('webm');
  const hasAudio = audioCodec ? true : inspectedTrackTable ? signature.includes('soun') : null;
  return {
    container: extension === 'mp4' ? 'MPEG-4' : extension === 'webm' ? 'WebM' : extension.toUpperCase(),
    mimeType: file.type || (extension === 'mp4' ? 'video/mp4' : 'video/webm'),
    videoCodec, audioCodec: audioCodec || (hasAudio === false ? 'None detected' : 'Not identified'), audio: hasAudio
  };
}

function scheduleOptimizerRender() {
  if (optimizerRenderPending) return;
  optimizerRenderPending = true;
  requestAnimationFrame(() => {
    optimizerRenderPending = false;
    renderMediaList();
    renderOptimizer();
  });
}

function updateBatchProgress(title, detail, percent) {
  state.batchProgress = { title, detail, percent: Math.max(0, Math.min(100, percent || 0)) };
  renderOptimizer();
}

async function loadOptimizerEngine() {
  if (optimizerEngine?.loaded) return optimizerEngine;
  if (optimizerLoadPromise) return optimizerLoadPromise;
  optimizerLoadError = '';
  optimizerLoadPromise = (async () => {
    renderOptimizer();
    const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
    const engine = new FFmpeg();
    engine.on('log', ({ message }) => { optimizerLastLog = message || optimizerLastLog; });
    engine.on('progress', ({ progress }) => {
      if (!activeOptimization) return;
      const clipProgress = Math.max(0, Math.min(100, Number(progress || 0) * 100));
      activeOptimization.media.optimization.progress = clipProgress;
      const overall = ((activeOptimization.index + (clipProgress / 100)) / activeOptimization.total) * 100;
      state.batchProgress = {
        title: `Optimizing ${activeOptimization.index + 1} of ${activeOptimization.total}`,
        detail: activeOptimization.media.sourceFilename,
        percent: overall
      };
      scheduleOptimizerRender();
    });
    updateBatchProgress('Preparing video optimizer…', 'Downloading the local conversion engine for the first run.', 0);
    await engine.load({
      coreURL: new URL('./vendor/ffmpeg-core/ffmpeg-core.js', import.meta.url).href,
      wasmURL: new URL('./vendor/ffmpeg-core/ffmpeg-core.wasm', import.meta.url).href
    });
    optimizerEngine = engine;
    renderOptimizer();
    return engine;
  })().catch((error) => {
    optimizerLoadError = error?.message || String(error);
    optimizerEngine = null;
    throw new Error(`The browser video optimizer could not start: ${optimizerLoadError}`);
  }).finally(() => {
    optimizerLoadPromise = null;
    renderOptimizer();
  });
  return optimizerLoadPromise;
}

function optimizedFilename(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '') || 'sign-video';
  return `${base}.mp4`;
}

async function optimizeIncomingMedia(media, index, total) {
  const engine = await loadOptimizerEngine();
  const source = media.sourceFile || media.file;
  if (!source) throw new Error('The original source video is unavailable.');
  const extension = fileExtension(media.sourceFilename || source.name) || 'video';
  const unique = `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
  const inputName = `input-${unique}.${extension}`;
  const outputName = `output-${unique}.mp4`;
  const audioMode = media.optimization?.audioMode || state.audioMode;
  media.optimization = { status: 'optimizing', progress: 0, audioMode, error: '' };
  activeOptimization = { media, index, total };
  optimizerLastLog = '';
  updateBatchProgress(`Optimizing ${index + 1} of ${total}`, media.sourceFilename, (index / total) * 100);
  try {
    await engine.writeFile(inputName, new Uint8Array(await source.arrayBuffer()));
    const args = [
      '-i', inputName,
      '-map', '0:v:0',
      '-vf', "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-sn', '-dn'
    ];
    if (audioMode === 'keep') {
      args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '44100');
    } else {
      args.push('-an');
    }
    args.push(outputName);
    const result = await engine.exec(args);
    if (result !== 0) throw new Error(optimizerLastLog || `FFmpeg exited with code ${result}`);
    const data = await engine.readFile(outputName);
    const outputFilename = optimizedFilename(media.sourceFilename);
    const output = new File([data], outputFilename, { type: 'video/mp4', lastModified: Date.now() });
    media.file = output;
    media.filename = outputFilename;
    media.size = output.size;
    media.modified = output.lastModified;
    media.metadata = null;
    media.probePromise = null;
    media.optimization = {
      status: 'done', progress: 100, audioMode,
      sourceSize: source.size, outputSize: output.size, optimizedAt: new Date().toISOString(), error: ''
    };
    setDirty(true);
    await probeMedia(media);
    if (state.selectedMediaId === media.id) await selectMedia(media.id, false);
    return true;
  } catch (error) {
    media.optimization = {
      status: 'error', progress: 0, audioMode,
      error: error?.message || String(error)
    };
    throw error;
  } finally {
    activeOptimization = null;
    try { await engine.deleteFile(inputName); } catch { /* The virtual source may already be gone. */ }
    try { await engine.deleteFile(outputName); } catch { /* No output exists after a failed conversion. */ }
    renderAll();
  }
}

async function optimizeBatch(mediaList) {
  const candidates = mediaList.filter((media) => media?.kind === 'incoming' && mediaNeedsOptimization(media));
  if (!candidates.length || state.optimizing) return;
  state.optimizing = true;
  const audioMode = state.audioMode;
  for (const media of candidates) media.optimization = { status: 'queued', progress: 0, audioMode, error: '' };
  renderAll();
  let completed = 0;
  let failed = 0;
  try {
    try {
      await loadOptimizerEngine();
    } catch (error) {
      failed = candidates.length;
      for (const media of candidates) {
        media.optimization = { status: 'error', progress: 0, audioMode, error: error.message };
      }
      return;
    }
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        await optimizeIncomingMedia(candidates[index], index, candidates.length);
        completed += 1;
      } catch (error) {
        failed += 1;
        console.error(`Could not optimize ${candidates[index].sourceFilename}:`, error);
      }
    }
  } finally {
    state.optimizing = false;
    updateBatchProgress(
      failed ? 'Optimization finished with errors' : 'All videos optimized',
      `${completed} completed${failed ? ` · ${failed} failed` : ''} · audio ${audioMode === 'keep' ? 'kept' : 'removed'}`,
      100
    );
    renderAll();
    toast(failed
      ? `${completed} video${completed === 1 ? '' : 's'} optimized; ${failed} failed. Review the marked video${failed === 1 ? '' : 's'}.`
      : `${completed} video${completed === 1 ? '' : 's'} optimized with audio ${audioMode === 'keep' ? 'kept' : 'removed'}.`, failed ? 'error' : '');
  }
}

function filenameStem(value) {
  return String(value || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

function matchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function simplifiedVideoTitle(value) {
  return matchText(filenameStem(value))
    .replace(/^(?:sl|sign language|sign|video|clip|recording)\s+/, '')
    .replace(/\s+(?:sl|sign language|sign video|video|clip|recording)$/, '')
    .trim();
}

function pageFromImportRecord(videoId, record) {
  const sectionId = String(record?.section_id || '');
  const bySection = state.pages.find((page) => page.sectionId.toLowerCase() === sectionId.toLowerCase());
  if (bySection) return bySection;
  const position = Number(String(videoId).match(/(\d+)$/)?.[1]);
  return position ? state.pages[position - 1] || null : null;
}

function detectPageForFilename(filename) {
  const stem = filenameStem(filename);
  const normalizedStem = matchText(stem);
  const simplifiedStem = simplifiedVideoTitle(stem);
  const previousName = matchText(stem);
  for (const [videoId, record] of Object.entries(state.importMetadata.videos || {})) {
    if (!record || typeof record !== 'object') continue;
    const recordedNames = [record.source_name, record.filename].filter(Boolean).map((value) => matchText(filenameStem(value)));
    if (!recordedNames.includes(previousName)) continue;
    const page = pageFromImportRecord(videoId, record);
    if (page) return { pageId: page.sectionId, score: 1000, reason: 'a previous import record' };
  }

  const sectionMatches = state.pages.filter((page) => {
    const section = matchText(page.sectionId);
    return section.length >= 4 && (` ${normalizedStem} `).includes(` ${section} `);
  });
  if (sectionMatches.length === 1) {
    const page = sectionMatches[0];
    return { pageId: page.sectionId, score: 950, reason: `section ID ${page.sectionId}` };
  }

  const pagePrefix = stem.match(/(?:^|[^a-z0-9])(pg\d+)(?:[^a-z0-9]|$)/i)?.[1]?.toLowerCase();
  if (pagePrefix) {
    const prefixMatches = state.pages.filter((page) => page.sectionId.toLowerCase().startsWith(`${pagePrefix}_`));
    if (prefixMatches.length === 1) {
      const page = prefixMatches[0];
      return { pageId: page.sectionId, score: 900, reason: `page ID ${pagePrefix}` };
    }
  }

  const indexMatch = stem.match(/(?:^|[^a-z0-9])(?:video|index|page|section|clip)[-_ ]*0*(\d+)(?:[^a-z0-9]|$)/i)
    || stem.match(/^0*(\d+)(?:[-_ .]|$)/);
  const position = Number(indexMatch?.[1]);
  if (position && state.pages[position - 1]) {
    const page = state.pages[position - 1];
    return { pageId: page.sectionId, score: 850, reason: `video index ${position}` };
  }

  const titleMatches = state.pages.map((page) => {
    const title = matchText(page.title);
    if (!title) return null;
    if (simplifiedStem === title) return { page, score: 800 };
    if (title.length >= 4 && (` ${simplifiedStem} `).includes(` ${title} `)) return { page, score: 760 + Math.min(30, title.length) };
    const tokens = title.split(' ').filter((token) => token.length >= 3);
    const stemTokens = new Set(simplifiedStem.split(' '));
    if (tokens.length && tokens.every((token) => stemTokens.has(token)) && (tokens.length > 1 || tokens[0].length >= 6)) {
      return { page, score: 650 + Math.min(50, tokens.join('').length) };
    }
    return null;
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  if (titleMatches.length && (titleMatches.length === 1 || titleMatches[0].score > titleMatches[1].score)) {
    const match = titleMatches[0];
    return { pageId: match.page.sectionId, score: match.score, reason: `page title “${match.page.title}”` };
  }
  return null;
}

function autoAssignmentsForFiles(files) {
  const usedPages = new Set(state.incoming.filter((media) => media.pageId).map((media) => media.pageId));
  const proposals = files.map((file) => ({ file, match: detectPageForFilename(file.name) }))
    .filter((proposal) => proposal.match)
    .sort((a, b) => b.match.score - a.match.score || naturalCompare(a.file.name, b.file.name));
  const assignments = new Map();
  for (const proposal of proposals) {
    if (usedPages.has(proposal.match.pageId)) continue;
    assignments.set(proposal.file, proposal.match);
    usedPages.add(proposal.match.pageId);
  }
  return assignments;
}

async function addIncomingFiles(fileList) {
  const files = [...fileList]
    .filter((file) => file.type.startsWith('video/') || VIDEO_INPUT_EXTENSIONS.has(fileExtension(file.name)))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) {
    toast('No supported video files were found. Choose MP4, WebM, MOV, M4V, AVI, or MKV recordings.', 'error');
    return;
  }
  const autoAssignments = autoAssignmentsForFiles(files);
  const added = [];
  for (const file of files) {
    const autoMatch = autoAssignments.get(file) || null;
    const media = {
      id: `incoming:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`,
      kind: 'incoming', filename: file.name, file, sourceFile: file, sourceFilename: file.name,
      size: file.size, modified: file.lastModified, pageId: autoMatch?.pageId || '',
      assignmentMethod: autoMatch ? 'auto' : '', assignmentReason: autoMatch?.reason || '',
      metadata: null, optimization: null
    };
    state.incoming.push(media);
    added.push(media);
    probeMedia(media).then(() => renderMediaList()).catch(() => {});
  }
  state.batchProgress = null;
  state.selectedMediaId = state.incoming.at(-1).id;
  state.openMediaGroups.add('incoming');
  state.mediaFilter = 'all';
  syncSegmented(els.mediaFilters, 'all');
  renderAll();
  await selectMedia(state.selectedMediaId);
  const matched = added.filter((media) => media.pageId).length;
  setDirty(true);
  toast(`Added ${files.length} incoming video${files.length === 1 ? '' : 's'} · ${matched} auto-assigned${files.length - matched ? ` · ${files.length - matched} need a page` : ''}. Review the matches, then optimize the batch.`);
}

function assignMediaToPage(media, pageId, { method = 'manual', reason = 'selected by the user' } = {}) {
  if (!media || media.kind !== 'incoming') return;
  const displaced = pageId ? state.incoming.find((item) => item.id !== media.id && item.pageId === pageId) : null;
  if (displaced) {
    displaced.pageId = '';
    displaced.assignmentTarget = undefined;
    displaced.assignmentMethod = '';
    displaced.assignmentReason = '';
  }
  media.pageId = pageId;
  media.assignmentTarget = pageId || undefined;
  media.assignmentMethod = pageId ? method : '';
  media.assignmentReason = pageId ? reason : '';
  if (pageId) state.selectedPageId = pageId;
  setDirty(true);
  renderPageList();
  renderSelectedPage();
  renderMediaList();
  renderEditor();
  if (displaced) toast(`${displaced.filename} was unassigned because each page can have one incoming video.`);
}

function mediaInfoRows(media) {
  const pageIds = media.kind === 'incoming' ? (media.pageId ? [media.pageId] : []) : media.pageIds;
  const pages = pageIds.map((id) => state.pages.find((page) => page.sectionId === id)?.title || id).join(', ') || 'Unlinked';
  const metadata = media.metadata || {};
  const optimized = media.kind === 'incoming' && media.optimization?.status === 'done';
  const savings = optimized ? optimizationSavings(media) : null;
  return [
    ['Project status', media.kind === 'incoming' ? optimized ? 'Incoming — optimized and ready' : 'Incoming — optimization pending' : media.missing ? 'Referenced file is missing' : 'Existing in ADT'],
    ['File name', media.filename],
    ['Assigned page', pages],
    ...(media.kind === 'incoming' && media.pageId ? [['Assignment method', media.assignmentMethod === 'auto' ? `Automatic · ${media.assignmentReason || 'filename match'}` : 'Manual']] : []),
    ['File size', formatBytes(media.size)],
    ...(optimized ? [
      ['Original file', media.sourceFilename],
      ['Original size', formatBytes(media.sourceFile?.size)],
      ['Size change', savings === null ? 'Not available' : savings >= 0 ? `${savings}% smaller` : `${Math.abs(savings)}% larger`]
    ] : []),
    ['Length', formatDuration(metadata.duration)],
    ['Dimensions', metadata.width ? `${metadata.width} × ${metadata.height} px` : 'Not available'],
    ['Container / type', `${metadata.container || fileExtension(media.filename).toUpperCase()} · ${metadata.mimeType || media.file?.type || 'type not reported'}`],
    ['Video compression', metadata.videoCodec || 'Not identified'],
    ['Audio', metadata.audio === true ? `Yes · ${metadata.audioCodec}` : metadata.audio === false ? 'No audio track detected' : 'Could not confirm in browser'],
    ['Overall data rate', metadata.dataRate ? `${(metadata.dataRate / 1_000_000).toFixed(2)} Mb/s` : 'Not available'],
    ['File modified', formatDate(media.modified)],
    ['Created', 'Creation date is not exposed by the browser'],
    ['Imported into ADT', media.kind === 'incoming' ? 'Not yet imported' : formatDate(media.importedAt)],
    ['Original source', media.sourceName || (media.kind === 'incoming' ? media.sourceFilename || media.filename : 'Not recorded')],
    ['Import preset', media.preset || (media.kind === 'incoming' ? optimized ? 'Optimize video — H.264, max 960 px, 30 fps' : 'Not optimized yet' : 'Not recorded')],
    ...(optimized ? [['Audio choice', media.optimization.audioMode === 'keep' ? 'Kept (mono AAC)' : 'Removed']] : []),
    ['Languages', media.kind === 'incoming' ? [...state.selectedLanguages].join(', ') : media.languages.join(', ')]
  ];
}

async function showMediaInfo(id) {
  const media = [...state.incoming, ...state.existing].find((item) => item.id === id);
  if (!media) return;
  await probeMedia(media);
  els.infoTitle.textContent = media.filename;
  els.mediaInfo.innerHTML = mediaInfoRows(media).map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
  els.infoDialog.showModal();
}

function nextBundleVersion(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? String(number + 1) : String(Date.now());
}

function sortedManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => naturalCompare(a, b)));
}

async function applyAssignments({ askToReplace = true } = {}) {
  const assigned = state.incoming.filter((media) => media.pageId);
  if (!assigned.length) return 0;
  const pendingOptimization = assigned.filter(mediaNeedsOptimization);
  if (pendingOptimization.length) {
    throw new Error(`Optimize the ${pendingOptimization.length} assigned incoming video${pendingOptimization.length === 1 ? '' : 's'} before applying them to the ADT.`);
  }
  const replacements = assigned.filter((media) => {
    const page = state.pages.find((candidate) => candidate.sectionId === media.pageId);
    return page && state.languages.some((language) => state.manifests.get(language)?.[`video-${page.position}`]);
  });
  if (askToReplace && replacements.length && !confirm(`${replacements.length} assigned video${replacements.length === 1 ? '' : 's'} will replace existing page links. Continue?`)) return -1;
  const selectedLanguages = [...state.selectedLanguages];
  if (!selectedLanguages.length) throw new Error('Select at least one language.');
  const importedAt = new Date().toISOString();
  for (const media of assigned) {
    const page = state.pages.find((candidate) => candidate.sectionId === media.pageId);
    if (!page) continue;
    const extension = fileExtension(media.filename);
    if (!VIDEO_EXTENSIONS.has(extension)) throw new Error(`${media.filename} must be MP4 or WebM for browser import.`);
    const filename = `sl_${page.sectionId}.${extension}`;
    const videoId = `video-${page.position}`;
    for (const language of selectedLanguages) {
      setOverride(`content/i18n/${language}/video/${filename}`, media.file);
      const manifest = state.manifests.get(language) || {};
      manifest[videoId] = filename;
      state.manifests.set(language, manifest);
    }
    state.importMetadata.videos[videoId] = {
      imported_at: importedAt,
      filename,
      section_id: page.sectionId,
      languages: selectedLanguages,
      source_name: media.sourceFilename || media.filename,
      source_size: media.sourceFile?.size || media.file.size,
      preset: 'optimize-video',
      audio_mode: media.optimization?.audioMode || 'keep',
      assignment_method: media.assignmentMethod || 'manual',
      assignment_reason: media.assignmentReason || 'selected by the user',
      trim_start: null,
      trim_end: null
    };
  }
  for (const language of selectedLanguages) {
    setOverride(`content/i18n/${language}/videos.json`, jsonText(sortedManifest(state.manifests.get(language) || {})), 'application/json');
  }
  state.importMetadata.version = 1;
  setOverride('content/video-import-metadata.json', jsonText(state.importMetadata), 'application/json');
  const config = structuredClone(state.config);
  config.features = config.features && typeof config.features === 'object' ? config.features : {};
  config.features.signLanguage = true;
  config.bundleVersion = nextBundleVersion(config.bundleVersion);
  state.config = config;
  setOverride('assets/config.json', jsonText(config), 'application/json');
  await regenerateOfflinePreloader();
  state.incoming = state.incoming.filter((media) => !media.pageId);
  await rebuildExistingMedia();
  state.selectedMediaId = '';
  renderAll();
  setDirty(true);
  return assigned.length;
}

async function regenerateOfflinePreloader() {
  if (!listProjectPaths().includes('assets/offline-preloader.js')) return false;
  const inline = {};
  const addJson = async (path) => {
    if (!listProjectPaths().includes(path)) return;
    inline[`./${path}`] = await getProjectJson(path);
  };
  const addText = async (path) => {
    if (!listProjectPaths().includes(path)) return;
    inline[`./${path}`] = await getProjectText(path);
  };
  for (const path of ['assets/config.json', 'content/pages.json', 'content/toc.json']) await addJson(path);
  await addText('content/navigation/nav.html');
  for (const path of listProjectPaths().filter((candidate) => !candidate.includes('/') && candidate.endsWith('.html')).sort(naturalCompare)) await addText(path);
  for (const language of state.languages) {
    await addJson(`assets/interface_translations/${language}/interface_translations.json`);
    for (const filename of ['texts.json', 'audios.json', 'videos.json', 'images.json', 'glossary.json', 'timecode/timecode_output.json']) {
      await addJson(`content/i18n/${language}/${filename}`);
    }
  }
  const javascript = `// offline-preloader.js — auto-generated, do not edit by hand
(function () {
  var INLINE = ${JSON.stringify(inline)};
  var BASE_DIR = (function () {
    var href = location.href.split("?")[0].split("#")[0];
    return href.slice(0, href.lastIndexOf("/") + 1);
  })();
  function lookup(url) {
    var clean = String(url).split("?")[0].split("#")[0];
    if (BASE_DIR && clean.indexOf(BASE_DIR) === 0) clean = clean.slice(BASE_DIR.length);
    if (clean.indexOf("./") === 0) clean = clean.slice(2);
    var withDot = "./" + clean;
    if (Object.prototype.hasOwnProperty.call(INLINE, withDot)) return withDot;
    if (Object.prototype.hasOwnProperty.call(INLINE, clean)) return clean;
    return null;
  }
  var _realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var raw = (url && typeof url === "object" && typeof url.url === "string") ? url.url : url;
    var key = lookup(raw);
    if (key !== null) {
      var data = INLINE[key];
      var isJson = key.slice(-5) === ".json";
      var body = isJson ? JSON.stringify(data) : data;
      var ct = isJson ? "application/json" : "text/html; charset=utf-8";
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": ct } }));
    }
    return _realFetch(url, opts);
  };
  if (location.protocol === "file:") {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType === 1 && node.tagName === "LINK" && node.rel === "manifest") node.parentNode.removeChild(node);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
`;
  setOverride('assets/offline-preloader.js', javascript, 'text/javascript');
  return true;
}

async function ensureWritablePermission() {
  if (!state.rootHandle) return false;
  const options = { mode: 'readwrite' };
  if ((await state.rootHandle.queryPermission(options)) === 'granted') return true;
  return (await state.rootHandle.requestPermission(options)) === 'granted';
}

async function writeToDirectory(path, blob) {
  const pieces = normalizePath(path).split('/');
  const name = pieces.pop();
  let directory = state.rootHandle;
  for (const piece of pieces) directory = await directory.getDirectoryHandle(piece, { create: true });
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  state.files.set(normalizePath(path), { handle: fileHandle });
}

async function persistProject() {
  if (state.mode !== 'direct') throw new Error('Direct save is unavailable in compatible mode. Download the updated ADT ZIP instead.');
  if (!(await ensureWritablePermission())) throw new Error('Write permission was not granted for this folder.');
  const entries = [...state.overrides.entries()];
  for (let index = 0; index < entries.length; index += 1) {
    const [path, blob] = entries[index];
    els.busyDetail.textContent = `${index + 1}/${entries.length} · ${path}`;
    await writeToDirectory(path, blob);
  }
  state.overrides.clear();
  setDirty(false);
}

async function saveProject() {
  try {
    setBusy(true, 'Saving project…', 'Preparing assigned videos');
    const applied = await applyAssignments();
    if (applied === -1) return;
    if (!state.overrides.size) {
      toast('There are no project changes to save.');
      return;
    }
    els.busyTitle.textContent = 'Saving to connected folder…';
    await persistProject();
    toast('The connected ADT folder has been updated.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(false); }
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let number = 0; number < 256; number += 1) {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    crcTable[number] = value >>> 0;
  }
  return crcTable;
}

async function crc32(blob) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  const chunkSize = 2 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const value = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
    for (const byte of value) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function localZipHeader(nameBytes, size, crc, timestamp) {
  const header = new ArrayBuffer(30 + nameBytes.length);
  const view = new DataView(header);
  const dos = dosDateTime(timestamp);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dos.time, true);
  view.setUint16(12, dos.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  new Uint8Array(header, 30).set(nameBytes);
  return header;
}

function centralZipHeader(nameBytes, size, crc, timestamp, offset) {
  const header = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(header);
  const dos = dosDateTime(timestamp);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dos.time, true);
  view.setUint16(14, dos.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  new Uint8Array(header, 46).set(nameBytes);
  return header;
}

function endZipRecord(fileCount, centralSize, centralOffset) {
  const footer = new ArrayBuffer(22);
  const view = new DataView(footer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return footer;
}

async function buildProjectZip() {
  const paths = listProjectPaths().filter((path) => path && !path.endsWith('/'));
  if (paths.length > 65535) throw new Error('This ADT has too many files for browser ZIP export.');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    els.busyDetail.textContent = `${index + 1}/${paths.length} · ${path}`;
    const blob = await getProjectBlob(path);
    if (blob.size > 0xffffffff) throw new Error(`${path} is too large for browser ZIP export.`);
    const checksum = await crc32(blob);
    const nameBytes = encoder.encode(path);
    const timestamp = blob.lastModified || Date.now();
    const local = localZipHeader(nameBytes, blob.size, checksum, timestamp);
    central.push(centralZipHeader(nameBytes, blob.size, checksum, timestamp, offset));
    chunks.push(local, blob);
    offset += local.byteLength + blob.size;
    if (offset > 0xffffffff) throw new Error('This ADT is larger than the browser ZIP32 export limit (4 GB).');
  }
  const centralOffset = offset;
  const centralSize = central.reduce((total, value) => total + value.byteLength, 0);
  chunks.push(...central, endZipRecord(paths.length, centralSize, centralOffset));
  return new Blob(chunks, { type: 'application/zip' });
}

function safeDownloadName(value) {
  return String(value || 'updated-adt').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 120) || 'updated-adt';
}

async function downloadProject() {
  try {
    setBusy(true, 'Preparing updated ADT…', 'Applying assigned videos');
    const applied = await applyAssignments();
    if (applied === -1) return;
    els.busyTitle.textContent = 'Building complete ADT ZIP…';
    const zip = await buildProjectZip();
    const url = URL.createObjectURL(zip);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeDownloadName(state.config.title || state.rootName)}-updated-adt.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloaded the complete updated ADT (${formatBytes(zip.size)}).`);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(false); }
}

function syncSegmented(container, value) {
  for (const button of container.querySelectorAll('button')) button.classList.toggle('active', button.dataset.filter === value);
}

function selectPage(pageId) {
  state.selectedPageId = pageId;
  const incoming = state.incoming.find((media) => media.pageId === pageId);
  const existing = state.existing.find((media) => media.pageIds.includes(pageId));
  const media = incoming || existing;
  if (media) selectMedia(media.id);
  else selectMedia('');
  renderPageList();
  renderSelectedPage();
}

function movePage(delta) {
  const page = currentPage();
  const target = page ? state.pages[page.position - 1 + delta] : null;
  if (target) selectPage(target.sectionId);
}

els.openFolder.addEventListener('click', openDirectFolder);
els.fallback.addEventListener('change', () => openFallbackFiles(els.fallback.files));
els.addVideos.addEventListener('change', () => { addIncomingFiles(els.addVideos.files); els.addVideos.value = ''; });
els.addVideoFolder.addEventListener('change', () => { addIncomingFiles(els.addVideoFolder.files); els.addVideoFolder.value = ''; });
els.optimizeSelected.addEventListener('click', () => optimizeBatch([currentMedia()]));
els.optimizeAll.addEventListener('click', () => optimizeBatch([...state.incoming]));
for (const input of document.querySelectorAll('input[name="optimize-audio"]')) {
  input.addEventListener('change', () => {
    if (!input.checked || state.optimizing) return;
    state.audioMode = input.value;
    state.batchProgress = null;
    renderMediaList();
    renderEditor();
    renderOptimizer();
  });
}
els.changeProject.addEventListener('click', goHome);
els.brandHome.addEventListener('click', (event) => { event.preventDefault(); if (!els.workspace.classList.contains('hidden')) goHome(); });
els.saveProject.addEventListener('click', saveProject);
els.downloadProject.addEventListener('click', downloadProject);
els.pageSearch.addEventListener('input', renderPageList);
els.pageFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.pageFilter = button.dataset.filter;
  syncSegmented(els.pageFilters, state.pageFilter);
  renderPageList();
});
els.mediaFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.mediaFilter = button.dataset.filter;
  syncSegmented(els.mediaFilters, state.mediaFilter);
  renderMediaList();
});
els.pageList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-page-id]');
  if (row) selectPage(row.dataset.pageId);
});
els.mediaPanel.addEventListener('click', (event) => {
  const info = event.target.closest('[data-info-id]');
  if (info) { event.stopPropagation(); showMediaInfo(info.dataset.infoId); return; }
  const row = event.target.closest('[data-media-id]');
  if (row) selectMedia(row.dataset.mediaId);
});
els.mediaPanel.addEventListener('toggle', (event) => {
  const group = event.target.closest?.('[data-media-group]');
  if (!group) return;
  if (group.open) state.openMediaGroups.add(group.dataset.mediaGroup);
  else state.openMediaGroups.delete(group.dataset.mediaGroup);
}, true);
els.assignmentSelect.addEventListener('change', () => {
  const media = currentMedia();
  if (media?.kind === 'incoming') media.assignmentTarget = els.assignmentSelect.value;
  updateAssignmentAction();
});
els.assignmentAction.addEventListener('click', () => {
  const media = currentMedia();
  if (media?.kind === 'incoming') assignMediaToPage(media, els.assignmentSelect.value);
});
els.removeIncoming.addEventListener('click', () => {
  const media = currentMedia();
  if (media?.kind !== 'incoming') return;
  state.incoming = state.incoming.filter((item) => item.id !== media.id);
  state.selectedMediaId = '';
  renderAll();
});
els.languageOptions.addEventListener('change', (event) => {
  if (event.target.checked) state.selectedLanguages.add(event.target.value);
  else state.selectedLanguages.delete(event.target.value);
  setDirty(true);
});
els.previousPage.addEventListener('click', () => movePage(-1));
els.nextPage.addEventListener('click', () => movePage(1));
els.videoPlayer.addEventListener('loadedmetadata', () => { els.previewDuration.textContent = formatDuration(els.videoPlayer.duration); });

let mediaScrollFrame = 0;
function updateStickyVideoPreview() {
  mediaScrollFrame = 0;
  els.mediaPanel.classList.toggle('video-pip', els.mediaPanel.scrollTop > 120 && window.innerWidth > 900);
}
els.mediaPanel.addEventListener('scroll', () => {
  if (!mediaScrollFrame) mediaScrollFrame = requestAnimationFrame(updateStickyVideoPreview);
}, { passive: true });
window.addEventListener('resize', updateStickyVideoPreview);

if (window.showDirectoryPicker && window.isSecureContext) {
  els.compatibility.textContent = 'Direct folder save is available in this browser. You can also use compatible mode and download a ZIP.';
} else {
  els.openFolder.classList.add('hidden');
  els.compatibility.textContent = 'This browser uses compatible mode: choose the ADT folder, then download the complete updated ZIP.';
}
