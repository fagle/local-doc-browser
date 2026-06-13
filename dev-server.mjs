import { createReadStream, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname);
const defaultWorkspacePath = "D:/proj/realtime-desktop-caption";
const port = Number(process.argv[2] || 5173);
let workspaceRoot = normalizeInputPath(process.argv[3] || defaultWorkspacePath);
const liveReloadClients = new Set();

const staticTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".md": "text/markdown;charset=utf-8",
};

const textExtensions = new Set([
  ".bat",
  ".bash",
  ".c",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".log",
  ".markdown",
  ".md",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".srt",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".vtt",
  ".xml",
  ".yaml",
  ".yml",
]);

const imageTypes = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const fileTypes = new Map([
  ...imageTypes,
  [".css", "text/css;charset=utf-8"],
  [".csv", "text/csv;charset=utf-8"],
  [".htm", "text/html;charset=utf-8"],
  [".html", "text/html;charset=utf-8"],
  [".js", "text/javascript;charset=utf-8"],
  [".json", "application/json;charset=utf-8"],
  [".md", "text/markdown;charset=utf-8"],
  [".mjs", "text/javascript;charset=utf-8"],
  [".txt", "text/plain;charset=utf-8"],
  [".xml", "application/xml;charset=utf-8"],
]);

const ignoredDirectoryNames = new Set([
  ".git",
  ".gradle",
  ".modelscope-cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function isWindowsDrivePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizeInputPath(value) {
  const rawPath = String(value || "").trim();
  if (!rawPath) return "";

  if (platform() !== "win32" && isWindowsDrivePath(rawPath)) {
    const drive = rawPath[0].toLowerCase();
    const rest = rawPath.slice(2).replaceAll("\\", "/").replace(/^\/+/, "");
    return resolve(`/mnt/${drive}/${rest}`);
  }

  return resolve(rawPath);
}

function displayPath(value) {
  if (platform() !== "win32") {
    const match = value.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = (match[2] || "").replaceAll("/", "\\");
      return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
    }
  }

  return value;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json;charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendLiveReload() {
  for (const client of liveReloadClients) {
    client.write("event: reload\ndata: changed\n\n");
  }
}

function setupLiveReload() {
  const watchedFiles = ["index.html", "styles.css", "app.js", "README.md"];
  for (const filename of watchedFiles) {
    watch(join(appRoot, filename), { persistent: false }, () => sendLiveReload());
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fileKind(filename) {
  const extension = extname(filename).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (textExtensions.has(extension)) return "text";
  if (imageTypes.has(extension)) return "image";
  return "";
}

function canPreview(filename) {
  return Boolean(fileKind(filename));
}

async function listPreviewFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const docs = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    if (entry.isDirectory()) continue;
    if (!entry.isFile() || !canPreview(entry.name)) continue;

    const fileStat = await stat(fullPath);
    docs.push({
      id: entry.name,
      name: entry.name,
      path: entry.name,
      kind: fileKind(entry.name),
      size: fileStat.size,
    });
  }

  return docs.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

function documentPath(relativePath) {
  const normalizedRelative = normalize(String(relativePath || ""));
  const target = normalize(join(workspaceRoot, normalizedRelative));
  const pathFromRoot = relative(workspaceRoot, target);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("文档路径超出当前目录");
  }
  return target;
}

function fileUrl(relativePath) {
  return `/api/file/${String(relativePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

async function listDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: displayPath(join(root, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function workspacePayload() {
  if (!workspaceRoot) {
    return { name: "", path: "", dirs: [], docs: [] };
  }

  const rootStat = await stat(workspaceRoot);
  if (!rootStat.isDirectory()) {
    throw new Error("路径不是文件夹");
  }

  return {
    name: basename(workspaceRoot),
    path: displayPath(workspaceRoot),
    resolvedPath: workspaceRoot,
    parentPath: workspaceRoot === parse(workspaceRoot).root ? "" : displayPath(dirname(workspaceRoot)),
    dirs: await listDirectories(workspaceRoot),
    docs: await listPreviewFiles(workspaceRoot),
  };
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/events" && request.method === "GET") {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write("event: connected\ndata: ok\n\n");
    liveReloadClients.add(response);
    request.on("close", () => liveReloadClients.delete(response));
    return true;
  }

  if (url.pathname === "/api/workspace" && request.method === "GET") {
    sendJson(response, 200, await workspacePayload());
    return true;
  }

  if (url.pathname === "/api/workspace" && request.method === "POST") {
    const body = await readBody(request);
    const payload = JSON.parse(body || "{}");
    workspaceRoot = payload.path ? normalizeInputPath(payload.path) : "";
    sendJson(response, 200, await workspacePayload());
    return true;
  }

  if (url.pathname === "/api/document" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const target = documentPath(path);
    const targetStat = await stat(target);
    const kind = fileKind(target);
    if (!targetStat.isFile() || !kind) {
      throw new Error("不是可预览的文件");
    }

    if (kind === "image") {
      sendJson(response, 200, {
        path,
        kind,
        mime: imageTypes.get(extname(target).toLowerCase()),
        rawUrl: fileUrl(path),
      });
      return true;
    }

    sendJson(response, 200, {
      path,
      kind,
      rawUrl: fileUrl(path),
      content: await readFile(target, "utf8"),
    });
    return true;
  }

  if (url.pathname.startsWith("/api/file/") && request.method === "GET") {
    const path = decodeURIComponent(url.pathname.slice("/api/file/".length));
    const target = documentPath(path);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new Error("不是可预览的文件");
    }

    response.writeHead(200, { "content-type": fileTypes.get(extname(target).toLowerCase()) || "application/octet-stream" });
    createReadStream(target).pipe(response);
    return true;
  }

  return false;
}

async function handleStatic(response, pathname) {
  const target = normalize(join(appRoot, pathname === "/" ? "index.html" : pathname));

  if (!target.startsWith(appRoot)) {
    response.writeHead(403, { "content-type": "text/plain;charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("Not file");
  } catch {
    response.writeHead(404, { "content-type": "text/plain;charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "content-type": staticTypes[extname(target)] || "application/octet-stream" });
  createReadStream(target).pipe(response);
}

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/") && (await handleApi(request, response, url))) {
      return;
    }

    await handleStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    sendJson(response, 500, { error: error.message || "服务器错误" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Local Doc Browser: http://0.0.0.0:${port}`);
  console.log(workspaceRoot ? `Workspace: ${displayPath(workspaceRoot)} (${workspaceRoot})` : "Workspace: not set");
  setupLiveReload();
});
