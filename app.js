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
let activeTranscodeController = null;
let activeMediaInfoController = null;
let pendingMediaInfoTimer = null;
let videoStateListVersion = 0;
let pendingTranscodeSeekTimer = null;
let transcodeControlsHideTimer = null;
let lastProgressSaveAt = 0;
let livePhotoProbeVersion = 0;
let livePhotosKitLoader = null;
let fileSizeObserver = null;
let fileSizeHydrationTimer = null;
let fileSizeHydrationVersion = 0;
let lastFileListScrollAt = 0;
let thumbnailObserver = null;
let thumbnailHydrationTimer = null;
let thumbnailHydrationVersion = 0;
const visibleFileSizePaths = new Set();
const visibleThumbnailPaths = new Set();
const fileSizeMemoryCache = new Map();
const thumbnailMemoryCache = new Map();
const pendingFileSizePaths = new Set();
const pendingThumbnailPaths = new Set();
const fileSizeBatchSize = 12;
const thumbnailBatchSize = 6;
const maxFileSizeMemoryCacheItems = 20000;
const maxThumbnailMemoryCacheItems = 20000;
const livePhotosKitUrl = "https://cdn.apple-livephotoskit.com/lpk/1/livephotoskit.js";

for (const [currentKey, legacyKey] of legacyStorageKeys) {
  if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
    localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
  }
}

const els = {
  openFolder: document.querySelector("#openFolder"),
  folderPath: document.querySelector("#folderPath"),
  searchInput: document.querySelector("#searchInput"),
  recentToggle: document.querySelector("#recentToggle"),
  recentPopover: document.querySelector("#recentPopover"),
  recentList: document.querySelector("#recentList"),
  clearRecent: document.querySelector("#clearRecent"),
  logout: document.querySelector("#logout"),
  splitter: document.querySelector("#splitter"),
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

function initResizableSidebar() {
  applySidebarWidth(readSidebarWidth());
  let dragStartX = 0;
  let dragStartWidth = 0;

  const stopResize = (event) => {
    if (event.pointerId !== undefined && els.splitter.hasPointerCapture?.(event.pointerId)) {
      els.splitter.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("resizing-sidebar");
    window.removeEventListener("pointermove", resizeSidebar);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    localStorage.setItem(sidebarWidthStorageKey, String(applySidebarWidth(readSidebarWidth())));
  };

  const persistWidth = (width) => {
    localStorage.setItem(sidebarWidthStorageKey, String(width));
  };

  const resizeSidebar = (event) => {
    const width = applySidebarWidth(dragStartWidth + event.clientX - dragStartX);
    persistWidth(width);
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
  });
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

function isPdf(doc) {
  return doc.kind === "pdf";
}

function isAudio(doc) {
  return doc.kind === "audio";
}

function isVideo(doc) {
  return doc.kind === "video";
}

function isHtml(doc) {
  return /\.(html|htm)$/i.test(doc.name);
}

function isTextLike(doc) {
  return doc.kind === "markdown" || doc.kind === "text";
}

function fileTypeLabel(doc) {
  if (doc.kind === "markdown") return "Markdown";
  if (doc.kind === "text") return "文本";
  if (doc.kind === "image") return "图片";
  if (doc.kind === "pdf") return "PDF";
  if (doc.kind === "audio") return "音频";
  if (doc.kind === "video") return "视频";
  const extension = doc.name.includes(".") ? doc.name.split(".").pop().toUpperCase() : "文件";
  return extension || "文件";
}

function languageFromFilename(name = "") {
  const lowerName = name.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.split(".").pop() : lowerName;
  const map = {
    bash: "shell",
    bat: "shell",
    c: "c",
    cmd: "shell",
    conf: "ini",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    csv: "csv",
    dockerfile: "docker",
    go: "go",
    h: "c",
    hpp: "cpp",
    htm: "html",
    html: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    log: "log",
    mjs: "javascript",
    nfo: "xml",
    php: "php",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "typescript",
    txt: "text",
    vue: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  if (lowerName === "dockerfile" || lowerName.endsWith(".dockerfile")) return "docker";
  return map[extension] || "text";
}

function keywordPattern(language) {
  const groups = {
    c: "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while",
    cpp: "alignas|alignof|and|auto|bool|break|case|catch|class|const|constexpr|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|if|inline|int|long|namespace|new|nullptr|operator|private|protected|public|return|short|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|using|virtual|void|while",
    csharp: "abstract|as|async|await|base|bool|break|case|catch|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|float|for|foreach|if|implicit|in|int|interface|internal|is|lock|namespace|new|null|object|out|override|private|protected|public|readonly|ref|return|sealed|static|string|struct|switch|this|throw|true|try|using|var|virtual|void|while",
    css: "align-items|background|border|box-shadow|color|content|display|flex|font|gap|grid|height|inset|justify-content|margin|max-width|min-height|overflow|padding|place-items|position|transform|transition|width|z-index",
    go: "break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var",
    java: "abstract|assert|boolean|break|case|catch|class|const|continue|default|do|double|else|enum|extends|false|final|finally|float|for|if|implements|import|instanceof|int|interface|long|new|null|package|private|protected|public|return|static|super|switch|this|throw|throws|true|try|void|while",
    javascript: "async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|get|if|import|in|instanceof|let|new|null|of|return|set|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield",
    json: "true|false|null",
    kotlin: "as|break|class|continue|data|do|else|false|for|fun|if|import|in|interface|is|null|object|package|return|this|throw|true|try|typealias|val|var|when|while",
    php: "abstract|and|array|as|break|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|endfor|endforeach|endif|endswitch|endwhile|extends|false|final|finally|fn|for|foreach|function|global|if|implements|include|interface|namespace|new|null|or|private|protected|public|require|return|static|switch|throw|trait|true|try|use|var|while|xor",
    powershell: "begin|break|catch|class|continue|data|do|dynamicparam|else|elseif|end|exit|filter|finally|for|foreach|from|function|if|in|param|process|return|switch|throw|trap|try|until|using|var|while",
    python: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield",
    ruby: "alias|and|begin|break|case|class|def|defined|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield",
    rust: "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while",
    shell: "case|do|done|elif|else|esac|fi|for|function|if|in|local|then|until|while",
    sql: "alter|and|as|between|by|case|create|delete|desc|distinct|drop|else|end|exists|from|group|having|in|insert|into|is|join|left|like|limit|not|null|on|or|order|outer|right|select|set|table|then|union|update|values|when|where",
    swift: "actor|as|associatedtype|async|await|break|case|catch|class|continue|defer|do|else|enum|extension|false|for|func|guard|if|import|in|init|let|nil|protocol|return|self|static|struct|switch|throw|true|try|typealias|var|where|while",
    typescript: "abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|keyof|let|module|namespace|never|new|null|number|of|private|protected|public|readonly|return|set|static|string|super|switch|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|yield",
  };
  return groups[language] || groups.javascript;
}

function highlightCode(rawCode, language = "text") {
  const code = String(rawCode || "");
  if (["text", "log", "csv"].includes(language)) return escapeHtml(code);
  if (language === "html" || language === "xml") {
    return escapeHtml(code).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, (_match, open, tag, attrs, close) => {
      const coloredAttrs = attrs.replace(/([\w:-]+)(=)(&quot;.*?&quot;|'.*?'|[^\s&]+)/g, '<span class="tok-attr">$1</span>$2<span class="tok-string">$3</span>');
      return `${open}<span class="tok-keyword">${tag}</span>${coloredAttrs}${close}`;
    });
  }

  const commentPrefix = ["python", "ruby", "shell", "powershell", "yaml", "toml", "ini", "docker"].includes(language) ? "#.*" : "\\/\\/.*";
  const commentBlock = ["css", "javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust", "swift", "php"].includes(language) ? "|\\/\\*[\\s\\S]*?\\*\\/" : "";
  const tokenRegex = new RegExp(`(${commentPrefix}${commentBlock}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`, "g");
  const keywords = new RegExp(`\\b(${keywordPattern(language)})\\b`, "g");
  let result = "";
  let lastIndex = 0;

  const highlightPlain = (part) =>
    escapeHtml(part)
      .replace(/\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>')
      .replace(keywords, '<span class="tok-keyword">$1</span>');

  for (const match of code.matchAll(tokenRegex)) {
    result += highlightPlain(code.slice(lastIndex, match.index));
    const token = match[0];
    const isComment = token.startsWith("//") || token.startsWith("/*") || token.startsWith("#");
    result += `<span class="${isComment ? "tok-comment" : "tok-string"}">${escapeHtml(token)}</span>`;
    lastIndex = match.index + token.length;
  }
  result += highlightPlain(code.slice(lastIndex));
  return result;
}

function renderCodeBlock(code, language, className = "") {
  const lang = language || "text";
  const classes = ["code-preview", className, `language-${lang}`].filter(Boolean).join(" ");
  return `<pre class="${classes}"><code>${highlightCode(code, lang)}</code></pre>`;
}

function updatePreviewActions(doc) {
  renderHtmlModeControl(doc);
  const canCopy = Boolean(doc && isTextLike(doc));
  els.copyMarkdown.hidden = !canCopy;
  els.downloadHtml.hidden = !doc || !isTextLike(doc);
  els.mediaInfo.hidden = !doc || !isVideo(doc);
  els.transcodeVideo.hidden = !doc || !isVideo(doc);
  if (!doc || !isVideo(doc)) els.transcodeVideo.textContent = "转码播放";
  els.downloadFile.hidden = !doc;
}

function updateAddress(filePath = activeId) {
  const params = new URLSearchParams();
  if (currentWorkspacePath) params.set("dir", currentWorkspacePath);
  if (filePath) params.set("file", filePath);
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function scopedQuery(params = {}) {
  const query = new URLSearchParams();
  if (currentWorkspacePath) query.set("dir", currentWorkspacePath);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  return query.toString();
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
      pendingFilePath = item.type === "file" ? item.file : "";
      openFolder(item.dir, { remember: false });
    });
    els.recentList.append(button);
  });
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
        html.push(renderCodeBlock(code.lines.join("\n"), code.language));
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?/);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
      code = { language: fence[1] || "text", lines: [] };
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
  if (code) html.push(renderCodeBlock(code.lines.join("\n"), code.language));
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

function fileSizeDisplayText(doc) {
  if (Number.isFinite(doc.size)) return formatBytes(doc.size);
  if (doc.content) return formatBytes(doc.content.length);
  if (doc.sizeLoading) return "大小读取中";
  if (doc.sizeError) return "大小读取失败";
  return "大小待加载";
}

function fileSizeCacheKey(rootPath, filePath) {
  return `${rootPath}\n${filePath}`;
}

function rememberFileSize(rootPath, filePath, size) {
  if (!Number.isFinite(size)) return;
  const key = fileSizeCacheKey(rootPath, filePath);
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
  const key = fileSizeCacheKey(rootPath, filePath);
  if (thumbnailMemoryCache.has(key)) thumbnailMemoryCache.delete(key);
  thumbnailMemoryCache.set(key, thumbnailUrl);
  while (thumbnailMemoryCache.size > maxThumbnailMemoryCacheItems) {
    const oldestKey = thumbnailMemoryCache.keys().next().value;
    if (!oldestKey) break;
    thumbnailMemoryCache.delete(oldestKey);
  }
}

function applyCachedFileSizes(rootPath = currentWorkspacePath) {
  for (const doc of docs) {
    if (Number.isFinite(doc.size)) continue;
    const cachedSize = fileSizeMemoryCache.get(fileSizeCacheKey(rootPath, doc.path));
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

function resetThumbnailHydration() {
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  visibleThumbnailPaths.clear();
  thumbnailHydrationVersion += 1;
  if (thumbnailHydrationTimer) {
    clearTimeout(thumbnailHydrationTimer);
    thumbnailHydrationTimer = null;
  }
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

async function hydrateVisibleThumbnails(version = thumbnailHydrationVersion) {
  if (!currentWorkspacePath || version !== thumbnailHydrationVersion) return;
  for (const path of visibleThumbnailPaths) {
    const doc = docs.find((entry) => entry.path === path);
    if (!doc || doc.thumbnailUrl) continue;
    const cachedThumbnail = thumbnailMemoryCache.get(fileSizeCacheKey(currentWorkspacePath, path));
    if (!cachedThumbnail) continue;
    doc.thumbnailUrl = cachedThumbnail;
    setThumbnail(path, cachedThumbnail);
  }

  const paths = [...visibleThumbnailPaths]
    .map((path) => docs.find((doc) => doc.path === path))
    .filter((doc) => doc && (doc.kind === "image" || doc.kind === "video") && !doc.thumbnailUrl && !doc.thumbnailLoading && !pendingThumbnailPaths.has(fileSizeCacheKey(currentWorkspacePath, doc.path)))
    .slice(0, thumbnailBatchSize)
    .map((doc) => doc.path);
  if (!paths.length) return;

  paths.forEach((path) => {
    const doc = docs.find((item) => item.path === path);
    if (!doc) return;
    pendingThumbnailPaths.add(fileSizeCacheKey(currentWorkspacePath, path));
    doc.thumbnailLoading = true;
    els.fileList.querySelectorAll("[data-thumbnail-path]").forEach((element) => {
      if (element.dataset.thumbnailPath === path) element.classList.add("loading");
    });
  });

  const response = await apiFetch("/api/thumbnails", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: currentWorkspacePath, paths }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "读取缩略图失败");
  if (version !== thumbnailHydrationVersion) return;

  for (const item of payload.thumbnails || []) {
    const doc = docs.find((entry) => entry.path === item.path);
    if (!doc) continue;
    doc.thumbnailLoading = false;
    pendingThumbnailPaths.delete(fileSizeCacheKey(currentWorkspacePath, doc.path));
    if (item.thumbnailUrl) {
      doc.thumbnailUrl = item.thumbnailUrl;
      rememberThumbnail(currentWorkspacePath, doc.path, item.thumbnailUrl);
      setThumbnail(doc.path, item.thumbnailUrl);
    } else {
      doc.thumbnailError = item.error || "生成失败";
      setThumbnail(doc.path, "");
    }
  }

  for (const path of paths) {
    const doc = docs.find((entry) => entry.path === path);
    pendingThumbnailPaths.delete(fileSizeCacheKey(currentWorkspacePath, path));
    if (doc?.thumbnailLoading) {
      doc.thumbnailLoading = false;
      doc.thumbnailError = "生成失败";
      setThumbnail(doc.path, "");
    }
  }

  if ([...visibleThumbnailPaths].some((path) => {
    const doc = docs.find((entry) => entry.path === path);
    return doc && !doc.thumbnailUrl && !doc.thumbnailLoading;
  })) {
    scheduleVisibleThumbnailHydration(450);
  }
}

function setFileSizeText(path, text) {
  els.fileList.querySelectorAll("[data-file-size-path]").forEach((element) => {
    if (element.dataset.fileSizePath === path) {
      const doc = docs.find((item) => item.path === path);
      element.textContent = `${fileTypeLabel(doc || { kind: "file", name: path })} · ${text}`;
    }
  });
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
  if (!currentWorkspacePath || version !== fileSizeHydrationVersion) return;
  for (const path of visibleFileSizePaths) {
    const doc = docs.find((entry) => entry.path === path);
    if (!doc || Number.isFinite(doc.size)) continue;
    const cachedSize = fileSizeMemoryCache.get(fileSizeCacheKey(currentWorkspacePath, path));
    if (!Number.isFinite(cachedSize)) continue;
    doc.size = cachedSize;
    doc.sizeDeferred = false;
    doc.sizeLoading = false;
    doc.sizeError = "";
    setFileSizeText(path, fileSizeDisplayText(doc));
  }

  const paths = [...visibleFileSizePaths]
    .map((path) => docs.find((doc) => doc.path === path))
    .filter((doc) => doc && !Number.isFinite(doc.size) && !doc.sizeLoading && !pendingFileSizePaths.has(fileSizeCacheKey(currentWorkspacePath, doc.path)))
    .slice(0, fileSizeBatchSize)
    .map((doc) => doc.path);
  if (!paths.length) return;

  paths.forEach((path) => {
    const doc = docs.find((item) => item.path === path);
    if (!doc) return;
    pendingFileSizePaths.add(fileSizeCacheKey(currentWorkspacePath, path));
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
    const doc = docs.find((entry) => entry.path === item.path);
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
    pendingFileSizePaths.delete(fileSizeCacheKey(currentWorkspacePath, doc.path));
    setFileSizeText(doc.path, fileSizeDisplayText(doc));
  }

  for (const path of paths) {
    const doc = docs.find((entry) => entry.path === path);
    pendingFileSizePaths.delete(fileSizeCacheKey(currentWorkspacePath, path));
    if (doc?.sizeLoading) {
      doc.sizeLoading = false;
      doc.sizeError = "读取失败";
      setFileSizeText(doc.path, fileSizeDisplayText(doc));
    }
  }

  if ([...visibleFileSizePaths].some((path) => {
    const doc = docs.find((entry) => entry.path === path);
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

function renderFileList() {
  resetFileSizeHydration();
  resetThumbnailHydration();
  const visibleDocs = filteredDocs();
  const visibleDirs = filteredDirs();
  els.fileCount.textContent = workspaceName ? `${workspaceName} · ${visibleDirs.length} 个文件夹 · ${visibleDocs.length} 个文件` : "未打开文件夹";
  els.fileList.innerHTML = "";

  if (parentPath && !els.searchInput.value.trim()) {
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
    els.fileList.append(button);
  }

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
    const directory = doc.path.includes("/") ? doc.path.split("/").slice(0, -1).join("/") : "";
    const statusMark = videoListStatusMark(doc);
    const fileSizeText = fileSizeDisplayText(doc);
    const canThumbnail = doc.kind === "image" || doc.kind === "video";
    const cachedThumbnail = doc.thumbnailUrl || thumbnailMemoryCache.get(fileSizeCacheKey(currentWorkspacePath, doc.path)) || "";
    if (cachedThumbnail) doc.thumbnailUrl = cachedThumbnail;
    const button = document.createElement("button");
    button.className = `file-item${doc.id === activeId ? " active" : ""}`;
    button.type = "button";
    button.title = doc.path;
    button.dataset.filePath = doc.path;
    if (!Number.isFinite(doc.size)) button.dataset.sizeDeferred = "true";
    button.innerHTML = `
      <span class="file-thumb${canThumbnail ? " media-thumb" : ""}${cachedThumbnail ? " ready" : ""}" ${canThumbnail ? `data-thumbnail-path="${escapeHtml(doc.path)}" ${cachedThumbnail ? "" : 'data-thumbnail-deferred="true"'}` : ""} aria-hidden="true">
        ${cachedThumbnail ? `<img src="${escapeHtml(cachedThumbnail)}" alt="">` : `<span>${escapeHtml(fileTypeLabel(doc).slice(0, 1))}</span>`}
      </span>
      <span class="file-title" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
      ${statusMark || '<span class="file-status-mark" aria-hidden="true"></span>'}
      <span class="file-size" data-file-size-path="${escapeHtml(doc.path)}">${escapeHtml(fileTypeLabel(doc))} · ${escapeHtml(fileSizeText)}</span>
      ${directory ? `<span class="file-path" title="${escapeHtml(directory)}">${escapeHtml(directory)}</span>` : ""}
    `;
    button.addEventListener("click", () => selectDoc(doc.id));
    els.fileList.append(button);
  });
  setupFileSizeObserver();
  setupThumbnailObserver();
}

function renderPreview(doc = docs.find((item) => item.id === activeId) || filteredDocs()[0]) {
  document.body.classList.toggle("video-mode", Boolean(doc && isVideo(doc)));
  els.preview.classList.toggle("media-preview-shell", Boolean(doc && (isVideo(doc) || isPdf(doc))));
  if (!doc) {
    activeId = null;
    updatePreviewActions(null);
    els.docPath.textContent = "未选择文档";
    els.docTitle.textContent = workspaceName ? "没有文件" : "打开一个文件夹";
    els.preview.innerHTML = `<div class="empty-state">${workspaceName ? "当前文件夹里没有文件" : "输入本机文件夹路径后，左侧会显示其中的文件"}</div>`;
    return;
  }
  activeId = doc.id;
  updatePreviewActions(doc);
  els.docPath.textContent = doc.path;
  if (isImage(doc) && doc.rawUrl) {
    els.docTitle.textContent = titleFromName(doc.name);
    const imageUrl = doc.previewUrl || doc.rawUrl;
    els.preview.innerHTML = `
      <div class="image-preview" data-live-photo-shell>
        <div class="motion-media-frame" data-motion-media-frame>
          <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(doc.name)}" data-live-photo-image />
          <div class="live-photo-toolbar" data-live-photo-toolbar hidden></div>
        </div>
      </div>
    `;
    const image = els.preview.querySelector("[data-live-photo-image]");
    const frame = els.preview.querySelector("[data-motion-media-frame]");
    const syncFrame = () => {
      if (!image?.naturalWidth || !image?.naturalHeight || !frame) return;
      frame.style.setProperty("--media-aspect-ratio", String(image.naturalWidth / image.naturalHeight));
    };
    image?.addEventListener("load", syncFrame, { once: true });
    syncFrame();
    renderLivePhotoControls(doc);
    return;
  }

  if (isPdf(doc) && doc.rawUrl) {
    els.docTitle.textContent = doc.name;
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame";
    frame.title = `${doc.name} 预览`;
    frame.src = doc.rawUrl;
    els.preview.replaceChildren(frame);
    return;
  }

  if (isAudio(doc) && doc.rawUrl) {
    els.docTitle.textContent = doc.name;
    els.preview.innerHTML = `
      <div class="file-preview">
        <div class="file-preview-icon">音频</div>
        <h3>${escapeHtml(doc.name)}</h3>
        <p>${escapeHtml(doc.mime || fileTypeLabel(doc))} · ${formatBytes(doc.size || 0)}</p>
        <audio controls src="${escapeHtml(doc.rawUrl)}"></audio>
      </div>
    `;
    return;
  }

  if (isVideo(doc) && doc.rawUrl) {
    els.docTitle.textContent = doc.name;
    els.preview.innerHTML = `
      <section class="video-decision">
        <div class="video-decision-header">
          <span class="video-decision-kicker">视频信息</span>
          <h3>${escapeHtml(doc.name)}</h3>
        </div>
        <div class="empty-state compact-empty">正在读取播放记录和编码信息...</div>
      </section>
    `;
    renderVideoDecision(doc);
    return;
  }

  els.docTitle.textContent = doc.content ? (isMarkdown(doc) ? getTitle(doc.content, doc.name) : titleFromName(doc.name)) : titleFromName(doc.name);
  if (!isTextLike(doc)) {
    els.docTitle.textContent = doc.name;
    els.preview.innerHTML = `
      <div class="file-preview">
        <div class="file-preview-icon">${escapeHtml(fileTypeLabel(doc))}</div>
        <h3>${escapeHtml(doc.name)}</h3>
        <p>${escapeHtml(doc.mime || "application/octet-stream")} · ${formatBytes(doc.size || 0)}</p>
        <p>此文件类型不支持内嵌预览。点击右上角“下载”保存文件。</p>
      </div>
    `;
    return;
  }

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

  els.preview.innerHTML = isMarkdown(doc) ? renderMarkdown(doc.content) : renderCodeBlock(doc.content, languageFromFilename(doc.name), "source-preview");
}

function supportLabel(value) {
  if (value === "probably") return "浏览器大概率支持";
  if (value === "maybe") return "浏览器可能支持";
  return "浏览器未声明支持";
}

function renderMediaInfo(info) {
  const videoProbe = document.createElement("video");
  const rows = info.tracks?.length
    ? info.tracks
        .map((track, index) => {
          const probeMime = track.kind === "video" && track.codec ? `video/mp4; codecs="${track.codec}"` : "";
          const support = probeMime ? videoProbe.canPlayType(probeMime) : "";
          return `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeHtml(track.kind || "")}</td>
              <td>${escapeHtml(track.description || track.codecTag || "")}</td>
              <td><code>${escapeHtml(track.codec || "")}</code></td>
              <td>${escapeHtml(probeMime ? supportLabel(support) : "-")}</td>
            </tr>
          `;
        })
        .join("")
    : '<tr><td colspan="5">没有解析到轨道信息</td></tr>';

  return `
    <section class="media-info-panel">
      <div class="media-info-summary">
        <span>容器：${escapeHtml(info.container || "unknown")}</span>
        <span>大小：${formatBytes(info.size || 0)}</span>
        ${info.inspectedBytes ? `<span>探测：${formatBytes(info.inspectedBytes)}${info.isCached ? " · 缓存" : ""}</span>` : ""}
        ${info.probeMs ? `<span>耗时：${Math.round(info.probeMs)}ms${info.isCached ? " · 缓存" : ""}</span>` : ""}
        ${info.durationSeconds ? `<span>时长：${formatDuration(info.durationSeconds)}</span>` : ""}
        <span>MIME：<code>${escapeHtml(info.mime || "")}</code></span>
      </div>
      ${info.warning ? `<p class="media-info-warning">${escapeHtml(info.warning)}</p>` : ""}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>轨道</th>
            <th>编码</th>
            <th>Codec String</th>
            <th>浏览器判断</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

async function readLivePhotoInfo(doc) {
  if (doc.livePhotoInfo) return doc.livePhotoInfo;
  const response = await apiFetch(`/api/live-photo?${scopedQuery({ path: doc.path })}`);
  const info = await response.json();
  doc.livePhotoInfo = info;
  return info;
}

function bytesToAscii(bytes, start = 0, end = bytes.length) {
  let result = "";
  const chunkSize = 8192;
  for (let offset = start; offset < end; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, end)));
  }
  return result;
}

function motionPhotoAttribute(block, name) {
  const match = block.match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : "";
}

function findMotionPhotoRange(bytes) {
  const headText = bytesToAscii(bytes, 0, Math.min(bytes.length, 512 * 1024));
  const itemBlocks = [...headText.matchAll(/<Container:Item\b[\s\S]*?(?:\/>|<\/Container:Item>)/g)].map((match) => match[0]);
  const videoItem = itemBlocks.find((block) => /Item:Mime="video\/mp4"/.test(block));
  if (videoItem) {
    const length = Number(motionPhotoAttribute(videoItem, "Item:Length"));
    const padding = Number(motionPhotoAttribute(videoItem, "Item:Padding") || 0);
    if (Number.isInteger(length) && length > 0 && Number.isFinite(padding) && padding >= 0) {
      return { start: bytes.length - padding - length, length };
    }
  }

  const offsetMatch = headText.match(/(?:GCamera|Camera):MicroVideoOffset="(\d+)"/);
  if (offsetMatch) {
    const offset = Number(offsetMatch[1]);
    if (Number.isInteger(offset) && offset > 0 && offset < bytes.length) {
      return { start: bytes.length - offset, length: offset };
    }
  }

  const tailStart = Math.max(0, bytes.length - 8 * 1024 * 1024);
  const tailText = bytesToAscii(bytes, tailStart, bytes.length);
  const ftypIndex = tailText.indexOf("ftyp");
  if (ftypIndex >= 4) {
    const start = tailStart + ftypIndex - 4;
    return { start, length: bytes.length - start };
  }
  return null;
}

async function extractMotionPhotoBlob(doc) {
  if (doc.motionVideoObjectUrl) return doc.motionVideoObjectUrl;
  const response = await apiFetch(doc.rawUrl);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const range = findMotionPhotoRange(bytes);
  if (!range || range.start < 0 || range.start + range.length > bytes.length) {
    throw new Error("没有在图片内解析到 Motion Photo 视频");
  }
  const videoBlob = new Blob([buffer.slice(range.start, range.start + range.length)], { type: "video/mp4" });
  doc.motionVideoObjectUrl = URL.createObjectURL(videoBlob);
  return doc.motionVideoObjectUrl;
}

function loadLivePhotosKit() {
  if (window.LivePhotosKit?.Player) return Promise.resolve(window.LivePhotosKit);
  if (livePhotosKitLoader) return livePhotosKitLoader;
  livePhotosKitLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = livePhotosKitUrl;
    script.async = true;
    script.onload = () => {
      if (window.LivePhotosKit?.Player) resolve(window.LivePhotosKit);
      else reject(new Error("LivePhotosKit 加载后没有可用播放器"));
    };
    script.onerror = () => reject(new Error("LivePhotosKit 加载失败"));
    document.head.append(script);
  });
  return livePhotosKitLoader;
}

function stopLivePhotoPlayback(shell, options = {}) {
  shell?.classList.remove("is-playing-live");
  shell?.classList.remove("is-motion-photo");
  const playerElement = shell?.querySelector("[data-live-photo-player]");
  if (playerElement) {
    playerElement.__livePhotoPlayer?.stop?.();
    playerElement.remove();
  }

  const video = shell?.querySelector("video[data-live-photo-video]");
  const image = shell?.querySelector("[data-live-photo-image]");
  if (video) {
    video.pause();
    video.remove();
  }
  if (options.revokeObjectUrl && video?.dataset.objectUrl) {
    URL.revokeObjectURL(video.dataset.objectUrl);
  }
  if (image) image.hidden = false;
}

function startLivePhotoVideo(shell, info, videoUrl, options = {}) {
  const image = shell.querySelector("[data-live-photo-image]");
  const frame = shell.querySelector("[data-motion-media-frame]") || shell;
  if (!image || !videoUrl) return;
  stopLivePhotoPlayback(shell);
  const isOverlayPlayback = info.mode === "embedded-motion-photo" || info.mode === "sidecar";
  shell.classList.add("is-playing-live");
  shell.classList.toggle("is-motion-photo", info.mode === "embedded-motion-photo");
  const video = document.createElement("video");
  video.dataset.livePhotoVideo = "true";
  if (isOverlayPlayback) video.dataset.motionOverlay = "true";
  if (options.objectUrl) video.dataset.objectUrl = videoUrl;
  video.controls = false;
  video.autoplay = true;
  video.muted = info.mode === "embedded-motion-photo";
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.src = videoUrl;
  let renderFallbackTimer = null;
  if (info.mode === "embedded-motion-photo" && options.objectUrl && info.transcodeUrl) {
    renderFallbackTimer = setTimeout(() => {
      if (!video.classList.contains("ready") && shell.contains(video)) {
        startLivePhotoVideo(shell, info, info.transcodeUrl);
      }
    }, 900);
  }
  const markReady = () => {
    if (renderFallbackTimer) clearTimeout(renderFallbackTimer);
    if (isOverlayPlayback) video.classList.add("ready");
  };
  video.addEventListener("loadeddata", () => {
    markReady();
  });
  video.addEventListener("canplay", markReady, { once: true });
  video.addEventListener("error", () => {
    if (renderFallbackTimer) clearTimeout(renderFallbackTimer);
    if (info.transcodeUrl && videoUrl !== info.transcodeUrl && shell.contains(video)) {
      video.remove();
      startLivePhotoVideo(shell, info, info.transcodeUrl);
    } else {
      video.remove();
      shell.classList.remove("is-playing-live");
    }
  }, { once: true });
  video.addEventListener("ended", () => {
    if (renderFallbackTimer) clearTimeout(renderFallbackTimer);
    shell.classList.remove("is-playing-live");
    video.remove();
  });
  image.hidden = false;
  frame.append(video);
  video.play().catch(() => {});
}

function startLivePhotoVideoFallback(shell, info) {
  startLivePhotoVideo(shell, info, info.videoUrl);
}

async function startLivePhotosKitPlayback(shell, info) {
  const image = shell.querySelector("[data-live-photo-image]");
  const frame = shell.querySelector("[data-motion-media-frame]") || shell;
  if (!image || !info?.videoUrl) return false;
  stopLivePhotoPlayback(shell);
  const LivePhotosKit = await loadLivePhotosKit();
  shell.classList.add("is-playing-live");
  shell.classList.remove("is-motion-photo");
  image.hidden = true;

  const playerElement = document.createElement("div");
  playerElement.className = "live-photo-player";
  playerElement.dataset.livePhotoPlayer = "true";
  frame.append(playerElement);

  const player = LivePhotosKit.Player(playerElement);
  player.photoSrc = info.previewUrl || image.currentSrc || image.src;
  player.videoSrc = info.videoUrl;
  player.proactivelyLoadsVideo = true;
  if (Number.isFinite(Number(info.photoTime))) player.photoTime = Number(info.photoTime);
  if (LivePhotosKit.PlaybackStyle?.FULL) player.playbackStyle = LivePhotosKit.PlaybackStyle.FULL;
  playerElement.__livePhotoPlayer = player;

  player.addEventListener?.("error", () => {
    stopLivePhotoPlayback(shell);
    startLivePhotoVideo(shell, info, info.transcodeUrl || info.videoUrl);
  });
  player.addEventListener?.("ended", () => {
    shell.classList.remove("is-playing-live");
  });
  player.play?.();
  return true;
}

async function startLivePhotoPlayback(shell, info) {
  const doc = currentDoc();
  if (!info?.videoUrl) return;
  if (info.mode === "sidecar") {
    startLivePhotoVideo(shell, info, info.transcodeUrl || info.videoUrl);
    return;
  }
  if (info.mode === "embedded-motion-photo" && doc?.rawUrl) {
    if (info.videoCodec === "hvc1" && info.transcodeUrl) {
      startLivePhotoVideo(shell, info, info.transcodeUrl);
      return;
    }
    try {
      const objectUrl = await extractMotionPhotoBlob(doc);
      startLivePhotoVideo(shell, info, objectUrl, { objectUrl: true });
      return;
    } catch {
      startLivePhotoVideoFallback(shell, info);
      return;
    }
  }
  startLivePhotoVideoFallback(shell, info);
}

async function renderLivePhotoControls(doc) {
  const version = ++livePhotoProbeVersion;
  const shell = els.preview.querySelector("[data-live-photo-shell]");
  const toolbar = els.preview.querySelector("[data-live-photo-toolbar]");
  if (!shell || !toolbar) return;

  toolbar.hidden = true;
  toolbar.innerHTML = "";
  try {
    const info = await readLivePhotoInfo(doc);
    if (version !== livePhotoProbeVersion || currentDoc()?.id !== doc.id) return;
    doc.livePhotoInfo = info;
    if (info.isLive && info.videoUrl) {
      const videoWidth = Number(info.videoDisplaySize?.width || 0);
      const videoHeight = Number(info.videoDisplaySize?.height || 0);
      if (videoWidth > 0 && videoHeight > 0) {
        shell.classList.add("has-live-photo");
        shell.style.setProperty("--live-photo-aspect-ratio", String(videoWidth / videoHeight));
        const frame = shell.querySelector("[data-motion-media-frame]");
        frame?.style.setProperty("--media-aspect-ratio", String(videoWidth / videoHeight));
      }
      const badgeLabel = info.mode === "embedded-motion-photo" ? "Motion" : "Live";
      toolbar.hidden = false;
      toolbar.innerHTML = `
        <button type="button" class="live-photo-badge" data-live-photo-action="play" title="${escapeHtml(info.message || "播放动态照片")}">
          <span aria-hidden="true">▶</span>${escapeHtml(badgeLabel)}
        </button>
      `;
      const togglePlayback = async () => {
        if (shell.querySelector("[data-live-photo-player]") || shell.querySelector("video[data-live-photo-video]")) stopLivePhotoPlayback(shell);
        else await startLivePhotoPlayback(shell, info);
      };
      toolbar.querySelector("[data-live-photo-action='play']")?.addEventListener("click", async (event) => {
        event.stopPropagation();
        await togglePlayback();
      });
      const frame = shell.querySelector("[data-motion-media-frame]");
      if (frame) {
        frame.classList.add("is-interactive-motion");
        frame.tabIndex = 0;
        frame.title = info.mode === "embedded-motion-photo" ? "点击播放 Motion Photo" : "点击播放 Live Photo";
        frame.addEventListener("click", togglePlayback);
        frame.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
          event.preventDefault();
          togglePlayback();
        });
      }
      return;
    }

    toolbar.hidden = true;
    toolbar.innerHTML = "";
  } catch (error) {
    if (version !== livePhotoProbeVersion || currentDoc()?.id !== doc.id) return;
    toolbar.hidden = true;
    toolbar.innerHTML = "";
  }
}

function nativeVideoSupport(info) {
  const videoProbe = document.createElement("video");
  const mime = info?.mime || "";
  const mimeSupport = mime ? videoProbe.canPlayType(mime) : "";
  const unsupportedVideoTrack = info?.tracks?.some((track) => {
    if (track.kind !== "video" || !track.codec) return false;
    return !videoProbe.canPlayType(`video/mp4; codecs="${track.codec}"`);
  });
  if (unsupportedVideoTrack) return "";
  return mimeSupport || (info?.tracks?.length ? "maybe" : "");
}

function nfoMediaInfoIsEnough(info) {
  if (!info?.isFromNfo) return false;
  const video = info.tracks?.find((track) => track.kind === "video");
  if (!video?.codec) return false;
  if (String(video.codec).toLowerCase() === String(video.codecTag || "").toLowerCase()) return false;
  return true;
}

function videoSupportLabel(info) {
  if (!info) return { text: "正在分析编码兼容性", needsTranscode: true, loading: true };
  const support = nativeVideoSupport(info);
  if (support === "probably") return { text: "浏览器大概率可原始播放", needsTranscode: false };
  if (support === "maybe") return { text: "浏览器可能可原始播放", needsTranscode: false };
  return { text: "建议使用转码播放", needsTranscode: true };
}

function watchedLabel(state) {
  if (!state?.exists) return "没有播放记录";
  if (state.watched) return `已播放${state.playcount ? ` · ${state.playcount} 次` : ""}`;
  return "未标记已播";
}

function progressPercent(state, durationHint = 0) {
  const position = Number(state?.positionSeconds || 0);
  const duration = Number(state?.durationSeconds || durationHint || 0);
  if (!duration || !Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(100, (position / duration) * 100));
}

function renderVideoDecisionContent(doc, state, info) {
  const support = videoSupportLabel(info);
  const resumeAt = resumePositionFromState(state);
  const duration = Number(info?.durationSeconds || state?.durationSeconds || 0);
  const progress = progressPercent(state, duration);
  const primaryAction = support.needsTranscode ? "transcode" : "raw";
  if (!support.loading) doc.recommendedVideoMode = primaryAction;
  const modeText = primaryAction === "raw" ? "原始播放" : "转码播放";
  const resumeText = support.loading ? "分析中" : resumeAt ? `继续${modeText} ${formatDuration(resumeAt)}` : modeText;
  const sourceLabel = info?.isFromNfo ? "Kodi NFO" : info?.isCached ? "媒体探测缓存" : info?.isFromFfprobe ? "ffprobe" : info ? "媒体探测" : "分析中";
  const codecRows = !info
    ? "<span>轨道</span><strong>编码信息分析中</strong><code>-</code>"
    : info.tracks?.length
    ? info.tracks
        .map((track) => `
          <span>${escapeHtml(track.kind || "track")}</span>
          <strong>${escapeHtml([
            track.description || track.codecTag || "-",
            track.width && track.height ? `${track.width}x${track.height}` : "",
            track.hdrType ? `HDR: ${track.hdrType}` : "",
            track.channels ? `${track.channels}ch` : "",
          ].filter(Boolean).join(" · "))}</strong>
          <code>${escapeHtml(track.codec || "-")}</code>
        `)
        .join("")
    : "<span>轨道</span><strong>未解析到</strong><code>-</code>";

  return `
    <section class="video-decision">
      <div class="video-decision-header">
        <span class="video-decision-kicker">视频信息</span>
        <h3>${escapeHtml(doc.name)}</h3>
      </div>
      <div class="video-state-grid">
        <div>
          <span>播放状态</span>
          <strong>${escapeHtml(watchedLabel(state))}</strong>
        </div>
        <div>
          <span>播放进度</span>
          <strong>${resumeAt ? `${formatDuration(resumeAt)} / ${formatDuration(duration)}` : "从头开始"}</strong>
        </div>
        <div>
          <span>最近播放</span>
          <strong>${escapeHtml(state?.lastPlayed || "无")}</strong>
        </div>
        <div>
          <span>播放方式</span>
          <strong>${escapeHtml(support.text)}</strong>
        </div>
        <div>
          <span>NFO</span>
          <strong>${state?.exists ? "已找到" : "尚未创建"}</strong>
        </div>
        <div>
          <span>编码来源</span>
          <strong>${escapeHtml(sourceLabel)}</strong>
        </div>
      </div>
      <div class="video-progress-track" aria-label="播放进度">
        <span style="width:${progress.toFixed(2)}%"></span>
      </div>
      <div class="video-codec-grid">${codecRows}</div>
      ${info?.warning ? `<p class="media-info-warning">${escapeHtml(info.warning)}</p>` : ""}
      <div class="video-decision-actions">
        <button class="primary-button" type="button" data-video-action="${primaryAction}" data-start="${resumeAt}" ${support.loading ? "disabled" : ""}>${escapeHtml(resumeText)}</button>
        ${!support.loading && resumeAt ? `<button type="button" data-video-action="${primaryAction}" data-start="0">从头播放</button>` : ""}
        ${!support.loading ? (support.needsTranscode ? `<button type="button" data-video-action="raw" data-start="${resumeAt}">尝试原始播放</button>` : `<button type="button" data-video-action="transcode" data-start="${resumeAt}">转码播放</button>`) : ""}
        ${state?.watched ? `<button type="button" disabled>已标记已播</button>` : `<button type="button" data-video-state-action="mark-watched">标记为已播</button>`}
      </div>
    </section>
  `;
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

function transcodeStatus(message) {
  const target = els.preview.querySelector(".video-preview") || els.preview;
  target.insertAdjacentHTML("beforeend", `<div class="media-info-panel media-info-warning transcode-status">${escapeHtml(message)}</div>`);
}

function chooseTranscodeMime() {
  const candidates = [
    'video/mp4; codecs="avc1.4D4033, mp4a.40.2"',
    'video/mp4; codecs="avc1.4D4028, mp4a.40.2"',
    'video/mp4; codecs="avc1.4D401F, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
  ];
  return candidates.find((mime) => MediaSource.isTypeSupported(mime)) || "";
}

function concatBytes(left, right) {
  if (!left?.length) return right;
  if (!right?.length) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function readMp4Box(buffer, offset = 0) {
  if (offset + 8 > buffer.length) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
  let size = view.getUint32(0);
  const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    const high = view.getUint32(8);
    const low = view.getUint32(12);
    size = high * 2 ** 32 + low;
    headerSize = 16;
  } else if (size === 0) {
    return null;
  }
  if (!Number.isFinite(size) || size < headerSize) throw new Error(`转码流 MP4 box 异常：${type || "unknown"}`);
  if (offset + size > buffer.length) return null;
  return { type, end: offset + size };
}

function takeMp4AppendSegments(state, chunk) {
  let buffer = concatBytes(state.pending, chunk);
  const segments = [];

  if (!state.initAppended) {
    let cursor = 0;
    let foundMoov = false;
    while (cursor < buffer.length) {
      const box = readMp4Box(buffer, cursor);
      if (!box) break;
      cursor = box.end;
      if (box.type === "moov") {
        foundMoov = true;
        break;
      }
    }
    if (!foundMoov) {
      state.pending = buffer;
      return segments;
    }
    segments.push(buffer.slice(0, cursor));
    buffer = buffer.slice(cursor);
    state.initAppended = true;
  }

  while (buffer.length) {
    let cursor = 0;
    let sawMoof = false;
    let foundSegment = false;
    while (cursor < buffer.length) {
      const box = readMp4Box(buffer, cursor);
      if (!box) break;
      if (box.type === "moof") sawMoof = true;
      cursor = box.end;
      if (sawMoof && box.type === "mdat") {
        foundSegment = true;
        break;
      }
    }
    if (!foundSegment) break;
    segments.push(buffer.slice(0, cursor));
    buffer = buffer.slice(cursor);
  }

  state.pending = buffer;
  return segments;
}

function waitForUpdateEnd(sourceBuffer) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onUpdateEnd);
      sourceBuffer.removeEventListener("error", onError);
    };
    const onUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("浏览器写入转码片段失败"));
    };
    sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
  });
}

function setMediaSourceDuration(mediaSource, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || mediaSource.readyState !== "open") return;
  try {
    mediaSource.duration = durationSeconds;
  } catch {
    // Some fragmented MP4 streams keep original timestamps after seeked transcode.
    // In that case lowering duration below buffered timestamps is illegal.
  }
}

function cleanupTranscode(video) {
  if (pendingTranscodeSeekTimer) {
    clearTimeout(pendingTranscodeSeekTimer);
    pendingTranscodeSeekTimer = null;
  }
  if (transcodeControlsHideTimer) {
    clearTimeout(transcodeControlsHideTimer);
    transcodeControlsHideTimer = null;
  }
  if (activeTranscodeController) {
    activeTranscodeController.abort();
    activeTranscodeController = null;
  }
  if (video?.dataset.mediaSourceUrl) {
    URL.revokeObjectURL(video.dataset.mediaSourceUrl);
    delete video.dataset.mediaSourceUrl;
  }
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

function resumePositionFromState(state) {
  const position = Number(state?.positionSeconds || 0);
  const duration = Number(state?.durationSeconds || 0);
  if (!Number.isFinite(position) || position < 5) return 0;
  if (duration > 0 && duration - position < 10) return 0;
  return position;
}

function videoDurationForSave(video, doc) {
  const originalDuration = Number(video.dataset.originalDuration || 0);
  if (Number.isFinite(originalDuration) && originalDuration > 0) return originalDuration;
  if (doc.mediaInfo?.durationSeconds) return doc.mediaInfo.durationSeconds;
  const offset = Number(video.dataset.resumeOffset || 0);
  if (Number.isFinite(video.duration) && video.duration > 0) return offset + video.duration;
  return Number(doc.videoState?.durationSeconds || 0);
}

function transcodeCurrentTime(video) {
  const offset = Number(video.dataset.resumeOffset || 0);
  return Math.max(0, offset + (Number(video.currentTime) || 0));
}

function updateTranscodeControls(video, doc) {
  const controls = els.preview.querySelector(".transcode-controls");
  if (!controls || video.dataset.transcoded !== "true") return;
  const duration = videoDurationForSave(video, doc);
  const current = transcodeCurrentTime(video);
  const slider = controls.querySelector("[data-transcode-seek]");
  const time = controls.querySelector("[data-transcode-time]");
  const playButton = controls.querySelector("[data-transcode-play]");
  const muteButton = controls.querySelector("[data-transcode-mute]");
  const volumeSlider = controls.querySelector("[data-transcode-volume]");
  if (slider && !slider.matches(":active")) {
    slider.max = String(Math.max(1, duration || current || 1));
    slider.value = String(Math.min(Number(slider.max), current));
  }
  if (time) time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
  if (playButton) playButton.textContent = video.paused ? "播放" : "暂停";
  if (muteButton) muteButton.textContent = video.muted || video.volume === 0 ? "静音" : "声音";
  if (volumeSlider && !volumeSlider.matches(":active")) volumeSlider.value = String(video.muted ? 0 : video.volume);
}

function showTranscodeControls(host) {
  if (!host) return;
  host.classList.add("show-transcode-controls");
  if (transcodeControlsHideTimer) clearTimeout(transcodeControlsHideTimer);
}

function isPointerNearTranscodeControls(host, event) {
  const controls = host?.querySelector(".transcode-controls");
  if (!controls) return false;
  const rect = controls.getBoundingClientRect();
  const verticalPadding = 34;
  const horizontalPadding = 8;
  return event.clientX >= rect.left - horizontalPadding
    && event.clientX <= rect.right + horizontalPadding
    && event.clientY >= rect.top - verticalPadding
    && event.clientY <= rect.bottom + verticalPadding;
}

function scheduleHideTranscodeControls(host, delay = 2500) {
  if (!host) return;
  if (transcodeControlsHideTimer) clearTimeout(transcodeControlsHideTimer);
  transcodeControlsHideTimer = setTimeout(() => {
    transcodeControlsHideTimer = null;
    const controls = host.querySelector(".transcode-controls");
    const sliderActive = controls?.querySelector("input[type='range']:active");
    const focusedRange = document.activeElement?.matches?.(".transcode-controls input[type='range']");
    if (!controls || host.dataset.transcodePointerNear === "true" || sliderActive || focusedRange) return;
    host.classList.remove("show-transcode-controls");
  }, delay);
}

function restartTranscodeAt(video, doc, targetSeconds, shouldPlay = !video.paused) {
  const duration = videoDurationForSave(video, doc);
  const upperBound = duration > 0 ? Math.max(0, duration - 2) : Number.MAX_SAFE_INTEGER;
  const target = Math.max(0, Math.min(Number(targetSeconds) || 0, upperBound));
  video.pause();
  startTranscodedPlayback(video, doc, target);
  if (shouldPlay) video.play().catch((error) => transcodeStatus(error.message || "播放失败。"));
}

function transcodeStepSeek(video, doc, seconds) {
  restartTranscodeAt(video, doc, transcodeCurrentTime(video) + seconds);
}

function toggleVideoPlayback(video) {
  if (video.paused) video.play().catch((error) => transcodeStatus(error.message || "播放失败。"));
  else video.pause();
}

function toggleFullscreen(host) {
  if (!document.fullscreenElement) {
    host.requestFullscreen?.().catch((error) => transcodeStatus(error.message || "无法进入全屏。"));
  } else {
    document.exitFullscreen?.();
  }
}

function ensureTranscodeControls(video, doc) {
  const host = els.preview.querySelector(".video-preview");
  if (!host || host.querySelector(".transcode-controls")) return;
  host.insertAdjacentHTML("beforeend", `
    <div class="transcode-controls">
      <button type="button" data-transcode-back title="后退 10 秒">后退</button>
      <button type="button" data-transcode-play>播放</button>
      <button type="button" data-transcode-forward title="前进 10 秒">前进</button>
      <input type="range" min="0" max="1" step="0.1" value="0" data-transcode-seek aria-label="转码播放进度">
      <span data-transcode-time>0:00 / -</span>
      <button type="button" data-transcode-mute>声音</button>
      <input type="range" min="0" max="1" step="0.05" value="1" data-transcode-volume aria-label="音量">
      <button type="button" data-transcode-fullscreen>全屏</button>
    </div>
  `);
  const controls = host.querySelector(".transcode-controls");
  const playButton = controls.querySelector("[data-transcode-play]");
  const slider = controls.querySelector("[data-transcode-seek]");
  const backButton = controls.querySelector("[data-transcode-back]");
  const forwardButton = controls.querySelector("[data-transcode-forward]");
  const muteButton = controls.querySelector("[data-transcode-mute]");
  const volumeSlider = controls.querySelector("[data-transcode-volume]");
  const fullscreenButton = controls.querySelector("[data-transcode-fullscreen]");
  const reveal = () => showTranscodeControls(host);
  const revealThenHide = () => {
    showTranscodeControls(host);
    scheduleHideTranscodeControls(host);
  };
  const blurControl = (event) => event.currentTarget.blur();
  const syncPointerHotZone = (event) => {
    const nearControls = isPointerNearTranscodeControls(host, event);
    host.dataset.transcodePointerNear = nearControls ? "true" : "false";
    if (nearControls) reveal();
    else scheduleHideTranscodeControls(host);
  };

  host.addEventListener("pointermove", syncPointerHotZone);
  host.addEventListener("pointerleave", () => {
    host.dataset.transcodePointerNear = "false";
    scheduleHideTranscodeControls(host);
  });
  host.addEventListener("focusin", reveal);
  host.addEventListener("focusout", () => scheduleHideTranscodeControls(host, 800));
  host.addEventListener("keydown", revealThenHide);
  controls.addEventListener("pointerenter", () => {
    host.dataset.transcodePointerNear = "true";
    reveal();
  });
  controls.addEventListener("pointerleave", () => {
    host.dataset.transcodePointerNear = "false";
    scheduleHideTranscodeControls(host);
  });

  playButton.addEventListener("click", (event) => {
    blurControl(event);
    revealThenHide();
    toggleVideoPlayback(video);
  });

  backButton.addEventListener("click", (event) => {
    blurControl(event);
    revealThenHide();
    transcodeStepSeek(video, doc, -10);
  });

  forwardButton.addEventListener("click", (event) => {
    blurControl(event);
    revealThenHide();
    transcodeStepSeek(video, doc, 10);
  });

  slider.addEventListener("input", () => {
    reveal();
    const duration = videoDurationForSave(video, doc);
    const current = Number(slider.value || 0);
    controls.querySelector("[data-transcode-time]").textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
  });

  slider.addEventListener("change", () => {
    revealThenHide();
    restartTranscodeAt(video, doc, Number(slider.value || 0));
  });

  muteButton.addEventListener("click", (event) => {
    blurControl(event);
    revealThenHide();
    video.muted = !video.muted;
    updateTranscodeControls(video, doc);
  });

  volumeSlider.addEventListener("input", () => {
    revealThenHide();
    video.volume = Math.max(0, Math.min(1, Number(volumeSlider.value || 0)));
    video.muted = video.volume === 0;
    updateTranscodeControls(video, doc);
  });

  fullscreenButton.addEventListener("click", (event) => {
    blurControl(event);
    revealThenHide();
    toggleFullscreen(host);
  });

  updateTranscodeControls(video, doc);
  revealThenHide();
}

async function saveVideoProgress(doc, video, { immediate = false, ended = false } = {}) {
  if (!doc || !video || !isVideo(doc)) return;
  const now = Date.now();
  if (!immediate && now - lastProgressSaveAt < 10000) return;
  const position = video.dataset.transcoded === "true" ? transcodeCurrentTime(video) : Math.max(0, Number(video.currentTime) || 0);
  const duration = videoDurationForSave(video, doc);
  const progressRatio = duration > 0 ? position / duration : 0;
  const watched = ended || (duration > 0 && (progressRatio >= 0.9 || (progressRatio >= 0.8 && duration - position <= 120)));
  if (!Number.isFinite(position) || position < 0) return;
  lastProgressSaveAt = now;
  const response = await apiFetch("/api/video-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    keepalive: immediate,
    body: JSON.stringify({
      dir: currentWorkspacePath,
      path: doc.path,
      positionSeconds: position,
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      watched,
    }),
  });
  const state = await response.json().catch(() => null);
  if (response.ok && state && !state.error) doc.videoState = state;
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

function scheduleTranscodeSeekRestart(video, doc) {
  if (video.dataset.transcoded !== "true") return;
  if (video.dataset.programmaticSeek === "true") return;
  if (video.dataset.restartingTranscode === "true") return;
  const offset = Number(video.dataset.resumeOffset || 0);
  const targetTime = offset + Number(video.currentTime || 0);
  if (!Number.isFinite(targetTime) || targetTime < 0) return;
  if (pendingTranscodeSeekTimer) clearTimeout(pendingTranscodeSeekTimer);
  pendingTranscodeSeekTimer = setTimeout(() => {
    pendingTranscodeSeekTimer = null;
    video.dataset.restartingTranscode = "true";
    startTranscodedPlayback(video, doc, targetTime);
    video.play().catch(() => {});
  }, 120);
}

function attachVideoProgress(video, doc) {
  video.addEventListener("timeupdate", () => {
    updateTranscodeControls(video, doc);
    saveVideoProgress(doc, video).catch(() => {});
  });
  video.addEventListener("pause", () => {
    updateTranscodeControls(video, doc);
    saveVideoProgress(doc, video, { immediate: true }).catch(() => {});
  });
  video.addEventListener("play", () => {
    updateTranscodeControls(video, doc);
  });
  video.addEventListener("loadedmetadata", () => {
    updateTranscodeControls(video, doc);
  });
  video.addEventListener("volumechange", () => {
    updateTranscodeControls(video, doc);
  });
  video.addEventListener("ended", () => {
    updateTranscodeControls(video, doc);
    saveVideoProgress(doc, video, { immediate: true, ended: true }).catch(() => {});
  });
  video.addEventListener("seeking", () => {
    scheduleTranscodeSeekRestart(video, doc);
  });
  video.addEventListener("seeked", () => {
    if (video.dataset.transcoded !== "true") return;
    if (video.dataset.programmaticSeek === "true") {
      delete video.dataset.programmaticSeek;
      return;
    }
    scheduleTranscodeSeekRestart(video, doc);
  });
}

function restoreRawVideoProgress(video, doc) {
  const position = resumePositionFromState(doc.videoState);
  if (!position) return;
  const restore = () => {
    try {
      video.currentTime = Math.min(position, Math.max(0, video.duration - 5));
    } catch {
      // Some browsers reject early seeks until metadata is ready.
    }
  };
  if (Number.isFinite(video.duration) && video.duration > 0) restore();
  else video.addEventListener("loadedmetadata", restore, { once: true });
}

function playVideo(doc, { mode = "transcode", startSeconds = 0, autoplay = true } = {}) {
  cancelMediaProbe();
  cleanupTranscode(els.preview.querySelector("video[data-preview-video]"));
  els.preview.innerHTML = `
    <div class="video-preview">
      <video controls preload="metadata" data-preview-video></video>
    </div>
  `;
  const video = els.preview.querySelector("video[data-preview-video]");
  attachVideoProgress(video, doc);
  const start = Math.max(0, Number(startSeconds) || 0);

  if (mode === "raw") {
    video.controls = true;
    video.dataset.transcoded = "false";
    video.dataset.resumeOffset = "0";
    video.src = doc.rawUrl;
    if (start > 0) {
      doc.videoState = {
        ...(doc.videoState || {}),
        positionSeconds: start,
        durationSeconds: doc.mediaInfo?.durationSeconds || doc.videoState?.durationSeconds || 0,
      };
      restoreRawVideoProgress(video, doc);
    }
    els.transcodeVideo.textContent = "转码播放";
    video.load();
  } else {
    startTranscodedPlayback(video, doc, start);
    els.transcodeVideo.textContent = "原始播放";
  }

  if (autoplay) {
    video.play().catch((error) => {
      const message = error?.message ? `浏览器没有自动开始播放：${error.message}。请点击播放器播放按钮。` : "浏览器没有自动开始播放，请点击播放器播放按钮。";
      transcodeStatus(message);
    });
  }
}

function startTranscodedPlayback(video, doc, startSeconds = 0) {
  cleanupTranscode(video);
  const start = Math.max(0, Number(startSeconds) || 0);
  video.controls = false;
  video.dataset.transcoded = "true";
  video.dataset.resumeOffset = String(start);
  video.dataset.transcodeStart = String(start);
  delete video.dataset.restartingTranscode;
  if (doc.mediaInfo?.durationSeconds) video.dataset.originalDuration = String(doc.mediaInfo.durationSeconds);
  readMediaInfo(doc)
    .then((info) => {
      if (info?.durationSeconds) video.dataset.originalDuration = String(info.durationSeconds);
      updateTranscodeControls(video, doc);
    })
    .catch(() => {});
  video.src = `/api/transcode?${scopedQuery({ path: doc.path, start })}`;
  video.load();
  ensureTranscodeControls(video, doc);
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
  if ((payload.path || "") !== currentWorkspacePath) pendingFileSizePaths.clear();
  dirs = payload.dirs || [];
  docs = payload.docs || [];
  parentPath = payload.parentPath || "";
  activeId = null;
  workspaceName = payload.name || "";
  currentWorkspacePath = payload.path || "";
  applyCachedFileSizes(currentWorkspacePath);
  els.folderPath.value = payload.path || "";
  els.searchInput.value = "";
  const listVersion = ++videoStateListVersion;
  render();
  hydrateVideoStatesForList(listVersion).catch(() => {});
  updateAddress("");
  addRecentItem({ type: "dir", dir: currentWorkspacePath, name: workspaceName });
  const targetDoc = docs.find((doc) => doc.path === pendingFilePath) || docs[0];
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
  if (Number.isFinite(payload.size)) {
    doc.size = payload.size;
    doc.sizeDeferred = false;
    doc.sizeLoading = false;
    doc.sizeError = "";
    rememberFileSize(currentWorkspacePath, doc.path, payload.size);
    setFileSizeText(doc.path, fileSizeDisplayText(doc));
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
  if (previousVideo && previousDoc) saveVideoProgress(previousDoc, previousVideo, { immediate: true }).catch(() => {});
  cleanupTranscode(previousVideo);
  if (previousDoc?.id !== id) releaseDocObjectUrls(previousDoc);
  activeId = id;
  htmlViewMode = "preview";
  updateAddress(doc.path);
  addRecentItem({ type: "file", dir: currentWorkspacePath, file: doc.path, name: doc.name });
  renderFileList();
  updatePreviewActions(doc);
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
    const response = await apiFetch("/api/workspace", {
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
    dirs = [];
    activeId = null;
    workspaceName = "";
    parentPath = "";
    currentWorkspacePath = "";
    videoStateListVersion += 1;
    updateAddress("");
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

function isTextInputTarget(target) {
  const tagName = target?.tagName?.toLowerCase();
  return target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select" || tagName === "button";
}

els.openFolder.addEventListener("click", openFolder);
els.folderPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") openFolder();
});
els.searchInput.addEventListener("input", renderFileList);
els.fileList.addEventListener("scroll", () => {
  lastFileListScrollAt = Date.now();
  scheduleVisibleFileSizeHydration();
  scheduleVisibleThumbnailHydration();
}, { passive: true });

els.recentToggle.addEventListener("click", () => {
  els.recentPopover.hidden = !els.recentPopover.hidden;
});

els.clearRecent.addEventListener("click", () => {
  writeRecentItems([]);
  renderRecentList();
});

els.logout.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

document.addEventListener("click", (event) => {
  if (els.recentPopover.hidden) return;
  if (els.recentPopover.contains(event.target) || els.recentToggle.contains(event.target)) return;
  els.recentPopover.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (isTextInputTarget(event.target)) return;
  const doc = currentDoc();
  const video = els.preview.querySelector("video[data-preview-video]");
  if (!doc || !isVideo(doc) || !video) return;
  const host = els.preview.querySelector(".video-preview");
  const isTranscoded = video.dataset.transcoded === "true";
  const step = event.shiftKey ? 60 : 10;

  if (event.key === " " || event.code === "Space") {
    event.preventDefault();
    toggleVideoPlayback(video);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (isTranscoded) transcodeStepSeek(video, doc, -step);
    else video.currentTime = Math.max(0, video.currentTime - step);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (isTranscoded) transcodeStepSeek(video, doc, step);
    else video.currentTime = Math.min(video.duration || Number.MAX_SAFE_INTEGER, video.currentTime + step);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    video.volume = Math.min(1, video.volume + 0.05);
    video.muted = false;
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    video.volume = Math.max(0, video.volume - 0.05);
    video.muted = video.volume === 0;
  } else if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    video.muted = !video.muted;
  } else if (event.key.toLowerCase() === "f" && host) {
    event.preventDefault();
    toggleFullscreen(host);
  } else {
    return;
  }
  if (isTranscoded) {
    showTranscodeControls(host);
    scheduleHideTranscodeControls(host);
    updateTranscodeControls(video, doc);
  }
});

els.preview.addEventListener("click", async (event) => {
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
    playVideo(doc, {
      mode: button.dataset.videoAction === "raw" ? "raw" : "transcode",
      startSeconds: Number(button.dataset.start || 0),
    });
  } finally {
    button.disabled = false;
  }
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
  cancelMediaProbe();
  const video = els.preview.querySelector("video[data-preview-video]");
  const doc = currentDoc();
  if (video && doc) saveVideoProgress(doc, video, { immediate: true }).catch(() => {});
  releaseDocObjectUrls(doc);
  cleanupTranscode(video);
  document.body.classList.remove("video-mode");
  docs = [];
  dirs = [];
  activeId = null;
  videoStateListVersion += 1;
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
  localStorage.setItem(themeStorageKey, document.body.classList.contains("dark") ? "dark" : "light");
});

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
    playVideo(doc, { mode, startSeconds: resumePositionFromState(state) });
    return;
  }
  els.preview.querySelectorAll(".transcode-status").forEach((item) => item.remove());
  const isTranscoded = video.dataset.transcoded === "true";
  await saveVideoProgress(doc, video, { immediate: true }).catch(() => {});
  video.pause();
  if (isTranscoded) {
    cleanupTranscode(video);
    els.preview.querySelector(".transcode-controls")?.remove();
    video.controls = true;
    video.dataset.transcoded = "false";
    video.dataset.resumeOffset = "0";
    delete video.dataset.transcodeStart;
    delete video.dataset.originalDuration;
    video.src = doc.rawUrl;
    els.transcodeVideo.textContent = "转码播放";
    video.load();
    restoreRawVideoProgress(video, doc);
  } else {
    try {
      const state = await readVideoState(doc).catch(() => doc.videoState);
      startTranscodedPlayback(video, doc, resumePositionFromState(state));
      els.transcodeVideo.textContent = "原始播放";
    } catch (error) {
      transcodeStatus(error.message || "转码播放启动失败。");
      return;
    }
  }
  video.play().catch((error) => {
    const message = error?.message ? `浏览器没有自动开始播放：${error.message}。请点击播放器播放按钮。` : "浏览器没有自动开始播放，请点击播放器播放按钮。";
    transcodeStatus(message);
  });
});

els.preview.addEventListener(
  "error",
  (event) => {
    const video = event.target.closest?.("video[data-preview-video]");
    if (!video || video.dataset.transcoded !== "true") return;
    const error = video.error;
    const message = error ? `转码流播放失败，浏览器错误码：${error.code}` : "转码流播放失败。";
    const target = els.preview.querySelector(".video-preview") || els.preview;
    target.insertAdjacentHTML("beforeend", `<div class="media-info-panel media-info-warning transcode-status">${escapeHtml(message)}</div>`);
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
  if (doc && video) saveVideoProgress(doc, video, { immediate: true }).catch(() => {});
  releaseDocObjectUrls(doc);
});

initResizableSidebar();

if (localStorage.getItem(themeStorageKey) === "dark") {
  document.body.classList.add("dark");
}

const initialDir = initialUrlParams.get("dir") || "";
if (initialDir && pendingFilePath) {
  previewInitialFile(initialDir, pendingFilePath, { replaceList: false });
}

const initialWorkspaceRequest = initialDir
  ? apiFetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: initialDir }),
    })
  : apiFetch("/api/workspace");

initialWorkspaceRequest
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
    render();
  });

renderRecentList();

if (window.EventSource) {
  const events = new EventSource("/api/events");
  events.addEventListener("reload", () => window.location.reload());
}
