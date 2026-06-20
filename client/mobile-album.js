export function createMobileAlbumController({
  els,
  escapeHtml,
  filteredDirs,
  folderDisplayName,
  getState,
  onOpenChange = () => {},
  openFolder,
  openRecentItem,
  readRecentItems,
  setMobilePhotoFullscreen,
}) {
  function dirButton(dir, label = dir?.name || folderDisplayName(dir?.path), className = "") {
    return `
      <button type="button" class="mobile-album-row${className ? ` ${className}` : ""}" data-mobile-dir="${escapeHtml(dir.path)}" title="${escapeHtml(dir.path)}">
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(dir.path)}</small>
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

  function renderSheet() {
    if (!els.mobileAlbumContent) return;
    const { currentWorkspacePath, parentPath } = getState();
    const recent = readRecentItems().slice(0, 5);
    const visibleDirs = filteredDirs();
    els.mobileAlbumContent.innerHTML = `
      <section class="mobile-album-section mobile-album-current-section">
        <span class="mobile-album-kicker">当前</span>
        <div class="mobile-album-current" title="${escapeHtml(currentWorkspacePath)}">${escapeHtml(currentWorkspacePath || "未打开路径")}</div>
        ${parentPath ? dirButton({ path: parentPath, name: "上级目录" }, "返回上级目录", "parent mobile-album-up") : ""}
        <form class="mobile-album-path-form" data-mobile-album-path-form>
          <input name="path" value="${escapeHtml(currentWorkspacePath)}" placeholder="输入文件夹路径" autocomplete="off" />
          <button type="submit">打开</button>
        </form>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">文件夹</span>
        <div class="mobile-album-rows">
          ${visibleDirs.length ? visibleDirs.map((dir) => dirButton(dir)).join("") : '<div class="mobile-album-empty">当前目录没有子文件夹</div>'}
        </div>
      </section>
      <section class="mobile-album-section">
        <span class="mobile-album-kicker">最近</span>
        <div class="mobile-album-rows">
          ${recent.length ? recent.map((item, index) => {
            const title = item.type === "file" ? item.name || item.file : item.name || folderDisplayName(item.dir);
            return `
              <button type="button" class="mobile-album-row" data-mobile-recent-index="${index}" title="${escapeHtml(item.dir)}">
                <span>${escapeHtml(title)}</span>
                <small>${escapeHtml(item.dir || "")}</small>
              </button>
            `;
          }).join("") : '<div class="mobile-album-empty">暂无最近记录</div>'}
        </div>
      </section>
    `;
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
        setOpen(false, { history: true });
        openFolder(dirButtonElement.dataset.mobileDir);
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
