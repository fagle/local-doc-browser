export function createMobileAlbumController({
  els,
  escapeHtml,
  filteredDirs,
  folderDisplayName,
  getState,
  loadFolderSnapshot,
  onOpenChange = () => {},
  openFolder,
  openRecentItem,
  readRecentItems,
  selectDoc,
  setMobilePhotoFullscreen,
}) {
  const siblingDirCache = new Map();

  function comparablePath(value = "") {
    return String(value || "").replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
  }

  function siblingCacheKey(value = "") {
    return comparablePath(value);
  }

  function dirButton(dir, label = dir?.name || folderDisplayName(dir?.path), className = "", options = {}) {
    const current = Boolean(options.current);
    return `
      <button type="button" class="mobile-album-row${className ? ` ${className}` : ""}${current ? " current" : ""}" data-mobile-dir="${escapeHtml(dir.path)}" title="${escapeHtml(dir.path)}"${current ? ' aria-current="true"' : ""}>
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(dir.path)}</small>
      </button>
    `;
  }

  function fileButton(doc, label, className = "", activeId = "") {
    if (!doc) return "";
    const active = doc.id === activeId;
    return `
      <button type="button" class="mobile-album-row mobile-album-file${className ? ` ${className}` : ""}${active ? " current" : ""}" data-mobile-doc-id="${escapeHtml(doc.id)}" title="${escapeHtml(doc.path || doc.name)}"${active ? ' aria-current="true"' : ""}>
        <span>${escapeHtml(label || doc.name)}</span>
        <small>${escapeHtml(doc.name || doc.path || "")}</small>
      </button>
    `;
  }

  function renderNav() {
    if (!els.mobileAlbumLabel) return;
    const { currentWorkspacePath, workspaceName } = getState();
    els.mobileAlbumLabel.textContent = workspaceName || folderDisplayName(currentWorkspacePath);
    els.mobileAlbumToggle.disabled = !currentWorkspacePath;
    if (els.mobileAlbumBrowse) els.mobileAlbumBrowse.disabled = !currentWorkspacePath;
  }

  function renderRecentRows(recent) {
    return recent.length ? recent.map((item, index) => {
      const title = item.type === "file" ? item.name || item.file : item.name || folderDisplayName(item.dir);
      return `
        <button type="button" class="mobile-album-row" data-mobile-recent-index="${index}" title="${escapeHtml(item.dir)}">
          <span>${escapeHtml(title)}</span>
          <small>${escapeHtml(item.dir || "")}</small>
        </button>
      `;
    }).join("") : '<div class="mobile-album-empty">暂无最近记录</div>';
  }

  function renderDocumentRows(docs, activeId) {
    return docs.length
      ? docs.map((doc) => fileButton(doc, doc.name, "", activeId)).join("")
      : '<div class="mobile-album-empty">当前目录没有可切换的文件</div>';
  }

  function siblingWindow(siblingDirs, currentWorkspacePath, limit = 18) {
    const currentKey = comparablePath(currentWorkspacePath);
    const dirs = siblingDirs.filter((dir) => dir?.path);
    const currentIndex = dirs.findIndex((dir) => comparablePath(dir.path) === currentKey);
    const fallbackCurrent = {
      name: folderDisplayName(currentWorkspacePath) || "当前相册",
      path: currentWorkspacePath,
    };
    if (!dirs.length) return currentWorkspacePath ? [fallbackCurrent] : [];
    if (currentIndex < 0) return currentWorkspacePath ? [fallbackCurrent, ...dirs.slice(0, limit - 1)] : dirs.slice(0, limit);
    if (dirs.length <= limit) return dirs;
    const half = Math.floor(limit / 2);
    const start = Math.max(0, Math.min(currentIndex - half, dirs.length - limit));
    return dirs.slice(start, start + limit);
  }

  function siblingState(parentPath) {
    if (!parentPath || !loadFolderSnapshot) return { status: "idle", dirs: [], error: "" };
    return siblingDirCache.get(siblingCacheKey(parentPath)) || { status: "idle", dirs: [], error: "" };
  }

  function ensureSiblingDirs(parentPath) {
    if (!parentPath || !loadFolderSnapshot) return;
    const key = siblingCacheKey(parentPath);
    const cached = siblingDirCache.get(key);
    if (cached?.status === "loading" || cached?.status === "ready") return;
    siblingDirCache.set(key, { status: "loading", dirs: [], error: "" });
    loadFolderSnapshot(parentPath)
      .then((payload) => {
        siblingDirCache.set(key, { status: "ready", dirs: payload?.dirs || [], error: "" });
        const latest = getState();
        if (isOpen() && siblingCacheKey(latest.parentPath) === key) renderSheet();
      })
      .catch((error) => {
        siblingDirCache.set(key, { status: "error", dirs: [], error: error?.message || "同级相册读取失败" });
        const latest = getState();
        if (isOpen() && siblingCacheKey(latest.parentPath) === key) renderSheet();
      });
  }

  function setSheetMode(mode) {
    els.mobileAlbumContent.classList.toggle("mobile-album-photo-mode", mode === "photo");
    els.mobileAlbumContent.classList.toggle("mobile-album-document-mode", mode === "document");
    const headerKicker = els.mobileAlbumSheet?.querySelector(".mobile-album-header span");
    const headerTitle = els.mobileAlbumSheet?.querySelector(".mobile-album-header strong");
    if (headerKicker) headerKicker.textContent = mode === "photo" ? "相册" : "导航";
    if (headerTitle) headerTitle.textContent = mode === "photo" ? "切换文件夹" : "切换";
  }

  function renderPhotoSheet({ currentWorkspacePath, parentPath, recent, siblingDirs, siblingStatus, siblingError, visibleDirs }) {
    setSheetMode("photo");
    const currentKey = comparablePath(currentWorkspacePath);
    const nearbyDirs = siblingWindow(siblingDirs, currentWorkspacePath);
    els.mobileAlbumContent.innerHTML = `
      <section class="mobile-album-section mobile-album-current-section">
        <span class="mobile-album-kicker">当前相册</span>
        <div class="mobile-album-current mobile-album-photo-current" title="${escapeHtml(currentWorkspacePath)}">
          <strong>${escapeHtml(folderDisplayName(currentWorkspacePath) || "未打开路径")}</strong>
          <small>${escapeHtml(currentWorkspacePath || "")}</small>
        </div>
        ${parentPath ? dirButton({ path: parentPath, name: "上级目录" }, "返回上级目录", "parent mobile-album-up") : ""}
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">同级相册</span>
        <div class="mobile-album-rows mobile-album-sibling-dirs">
          ${nearbyDirs.length
            ? nearbyDirs.map((dir) => dirButton(dir, undefined, "mobile-album-dir mobile-album-sibling", { current: comparablePath(dir.path) === currentKey })).join("")
            : siblingStatus === "loading"
              ? '<div class="mobile-album-empty">正在读取同级相册...</div>'
              : `<div class="mobile-album-empty">${escapeHtml(siblingError || "没有找到同级相册")}</div>`}
        </div>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">子相册</span>
        <div class="mobile-album-rows mobile-album-photo-dirs">
          ${visibleDirs.length ? visibleDirs.map((dir) => dirButton(dir, undefined, "mobile-album-dir")).join("") : '<div class="mobile-album-empty">当前相册没有子相册</div>'}
        </div>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">最近</span>
        <div class="mobile-album-rows">${renderRecentRows(recent)}</div>
      </section>
      <section class="mobile-album-section mobile-album-manual-section">
        <details>
          <summary>输入路径</summary>
          <form class="mobile-album-path-form" data-mobile-album-path-form>
            <input name="path" value="${escapeHtml(currentWorkspacePath)}" placeholder="输入文件夹路径" autocomplete="off" />
            <button type="submit">打开</button>
          </form>
        </details>
      </section>
    `;
  }

  function renderDocumentSheet({ activeId, currentWorkspacePath, docs, parentPath, recent, visibleDirs }) {
    setSheetMode("document");
    const activeIndex = docs.findIndex((doc) => doc.id === activeId);
    const currentDoc = activeIndex >= 0 ? docs[activeIndex] : null;
    els.mobileAlbumContent.innerHTML = `
      <section class="mobile-album-section mobile-album-current-section">
        <span class="mobile-album-kicker">当前位置</span>
        <div class="mobile-album-current" title="${escapeHtml(currentWorkspacePath)}">
          <strong>${escapeHtml(folderDisplayName(currentWorkspacePath) || "未打开路径")}</strong>
          <small>${escapeHtml(currentWorkspacePath || "")}</small>
        </div>
        ${currentDoc ? `
          <div class="mobile-album-current-file">
            <span>当前文件</span>
            <strong title="${escapeHtml(currentDoc.name)}">${escapeHtml(currentDoc.name)}</strong>
          </div>
        ` : ""}
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">当前目录文件</span>
        <div class="mobile-album-rows mobile-album-document-list">
          ${renderDocumentRows(docs, activeId)}
        </div>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">目录</span>
        <div class="mobile-album-rows">
          ${parentPath ? dirButton({ path: parentPath, name: "上级目录" }, "返回上级目录", "parent mobile-album-up") : ""}
          ${visibleDirs.length ? visibleDirs.map((dir) => dirButton(dir)).join("") : '<div class="mobile-album-empty">当前目录没有子文件夹</div>'}
        </div>
      </section>
      <section class="mobile-album-section mobile-album-manual-section">
        <details>
          <summary>手动输入路径</summary>
          <form class="mobile-album-path-form" data-mobile-album-path-form>
            <input name="path" value="${escapeHtml(currentWorkspacePath)}" placeholder="输入文件夹路径" autocomplete="off" />
            <button type="submit">打开</button>
          </form>
        </details>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">最近</span>
        <div class="mobile-album-rows">${renderRecentRows(recent)}</div>
      </section>
    `;
    requestAnimationFrame(() => {
      const list = els.mobileAlbumContent.querySelector(".mobile-album-document-list");
      const current = list?.querySelector(".mobile-album-file.current");
      if (!list || !current) return;
      list.scrollTop = current.offsetTop - list.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
    });
  }

  function renderSheet() {
    if (!els.mobileAlbumContent) return;
    const { activeId, currentWorkspacePath, docs = [], isPhotoMode, parentPath } = getState();
    const recent = readRecentItems().slice(0, 5);
    const visibleDirs = filteredDirs();
    if (isPhotoMode) {
      const siblings = siblingState(parentPath);
      renderPhotoSheet({
        currentWorkspacePath,
        parentPath,
        recent,
        siblingDirs: siblings.dirs || [],
        siblingError: siblings.error || "",
        siblingStatus: siblings.status,
        visibleDirs,
      });
      ensureSiblingDirs(parentPath);
      return;
    }
    renderDocumentSheet({ activeId, currentWorkspacePath, docs, parentPath, recent, visibleDirs });
  }

  function isOpen() {
    return Boolean(els.mobileAlbumSheet && !els.mobileAlbumSheet.hidden);
  }

  function setOpen(open, options = {}) {
    if (!els.mobileAlbumSheet) return;
    const previous = isOpen();
    if (open) renderSheet();
    els.mobileAlbumSheet.hidden = !open;
    document.body.classList.toggle("mobile-album-sheet-open", Boolean(open));
    if (previous !== Boolean(open)) onOpenChange(Boolean(open), options);
  }

  function bind() {
    const openSheet = () => {
      setMobilePhotoFullscreen(false);
      setOpen(true, { history: true });
    };

    els.mobileAlbumToggle?.addEventListener("click", openSheet);
    els.mobileAlbumBrowse?.addEventListener("click", openSheet);

    els.mobileAlbumClose?.addEventListener("click", () => setOpen(false, { history: true }));
    els.mobileAlbumScrim?.addEventListener("click", () => setOpen(false, { history: true }));

    els.mobileAlbumSheet?.addEventListener("click", (event) => {
      const dirButtonElement = event.target.closest?.("[data-mobile-dir]");
      if (dirButtonElement) {
        if (dirButtonElement.getAttribute("aria-current") === "true") return;
        setOpen(false, { history: true });
        openFolder(dirButtonElement.dataset.mobileDir);
        return;
      }

      const docButton = event.target.closest?.("[data-mobile-doc-id]");
      if (docButton) {
        setOpen(false, { history: true });
        selectDoc?.(docButton.dataset.mobileDocId);
        return;
      }

      const recentButton = event.target.closest?.("[data-mobile-recent-index]");
      if (recentButton) {
        const item = readRecentItems()[Number(recentButton.dataset.mobileRecentIndex)];
        setOpen(false, { history: true });
        openRecentItem(item);
      }
    });

    els.mobileAlbumSheet?.addEventListener("submit", (event) => {
      const form = event.target.closest?.("[data-mobile-album-path-form]");
      if (!form) return;
      event.preventDefault();
      const value = new FormData(form).get("path")?.toString().trim();
      if (value) {
        setOpen(false, { history: true });
        openFolder(value);
      }
    });
  }

  return { bind, isOpen, renderNav, renderSheet, setOpen };
}
