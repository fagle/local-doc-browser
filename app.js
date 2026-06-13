let docs = [];
let dirs = [];
let activeId = null;
let workspaceName = "";
let parentPath = "";
let htmlViewMode = "preview";
let currentWorkspacePath = "";
let pendingFilePath = new URLSearchParams(window.location.search).get("file") || "";
const recentStorageKey = "local-doc-browser-recent";
const maxRecentItems = 8;

const els = {
  openFolder: document.querySelector("#openFolder"),
  folderPath: document.querySelector("#folderPath"),
  searchInput: document.querySelector("#searchInput"),
  recentToggle: document.querySelector("#recentToggle"),
  recentPopover: document.querySelector("#recentPopover"),
  recentList: document.querySelector("#recentList"),
  clearRecent: document.querySelector("#clearRecent"),
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  closeWorkspace: document.querySelector("#closeWorkspace"),
  docPath: document.querySelector("#docPath"),
  docTitle: document.querySelector("#docTitle"),
  preview: document.querySelector("#preview"),
  htmlMode: document.querySelector("#htmlMode"),
  htmlSourceMode: document.querySelector("#htmlSourceMode"),
  htmlPreviewMode: document.querySelector("#htmlPreviewMode"),
  themeToggle: document.querySelector("#themeToggle"),
  copyMarkdown: document.querySelector("#copyMarkdown"),
  downloadHtml: document.querySelector("#downloadHtml"),
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function getTitle(content, fallback) {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : titleFromName(fallback);
}

function titleFromName(name) {
  return name.replace(/\.[^.]+$/i, "");
}

function isMarkdown(doc) {
  return doc.kind === "markdown" || /\.(md|markdown)$/i.test(doc.name);
}

function isImage(doc) {
  return doc.kind === "image";
}

function isHtml(doc) {
  return /\.(html|htm)$/i.test(doc.name);
}

function updateAddress(filePath = activeId) {
  const params = [];
  if (currentWorkspacePath) params.push(`dir=${currentWorkspacePath}`);
  if (filePath) params.push(`file=${filePath}`);
  const query = params.join("&");
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
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
    const button = document.createElement("button");
    button.className = "recent-item";
    button.type = "button";
    button.innerHTML = `
      <span class="recent-title">${escapeHtml(item.type === "file" ? item.name || item.file : item.name || item.dir)}</span>
      <span class="recent-path">${escapeHtml(item.type === "file" ? item.dir : item.dir)}</span>
    `;
    button.addEventListener("click", () => {
      els.recentPopover.hidden = true;
      pendingFilePath = item.type === "file" ? item.file : "";
      openFolder(item.dir, { remember: false });
    });
    els.recentList.append(button);
  });
}

function renderHtmlModeControl(doc) {
  els.htmlMode.hidden = !doc || !isHtml(doc);
  els.htmlSourceMode.classList.toggle("active", htmlViewMode === "source");
  els.htmlPreviewMode.classList.toggle("active", htmlViewMode === "preview");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function renderTable(lines) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => inlineMarkdown(cell.trim())),
  );
  const header = rows[0].map((cell) => `<th>${cell}</th>`).join("");
  const body = rows
    .slice(2)
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let code = null;
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list) {
      html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
      list = null;
    }
  };

  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${quote.map((line) => `<p>${inlineMarkdown(line)}</p>`).join("")}</blockquote>`);
      quote = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (code) {
      if (/^```/.test(line)) {
        html.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      code = { lines: [] };
      continue;
    }

    const tableBlock = [line];
    while (index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index + 1])) {
      tableBlock.push(lines[index + 1]);
      index += 1;
    }
    if (tableBlock.length >= 3 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableBlock[1])) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push(renderTable(tableBlock));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = unordered ? "ul" : "ol";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (code) html.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  return html.join("\n") || '<div class="empty-state">这个文档是空的</div>';
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

function renderFileList() {
  const visibleDocs = filteredDocs();
  const visibleDirs = filteredDirs();
  els.fileCount.textContent = workspaceName ? `${workspaceName} · ${visibleDirs.length} 个文件夹 · ${visibleDocs.length} 个文档` : "未打开文件夹";
  els.fileList.innerHTML = "";

  if (parentPath && !els.searchInput.value.trim()) {
    const button = document.createElement("button");
    button.className = "file-item folder-item parent-item";
    button.type = "button";
    button.innerHTML = `
      <span class="file-title">[..] 上级目录</span>
      <span class="file-size">返回</span>
      <span class="file-path">${escapeHtml(parentPath)}</span>
    `;
    button.addEventListener("click", () => openFolder(parentPath));
    els.fileList.append(button);
  }

  if (!visibleDirs.length && !visibleDocs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    empty.textContent = docs.length || dirs.length ? "没有匹配的项目" : "当前目录没有文件夹或可预览文件";
    els.fileList.append(empty);
    return;
  }

  visibleDirs.forEach((dir) => {
    const button = document.createElement("button");
    button.className = "file-item folder-item";
    button.type = "button";
    button.innerHTML = `
      <span class="file-title">[目录] ${escapeHtml(dir.name)}</span>
      <span class="file-size">文件夹</span>
      <span class="file-path">${escapeHtml(dir.path)}</span>
    `;
    button.addEventListener("click", () => openFolder(dir.path));
    els.fileList.append(button);
  });

  visibleDocs.forEach((doc) => {
    const directory = doc.path.includes("/") ? doc.path.split("/").slice(0, -1).join("/") : "";
    const button = document.createElement("button");
    button.className = `file-item${doc.id === activeId ? " active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span class="file-title">${escapeHtml(doc.name)}</span>
      <span class="file-size">${formatBytes(doc.size || doc.content.length)}</span>
      ${directory ? `<span class="file-path">${escapeHtml(directory)}</span>` : ""}
    `;
    button.addEventListener("click", () => selectDoc(doc.id));
    els.fileList.append(button);
  });
}

function renderPreview(doc = docs.find((item) => item.id === activeId) || filteredDocs()[0]) {
  if (!doc) {
    activeId = null;
    renderHtmlModeControl(null);
    els.docPath.textContent = "未选择文档";
    els.docTitle.textContent = workspaceName ? "没有 Markdown 文档" : "打开一个 Markdown 文件夹";
    els.preview.innerHTML = `<div class="empty-state">${workspaceName ? "当前文件夹里没有可预览的 Markdown 文档" : "输入本机文件夹路径后，左侧会显示其中的 Markdown 文档"}</div>`;
    return;
  }
  activeId = doc.id;
  renderHtmlModeControl(doc);
  els.docPath.textContent = doc.path;
  if (isImage(doc) && doc.rawUrl) {
    els.docTitle.textContent = titleFromName(doc.name);
    els.preview.innerHTML = `
      <div class="image-preview">
        <img src="${escapeHtml(doc.rawUrl)}" alt="${escapeHtml(doc.name)}" />
      </div>
    `;
    return;
  }

  els.docTitle.textContent = doc.content ? (isMarkdown(doc) ? getTitle(doc.content, doc.name) : titleFromName(doc.name)) : titleFromName(doc.name);
  if (!doc.content) {
    els.preview.innerHTML = '<div class="empty-state">选择文件后读取内容</div>';
    return;
  }

  if (isHtml(doc) && htmlViewMode === "preview") {
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame";
    frame.title = `${doc.name} 预览`;
    frame.sandbox = "allow-scripts";
    frame.src = doc.rawUrl;
    els.preview.replaceChildren(frame);
    return;
  }

  els.preview.innerHTML = isMarkdown(doc) ? renderMarkdown(doc.content) : `<pre class="source-preview"><code>${escapeHtml(doc.content)}</code></pre>`;
}

function render() {
  renderFileList();
  renderPreview();
}

function setWorkspace(payload) {
  dirs = payload.dirs || [];
  docs = payload.docs || [];
  parentPath = payload.parentPath || "";
  activeId = null;
  workspaceName = payload.name || "";
  currentWorkspacePath = payload.path || "";
  els.folderPath.value = payload.path || "";
  els.searchInput.value = "";
  render();
  updateAddress("");
  addRecentItem({ type: "dir", dir: currentWorkspacePath, name: workspaceName });
  const targetDoc = docs.find((doc) => doc.path === pendingFilePath) || docs[0];
  pendingFilePath = "";
  if (targetDoc) selectDoc(targetDoc.id);
}

async function loadDoc(doc) {
  if (doc.content !== undefined) return doc;

  const response = await fetch(`/api/document?path=${encodeURIComponent(doc.path)}`);
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "读取文档失败");
  doc.kind = payload.kind || doc.kind;
  doc.content = payload.content;
  doc.rawUrl = payload.rawUrl;
  doc.mime = payload.mime;
  return doc;
}

async function selectDoc(id) {
  const doc = docs.find((item) => item.id === id);
  if (!doc) return;

  activeId = id;
  htmlViewMode = isHtml(doc) ? "preview" : "source";
  updateAddress(doc.path);
  addRecentItem({ type: "file", dir: currentWorkspacePath, file: doc.path, name: doc.name });
  renderFileList();
  renderHtmlModeControl(doc);
  els.docPath.textContent = doc.path;
  els.docTitle.textContent = titleFromName(doc.name);
  els.preview.innerHTML = '<div class="empty-state">正在读取文件...</div>';

  try {
    await loadDoc(doc);
    if (activeId === id) renderPreview(doc);
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
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "打开失败");
    if (remember) pendingFilePath = "";
    setWorkspace(payload);
  } catch (error) {
    docs = [];
    activeId = null;
    workspaceName = "";
    render();
    els.preview.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  } finally {
    els.openFolder.disabled = false;
    els.openFolder.textContent = "打开路径";
  }
}

function currentDoc() {
  return docs.find((doc) => doc.id === activeId);
}

els.openFolder.addEventListener("click", openFolder);
els.folderPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") openFolder();
});
els.searchInput.addEventListener("input", renderFileList);

els.recentToggle.addEventListener("click", () => {
  els.recentPopover.hidden = !els.recentPopover.hidden;
});

els.clearRecent.addEventListener("click", () => {
  writeRecentItems([]);
  renderRecentList();
});

document.addEventListener("click", (event) => {
  if (els.recentPopover.hidden) return;
  if (els.recentPopover.contains(event.target) || els.recentToggle.contains(event.target)) return;
  els.recentPopover.hidden = true;
});

els.htmlSourceMode.addEventListener("click", () => {
  htmlViewMode = "source";
  renderPreview(currentDoc());
});

els.htmlPreviewMode.addEventListener("click", () => {
  htmlViewMode = "preview";
  renderPreview(currentDoc());
});

els.closeWorkspace.addEventListener("click", () => {
  docs = [];
  dirs = [];
  activeId = null;
  workspaceName = "";
  parentPath = "";
  currentWorkspacePath = "";
  pendingFilePath = "";
  els.folderPath.value = "";
  els.searchInput.value = "";
  render();
  updateAddress("");
});

els.themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("local-doc-browser-theme", document.body.classList.contains("dark") ? "dark" : "light");
});

els.copyMarkdown.addEventListener("click", async () => {
  const doc = currentDoc();
  if (!doc) return;
  await loadDoc(doc);
  if (isImage(doc)) return;
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

if (localStorage.getItem("local-doc-browser-theme") === "dark") {
  document.body.classList.add("dark");
}

const initialParams = new URLSearchParams(window.location.search);
const initialDir = initialParams.get("dir");
const initialWorkspaceRequest = initialDir
  ? fetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: initialDir }),
    })
  : fetch("/api/workspace");

initialWorkspaceRequest
  .then((response) => response.json())
  .then(setWorkspace)
  .catch(() => render());

renderRecentList();

if (window.EventSource) {
  const events = new EventSource("/api/events");
  events.addEventListener("reload", () => window.location.reload());
}
