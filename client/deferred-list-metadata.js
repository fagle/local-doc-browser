export function createDeferredListMetadataController({
  apiFetch,
  els,
  escapeHtml,
  fileTypeLabel,
  formatBytes,
  getCurrentWorkspacePath,
  getDocs,
}) {
  let fileSizeObserver = null;
  let fileSizeHydrationTimer = null;
  let fileSizeHydrationVersion = 0;
  let lastFileListScrollAt = 0;
  let thumbnailObserver = null;
  let thumbnailHydrationTimer = null;
  let thumbnailHydrationVersion = 0;
  let renderedThumbnailRootPath = "";
  let thumbnailInFlightBatches = 0;

  const visibleFileSizePaths = new Set();
  const visibleThumbnailPaths = new Set();
  const fileSizeMemoryCache = new Map();
  const thumbnailMemoryCache = new Map();
  const pendingFileSizePaths = new Set();
  const pendingThumbnailPaths = new Set();
  const fileSizeBatchSize = 12;
  const thumbnailBatchSize = 12;
  const maxThumbnailInFlightBatches = 1;
  const maxFileSizeMemoryCacheItems = 20000;
  const maxThumbnailMemoryCacheItems = 20000;

  function docs() {
    return getDocs();
  }

  function cacheKey(rootPath, filePath) {
    return `${rootPath}\n${filePath}`;
  }

  function fileSizeDisplayText(doc) {
    if (Number.isFinite(doc.size)) return formatBytes(doc.size);
    if (doc.content) return formatBytes(doc.content.length);
    if (doc.sizeLoading) return "大小读取中";
    if (doc.sizeError) return "大小读取失败";
    return "大小待加载";
  }

  function rememberFileSize(rootPath, filePath, size) {
    if (!Number.isFinite(size)) return;
    const key = cacheKey(rootPath, filePath);
    if (fileSizeMemoryCache.has(key)) fileSizeMemoryCache.delete(key);
    fileSizeMemoryCache.set(key, size);
    while (fileSizeMemoryCache.size > maxFileSizeMemoryCacheItems) {
      const oldestKey = fileSizeMemoryCache.keys().next().value;
      if (!oldestKey) break;
      fileSizeMemoryCache.delete(oldestKey);
    }
  }

  function rememberThumbnail(rootPath, filePath, thumbnailUrl) {
    if (!thumbnailUrl) return;
    const key = cacheKey(rootPath, filePath);
    if (thumbnailMemoryCache.has(key)) thumbnailMemoryCache.delete(key);
    thumbnailMemoryCache.set(key, thumbnailUrl);
    while (thumbnailMemoryCache.size > maxThumbnailMemoryCacheItems) {
      const oldestKey = thumbnailMemoryCache.keys().next().value;
      if (!oldestKey) break;
      thumbnailMemoryCache.delete(oldestKey);
    }
  }

  function getCachedThumbnail(doc, rootPath = getCurrentWorkspacePath()) {
    if (!doc) return "";
    const cachedThumbnail = doc.thumbnailUrl || thumbnailMemoryCache.get(cacheKey(rootPath, doc.path)) || "";
    if (cachedThumbnail) doc.thumbnailUrl = cachedThumbnail;
    return cachedThumbnail;
  }

  function applyCachedFileSizes(rootPath = getCurrentWorkspacePath()) {
    for (const doc of docs()) {
      if (Number.isFinite(doc.size)) continue;
      const cachedSize = fileSizeMemoryCache.get(cacheKey(rootPath, doc.path));
      if (!Number.isFinite(cachedSize)) continue;
      doc.size = cachedSize;
      doc.sizeDeferred = false;
      doc.sizeLoading = false;
      doc.sizeError = "";
    }
  }

  function resetFileSizeHydration() {
    fileSizeObserver?.disconnect();
    fileSizeObserver = null;
    visibleFileSizePaths.clear();
    fileSizeHydrationVersion += 1;
    if (fileSizeHydrationTimer) {
      clearTimeout(fileSizeHydrationTimer);
      fileSizeHydrationTimer = null;
    }
  }

  function resetThumbnailHydration({ invalidateRequests = true } = {}) {
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    visibleThumbnailPaths.clear();
    if (invalidateRequests) thumbnailHydrationVersion += 1;
    if (thumbnailHydrationTimer) {
      clearTimeout(thumbnailHydrationTimer);
      thumbnailHydrationTimer = null;
    }
  }

  function beginRender(rootPath = getCurrentWorkspacePath()) {
    resetFileSizeHydration();
    const isSameThumbnailRoot = renderedThumbnailRootPath === rootPath;
    resetThumbnailHydration({ invalidateRequests: !isSameThumbnailRoot });
    renderedThumbnailRootPath = rootPath;
  }

  function setThumbnail(path, thumbnailUrl) {
    els.fileList.querySelectorAll("[data-thumbnail-path]").forEach((element) => {
      if (element.dataset.thumbnailPath !== path) return;
      element.classList.remove("loading", "failed", "ready");
      if (!thumbnailUrl) {
        element.classList.add("failed");
        return;
      }
      element.classList.add("ready");
      element.innerHTML = `<img src="${escapeHtml(thumbnailUrl)}" alt="">`;
    });
  }

  function setFileSizeText(path, text) {
    els.fileList.querySelectorAll("[data-file-size-path]").forEach((element) => {
      if (element.dataset.fileSizePath === path) {
        const doc = docs().find((item) => item.path === path);
        element.textContent = `${fileTypeLabel(doc || { kind: "file", name: path })} · ${text}`;
      }
    });
  }

  function updateFileSizeText(doc) {
    if (!doc?.path) return;
    setFileSizeText(doc.path, fileSizeDisplayText(doc));
  }

  function scheduleVisibleThumbnailHydration(delay = 850) {
    if (thumbnailHydrationTimer) clearTimeout(thumbnailHydrationTimer);
    const version = thumbnailHydrationVersion;
    thumbnailHydrationTimer = setTimeout(() => {
      thumbnailHydrationTimer = null;
      if (version !== thumbnailHydrationVersion) return;
      if (Date.now() - lastFileListScrollAt < delay) {
        scheduleVisibleThumbnailHydration(delay);
        return;
      }
      hydrateVisibleThumbnails(version).catch(() => {});
    }, delay);
  }

  function hasVisibleThumbnailWork(rootPath = getCurrentWorkspacePath()) {
    return [...visibleThumbnailPaths].some((path) => {
      const doc = docs().find((entry) => entry.path === path);
      return doc
        && (doc.kind === "image" || doc.kind === "video")
        && !doc.thumbnailUrl
        && !doc.thumbnailLoading
        && !pendingThumbnailPaths.has(cacheKey(rootPath, doc.path));
    });
  }

  function applyThumbnailResult(item, requestRootPath, stillCurrentBatch) {
    if (!item?.path) return;
    pendingThumbnailPaths.delete(cacheKey(requestRootPath, item.path));
    if (item.thumbnailUrl) rememberThumbnail(requestRootPath, item.path, item.thumbnailUrl);
    if (!stillCurrentBatch) return;
    const doc = docs().find((entry) => entry.path === item.path);
    if (!doc) return;
    doc.thumbnailLoading = false;
    if (item.imageSize) doc.imageSize = item.imageSize;
    if (item.thumbnailUrl) {
      doc.thumbnailUrl = item.thumbnailUrl;
      doc.thumbnailError = "";
      setThumbnail(doc.path, item.thumbnailUrl);
    } else {
      doc.thumbnailError = item.error || "生成失败";
      setThumbnail(doc.path, "");
    }
  }

  async function readThumbnailResultStream(response, onItem) {
    if (!response.body?.getReader) {
      const payload = await response.json();
      for (const item of payload.thumbnails || []) onItem(item);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onItem(JSON.parse(trimmed));
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail) onItem(JSON.parse(tail));
  }

  async function hydrateVisibleThumbnails(version = thumbnailHydrationVersion) {
    const currentWorkspacePath = getCurrentWorkspacePath();
    if (!currentWorkspacePath || version !== thumbnailHydrationVersion) return;
    if (thumbnailInFlightBatches >= maxThumbnailInFlightBatches) return;
    const requestRootPath = currentWorkspacePath;
    for (const path of visibleThumbnailPaths) {
      const doc = docs().find((entry) => entry.path === path);
      if (!doc || doc.thumbnailUrl) continue;
      const cachedThumbnail = thumbnailMemoryCache.get(cacheKey(requestRootPath, path));
      if (!cachedThumbnail) continue;
      doc.thumbnailUrl = cachedThumbnail;
      setThumbnail(path, cachedThumbnail);
    }

    const paths = [...visibleThumbnailPaths]
      .map((path) => docs().find((doc) => doc.path === path))
      .filter((doc) => doc && (doc.kind === "image" || doc.kind === "video") && !doc.thumbnailUrl && !doc.thumbnailLoading && !pendingThumbnailPaths.has(cacheKey(requestRootPath, doc.path)))
      .slice(0, thumbnailBatchSize)
      .map((doc) => doc.path);
    if (!paths.length) return;

    paths.forEach((path) => {
      const doc = docs().find((item) => item.path === path);
      if (!doc) return;
      pendingThumbnailPaths.add(cacheKey(requestRootPath, path));
      doc.thumbnailLoading = true;
      els.fileList.querySelectorAll("[data-thumbnail-path]").forEach((element) => {
        if (element.dataset.thumbnailPath === path) element.classList.add("loading");
      });
    });

    thumbnailInFlightBatches += 1;

    try {
      let requestError = null;
      try {
        const response = await apiFetch("/api/thumbnails", {
          method: "POST",
          headers: { "accept": "application/x-ndjson", "content-type": "application/json" },
          body: JSON.stringify({ dir: requestRootPath, paths }),
        });
        if (!response.ok) {
          let payload = {};
          try {
            payload = await response.json();
          } catch {
            // The streaming endpoint may fail before sending a JSON body.
          }
          throw new Error(payload.error || "读取缩略图失败");
        }
        await readThumbnailResultStream(response, (item) => {
          applyThumbnailResult(item, requestRootPath, version === thumbnailHydrationVersion && getCurrentWorkspacePath() === requestRootPath);
        });
      } catch (error) {
        requestError = error;
      }
      const stillCurrentBatch = version === thumbnailHydrationVersion && getCurrentWorkspacePath() === requestRootPath;

      if (requestError) {
        paths.forEach((path) => {
          pendingThumbnailPaths.delete(cacheKey(requestRootPath, path));
          if (!stillCurrentBatch) return;
          const doc = docs().find((entry) => entry.path === path);
          if (!doc) return;
          doc.thumbnailLoading = false;
          doc.thumbnailError = requestError.message || "生成失败";
          setThumbnail(doc.path, "");
        });
        if (stillCurrentBatch) scheduleVisibleThumbnailHydration(1200);
        return;
      }

      for (const path of paths) {
        const doc = docs().find((entry) => entry.path === path);
        pendingThumbnailPaths.delete(cacheKey(requestRootPath, path));
        if (stillCurrentBatch && doc?.thumbnailLoading) {
          doc.thumbnailLoading = false;
          doc.thumbnailError = "生成失败";
          setThumbnail(doc.path, "");
        }
      }

      if (stillCurrentBatch && hasVisibleThumbnailWork(requestRootPath)) {
        scheduleVisibleThumbnailHydration(220);
      }
    } finally {
      thumbnailInFlightBatches = Math.max(0, thumbnailInFlightBatches - 1);
    }
  }

  function scheduleVisibleFileSizeHydration(delay = 650) {
    if (fileSizeHydrationTimer) clearTimeout(fileSizeHydrationTimer);
    const version = fileSizeHydrationVersion;
    fileSizeHydrationTimer = setTimeout(() => {
      fileSizeHydrationTimer = null;
      if (version !== fileSizeHydrationVersion) return;
      if (Date.now() - lastFileListScrollAt < delay) {
        scheduleVisibleFileSizeHydration(delay);
        return;
      }
      hydrateVisibleFileSizes(version).catch(() => {});
    }, delay);
  }

  async function hydrateVisibleFileSizes(version = fileSizeHydrationVersion) {
    const currentWorkspacePath = getCurrentWorkspacePath();
    if (!currentWorkspacePath || version !== fileSizeHydrationVersion) return;
    for (const path of visibleFileSizePaths) {
      const doc = docs().find((entry) => entry.path === path);
      if (!doc || Number.isFinite(doc.size)) continue;
      const cachedSize = fileSizeMemoryCache.get(cacheKey(currentWorkspacePath, path));
      if (!Number.isFinite(cachedSize)) continue;
      doc.size = cachedSize;
      doc.sizeDeferred = false;
      doc.sizeLoading = false;
      doc.sizeError = "";
      setFileSizeText(path, fileSizeDisplayText(doc));
    }

    const paths = [...visibleFileSizePaths]
      .map((path) => docs().find((doc) => doc.path === path))
      .filter((doc) => doc && !Number.isFinite(doc.size) && !doc.sizeLoading && !pendingFileSizePaths.has(cacheKey(currentWorkspacePath, doc.path)))
      .slice(0, fileSizeBatchSize)
      .map((doc) => doc.path);
    if (!paths.length) return;

    paths.forEach((path) => {
      const doc = docs().find((item) => item.path === path);
      if (!doc) return;
      pendingFileSizePaths.add(cacheKey(currentWorkspacePath, path));
      doc.sizeLoading = true;
      setFileSizeText(path, fileSizeDisplayText(doc));
    });

    const response = await apiFetch("/api/file-sizes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: currentWorkspacePath, paths }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "读取文件大小失败");
    if (version !== fileSizeHydrationVersion) return;

    for (const item of payload.sizes || []) {
      const doc = docs().find((entry) => entry.path === item.path);
      if (!doc) continue;
      doc.sizeLoading = false;
      if (Number.isFinite(item.size)) {
        doc.size = item.size;
        doc.sizeDeferred = false;
        doc.sizeError = "";
        rememberFileSize(currentWorkspacePath, doc.path, item.size);
      } else {
        doc.sizeError = item.error || "读取失败";
      }
      pendingFileSizePaths.delete(cacheKey(currentWorkspacePath, doc.path));
      setFileSizeText(doc.path, fileSizeDisplayText(doc));
    }

    for (const path of paths) {
      const doc = docs().find((entry) => entry.path === path);
      pendingFileSizePaths.delete(cacheKey(currentWorkspacePath, path));
      if (doc?.sizeLoading) {
        doc.sizeLoading = false;
        doc.sizeError = "读取失败";
        setFileSizeText(doc.path, fileSizeDisplayText(doc));
      }
    }

    if ([...visibleFileSizePaths].some((path) => {
      const doc = docs().find((entry) => entry.path === path);
      return doc && !Number.isFinite(doc.size) && !doc.sizeLoading;
    })) {
      scheduleVisibleFileSizeHydration(350);
    }
  }

  function setupFileSizeObserver() {
    fileSizeObserver?.disconnect();
    fileSizeObserver = null;
    visibleFileSizePaths.clear();
    const candidates = els.fileList.querySelectorAll("[data-file-path][data-size-deferred='true']");
    if (!candidates.length) return;

    fileSizeObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = entry.target.dataset.filePath;
        if (!path) continue;
        if (entry.isIntersecting) visibleFileSizePaths.add(path);
        else visibleFileSizePaths.delete(path);
      }
      scheduleVisibleFileSizeHydration();
    }, {
      root: els.fileList,
      rootMargin: "48px 0px",
      threshold: 0.6,
    });

    candidates.forEach((item) => fileSizeObserver.observe(item));
    scheduleVisibleFileSizeHydration();
  }

  function setupThumbnailObserver() {
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    visibleThumbnailPaths.clear();
    const candidates = els.fileList.querySelectorAll("[data-thumbnail-path][data-thumbnail-deferred='true']");
    if (!candidates.length) return;

    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = entry.target.dataset.thumbnailPath;
        if (!path) continue;
        if (entry.isIntersecting) visibleThumbnailPaths.add(path);
        else visibleThumbnailPaths.delete(path);
      }
      scheduleVisibleThumbnailHydration();
    }, {
      root: els.fileList,
      rootMargin: "72px 0px",
      threshold: 0.55,
    });

    candidates.forEach((item) => thumbnailObserver.observe(item));
    scheduleVisibleThumbnailHydration();
  }

  function setupObservers() {
    setupFileSizeObserver();
    setupThumbnailObserver();
  }

  function markScrolled() {
    lastFileListScrollAt = Date.now();
    scheduleVisibleFileSizeHydration();
    scheduleVisibleThumbnailHydration();
  }

  return {
    applyCachedFileSizes,
    beginRender,
    fileSizeDisplayText,
    getCachedThumbnail,
    markScrolled,
    rememberFileSize,
    rememberThumbnail,
    resetFileSizeHydration,
    resetThumbnailHydration,
    scheduleVisibleThumbnailHydration,
    setupObservers,
    updateFileSizeText,
  };
}
