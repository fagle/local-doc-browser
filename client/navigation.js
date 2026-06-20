export function createNavigationController({
  els,
  escapeHtml,
  getActiveId,
  getCurrentWorkspacePath,
  joinWorkspacePath,
  maxRecentItems = 8,
  openFolder,
  recentStorageKey,
  setPendingFilePath,
  splitWorkspacePath,
}) {
  function renderPathBreadcrumbs(path = getCurrentWorkspacePath()) {
    const value = String(path || "").trim();
    if (!els.pathBreadcrumbs) return;
    els.pathBreadcrumbs.innerHTML = "";
    els.pathBreadcrumbs.classList.toggle("is-empty", !value);
    els.editPath.textContent = value ? "更改" : "输入";
    els.editPath.title = value ? "编辑当前路径" : "输入要打开的路径";
    if (!value) {
      els.pathBreadcrumbs.innerHTML = '<span class="path-placeholder">未打开路径</span>';
      return;
    }

    const { root, separator, segments } = splitWorkspacePath(value);
    const crumbs = [];
    if (root) crumbs.push({ label: root, path: joinWorkspacePath(root, [], separator) });
    segments.forEach((segment, index) => {
      crumbs.push({
        label: segment,
        path: joinWorkspacePath(root, segments.slice(0, index + 1), separator),
      });
    });

    renderPathCrumbs(crumbs, { compact: false });
    if (!pathTrailFits()) renderPathCrumbs(crumbs, { compact: true });
  }

  function compactTrailCrumbs(crumbs) {
    if (crumbs.length <= 3) {
      return crumbs.map((crumb, index) => ({
        crumb,
        className: index === crumbs.length - 1 ? "current" : "",
        isCurrent: index === crumbs.length - 1,
      }));
    }

    const rootCrumb = crumbs[0];
    const hiddenCrumbs = crumbs.slice(1, -1);
    const currentCrumb = crumbs.at(-1);
    return [
      { crumb: rootCrumb, className: "root" },
      { type: "overflow", crumbs: hiddenCrumbs },
      { crumb: currentCrumb, className: "current", isCurrent: true },
    ];
  }

  function renderPathCrumbs(crumbs, { compact = false } = {}) {
    const fragment = document.createDocumentFragment();
    const trailCrumbs = compact
      ? compactTrailCrumbs(crumbs)
      : crumbs.map((crumb, index) => ({
          crumb,
          className: index === 0 ? "root" : index === crumbs.length - 1 ? "current" : "",
          isCurrent: index === crumbs.length - 1,
        }));
    if (trailCrumbs.length) fragment.append(pathTrailNode(trailCrumbs, compact));

    els.pathBreadcrumbs.classList.toggle("is-compact-path", compact);
    els.pathBreadcrumbs.replaceChildren(fragment);
  }

  function pathTrailFits() {
    const trail = els.pathBreadcrumbs.querySelector(".path-trail");
    if (!trail) return true;
    const availableWidth = trail.getBoundingClientRect().width;
    const trailHeight = trail.getBoundingClientRect().height;
    return trail.scrollWidth <= Math.ceil(availableWidth) + 1 || trailHeight <= 42;
  }

  function pathTrailNode(trailCrumbs, compact = false) {
    const trail = document.createElement("span");
    trail.className = `path-trail${compact ? " compact" : " full"}`;
    trailCrumbs.forEach((item, index) => {
      if (index > 0) trail.append(pathSeparatorNode());
      if (item.type === "overflow") {
        trail.append(pathOverflowNode(item.crumbs));
      } else {
        trail.append(pathCrumbNode(item.crumb, item.className, Boolean(item.isCurrent)));
      }
    });
    return trail;
  }

  function pathSeparatorNode() {
    const separatorNode = document.createElement("span");
    separatorNode.className = "path-separator";
    separatorNode.textContent = "›";
    return separatorNode;
  }

  function pathCrumbNode(crumb, className = "", isCurrent = false) {
    const button = document.createElement("button");
    button.className = `path-crumb${className ? ` ${className}` : ""}`;
    button.type = "button";
    button.textContent = crumb.label;
    button.title = crumb.path;
    button.disabled = isCurrent;
    if (!isCurrent) button.addEventListener("click", () => openFolder(crumb.path));
    return button;
  }

  function pathOverflowNode(hiddenCrumbs) {
    const wrapper = document.createElement("span");
    wrapper.className = "path-overflow";
    const button = document.createElement("button");
    button.className = "path-overflow-button";
    button.type = "button";
    button.textContent = "...";
    button.title = hiddenCrumbs.map((crumb) => crumb.label).join(" / ");
    button.setAttribute("aria-label", "显示中间路径");
    const menu = document.createElement("span");
    menu.className = "path-overflow-menu";
    menu.hidden = true;
    hiddenCrumbs.forEach((crumb) => {
      const item = document.createElement("button");
      item.className = "path-overflow-item";
      item.type = "button";
      item.textContent = crumb.label;
      item.title = crumb.path;
      item.addEventListener("click", () => openFolder(crumb.path));
      menu.append(item);
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeOverflowMenus(menu);
      menu.hidden = !menu.hidden;
    });
    wrapper.append(button, menu);
    return wrapper;
  }

  function closeOverflowMenus(except = null) {
    els.pathBreadcrumbs?.querySelectorAll(".path-overflow-menu").forEach((existing) => {
      if (existing !== except) existing.hidden = true;
    });
  }

  function setPathEditorVisible(visible, { focus = false } = {}) {
    const shouldShow = Boolean(visible || !getCurrentWorkspacePath());
    els.pathEditor.hidden = !shouldShow;
    els.editPath.classList.toggle("active", shouldShow);
    if (focus && shouldShow) {
      requestAnimationFrame(() => {
        els.folderPath.focus();
        els.folderPath.select();
      });
    }
  }

  function updateAddress(filePath = getActiveId()) {
    const params = new URLSearchParams();
    const currentWorkspacePath = getCurrentWorkspacePath();
    if (currentWorkspacePath) params.set("dir", currentWorkspacePath);
    if (filePath) params.set("file", filePath);
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }

  function readRecentItems() {
    try {
      const value = JSON.parse(localStorage.getItem(recentStorageKey) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeRecentItems(items) {
    localStorage.setItem(recentStorageKey, JSON.stringify(items.slice(0, maxRecentItems)));
  }

  function recentKey(item) {
    return item.type === "file" ? `file:${item.dir}:${item.file}` : `dir:${item.dir}`;
  }

  function addRecentItem(item) {
    if (!item.dir) return;
    const nextItem = { ...item, openedAt: Date.now() };
    const items = [nextItem, ...readRecentItems().filter((existing) => recentKey(existing) !== recentKey(nextItem))];
    writeRecentItems(items);
    renderRecentList();
    renderStartPageIfIdle();
  }

  function openRecentItem(item) {
    if (!item?.dir) return;
    setPendingFilePath(item.type === "file" ? item.file : "");
    openFolder(item.dir, { remember: false });
  }

  function renderStartPageIfIdle() {
    if (getCurrentWorkspacePath() || getActiveId()) return;
    els.preview.innerHTML = renderStartPage();
  }

  function renderRecentList() {
    const items = readRecentItems();
    els.recentToggle.classList.toggle("has-recent", items.length > 0);
    els.recentList.innerHTML = "";

    if (!items.length) {
      els.recentList.innerHTML = '<div class="recent-empty">暂无记录</div>';
      return;
    }

    items.forEach((item) => {
      const title = item.type === "file" ? item.name || item.file : item.name || item.dir;
      const path = item.type === "file" ? item.dir : item.dir;
      const button = document.createElement("button");
      button.className = "recent-item";
      button.type = "button";
      button.title = item.type === "file" ? `${item.file}\n${item.dir}` : item.dir;
      button.innerHTML = `
        <span class="recent-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <span class="recent-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      `;
      button.addEventListener("click", () => {
        els.recentPopover.hidden = true;
        openRecentItem(item);
      });
      els.recentList.append(button);
    });
  }

  function renderStartPage() {
    const items = readRecentItems().slice(0, 6);
    if (!items.length) {
      return '<div class="empty-state">从左侧输入路径，或点击最近记录开始浏览</div>';
    }

    return `
      <section class="start-page">
        <div class="start-page-header">
          <span class="video-decision-kicker">最近打开</span>
          <h3>继续浏览</h3>
        </div>
        <div class="start-recent-grid">
          ${items.map((item, index) => {
            const title = item.type === "file" ? item.name || item.file : item.name || item.dir;
            const path = item.type === "file" ? `${item.dir}${item.file ? ` / ${item.file}` : ""}` : item.dir;
            return `
              <button type="button" class="start-recent-card" data-start-recent-index="${index}" title="${escapeHtml(path)}">
                <span>${escapeHtml(title)}</span>
                <small>${escapeHtml(path)}</small>
              </button>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function folderDisplayName(path = "") {
    const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || path || "未打开路径";
  }

  return {
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
  };
}
