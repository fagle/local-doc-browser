import {
  escapeHtml,
  formatBytes,
  getTitle,
  isAudio,
  isHeicLike,
  isImage,
  isMarkdown,
  isMovLike,
  isPdf,
  isVideo,
  joinWorkspacePath,
  pathDirectory,
  splitWorkspacePath,
  titleFromName,
} from "./client/utils.js";
import { createMobileAlbumController } from "./client/mobile-album.js";
import { createPhotoSwipeController } from "./client/photo-swipe.js";
import { createLivePhotoController } from "./client/live-photo.js";
import { createDeferredListMetadataController } from "./client/deferred-list-metadata.js";
import { createVideoPlayerController } from "./client/video-player.js";
import { createNavigationController } from "./client/navigation.js";
import {
  languageFromFilename,
  renderCodeBlock as renderCodeBlockContent,
  renderMarkdown as renderMarkdownContent,
} from "./client/text-renderer.js";
import { createVideoInfoRenderer } from "./client/video-info-renderer.js";
import { createPreviewRenderers } from "./client/preview-renderers.js";
import { createDesktopShellController } from "./client/desktop-shell.js";
import {
  fileTypeLabel as mediaFileTypeLabel,
  isHtmlDocument,
  isTextDocument,
  mediaAssetFor,
} from "./client/media-model.js";

let docs = [];
let dirs = [];
let activeId = null;
let workspaceName = "";
let parentPath = "";
let htmlViewMode = "preview";
let currentWorkspacePath = "";
const initialUrlParams = new URLSearchParams(window.location.search);
let pendingFilePath = initialUrlParams.get("file") || "";
const recentStorageKey = "komios-recent";
const sidebarWidthStorageKey = "komios-sidebar-width";
const themeStorageKey = "komios-theme";
const legacyStorageKeys = new Map([
  [recentStorageKey, "local-doc-browser-recent"],
  [sidebarWidthStorageKey, "local-doc-browser-sidebar-width"],
  [themeStorageKey, "local-doc-browser-theme"],
]);
const maxRecentItems = 8;
let activeMediaInfoController = null;
let pendingMediaInfoTimer = null;
let videoStateListVersion = 0;
let previewRenderVersion = 0;
const livePhotosKitUrl = "https://cdn.apple-livephotoskit.com/lpk/1/livephotoskit.js";

for (const [currentKey, legacyKey] of legacyStorageKeys) {
  if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
    localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
  }
}

const els = {
  openFolder: document.querySelector("#openFolder"),
  folderPath: document.querySelector("#folderPath"),
  pathBreadcrumbs: document.querySelector("#pathBreadcrumbs"),
  pathEditor: document.querySelector("#pathEditor"),
  editPath: document.querySelector("#editPath"),
  searchInput: document.querySelector("#searchInput"),
  recentToggle: document.querySelector("#recentToggle"),
  recentPopover: document.querySelector("#recentPopover"),
  recentList: document.querySelector("#recentList"),
  clearRecent: document.querySelector("#clearRecent"),
  logout: document.querySelector("#logout"),
  splitter: document.querySelector("#splitter"),
  parentNav: document.querySelector("#parentNav"),
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  closeWorkspace: document.querySelector("#closeWorkspace"),
  mobileAlbumToggle: document.querySelector("#mobileAlbumToggle"),
  mobileAlbumBrowse: document.querySelector("#mobileAlbumBrowse"),
  mobileAlbumLabel: document.querySelector("#mobileAlbumLabel"),
  mobileAlbumSheet: document.querySelector("#mobileAlbumSheet"),
  mobileAlbumScrim: document.querySelector("#mobileAlbumScrim"),
  mobileAlbumClose: document.querySelector("#mobileAlbumClose"),
  mobileAlbumContent: document.querySelector("#mobileAlbumContent"),
  docPath: document.querySelector("#docPath"),
  docTitle: document.querySelector("#docTitle"),
  preview: document.querySelector("#preview"),
  mobileDocActionsToggle: document.querySelector("#mobileDocActionsToggle"),
  htmlMode: document.querySelector("#htmlMode"),
  htmlSourceMode: document.querySelector("#htmlSourceMode"),
  htmlPreviewMode: document.querySelector("#htmlPreviewMode"),
  themeToggle: document.querySelector("#themeToggle"),
  copyMarkdown: document.querySelector("#copyMarkdown"),
  downloadHtml: document.querySelector("#downloadHtml"),
  mediaInfo: document.querySelector("#mediaInfo"),
  transcodeVideo: document.querySelector("#transcodeVideo"),
  downloadFile: document.querySelector("#downloadFile"),
};

async function apiFetch(input, init) {
  const response = await fetch(input, init);
  if (response.status === 401) {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
    throw new Error("未登录");
  }
  return response;
}

async function loadFolderSnapshot(path) {
  const params = new URLSearchParams({ dir: path || "" });
  const response = await apiFetch(`/api/workspace?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "读取目录失败");
  return payload;
}

function pathStem(path = "") {
  const name = String(path || "").replaceAll("\\", "/").split("/").pop() || "";
  return name.replace(/\.[^.]+$/i, "").toLowerCase();
}

function livePhotoSidecarKey(doc) {
  return `${pathDirectory(doc?.path || "")}\n${pathStem(doc?.path || "")}`;
}

function livePhotoSidecarMap(sourceDocs = docs) {
  const map = new Map();
  sourceDocs.filter(isMovLike).forEach((doc) => {
    map.set(livePhotoSidecarKey(doc), doc);
  });
  return map;
}

function sameStemLiveSidecar(doc, sourceDocs = docs) {
  if (!isHeicLike(doc)) return null;
  return livePhotoSidecarMap(sourceDocs).get(livePhotoSidecarKey(doc)) || null;
}

function optimisticLivePhotoInfo(doc) {
  const sidecar = sameStemLiveSidecar(doc);
  if (!sidecar) return null;
  const transcodeParams = scopedQuery({ path: sidecar.path, start: "0" });
  const fileParams = scopedQuery();
  const videoUrl = sidecar.rawUrl || `/api/file/${encodeURIComponent(sidecar.path)}${fileParams ? `?${fileParams}` : ""}`;
  return {
    isLive: true,
    mode: "sidecar",
    confidence: "exact-stem-sidecar-client",
    label: "Live Photo",
    videoPath: sidecar.path,
    videoUrl,
    transcodeUrl: `/api/transcode?${transcodeParams}`,
    videoSize: sidecar.size,
    message: "找到严格同名的 MOV/MP4 动态部分。",
    optimistic: true,
  };
}

function visiblePhotoDocs(sourceDocs = filteredDocs()) {
  const imageKeys = new Set(sourceDocs.filter(isHeicLike).map(livePhotoSidecarKey));
  return sourceDocs.filter((doc) => !(isMovLike(doc) && imageKeys.has(livePhotoSidecarKey(doc))));
}

function visibleImageDocs() {
  return visiblePhotoDocs(filteredDocs()).filter(isImage);
}

function imageSequenceState(doc = currentDoc()) {
  if (!doc || !isImage(doc)) return { items: [], index: -1, previous: null, next: null };
  const items = visibleImageDocs();
  const index = items.findIndex((item) => item.id === doc.id);
  return {
    items,
    index,
    previous: index > 0 ? items[index - 1] : null,
    next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
  };
}

function selectAdjacentImage(direction) {
  const { previous, next } = imageSequenceState();
  const target = direction < 0 ? previous : next;
  if (target) selectDoc(target.id);
}

function setPhotoZoom(zoomed) {
  const shell = els.preview.querySelector("[data-live-photo-shell]");
  const button = els.preview.querySelector("[data-photo-action='zoom']");
  if (!shell) return;
  shell.classList.toggle("is-zoomed-photo", Boolean(zoomed));
  if (button) {
    button.textContent = zoomed ? "适应窗口" : "放大";
    button.title = zoomed ? "适应窗口" : "查看大图";
  }
}

function togglePhotoZoom() {
  const shell = els.preview.querySelector("[data-live-photo-shell]");
  setPhotoZoom(!shell?.classList.contains("is-zoomed-photo"));
}

function isHtml(doc) {
  return isHtmlDocument(doc);
}

function isTextLike(doc) {
  return isTextDocument(doc);
}

function fileTypeLabel(doc) {
  return mediaFileTypeLabel(doc);
}

function renderCodeBlock(code, language, className = "") {
  return renderCodeBlockContent(code, language, className, escapeHtml);
}

function renderMarkdown(markdown) {
  return renderMarkdownContent(markdown, escapeHtml);
}
function updatePreviewActions(doc) {
  renderHtmlModeControl(doc);
  const asset = mediaAssetFor(doc);
  els.copyMarkdown.hidden = !asset.canCopySource;
  els.downloadHtml.hidden = !asset.canDownloadHtml;
  els.mediaInfo.hidden = !asset.canShowMediaInfo;
  els.transcodeVideo.hidden = !asset.canTranscode;
  if (!asset.canTranscode) els.transcodeVideo.textContent = "转码播放";
  els.downloadFile.hidden = !doc;
  els.downloadFile.textContent = asset.downloadLabel;
}

function scopedQuery(params = {}) {
  const query = new URLSearchParams();
  if (currentWorkspacePath) query.set("dir", currentWorkspacePath);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  return query.toString();
}

function renderHtmlModeControl(doc) {
  const showHtmlMode = Boolean(doc && isHtml(doc));
  els.htmlMode.hidden = !showHtmlMode;
  if (!showHtmlMode) {
    els.htmlSourceMode.classList.remove("active");
    els.htmlPreviewMode.classList.add("active");
    return;
  }
  els.htmlSourceMode.classList.toggle("active", htmlViewMode === "source");
  els.htmlPreviewMode.classList.toggle("active", htmlViewMode === "preview");
}

function filteredDocs() {
  const query = els.searchInput.value.trim().toLowerCase();
  if (!query) return docs;
  return docs.filter((doc) => `${doc.name}\n${doc.path}\n${doc.content || ""}`.toLowerCase().includes(query));
}

function filteredDirs() {
  const query = els.searchInput.value.trim().toLowerCase();
  if (!query) return dirs;
  return dirs.filter((dir) => `${dir.name}\n${dir.path}`.toLowerCase().includes(query));
}

function imageAspectRatio(doc) {
  const width = Number(doc?.imageSize?.width || 0);
  const height = Number(doc?.imageSize?.height || 0);
  return width > 0 && height > 0 ? width / height : null;
}

async function ensurePreviewImageSize(doc, version) {
  if (!doc || !isImage(doc) || imageAspectRatio(doc)) return;
  const requestRootPath = currentWorkspacePath;
  try {
    const response = await apiFetch(`/api/image-size?${scopedQuery({ path: doc.path })}`);
    const payload = await response.json();
    if (!response.ok || payload.error || !payload.imageSize) return;
    doc.imageSize = payload.imageSize;
    if (version !== previewRenderVersion || currentWorkspacePath !== requestRootPath || currentDoc()?.id !== doc.id) return;
    const aspect = imageAspectRatio(doc);
    const frame = els.preview.querySelector("[data-motion-media-frame]");
    if (aspect && frame) frame.style.setProperty("--media-aspect-ratio", String(aspect));
  } catch {
    // The image itself can still load and provide natural dimensions.
  }
}

function scrollActiveFileIntoView() {
  requestAnimationFrame(() => {
    const active = els.fileList.querySelector(".file-item.active");
    if (!active) return;
    active.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

function renderParentNav() {
  els.parentNav.innerHTML = "";
  const showParent = Boolean(parentPath && !els.searchInput.value.trim());
  els.parentNav.hidden = !showParent;
  if (!showParent) return;

  const button = document.createElement("button");
  button.className = "file-item folder-item parent-item";
  button.type = "button";
  button.title = parentPath;
  button.innerHTML = `
    <span class="file-thumb folder-thumb" aria-hidden="true">..</span>
    <span class="file-title">[..] 上级目录</span>
    <span class="file-status-mark" aria-hidden="true"></span>
    <span class="file-size">返回</span>
    <span class="file-path" title="${escapeHtml(parentPath)}">${escapeHtml(parentPath)}</span>
  `;
  button.addEventListener("click", () => openFolder(parentPath));
  els.parentNav.append(button);
}

function renderFileList() {
  deferredMetadata.beginRender(currentWorkspacePath);
  const filteredDocItems = filteredDocs();
  const visibleDocs = visiblePhotoDocs(filteredDocItems);
  const sidecars = livePhotoSidecarMap(filteredDocItems);
  const visibleDirs = filteredDirs();
  els.fileCount.textContent = workspaceName ? `${workspaceName} · ${visibleDirs.length} 个文件夹 · ${filteredDocItems.length} 个文件` : "未打开文件夹";
  mobileAlbum.renderNav();
  renderParentNav();
  els.fileList.innerHTML = "";

  if (!visibleDirs.length && !visibleDocs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    empty.textContent = docs.length || dirs.length ? "没有匹配的项目" : "当前目录没有文件夹或文件";
    els.fileList.append(empty);
    return;
  }

  visibleDirs.forEach((dir) => {
    const button = document.createElement("button");
    button.className = "file-item folder-item";
    button.type = "button";
    button.title = dir.path;
    button.innerHTML = `
      <span class="file-thumb folder-thumb" aria-hidden="true">目</span>
      <span class="file-title" title="${escapeHtml(dir.name)}">[目录] ${escapeHtml(dir.name)}</span>
      <span class="file-status-mark" aria-hidden="true"></span>
      <span class="file-size">文件夹</span>
      <span class="file-path" title="${escapeHtml(dir.path)}">${escapeHtml(dir.path)}</span>
    `;
    button.addEventListener("click", () => openFolder(dir.path));
    els.fileList.append(button);
  });

  visibleDocs.forEach((doc) => {
    const directory = pathDirectory(doc.path);
    const liveSidecar = isHeicLike(doc) ? sidecars.get(livePhotoSidecarKey(doc)) : null;
    const statusMark = videoListStatusMark(doc);
    const fileSizeText = deferredMetadata.fileSizeDisplayText(doc);
    const canThumbnail = doc.kind === "image" || doc.kind === "video";
    const cachedThumbnail = deferredMetadata.getCachedThumbnail(doc, currentWorkspacePath);
    const isActive = doc.id === activeId || liveSidecar?.id === activeId;
    const button = document.createElement("button");
    button.className = `file-item${isActive ? " active" : ""}${liveSidecar ? " live-photo-item" : ""}`;
    button.type = "button";
    button.title = doc.path;
    button.dataset.fileId = doc.id;
    button.dataset.filePath = doc.path;
    if (!Number.isFinite(doc.size)) button.dataset.sizeDeferred = "true";
    button.innerHTML = `
      <span class="file-thumb${canThumbnail ? " media-thumb" : ""}${cachedThumbnail ? " ready" : ""}" ${canThumbnail ? `data-thumbnail-path="${escapeHtml(doc.path)}" ${cachedThumbnail ? "" : 'data-thumbnail-deferred="true"'}` : ""} aria-hidden="true">
        ${cachedThumbnail ? `<img src="${escapeHtml(cachedThumbnail)}" alt="">` : `<span>${escapeHtml(fileTypeLabel(doc).slice(0, 1))}</span>`}
      </span>
      <span class="file-title" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
      ${liveSidecar ? '<span class="file-status-mark live-list-mark" title="Live Photo" aria-label="Live Photo">Live</span>' : statusMark || '<span class="file-status-mark" aria-hidden="true"></span>'}
      <span class="file-size" data-file-size-path="${escapeHtml(doc.path)}">${escapeHtml(fileTypeLabel(doc))} · ${escapeHtml(fileSizeText)}</span>
      ${directory ? `<span class="file-path" title="${escapeHtml(directory)}">${escapeHtml(directory)}</span>` : ""}
    `;
    button.addEventListener("click", () => selectDoc(doc.id));
    els.fileList.append(button);
  });
  deferredMetadata.setupObservers();
  scrollActiveFileIntoView();
}

function isSystemNoiseFile(doc) {
  return Boolean(doc && /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(doc.name || ""));
}

function defaultPreviewDoc() {
  if (window.matchMedia?.("(max-width: 820px)")?.matches && !activeId) return null;
  return docs.find((item) => item.id === activeId) || filteredDocs().find((doc) => !isSystemNoiseFile(doc));
}

function renderPreview(doc = defaultPreviewDoc()) {
  const renderVersion = ++previewRenderVersion;
  setPreviewMode(doc);
  if (!doc) {
    renderEmptyPreview();
    return;
  }

  activeId = doc.id;
  updatePreviewActions(doc);
  els.docPath.textContent = doc.path;

  const renderer = previewRendererFor(doc);
  renderer(doc, renderVersion);
}

function setPreviewMode(doc) {
  const asset = mediaAssetFor(doc);
  document.body.classList.toggle("video-mode", asset.isVideo);
  document.body.classList.toggle("photo-mode", asset.isPhoto);
  document.body.classList.toggle("document-mode", Boolean(doc && !asset.isMediaShell && !asset.isPhoto));
  document.body.classList.toggle("directory-mode", Boolean(!doc && currentWorkspacePath));
  document.body.classList.toggle("html-mode", asset.previewKind === "html");
  if (asset.previewKind !== "html") document.body.classList.remove("mobile-doc-actions-open");
  if (!asset.isPhoto) photoSwipe.setFullscreen(false);
  els.preview.classList.toggle("media-preview-shell", asset.isMediaShell);
  els.preview.classList.toggle("photo-preview-shell", asset.isPhoto);
}

function renderEmptyPreview() {
  activeId = null;
  updatePreviewActions(null);
  previewRenderers.renderEmptyPreview({ workspaceName });
}

function previewRendererFor(doc) {
  const asset = mediaAssetFor(doc);
  if (asset.previewKind === "image") return renderImagePreview;
  if (asset.previewKind === "pdf") return renderPdfPreview;
  if (asset.previewKind === "audio") return renderAudioPreview;
  if (asset.previewKind === "video") return renderVideoPreview;
  if (asset.previewKind === "html" && htmlViewMode === "preview") return renderHtmlPreview;
  if (asset.previewKind === "html" || asset.previewKind === "text") return renderTextPreview;
  return renderUnsupportedFilePreview;
}

function renderImagePreview(doc, renderVersion) {
  els.docTitle.textContent = titleFromName(doc.name);
  const imageUrl = photoSwipe.getPreloadedImageUrl(doc) || previewUrlWithPriority(doc.previewUrl || doc.rawUrl, 100);
  const initialAspect = imageAspectRatio(doc);
  const sequence = imageSequenceState(doc);
  const existingShell = els.preview.querySelector("[data-live-photo-shell]");
  if (existingShell) {
    updateImagePreviewShell(existingShell, doc, renderVersion, imageUrl, initialAspect, sequence);
    return;
  }
  els.preview.innerHTML = `
    <div class="image-preview" data-live-photo-shell>
      <div class="motion-media-frame is-loading-preview" data-motion-media-frame>
        <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(doc.name)}" data-live-photo-image decoding="async" />
        <div class="image-preview-spinner" aria-hidden="true"></div>
        <div class="live-photo-toolbar" data-live-photo-toolbar hidden></div>
        <button type="button" class="mobile-fullscreen-album-button" data-mobile-album-open>相册</button>
        <div class="photo-viewer-controls" aria-label="照片查看器控制">
          <button type="button" data-photo-action="previous" ${sequence.previous ? "" : "disabled"} title="上一张">‹</button>
          <button type="button" data-photo-action="zoom" title="查看大图">放大</button>
          <button type="button" data-photo-action="next" ${sequence.next ? "" : "disabled"} title="下一张">›</button>
        </div>
      </div>
    </div>
  `;
  const image = els.preview.querySelector("[data-live-photo-image]");
  const frame = els.preview.querySelector("[data-motion-media-frame]");
  const shell = els.preview.querySelector("[data-live-photo-shell]");
  const toolbar = els.preview.querySelector("[data-live-photo-toolbar]");
  if (initialAspect && frame) frame.style.setProperty("--media-aspect-ratio", String(initialAspect));

  livePhoto.bindImagePreviewLifecycle({ doc, image, frame, shell, toolbar, renderVersion });
  ensurePreviewImageSize(doc, renderVersion);
  photoSwipe.preloadImage(doc, { immediate: true, priority: 100 });
  photoSwipe.preloadAdjacent(doc);
}

function updateImagePreviewShell(shell, doc, renderVersion, imageUrl, initialAspect, sequence) {
  const image = shell.querySelector("[data-live-photo-image]");
  const frame = shell.querySelector("[data-motion-media-frame]");
  const toolbar = shell.querySelector("[data-live-photo-toolbar]");
  if (!image || !frame || !toolbar) {
    els.preview.innerHTML = "";
    renderImagePreview(doc, renderVersion);
    return;
  }

  livePhoto.stopPlayback(shell);
  shell.classList.remove("has-live-photo", "is-starting-live", "is-playing-live", "is-motion-photo", "is-zoomed-photo");
  frame.classList.remove("is-preview-error", "is-interactive-motion", "is-photo-transitioning");
  frame.classList.add("is-loading-preview");
  frame.onclick = null;
  frame.onkeydown = null;
  frame.title = "";
  frame.tabIndex = -1;
  toolbar.hidden = true;
  toolbar.innerHTML = "";

  const previousSrc = image.currentSrc || image.src || "";
  image.hidden = false;
  image.alt = doc.name;
  image.dataset.jpegFallback = "false";
  if (previousSrc !== new URL(imageUrl, window.location.href).href && image.getAttribute("src") !== imageUrl) {
    image.removeAttribute("width");
    image.removeAttribute("height");
    image.src = imageUrl;
  }

  if (initialAspect && frame) frame.style.setProperty("--media-aspect-ratio", String(initialAspect));

  const previousButton = frame.querySelector("[data-photo-action='previous']");
  const nextButton = frame.querySelector("[data-photo-action='next']");
  if (previousButton) previousButton.disabled = !sequence.previous;
  if (nextButton) nextButton.disabled = !sequence.next;

  livePhoto.bindImagePreviewLifecycle({ doc, image, frame, shell, toolbar, renderVersion });
  ensurePreviewImageSize(doc, renderVersion);
  photoSwipe.preloadImage(doc, { immediate: true, priority: 100 });
  photoSwipe.preloadAdjacent(doc);
}

function jpegPreviewFallbackUrl(url) {
  if (!url || !url.includes("/api/image-preview")) return "";
  const fallback = new URL(url, window.location.origin);
  if (fallback.searchParams.get("format") === "jpeg") return "";
  fallback.searchParams.set("format", "jpeg");
  return `${fallback.pathname}${fallback.search}`;
}

function previewUrlWithPriority(url, priority) {
  if (!url || !url.includes("/api/image-preview")) return url || "";
  const next = new URL(url, window.location.origin);
  next.searchParams.set("priority", String(priority));
  return `${next.pathname}${next.search}`;
}

function renderPdfPreview(doc) {
  previewRenderers.renderPdfPreview(doc);
}

function renderAudioPreview(doc) {
  previewRenderers.renderAudioPreview(doc);
}

function renderVideoPreview(doc) {
  previewRenderers.renderVideoShell(doc, renderVideoDecision);
}

function renderUnsupportedFilePreview(doc) {
  previewRenderers.renderUnsupportedFilePreview(doc);
}

function renderHtmlPreview(doc) {
  previewRenderers.renderHtmlPreview(doc);
}

function renderTextPreview(doc) {
  previewRenderers.renderTextPreview(doc);
}

function renderMediaInfo(info) {
  return videoInfoRenderer.renderMediaInfo(info);
}

async function readLivePhotoInfo(doc) {
  if (doc.livePhotoInfo && !doc.livePhotoInfo.optimistic) return doc.livePhotoInfo;
  const response = await apiFetch(`/api/live-photo?${scopedQuery({ path: doc.path })}`);
  const info = await response.json();
  doc.livePhotoInfo = info;
  return info;
}

function nativeVideoSupport(info) {
  return videoInfoRenderer.nativeVideoSupport(info);
}

function nfoMediaInfoIsEnough(info) {
  return videoInfoRenderer.nfoMediaInfoIsEnough(info);
}

function videoSupportLabel(info) {
  return videoInfoRenderer.videoSupportLabel(info);
}

function renderVideoDecisionContent(doc, state, info) {
  return videoInfoRenderer.renderVideoDecisionContent(doc, state, info);
}

async function renderVideoDecision(doc) {
  cancelMediaProbe();
  const state = await readVideoState(doc).catch(() => null);
  if (currentDoc()?.id !== doc.id) return;
  const nfoInfo = state?.mediaInfo || null;
  const nfoInfoEnough = nfoMediaInfoIsEnough(nfoInfo);
  doc.videoState = state;
  if (nfoInfoEnough) doc.mediaInfo = nfoInfo;
  else if (doc.mediaInfo?.isFromNfo) delete doc.mediaInfo;
  const initialInfo = nfoInfo || null;
  const initialSupport = videoSupportLabel(initialInfo);
  doc.recommendedVideoMode = initialSupport.loading ? "" : initialSupport.needsTranscode ? "transcode" : "raw";
  els.transcodeVideo.textContent = initialSupport.loading ? "分析中" : initialSupport.needsTranscode ? "转码播放" : "原始播放";
  els.preview.innerHTML = renderVideoDecisionContent(doc, state, initialInfo);
  if (nfoInfoEnough) return;

  pendingMediaInfoTimer = setTimeout(() => {
    pendingMediaInfoTimer = null;
    const controller = new AbortController();
    activeMediaInfoController = controller;
    readMediaInfo(doc, { signal: controller.signal })
      .catch((error) => {
        if (controller.signal.aborted) return null;
        return { warning: error.message, tracks: [], mime: doc.mime, size: doc.size };
      })
      .then((info) => {
        if (!info || controller.signal.aborted || currentDoc()?.id !== doc.id) return;
        const support = videoSupportLabel(info);
        els.transcodeVideo.textContent = support.needsTranscode ? "转码播放" : "原始播放";
        els.preview.innerHTML = renderVideoDecisionContent(doc, doc.videoState || state, info);
      })
      .finally(() => {
        if (activeMediaInfoController === controller) activeMediaInfoController = null;
      });
  }, 300);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const total = Math.round(seconds);
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return hour ? `${hour}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` : `${minute}:${String(second).padStart(2, "0")}`;
}

function cancelMediaProbe() {
  if (pendingMediaInfoTimer) {
    clearTimeout(pendingMediaInfoTimer);
    pendingMediaInfoTimer = null;
  }
  if (activeMediaInfoController) {
    activeMediaInfoController.abort();
    activeMediaInfoController = null;
  }
}

async function readMediaInfo(doc, options = {}) {
  if (doc.mediaInfo) return doc.mediaInfo;
  const response = await apiFetch(`/api/media-info?${scopedQuery({ path: doc.path })}`, {
    signal: options.signal,
  });
  const info = await response.json();
  if (!response.ok || info.error) throw new Error(info.error || "读取编码信息失败");
  doc.mediaInfo = info;
  return info;
}

async function readVideoState(doc) {
  if (doc.videoState) return doc.videoState;
  const response = await apiFetch(`/api/video-state?${scopedQuery({ path: doc.path })}`);
  const state = await response.json();
  if (!response.ok || state.error) throw new Error(state.error || "读取播放进度失败");
  doc.videoState = state;
  return state;
}

async function hydrateVideoStatesForList(version) {
  const videoDocs = docs.filter((doc) => isVideo(doc) && !doc.videoState);
  const concurrency = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < videoDocs.length && version === videoStateListVersion) {
      const doc = videoDocs[cursor];
      cursor += 1;
      const state = await readVideoState(doc).catch(() => null);
      if (version !== videoStateListVersion) return;
      if (state?.watched || Number(state?.positionSeconds || 0) > 0) renderFileList();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, videoDocs.length) }, () => worker()));
}

async function markVideoWatched(doc) {
  const duration = Number(doc.mediaInfo?.durationSeconds || doc.videoState?.durationSeconds || 0);
  const response = await apiFetch("/api/video-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dir: currentWorkspacePath,
      path: doc.path,
      positionSeconds: Number(doc.videoState?.positionSeconds || 0),
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      watched: true,
      updateResume: false,
    }),
  });
  const state = await response.json();
  if (!response.ok || state.error) throw new Error(state.error || "标记已播失败");
  doc.videoState = state;
  return state;
}

function render() {
  renderFileList();
  renderPreview();
}

function videoListStatusMark(doc) {
  if (!isVideo(doc) || !doc.videoState) return "";
  if (doc.videoState.watched) {
    return '<span class="file-status-mark" title="已播放" aria-label="已播放"><span class="watched-dot">✓</span></span>';
  }

  const position = Number(doc.videoState.positionSeconds || 0);
  const duration = Number(doc.videoState.durationSeconds || 0);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0 || duration <= 0) return "";
  const percent = Math.max(1, Math.min(99, (position / duration) * 100));
  const label = `已看 ${percent.toFixed(0)}% · ${formatDuration(position)} / ${formatDuration(duration)}`;
  return `<span class="file-status-mark" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="progress-pie" style="--progress:${percent.toFixed(2)}%"></span></span>`;
}

function setWorkspace(payload) {
  dirs = payload.dirs || [];
  docs = payload.docs || [];
  parentPath = payload.parentPath || "";
  activeId = null;
  workspaceName = payload.name || "";
  currentWorkspacePath = payload.path || "";
  deferredMetadata.applyCachedFileSizes(currentWorkspacePath);
  els.folderPath.value = payload.path || "";
  renderPathBreadcrumbs(currentWorkspacePath);
  setPathEditorVisible(false);
  els.searchInput.value = "";
  const listVersion = ++videoStateListVersion;
  render();
  hydrateVideoStatesForList(listVersion).catch(() => {});
  updateAddress("");
  mobileOverlayHistory.rememberCurrentUrl();
  addRecentItem({ type: "dir", dir: currentWorkspacePath, name: workspaceName });
  const mobileViewport = Boolean(window.matchMedia?.("(max-width: 820px)")?.matches);
  const targetDoc = docs.find((doc) => doc.path === pendingFilePath) || (mobileViewport ? null : docs.find((doc) => !isSystemNoiseFile(doc)));
  pendingFilePath = "";
  if (targetDoc) selectDoc(targetDoc.id);
}

async function previewInitialFile(rootPath, filePath, { replaceList = true } = {}) {
  if (!rootPath || !filePath) return;
  if (currentWorkspacePath === rootPath && docs.some((doc) => doc.path === filePath)) return;
  try {
    currentWorkspacePath = rootPath;
    workspaceName = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;
    els.folderPath.value = rootPath;
    renderPathBreadcrumbs(rootPath);
    setPathEditorVisible(false);
    els.fileCount.textContent = `${workspaceName} · 正在读取完整目录`;
    els.preview.innerHTML = '<div class="empty-state">正在打开目标文件...</div>';

    const response = await apiFetch(`/api/document-meta?${new URLSearchParams({ dir: rootPath, path: filePath }).toString()}`);
    const doc = await response.json();
    if (!response.ok || doc.error) throw new Error(doc.error || "打开目标文件失败");

    if (replaceList) {
      docs = [doc];
      dirs = [];
      parentPath = "";
      activeId = doc.id;
      renderFileList();
    }
    updateAddress(doc.path);
    mobileOverlayHistory.rememberCurrentUrl();
    await loadDoc(doc);
    if (replaceList || pendingFilePath === filePath || activeId === doc.id) renderPreview(doc);
  } catch (error) {
    els.preview.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "打开目标文件失败")}</div>`;
  }
}

async function loadDoc(doc) {
  if (doc.content !== undefined) return doc;

  const response = await apiFetch(`/api/document?${scopedQuery({ path: doc.path })}`);
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "读取文档失败");
  doc.kind = payload.kind || doc.kind;
  doc.content = payload.content;
  doc.rawUrl = payload.rawUrl;
  doc.previewUrl = payload.previewUrl;
  doc.downloadUrl = payload.downloadUrl;
  doc.mime = payload.mime;
  doc.imageSize = payload.imageSize || doc.imageSize || null;
  if (Number.isFinite(payload.size)) {
    doc.size = payload.size;
    doc.sizeDeferred = false;
    doc.sizeLoading = false;
    doc.sizeError = "";
    deferredMetadata.rememberFileSize(currentWorkspacePath, doc.path, payload.size);
    deferredMetadata.updateFileSizeText(doc);
  }
  return doc;
}

function releaseDocObjectUrls(doc) {
  if (doc?.motionVideoObjectUrl) {
    URL.revokeObjectURL(doc.motionVideoObjectUrl);
    delete doc.motionVideoObjectUrl;
  }
}

async function selectDoc(id) {
  const doc = docs.find((item) => item.id === id);
  if (!doc) return;

  cancelMediaProbe();
  const previousVideo = els.preview.querySelector("video[data-preview-video]");
  const previousDoc = currentDoc();
  if (previousVideo && previousDoc) videoPlayer.saveProgress(previousDoc, previousVideo, { immediate: true }).catch(() => {});
  videoPlayer.cleanup(previousVideo);
  if (previousDoc?.id !== id) releaseDocObjectUrls(previousDoc);
  activeId = id;
  htmlViewMode = "preview";
  updateAddress(doc.path);
  mobileOverlayHistory.rememberCurrentUrl();
  addRecentItem({ type: "file", dir: currentWorkspacePath, file: doc.path, name: doc.name });
  renderFileList();
  updatePreviewActions(doc);
  els.docPath.textContent = doc.path;
  els.docTitle.textContent = titleFromName(doc.name);
  const canRenderImageImmediately = isImage(doc) && Boolean(doc.previewUrl || doc.rawUrl);
  if (canRenderImageImmediately) {
    renderPreview(doc);
  } else {
    els.preview.innerHTML = '<div class="empty-state">正在读取文件...</div>';
  }

  try {
    await loadDoc(doc);
    if (activeId === id && !canRenderImageImmediately) renderPreview(doc);
  } catch (error) {
    if (activeId === id) {
      els.preview.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }
}

async function openFolder(nextPath, options = {}) {
  const remember = options.remember !== false;
  const path = (nextPath || els.folderPath.value).trim();
  if (!path) {
    els.folderPath.focus();
    return;
  }

  els.openFolder.disabled = true;
  els.openFolder.textContent = "读取中";
  try {
    const response = await apiFetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, remember }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "打开失败");
    mobileAlbum.setOpen(false);
    if (remember) pendingFilePath = "";
    setWorkspace(payload);
  } catch (error) {
    docs = [];
    dirs = [];
    activeId = null;
    workspaceName = "";
    parentPath = "";
    currentWorkspacePath = "";
    renderPathBreadcrumbs("");
    setPathEditorVisible(true);
    videoStateListVersion += 1;
    updateAddress("");
    mobileOverlayHistory.rememberCurrentUrl();
    render();
    els.preview.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  } finally {
    els.openFolder.disabled = false;
    els.openFolder.textContent = "打开";
  }
}

function currentDoc() {
  return docs.find((doc) => doc.id === activeId);
}

const navigation = createNavigationController({
  els,
  escapeHtml,
  getActiveId: () => activeId,
  getCurrentWorkspacePath: () => currentWorkspacePath,
  joinWorkspacePath,
  maxRecentItems,
  openFolder,
  recentStorageKey,
  setPendingFilePath: (filePath) => {
    pendingFilePath = filePath || "";
  },
  splitWorkspacePath,
});

const {
  addRecentItem,
  closeOverflowMenus,
  folderDisplayName,
  openRecentItem,
  readRecentItems,
  renderPathBreadcrumbs,
  renderRecentList,
  renderStartPage,
  renderStartPageIfIdle,
  setPathEditorVisible,
  updateAddress,
  writeRecentItems,
} = navigation;

const previewRenderers = createPreviewRenderers({
  els,
  escapeHtml,
  fileTypeLabel,
  formatBytes,
  getTitle,
  isMarkdown,
  languageFromFilename,
  renderCodeBlock,
  renderMarkdown,
  renderStartPage,
  titleFromName,
});

const desktopShell = createDesktopShellController({
  els,
  renderPathBreadcrumbs,
  renderRecentList,
  renderStartPageIfIdle,
  sidebarWidthStorageKey,
  themeStorageKey,
  writeRecentItems,
});

const deferredMetadata = createDeferredListMetadataController({
  apiFetch,
  els,
  escapeHtml,
  fileTypeLabel,
  formatBytes,
  getCurrentWorkspacePath: () => currentWorkspacePath,
  getDocs: () => docs,
});

const livePhoto = createLivePhotoController({
  apiFetch,
  currentDoc,
  escapeHtml,
  getPreviewRenderVersion: () => previewRenderVersion,
  jpegPreviewFallbackUrl,
  livePhotosKitUrl,
  optimisticLivePhotoInfo,
  readLivePhotoInfo,
});

const videoPlayer = createVideoPlayerController({
  apiFetch,
  cancelMediaProbe,
  els,
  escapeHtml,
  formatDuration,
  getCurrentWorkspacePath: () => currentWorkspacePath,
  isVideo,
  readMediaInfo,
  readVideoState,
  scopedQuery,
});

const videoInfoRenderer = createVideoInfoRenderer({
  escapeHtml,
  formatBytes,
  formatDuration,
  resumePositionFromState: videoPlayer.resumePositionFromState,
});

const mobileOverlayHistory = (() => {
  let consumingOverlayPop = false;
  let protectedUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  function canUseOverlayHistory() {
    return Boolean(window.matchMedia?.("(max-width: 820px)")?.matches);
  }

  function currentUrl() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function guardState() {
    const { komiosOverlay, ...state } = window.history.state || {};
    return { ...state, komiosBackGuard: true };
  }

  function pushGuard() {
    if (!canUseOverlayHistory()) return;
    if (window.history.state?.komiosBackGuard) {
      window.history.replaceState(guardState(), "", protectedUrl);
      return;
    }
    window.history.pushState(guardState(), "", protectedUrl);
  }

  function rememberCurrentUrl() {
    protectedUrl = currentUrl();
    pushGuard();
  }

  function push(kind) {
    if (!canUseOverlayHistory()) return;
    window.history.pushState({ ...(window.history.state || {}), komiosOverlay: kind }, "", window.location.href);
  }

  function consume(kind) {
    if (!canUseOverlayHistory() || consumingOverlayPop) return;
    if (window.history.state?.komiosOverlay !== kind) return;
    window.history.back();
  }

  function onOverlayChange(kind, open, options = {}) {
    if (options.history !== true) return;
    if (open) push(kind);
    else consume(kind);
  }

  function handlePopState() {
    if (!canUseOverlayHistory()) return;
    if (mobileAlbum?.isOpen?.()) {
      consumingOverlayPop = true;
      mobileAlbum.setOpen(false, { history: false });
      consumingOverlayPop = false;
      pushGuard();
      return;
    }
    if (photoSwipe?.isFullscreen?.()) {
      consumingOverlayPop = true;
      photoSwipe.setFullscreen(false, { history: false });
      consumingOverlayPop = false;
      pushGuard();
      return;
    }
    pushGuard();
  }

  return { handlePopState, onOverlayChange, rememberCurrentUrl };
})();

const photoSwipe = createPhotoSwipeController({
  els,
  escapeHtml,
  getCurrentWorkspacePath: () => currentWorkspacePath,
  currentDoc,
  imageSequenceState,
  isImage,
  loadDoc,
  onFullscreenChange: (open, options) => {
    mobileOverlayHistory.onOverlayChange("photo-fullscreen", open, options);
  },
  selectDoc,
});

const mobileAlbum = createMobileAlbumController({
  els,
  escapeHtml,
  filteredDirs,
  folderDisplayName,
  getState: () => ({ activeId, currentWorkspacePath, docs, isPhotoMode: Boolean(currentDoc() && isImage(currentDoc())), workspaceName, parentPath }),
  loadFolderSnapshot,
  onOpenChange: (open, options) => {
    mobileOverlayHistory.onOverlayChange("album-sheet", open, options);
  },
  openFolder,
  openRecentItem,
  readRecentItems,
  selectDoc,
  setMobilePhotoFullscreen: photoSwipe.setFullscreen,
});

function isTextInputTarget(target) {
  const tagName = target?.tagName?.toLowerCase();
  return target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select" || tagName === "button";
}

els.openFolder.addEventListener("click", openFolder);
els.editPath.addEventListener("click", () => setPathEditorVisible(els.pathEditor.hidden, { focus: true }));
document.addEventListener("click", (event) => {
  if (els.pathBreadcrumbs?.contains(event.target)) return;
  closeOverflowMenus();
});
els.folderPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") openFolder();
  if (event.key === "Escape" && currentWorkspacePath) setPathEditorVisible(false);
});
els.searchInput.addEventListener("input", renderFileList);
els.fileList.addEventListener("scroll", () => {
  deferredMetadata.markScrolled();
}, { passive: true });
els.fileList.addEventListener("click", (event) => {
  const item = event.target.closest?.(".file-item[data-file-id]");
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  photoSwipe.setFullscreen(false, { history: true });
  selectDoc(item.dataset.fileId);
}, { capture: true });

els.logout.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

document.addEventListener("keydown", (event) => {
  if (isTextInputTarget(event.target)) return;
  const doc = currentDoc();
  if (doc && isImage(doc)) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectAdjacentImage(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectAdjacentImage(1);
      return;
    }
    if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "0") {
      event.preventDefault();
      if (event.key === "-" || event.key === "0") setPhotoZoom(false);
      else togglePhotoZoom();
      return;
    }
  }
  const video = els.preview.querySelector("video[data-preview-video]");
  if (!doc || !isVideo(doc) || !video) return;
  const host = els.preview.querySelector(".video-preview");
  videoPlayer.handleKeyboard(event, doc, video, host);
});

els.preview.addEventListener("click", async (event) => {
  const recentButton = event.target.closest?.("[data-start-recent-index]");
  if (recentButton) {
    const item = readRecentItems()[Number(recentButton.dataset.startRecentIndex)];
    openRecentItem(item);
    return;
  }

  const photoButton = event.target.closest?.("[data-photo-action]");
  if (photoButton) {
    event.preventDefault();
    event.stopPropagation();
    const action = photoButton.dataset.photoAction;
    if (action === "previous") selectAdjacentImage(-1);
    if (action === "next") selectAdjacentImage(1);
    if (action === "zoom") togglePhotoZoom();
    return;
  }

  const mobileAlbumButton = event.target.closest?.("[data-mobile-album-open]");
  if (mobileAlbumButton) {
    event.preventDefault();
    event.stopPropagation();
    photoSwipe.setFullscreen(false, { history: true });
    mobileAlbum.setOpen(true, { history: true });
    return;
  }

  const photoFrame = event.target.closest?.("[data-motion-media-frame]");
  if (
    photoFrame
    && currentDoc()
    && isImage(currentDoc())
    && photoSwipe.isMobileViewport()
    && !event.target.closest?.(".live-photo-toolbar, .photo-viewer-controls")
  ) {
    if (photoSwipe.suppressesClick()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    photoSwipe.handlePhotoFrameClick(event);
    return;
  }

  const stateButton = event.target.closest?.("[data-video-state-action]");
  if (stateButton?.dataset.videoStateAction === "mark-watched") {
    const doc = currentDoc();
    if (!doc || !isVideo(doc)) return;
    stateButton.disabled = true;
    stateButton.textContent = "写入中";
    try {
      const state = await markVideoWatched(doc);
      els.preview.innerHTML = renderVideoDecisionContent(doc, state, doc.mediaInfo || null);
      renderFileList();
    } catch (error) {
      stateButton.disabled = false;
      stateButton.textContent = "标记为已播";
      const target = els.preview.querySelector(".video-decision") || els.preview;
      target.insertAdjacentHTML("beforeend", `<p class="media-info-warning">${escapeHtml(error.message || "标记已播失败")}</p>`);
    }
    return;
  }

  const button = event.target.closest?.("[data-video-action]");
  if (!button) return;
  const doc = currentDoc();
  if (!doc || !isVideo(doc)) return;
  await loadDoc(doc);
  button.disabled = true;
  try {
    videoPlayer.play(doc, {
      mode: button.dataset.videoAction === "raw" ? "raw" : "transcode",
      startSeconds: Number(button.dataset.start || 0),
    });
  } finally {
    button.disabled = false;
  }
});

els.htmlSourceMode.addEventListener("click", () => {
  htmlViewMode = "source";
  document.body.classList.remove("mobile-doc-actions-open");
  renderPreview(currentDoc());
});

els.htmlPreviewMode.addEventListener("click", () => {
  htmlViewMode = "preview";
  document.body.classList.remove("mobile-doc-actions-open");
  renderPreview(currentDoc());
});

els.mobileDocActionsToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  document.body.classList.toggle("mobile-doc-actions-open");
});

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("mobile-doc-actions-open")) return;
  if (event.target.closest?.(".preview-actions")) return;
  document.body.classList.remove("mobile-doc-actions-open");
});

els.closeWorkspace.addEventListener("click", () => {
  cancelMediaProbe();
  const video = els.preview.querySelector("video[data-preview-video]");
  const doc = currentDoc();
  if (video && doc) videoPlayer.saveProgress(doc, video, { immediate: true }).catch(() => {});
  releaseDocObjectUrls(doc);
  videoPlayer.cleanup(video);
  document.body.classList.remove("video-mode");
  docs = [];
  dirs = [];
  activeId = null;
  videoStateListVersion += 1;
  workspaceName = "";
  parentPath = "";
  currentWorkspacePath = "";
  pendingFilePath = "";
  mobileAlbum.setOpen(false);
  els.folderPath.value = "";
  els.searchInput.value = "";
  render();
  updateAddress("");
  mobileOverlayHistory.rememberCurrentUrl();
});

photoSwipe.bind();
mobileAlbum.bind();
desktopShell.bind();
window.addEventListener("popstate", mobileOverlayHistory.handlePopState);
mobileOverlayHistory.rememberCurrentUrl();

els.copyMarkdown.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc) return;
  await loadDoc(doc);
  if (!isTextLike(doc)) return;
  await navigator.clipboard.writeText(doc.content);
  els.copyMarkdown.textContent = "已复制";
  setTimeout(() => {
    els.copyMarkdown.textContent = "复制源码";
  }, 1200);
});

els.downloadHtml.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc) return;
  await loadDoc(doc);
  if (!isTextLike(doc)) return;
  const body = isImage(doc)
    ? `<img src="${escapeHtml(doc.rawUrl)}" alt="${escapeHtml(doc.name)}">`
    : isMarkdown(doc)
      ? renderMarkdown(doc.content)
      : `<pre><code>${escapeHtml(doc.content || "")}</code></pre>`;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(isMarkdown(doc) && doc.content ? getTitle(doc.content, doc.name) : titleFromName(doc.name))}</title><body>${body}</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = doc.name.replace(/\.(md|markdown|txt)$/i, ".html");
  link.click();
  URL.revokeObjectURL(url);
});

els.mediaInfo.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc || !isVideo(doc)) return;
  cancelMediaProbe();
  const panel = els.preview.querySelector(".media-info-panel");
  if (panel) {
    panel.remove();
    return;
  }

  els.mediaInfo.disabled = true;
  els.mediaInfo.textContent = "分析中";
  try {
    await loadDoc(doc);
    const info = await readMediaInfo(doc);
    const target = els.preview.querySelector(".video-preview") || els.preview;
    target.insertAdjacentHTML("beforeend", renderMediaInfo(info));
  } catch (error) {
    const target = els.preview.querySelector(".video-preview") || els.preview;
    target.insertAdjacentHTML("beforeend", `<div class="media-info-panel media-info-warning">${escapeHtml(error.message)}</div>`);
  } finally {
    els.mediaInfo.disabled = false;
    els.mediaInfo.textContent = "编码信息";
  }
});

els.transcodeVideo.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc || !isVideo(doc)) return;
  await loadDoc(doc);
  const video = els.preview.querySelector("video[data-preview-video]");
  if (!video) {
    const state = await readVideoState(doc).catch(() => doc.videoState);
    let mode = doc.recommendedVideoMode;
    if (!mode) {
      cancelMediaProbe();
      els.transcodeVideo.disabled = true;
      els.transcodeVideo.textContent = "分析中";
      try {
        const info = await readMediaInfo(doc).catch(() => null);
        mode = videoSupportLabel(info).needsTranscode ? "transcode" : "raw";
      } finally {
        els.transcodeVideo.disabled = false;
        els.transcodeVideo.textContent = mode === "raw" ? "原始播放" : "转码播放";
      }
    }
    videoPlayer.play(doc, { mode, startSeconds: videoPlayer.resumePositionFromState(state) });
    return;
  }
  els.preview.querySelectorAll(".transcode-status").forEach((item) => item.remove());
  try {
    await videoPlayer.toggleMode(doc, video);
  } catch (error) {
    videoPlayer.status(error.message || "播放模式切换失败。");
  }
});

els.preview.addEventListener(
  "error",
  (event) => {
    const video = event.target.closest?.("video[data-preview-video]");
    if (!video || video.dataset.transcoded !== "true") return;
    const error = video.error;
    const message = error ? `转码流播放失败，浏览器错误码：${error.code}` : "转码流播放失败。";
    videoPlayer.status(message);
  },
  true,
);

els.downloadFile.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc) return;
  await loadDoc(doc);
  const link = document.createElement("a");
  link.href = doc.downloadUrl || `${doc.rawUrl}?download=1`;
  link.download = doc.name;
  link.click();
});

window.addEventListener("beforeunload", () => {
  const doc = currentDoc();
  const video = els.preview.querySelector("video[data-preview-video]");
  if (doc && video) videoPlayer.saveProgress(doc, video, { immediate: true }).catch(() => {});
  releaseDocObjectUrls(doc);
});

renderPathBreadcrumbs("");
setPathEditorVisible(true);
desktopShell.applyInitialTheme();

const initialDir = initialUrlParams.get("dir") || "";
if (initialDir && pendingFilePath) {
  previewInitialFile(initialDir, pendingFilePath, { replaceList: false });
}

if (initialDir) {
  apiFetch(`/api/workspace?${new URLSearchParams({ dir: initialDir }).toString()}`)
    .then((response) => response.json())
    .then((payload) => {
      if (payload.error) throw new Error(payload.error);
      setWorkspace(payload);
    })
    .catch(() => {
      if (initialDir && pendingFilePath) {
        previewInitialFile(initialDir, pendingFilePath, { replaceList: true });
        return;
      }
      renderPathBreadcrumbs("");
      setPathEditorVisible(true);
      render();
    });
} else {
  renderPathBreadcrumbs("");
  setPathEditorVisible(true);
  render();
}

renderRecentList();

if (window.EventSource) {
  const events = new EventSource("/api/events");
  events.addEventListener("reload", () => window.location.reload());
}
