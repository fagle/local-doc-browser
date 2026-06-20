export function createDesktopShellController({
  els,
  renderPathBreadcrumbs,
  renderRecentList,
  renderStartPageIfIdle,
  sidebarWidthStorageKey,
  themeStorageKey,
  writeRecentItems,
}) {
  function sidebarWidthBounds() {
    const max = Math.max(320, Math.floor(window.innerWidth * 0.55));
    return { min: 240, max };
  }

  function applySidebarWidth(value) {
    const { min, max } = sidebarWidthBounds();
    const width = Math.max(min, Math.min(max, Number(value) || 340));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    return width;
  }

  function readSidebarWidth() {
    return Number(localStorage.getItem(sidebarWidthStorageKey) || 340);
  }

  function persistWidth(width) {
    localStorage.setItem(sidebarWidthStorageKey, String(width));
  }

  function bindResizableSidebar() {
    applySidebarWidth(readSidebarWidth());
    let dragStartX = 0;
    let dragStartWidth = 0;

    const resizeSidebar = (event) => {
      const width = applySidebarWidth(dragStartWidth + event.clientX - dragStartX);
      persistWidth(width);
      renderPathBreadcrumbs();
    };

    const stopResize = (event) => {
      if (event.pointerId !== undefined && els.splitter.hasPointerCapture?.(event.pointerId)) {
        els.splitter.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", resizeSidebar);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      persistWidth(applySidebarWidth(readSidebarWidth()));
    };

    els.splitter.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 820) return;
      dragStartX = event.clientX;
      dragStartWidth = readSidebarWidth();
      document.body.classList.add("resizing-sidebar");
      els.splitter.setPointerCapture?.(event.pointerId);
      window.addEventListener("pointermove", resizeSidebar);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    });

    els.splitter.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const { min, max } = sidebarWidthBounds();
      const step = event.shiftKey ? 40 : 16;
      let next = readSidebarWidth();
      if (event.key === "ArrowLeft") next -= step;
      if (event.key === "ArrowRight") next += step;
      if (event.key === "Home") next = min;
      if (event.key === "End") next = max;
      persistWidth(applySidebarWidth(next));
    });

    window.addEventListener("resize", () => {
      persistWidth(applySidebarWidth(readSidebarWidth()));
      renderPathBreadcrumbs();
    });
  }

  function bindRecentMenu() {
    els.recentToggle.addEventListener("click", () => {
      els.recentPopover.hidden = !els.recentPopover.hidden;
    });

    els.clearRecent.addEventListener("click", () => {
      writeRecentItems([]);
      renderRecentList();
      renderStartPageIfIdle();
    });

    document.addEventListener("click", (event) => {
      if (els.recentPopover.hidden) return;
      if (els.recentPopover.contains(event.target) || els.recentToggle.contains(event.target)) return;
      els.recentPopover.hidden = true;
    });
  }

  function bindThemeToggle() {
    els.themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      localStorage.setItem(themeStorageKey, document.body.classList.contains("dark") ? "dark" : "light");
    });
  }

  function applyInitialTheme() {
    if (localStorage.getItem(themeStorageKey) === "dark") {
      document.body.classList.add("dark");
    }
  }

  function bind() {
    bindResizableSidebar();
    bindRecentMenu();
    bindThemeToggle();
  }

  return {
    applyInitialTheme,
    bind,
  };
}
