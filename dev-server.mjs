import { createReadStream, createWriteStream, existsSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

const appRoot = resolve(import.meta.dirname);
const defaultWorkspacePath = appRoot;
const port = Number(process.argv[2] || 5173);
const workspaceFilePath = join(appRoot, ".last-workspace");
let workspaceRoot = await resolveInitialWorkspace(process.argv[3]);
const liveReloadClients = new Set();
const appUsername = String(process.env.APP_USERNAME || "admin");
const passwordFilePath = join(appRoot, ".app-password");
const sessionCookieName = "ldb_session";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
const mediaInfoCache = new Map();
const workspacePayloadCache = new Map();
const maxWorkspacePayloadCacheSize = 32;
const configRoot = normalizeInputPath(process.env.CONFIG_DIR || join(appRoot, "data"));
const thumbnailRoot = join(configRoot, "thumbs");
const thumbnailSize = Math.max(80, Math.min(512, Number(process.env.THUMBNAIL_SIZE || 192) || 192));
const db = await openIndexDatabase();
const sessions = new Map();

const staticTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".md": "text/markdown;charset=utf-8",
};

async function resolveBootstrapPassword() {
  if (process.env.APP_PASSWORD) return String(process.env.APP_PASSWORD);

  try {
    const savedPassword = (await readFile(passwordFilePath, "utf8")).trim();
    if (savedPassword) return savedPassword;
  } catch {
    // No saved password yet; generate one below.
  }

  const generatedPassword = randomBytes(18).toString("base64url");
  await writeFile(passwordFilePath, generatedPassword, { mode: 0o600 });
  return generatedPassword;
}

function hashPassword(password, salt = randomBytes(16).toString("base64url"), iterations = 210000) {
  const passwordHash = pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("base64url");
  return { passwordHash, salt, iterations };
}

function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function initializeAuthState() {
  const configuredPassword = process.env.APP_PASSWORD ? String(process.env.APP_PASSWORD) : "";
  const existingUser = indexStatements.authUserByUsername.get(appUsername);

  if (existingUser && !configuredPassword) {
    return {
      source: "sqlite",
      username: existingUser.username,
      user: existingUser,
    };
  }

  const password = configuredPassword || (await resolveBootstrapPassword());
  const hashed = hashPassword(password);
  indexStatements.upsertAuthUser.run({
    username: appUsername,
    password_hash: hashed.passwordHash,
    password_salt: hashed.salt,
    password_iterations: hashed.iterations,
    updated_at: Date.now(),
  });

  return {
    source: configuredPassword ? "APP_PASSWORD migrated to sqlite" : existingUser ? "password file migrated to sqlite" : "generated password migrated to sqlite",
    username: appUsername,
    user: indexStatements.authUserByUsername.get(appUsername),
  };
}

async function resolveInitialWorkspace(argumentPath) {
  if (argumentPath) return normalizeInputPath(argumentPath);
  if (process.env.WORKSPACE) return normalizeInputPath(process.env.WORKSPACE);

  try {
    const savedPath = (await readFile(workspaceFilePath, "utf8")).trim();
    if (savedPath) return normalizeInputPath(savedPath);
  } catch {
    // No saved workspace yet; fall back to the built-in default.
  }

  return normalizeInputPath(defaultWorkspacePath);
}

async function rememberWorkspace(path) {
  if (path) {
    await writeFile(workspaceFilePath, displayPath(path), { mode: 0o600 });
  }
}

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
  ".nfo",
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

const textFilenames = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".nomedia",
  ".npmrc",
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);

const imageTypes = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heics", "image/heic-sequence"],
  [".heif", "image/heif"],
  [".heifs", "image/heif-sequence"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const mediaTypes = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

const fileTypes = new Map([
  ...imageTypes,
  ...mediaTypes,
  [".7z", "application/x-7z-compressed"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gz", "application/gzip"],
  [".pdf", "application/pdf"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".rar", "application/vnd.rar"],
  [".tar", "application/x-tar"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
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

  if (platform() !== "win32") {
    const legacyMount = process.env.LEGACY_NAS_MOUNT || "";
    const mappedMount = process.env.LEGACY_NAS_MAPPED_MOUNT || "";
    if (legacyMount && mappedMount && (rawPath === legacyMount || rawPath.startsWith(`${legacyMount}/`))) {
      const rest = rawPath.slice(legacyMount.length).replace(/^\/+/, "");
      const mountedDrivePath = resolve(mappedMount, rest);
      if (existsSync(mountedDrivePath)) return mountedDrivePath;
    }
  }

  if (platform() === "win32") {
    const legacyMount = process.env.LEGACY_NAS_MOUNT || "";
    const windowsNasDrive = process.env.WINDOWS_NAS_DRIVE || "";
    if (legacyMount && windowsNasDrive && (rawPath === legacyMount || rawPath.startsWith(`${legacyMount}/`))) {
      const rest = rawPath.slice(legacyMount.length).replace(/^\/+/, "").replaceAll("/", "\\");
      return resolve(windowsNasDrive, rest);
    }
  }

  if (platform() !== "win32" && isWindowsDrivePath(rawPath)) {
    const drive = rawPath[0].toLowerCase();
    const rest = rawPath.slice(2).replaceAll("\\", "/").replace(/^\/+/, "");
    const mountedDrivePath = resolve(`/mnt/${drive}/${rest}`);
    if (existsSync(mountedDrivePath)) return mountedDrivePath;

    const configuredMount = process.env[`WSL_DRIVE_${drive.toUpperCase()}`] || process.env[`WINDOWS_DRIVE_${drive.toUpperCase()}`];
    if (configuredMount) {
      const configuredPath = resolve(configuredMount, rest);
      if (existsSync(configuredPath)) return configuredPath;
    }

    const fallbackMount = process.env.WINDOWS_DRIVE_FALLBACK_MOUNT || "";
    if (fallbackMount) {
      const fallbackPath = resolve(fallbackMount, rest);
      if (existsSync(fallbackPath)) return fallbackPath;
    }

    return mountedDrivePath;
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

function sendHtml(response, status, html) {
  response.writeHead(status, { "content-type": "text/html;charset=utf-8" });
  response.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeNextPath(value) {
  const next = String(value || "/");
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.includes("\n") || next.includes("\r")) return "/";
  return next;
}

function loginPage(error = "", next = "/") {
  const safeNext = safeNextPath(next);
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 可米 KomiOS</title>
<style>
  :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#1d252f; --muted:#687483; --line:#d9e0e7; --accent:#0f766e; }
  * { box-sizing: border-box; }
  body { display:grid; place-items:center; min-height:100vh; margin:0; background:var(--bg); color:var(--text); font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif; }
  main { width:min(380px, calc(100vw - 32px)); padding:28px; border:1px solid var(--line); border-radius:8px; background:var(--panel); box-shadow:0 18px 45px rgba(30,41,59,.12); }
  h1 { margin:0 0 6px; font-size:24px; }
  p { margin:0 0 18px; color:var(--muted); font-size:14px; }
  label { display:grid; gap:8px; color:var(--muted); font-size:13px; }
  input { min-height:42px; padding:0 12px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  button { width:100%; min-height:42px; margin-top:14px; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  .error { margin:0 0 12px; color:#b42318; }
</style>
<main>
  <h1>可米 KomiOS</h1>
  <p>请输入访问账号。</p>
  ${error ? `<p class="error">${error}</p>` : ""}
  <form method="post" action="/api/login">
    <input name="next" type="hidden" value="${escapeHtml(safeNext)}">
    <label>用户名
      <input name="username" type="text" value="${escapeHtml(authState.username)}" autofocus autocomplete="username">
    </label>
    <label>密码
      <input name="password" type="password" autocomplete="current-password">
    </label>
    <button type="submit">登录</button>
  </form>
</main>`;
}

function parseCookies(request) {
  const cookies = new Map();
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
  }
  return cookies;
}

function verifyLogin(username, password) {
  if (!authState?.user) return false;
  if (!safeEqualText(username, authState.user.username)) return false;
  const actualPassword = hashPassword(password, authState.user.password_salt, authState.user.password_iterations);
  return safeEqualText(actualPassword.passwordHash, authState.user.password_hash);
}

function authEnabled() {
  return Boolean(authState?.user);
}

function isAuthenticated(request) {
  if (!authEnabled()) return true;
  const token = parseCookies(request).get(sessionCookieName);
  if (!token) return false;
  const now = Date.now();
  const tokenHash = hashSessionToken(token);
  let session = sessions.get(tokenHash);
  if (!session) {
    const persistedSession = indexStatements.authSessionByTokenHash.get(tokenHash);
    if (persistedSession && persistedSession.expires_at > now) {
      session = { expiresAt: persistedSession.expires_at, username: persistedSession.username };
      sessions.set(tokenHash, session);
    }
  }
  if (!session || session.expiresAt <= Date.now() || session.username !== authState.username) {
    sessions.delete(tokenHash);
    indexStatements.deleteAuthSession.run(tokenHash);
    return false;
  }
  indexStatements.touchAuthSession.run({ token_hash: tokenHash, last_seen_at: now });
  return true;
}

function createSession(response) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + sessionMaxAgeSeconds * 1000;
  sessions.set(tokenHash, { expiresAt, username: authState.username });
  indexStatements.upsertAuthSession.run({
    token_hash: tokenHash,
    username: authState.username,
    expires_at: expiresAt,
    created_at: now,
    last_seen_at: now,
  });
  response.setHeader("set-cookie", `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}`);
}

function clearSession(request, response) {
  const token = parseCookies(request).get(sessionCookieName);
  if (token) {
    const tokenHash = hashSessionToken(token);
    sessions.delete(tokenHash);
    indexStatements.deleteAuthSession.run(tokenHash);
  }
  response.setHeader("set-cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function wantsHtml(request) {
  return String(request.headers.accept || "").includes("text/html");
}

function rejectUnauthenticated(request, response, url) {
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 401, { error: "未登录" });
  } else if (wantsHtml(request)) {
    response.writeHead(302, { location: `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}` });
    response.end();
  } else {
    response.writeHead(401, { "content-type": "text/plain;charset=utf-8" });
    response.end("Unauthorized");
  }
}

function sendLiveReload() {
  for (const client of liveReloadClients) {
    client.write("event: reload\ndata: changed\n\n");
  }
}

async function openIndexDatabase() {
  await mkdir(configRoot, { recursive: true });
  await mkdir(thumbnailRoot, { recursive: true });
  const database = new Database(join(configRoot, "komios.db"));
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    create table if not exists files (
      path text primary key,
      display_path text not null,
      name text not null,
      kind text not null,
      mime text not null,
      size integer,
      mtime_ms real,
      indexed_at integer not null
    );

    create index if not exists files_kind_idx on files(kind);
    create index if not exists files_indexed_at_idx on files(indexed_at);

    create table if not exists media_info (
      path text primary key references files(path) on delete cascade,
      size integer not null,
      mtime_ms real not null,
      payload_json text not null,
      probed_at integer not null
    );

    create table if not exists thumbnails (
      path text primary key references files(path) on delete cascade,
      size integer not null,
      mtime_ms real not null,
      thumb_path text not null,
      width integer,
      height integer,
      generated_at integer not null
    );

    create table if not exists auth_users (
      username text primary key,
      password_hash text not null,
      password_salt text not null,
      password_iterations integer not null,
      updated_at integer not null
    );

    create table if not exists auth_sessions (
      token_hash text primary key,
      username text not null references auth_users(username) on delete cascade,
      expires_at integer not null,
      created_at integer not null,
      last_seen_at integer not null
    );

    create index if not exists auth_sessions_expires_at_idx on auth_sessions(expires_at);
  `);
  return database;
}

const indexStatements = {
  fileByPath: db.prepare("select path, display_path, name, kind, mime, size, mtime_ms, indexed_at from files where path = ?"),
  upsertFile: db.prepare(`
    insert into files(path, display_path, name, kind, mime, size, mtime_ms, indexed_at)
    values(@path, @display_path, @name, @kind, @mime, @size, @mtime_ms, @indexed_at)
    on conflict(path) do update set
      display_path = excluded.display_path,
      name = excluded.name,
      kind = excluded.kind,
      mime = excluded.mime,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `),
  mediaByPath: db.prepare("select payload_json, size, mtime_ms, probed_at from media_info where path = ?"),
  upsertMedia: db.prepare(`
    insert into media_info(path, size, mtime_ms, payload_json, probed_at)
    values(@path, @size, @mtime_ms, @payload_json, @probed_at)
    on conflict(path) do update set
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      payload_json = excluded.payload_json,
      probed_at = excluded.probed_at
  `),
  thumbnailByPath: db.prepare("select thumb_path, size, mtime_ms, width, height, generated_at from thumbnails where path = ?"),
  upsertThumbnail: db.prepare(`
    insert into thumbnails(path, size, mtime_ms, thumb_path, width, height, generated_at)
    values(@path, @size, @mtime_ms, @thumb_path, @width, @height, @generated_at)
    on conflict(path) do update set
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      thumb_path = excluded.thumb_path,
      width = excluded.width,
      height = excluded.height,
      generated_at = excluded.generated_at
  `),
  stats: db.prepare(`
    select
      (select count(*) from files) as files,
      (select count(*) from media_info) as media,
      (select count(*) from thumbnails) as thumbnails,
      (select count(*) from auth_sessions where expires_at > unixepoch() * 1000) as activeSessions
  `),
  authUserByUsername: db.prepare("select username, password_hash, password_salt, password_iterations, updated_at from auth_users where username = ?"),
  upsertAuthUser: db.prepare(`
    insert into auth_users(username, password_hash, password_salt, password_iterations, updated_at)
    values(@username, @password_hash, @password_salt, @password_iterations, @updated_at)
    on conflict(username) do update set
      password_hash = excluded.password_hash,
      password_salt = excluded.password_salt,
      password_iterations = excluded.password_iterations,
      updated_at = excluded.updated_at
  `),
  authSessionByTokenHash: db.prepare("select token_hash, username, expires_at, created_at, last_seen_at from auth_sessions where token_hash = ?"),
  upsertAuthSession: db.prepare(`
    insert into auth_sessions(token_hash, username, expires_at, created_at, last_seen_at)
    values(@token_hash, @username, @expires_at, @created_at, @last_seen_at)
    on conflict(token_hash) do update set
      username = excluded.username,
      expires_at = excluded.expires_at,
      last_seen_at = excluded.last_seen_at
  `),
  touchAuthSession: db.prepare("update auth_sessions set last_seen_at = @last_seen_at where token_hash = @token_hash"),
  deleteAuthSession: db.prepare("delete from auth_sessions where token_hash = ?"),
  deleteExpiredAuthSessions: db.prepare("delete from auth_sessions where expires_at <= ?"),
};

const authState = await initializeAuthState();
indexStatements.deleteExpiredAuthSessions.run(Date.now());

function indexedPathKey(target) {
  return normalize(target);
}

function cacheFileMetadata(target, targetStat) {
  indexStatements.upsertFile.run({
    path: indexedPathKey(target),
    display_path: displayPath(target),
    name: basename(target),
    kind: fileKind(target),
    mime: fileMime(target),
    size: Number.isFinite(targetStat?.size) ? targetStat.size : null,
    mtime_ms: Number.isFinite(targetStat?.mtimeMs) ? targetStat.mtimeMs : null,
    indexed_at: Date.now(),
  });
}

function cachedFileMetadata(target) {
  return indexStatements.fileByPath.get(indexedPathKey(target)) || null;
}

function cachedMediaInfo(target, targetStat) {
  const row = indexStatements.mediaByPath.get(indexedPathKey(target));
  if (!row || row.size !== targetStat.size || row.mtime_ms !== targetStat.mtimeMs) return null;
  try {
    return {
      ...JSON.parse(row.payload_json),
      isCached: true,
      cacheSource: "sqlite",
      probedAt: row.probed_at,
    };
  } catch {
    return null;
  }
}

function cacheMediaInfo(target, targetStat, payload) {
  cacheFileMetadata(target, targetStat);
  indexStatements.upsertMedia.run({
    path: indexedPathKey(target),
    size: targetStat.size,
    mtime_ms: targetStat.mtimeMs,
    payload_json: JSON.stringify(payload),
    probed_at: Date.now(),
  });
}

function cachedThumbnail(target, targetStat) {
  const row = indexStatements.thumbnailByPath.get(indexedPathKey(target));
  if (!row || row.size !== targetStat.size || row.mtime_ms !== targetStat.mtimeMs) return null;
  if (!row.thumb_path || !existsSync(row.thumb_path)) return null;
  return {
    generatedAt: row.generated_at,
    height: row.height || null,
    path: row.thumb_path,
    url: thumbnailFileUrl(row.thumb_path),
    width: row.width || null,
  };
}

function cacheThumbnail(target, targetStat, thumbPath, dimensions = {}) {
  cacheFileMetadata(target, targetStat);
  indexStatements.upsertThumbnail.run({
    path: indexedPathKey(target),
    size: targetStat.size,
    mtime_ms: targetStat.mtimeMs,
    thumb_path: thumbPath,
    width: Number.isFinite(dimensions.width) ? dimensions.width : null,
    height: Number.isFinite(dimensions.height) ? dimensions.height : null,
    generated_at: Date.now(),
  });
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
  const name = basename(filename).toLowerCase();
  const extension = extname(filename).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (textFilenames.has(name)) return "text";
  if (textExtensions.has(extension)) return "text";
  if (imageTypes.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ((mediaTypes.get(extension) || "").startsWith("audio/")) return "audio";
  if ((mediaTypes.get(extension) || "").startsWith("video/")) return "video";
  return "file";
}

function fileMime(filename) {
  const name = basename(filename).toLowerCase();
  if (textFilenames.has(name)) return "text/plain;charset=utf-8";
  return fileTypes.get(extname(filename).toLowerCase()) || "application/octet-stream";
}

async function documentMetadata(relativePath, rootPath = "") {
  const target = documentPath(relativePath, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  cacheFileMetadata(target, targetStat);
  const name = basename(target);
  const rawUrl = fileUrl(relativePath, rootPath);
  return {
    id: relativePath,
    name,
    path: relativePath,
    kind: fileKind(target),
    size: targetStat.size,
    mime: fileMime(target),
    rawUrl,
    previewUrl: needsImagePreview(target) ? imagePreviewUrl(relativePath, rootPath) : rawUrl,
    downloadUrl: `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}download=1`,
  };
}

async function fileSizesPayload(paths, rootPath = "") {
  const requestedPaths = Array.isArray(paths) ? paths.slice(0, 16) : [];
  const sizes = [];
  for (const relativePath of requestedPaths) {
    try {
      const target = documentPath(relativePath, rootPath);
      const targetStat = await stat(target);
      if (!targetStat.isFile()) continue;
      cacheFileMetadata(target, targetStat);
      sizes.push({ path: relativePath, size: targetStat.size });
    } catch {
      sizes.push({ path: relativePath, error: "无法读取大小" });
    }
  }
  return { sizes };
}

async function listPreviewFiles(root, entries) {
  const fileEntries = entries.filter((entry) => entry.isFile());
  return fileEntries
    .map((entry) => {
      const target = join(root, entry.name);
      const cached = cachedFileMetadata(target);
      const cachedThumb = cached && Number.isFinite(cached.size) && Number.isFinite(cached.mtime_ms)
        ? cachedThumbnail(target, { size: cached.size, mtimeMs: cached.mtime_ms })
        : null;
      return {
        id: entry.name,
        name: entry.name,
        path: entry.name,
        kind: cached?.kind || fileKind(entry.name),
        size: Number.isFinite(cached?.size) ? cached.size : null,
        sizeDeferred: !Number.isFinite(cached?.size),
        thumbnailUrl: cachedThumb?.url || "",
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

function scopedWorkspaceRoot(rootPath = "") {
  return rootPath ? normalizeInputPath(rootPath) : workspaceRoot;
}

function documentPath(relativePath, rootPath = "") {
  const root = scopedWorkspaceRoot(rootPath);
  const normalizedRelative = normalize(String(relativePath || ""));
  const target = normalize(join(root, normalizedRelative));
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("文档路径超出当前目录");
  }
  return target;
}

function fileUrl(relativePath, rootPath = "") {
  const pathPart = String(relativePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const params = new URLSearchParams();
  if (rootPath) params.set("dir", rootPath);
  const query = params.toString();
  return `/api/file/${pathPart}${query ? `?${query}` : ""}`;
}

function thumbnailFilename(target, targetStat) {
  const key = `${indexedPathKey(target)}|${targetStat.size}|${targetStat.mtimeMs}|${thumbnailSize}`;
  return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.jpg`;
}

function thumbnailFileUrl(thumbPath) {
  return `/api/thumb/${encodeURIComponent(basename(thumbPath))}`;
}

function imagePreviewUrl(relativePath, rootPath = "", options = {}) {
  const params = new URLSearchParams({ path: relativePath });
  if (rootPath) params.set("dir", rootPath);
  params.set("v", "4");
  if (options.width && options.height) {
    params.set("fitWidth", String(options.width));
    params.set("fitHeight", String(options.height));
  }
  return `/api/image-preview?${params.toString()}`;
}

function needsImagePreview(filename) {
  return [".heic", ".heif", ".heics", ".heifs"].includes(extname(filename).toLowerCase());
}

function relativePathFromTarget(target, rootPath = "") {
  const root = scopedWorkspaceRoot(rootPath);
  return relative(root, target).replaceAll("\\", "/");
}

async function existingSidecarVideo(target) {
  const parsed = parse(target);
  const stems = new Set([parsed.name]);
  const appleEdited = parsed.name.match(/^IMG_E(\d+)$/i);
  const appleOriginal = parsed.name.match(/^IMG_(\d+)$/i);
  if (appleEdited) stems.add(`IMG_${appleEdited[1]}`);
  if (appleOriginal) stems.add(`IMG_E${appleOriginal[1]}`);

  const extensions = [".MOV", ".mov", ".MP4", ".mp4", ".M4V", ".m4v"];
  const exactNameCache = new Map();
  const exactPath = async (candidate) => {
    const candidateParsed = parse(candidate);
    const cacheKey = candidateParsed.dir.toLowerCase();
    let names = exactNameCache.get(cacheKey);
    if (!names) {
      names = await readdir(candidateParsed.dir).catch(() => []);
      exactNameCache.set(cacheKey, names);
    }
    const exactName = names.find((name) => name.toLowerCase() === candidateParsed.base.toLowerCase());
    return exactName ? join(candidateParsed.dir, exactName) : candidate;
  };

  for (const stem of stems) {
    for (const extension of extensions) {
      let candidate = join(parsed.dir, `${stem}${extension}`);
      if (candidate === target) continue;
      if (!existsSync(candidate)) continue;
      try {
        candidate = await exactPath(candidate);
        const candidateStat = await stat(candidate);
        if (candidateStat.isFile() && fileKind(candidate) === "video") return { target: candidate, stat: candidateStat };
      } catch {
        // Candidate disappeared between exists and stat.
      }
    }
  }

  return null;
}

async function exactStemSidecarVideo(target) {
  const parsed = parse(target);
  const extensions = [".MOV", ".mov", ".MP4", ".mp4", ".M4V", ".m4v"];
  const names = await readdir(parsed.dir).catch(() => []);
  for (const extension of extensions) {
    const expected = `${parsed.name}${extension}`;
    const exactName = names.find((name) => name.toLowerCase() === expected.toLowerCase());
    if (!exactName) continue;
    const candidate = join(parsed.dir, exactName);
    if (candidate === target) continue;
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile() && fileKind(candidate) === "video") return { target: candidate, stat: candidateStat };
  }
  return null;
}

function livePhotoSidecarPayload({ path, rootPath, sidecar, confidence, message, contentIdentifiers = [] }) {
  const videoPath = relativePathFromTarget(sidecar.target, rootPath);
  const transcodeParams = new URLSearchParams({ path: videoPath, start: "0" });
  if (rootPath) transcodeParams.set("dir", rootPath);
  return videoDisplaySize(sidecar.target).then((displaySize) => ({
    isLive: true,
    mode: "sidecar",
    confidence,
    label: "Live Photo",
    previewUrl: displaySize ? imagePreviewUrl(path, rootPath, displaySize) : imagePreviewUrl(path, rootPath),
    videoDisplaySize: displaySize,
    videoPath,
    videoUrl: fileUrl(videoPath, rootPath),
    transcodeUrl: `/api/transcode?${transcodeParams.toString()}`,
    videoSize: sidecar.stat.size,
    contentIdentifiers,
    message,
  }));
}

function readIsoBoxes(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < headerSize || offset + size > end) break;
    boxes.push({ type, offset, size, headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function heifItemSummary(buffer) {
  const topBoxes = readIsoBoxes(buffer);
  const metaBox = topBoxes.find((box) => box.type === "meta");
  if (!metaBox) return { topLevelBoxes: topBoxes.map((box) => box.type), itemTypes: {}, itemCount: 0 };

  const metaChildren = readIsoBoxes(buffer, metaBox.offset + metaBox.headerSize + 4, metaBox.end);
  const iinfBox = metaChildren.find((box) => box.type === "iinf");
  const itemTypes = {};
  let itemCount = 0;
  if (iinfBox) {
    let cursor = iinfBox.offset + iinfBox.headerSize;
    const version = buffer.readUInt8(cursor);
    cursor += 4;
    itemCount = version === 0 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
    cursor += version === 0 ? 2 : 4;
    for (const itemBox of readIsoBoxes(buffer, cursor, iinfBox.end)) {
      if (itemBox.type !== "infe") continue;
      const itemVersion = buffer.readUInt8(itemBox.offset + itemBox.headerSize);
      if (itemVersion < 2) continue;
      const idBytes = itemVersion === 2 ? 2 : 4;
      const typeOffset = itemBox.offset + itemBox.headerSize + 4 + idBytes + 2;
      if (typeOffset + 4 > itemBox.end) continue;
      const itemType = buffer.toString("latin1", typeOffset, typeOffset + 4);
      itemTypes[itemType] = (itemTypes[itemType] || 0) + 1;
    }
  }

  return {
    topLevelBoxes: topBoxes.map((box) => box.type),
    itemTypes,
    itemCount,
    hasMovieBox: topBoxes.some((box) => box.type === "moov"),
  };
}

function readHeifInteger(buffer, offset, bytes) {
  if (bytes === 0) return 0;
  if (bytes === 1) return buffer.readUInt8(offset);
  if (bytes === 2) return buffer.readUInt16BE(offset);
  if (bytes === 4) return buffer.readUInt32BE(offset);
  if (bytes === 8) return Number(buffer.readBigUInt64BE(offset));
  let value = 0;
  for (let index = 0; index < bytes; index += 1) value = value * 256 + buffer[offset + index];
  return value;
}

function parseHeifItemInfos(buffer, iinfBox) {
  const itemInfos = new Map();
  if (!iinfBox) return itemInfos;
  let cursor = iinfBox.offset + iinfBox.headerSize;
  if (cursor + 6 > iinfBox.end) return itemInfos;
  const version = buffer.readUInt8(cursor);
  cursor += 4;
  const itemCount = version === 0 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
  cursor += version === 0 ? 2 : 4;
  for (const itemBox of readIsoBoxes(buffer, cursor, iinfBox.end).slice(0, itemCount)) {
    if (itemBox.type !== "infe") continue;
    const itemVersion = buffer.readUInt8(itemBox.offset + itemBox.headerSize);
    if (itemVersion < 2) continue;
    const idBytes = itemVersion === 2 ? 2 : 4;
    const idOffset = itemBox.offset + itemBox.headerSize + 4;
    if (idOffset + idBytes + 6 > itemBox.end) continue;
    const itemId = idBytes === 2 ? buffer.readUInt16BE(idOffset) : buffer.readUInt32BE(idOffset);
    const itemTypeOffset = idOffset + idBytes + 2;
    const itemType = buffer.toString("latin1", itemTypeOffset, itemTypeOffset + 4);
    let name = "";
    const nameStart = itemTypeOffset + 4;
    const nameEnd = buffer.indexOf(0, nameStart);
    if (nameEnd >= nameStart && nameEnd < itemBox.end) name = buffer.toString("utf8", nameStart, nameEnd);
    itemInfos.set(itemId, { itemId, itemType, name });
  }
  return itemInfos;
}

function parseHeifItemLocations(buffer, ilocBox) {
  const locations = new Map();
  if (!ilocBox) return locations;
  let cursor = ilocBox.offset + ilocBox.headerSize;
  if (cursor + 8 > ilocBox.end) return locations;
  const version = buffer.readUInt8(cursor);
  cursor += 4;
  const sizeByte = buffer.readUInt8(cursor);
  const offsetSize = sizeByte >> 4;
  const lengthSize = sizeByte & 0x0f;
  const baseIndexByte = buffer.readUInt8(cursor + 1);
  const baseOffsetSize = baseIndexByte >> 4;
  const indexSize = version === 1 || version === 2 ? baseIndexByte & 0x0f : 0;
  cursor += 2;
  const itemCount = version < 2 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
  cursor += version < 2 ? 2 : 4;

  for (let item = 0; item < itemCount && cursor < ilocBox.end; item += 1) {
    const itemId = version < 2 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
    cursor += version < 2 ? 2 : 4;
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = buffer.readUInt16BE(cursor) & 0x000f;
      cursor += 2;
    }
    cursor += 2; // data_reference_index
    const baseOffset = readHeifInteger(buffer, cursor, baseOffsetSize);
    cursor += baseOffsetSize;
    const extentCount = buffer.readUInt16BE(cursor);
    cursor += 2;
    const extents = [];
    for (let extent = 0; extent < extentCount && cursor < ilocBox.end; extent += 1) {
      if (indexSize > 0) cursor += indexSize;
      const extentOffset = readHeifInteger(buffer, cursor, offsetSize);
      cursor += offsetSize;
      const extentLength = readHeifInteger(buffer, cursor, lengthSize);
      cursor += lengthSize;
      extents.push({ offset: baseOffset + extentOffset, length: extentLength });
    }
    locations.set(itemId, { itemId, constructionMethod, extents });
  }
  return locations;
}

function heifMetaLayout(buffer) {
  const topBoxes = readIsoBoxes(buffer);
  const metaBox = topBoxes.find((box) => box.type === "meta");
  if (!metaBox) return null;
  const metaChildren = readIsoBoxes(buffer, metaBox.offset + metaBox.headerSize + 4, metaBox.end);
  const idatBox = metaChildren.find((box) => box.type === "idat");
  return {
    metaChildren,
    idatPayloadOffset: idatBox ? idatBox.offset + idatBox.headerSize : 0,
    itemInfos: parseHeifItemInfos(buffer, metaChildren.find((box) => box.type === "iinf")),
    locations: parseHeifItemLocations(buffer, metaChildren.find((box) => box.type === "iloc")),
  };
}

async function heifMetadataText(target) {
  const targetStat = await stat(target);
  const handle = await open(target, "r");
  try {
    const head = Buffer.alloc(Math.min(targetStat.size, 1024 * 1024));
    await handle.read(head, 0, head.length, 0);
    const layout = heifMetaLayout(head);
    if (!layout) return head.toString("latin1");
    const chunks = [head.toString("latin1")];
    for (const [itemId, info] of layout.itemInfos) {
      if (!["Exif", "mime", "uri "].includes(info.itemType)) continue;
      const location = layout.locations.get(itemId);
      if (!location) continue;
      for (const extent of location.extents) {
        if (!extent.length || extent.length > 1024 * 1024) continue;
        const absoluteOffset = location.constructionMethod === 1
          ? layout.idatPayloadOffset + extent.offset
          : extent.offset;
        if (absoluteOffset < 0 || absoluteOffset + extent.length > targetStat.size) continue;
        const itemBuffer = Buffer.alloc(extent.length);
        await handle.read(itemBuffer, 0, itemBuffer.length, absoluteOffset);
        chunks.push(itemBuffer.toString("latin1"));
        chunks.push(itemBuffer.toString("utf8"));
      }
    }
    return chunks.join("\n");
  } finally {
    await handle.close();
  }
}

function extractContentIdentifiers(text) {
  const identifiers = new Set();
  const source = String(text || "");
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const compactUuidPattern = /[0-9a-f]{32}/i;
  const keyPattern = /(?:content[-_. ]?identifier|assetidentifier|asset[-_. ]?identifier|com\.apple\.quicktime\.content\.identifier)[^0-9a-f]{0,120}([0-9a-f-]{32,36})/ig;
  for (const match of source.matchAll(keyPattern)) {
    const raw = match[1];
    const value = raw.match(uuidPattern)?.[0] || raw.match(compactUuidPattern)?.[0];
    if (!value) continue;
    const normalized = value.length === 32
      ? `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
      : value;
    identifiers.add(normalized.toLowerCase());
  }
  return [...identifiers];
}

function parseHeifPrimaryItemId(buffer, metaChildren) {
  const pitmBox = metaChildren.find((box) => box.type === "pitm");
  if (!pitmBox || pitmBox.offset + pitmBox.headerSize + 8 > pitmBox.end) return 0;
  const version = buffer.readUInt8(pitmBox.offset + pitmBox.headerSize);
  const cursor = pitmBox.offset + pitmBox.headerSize + 4;
  return version === 0 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
}

function parseHeifProperties(buffer, ipcoBox) {
  if (!ipcoBox) return [];
  return readIsoBoxes(buffer, ipcoBox.offset + ipcoBox.headerSize, ipcoBox.end).map((box) => {
    const payloadOffset = box.offset + box.headerSize;
    const payload = buffer.subarray(payloadOffset, box.end);
    const property = { type: box.type, payload };
    if (box.type === "ispe" && payload.length >= 12) {
      property.width = payload.readUInt32BE(4);
      property.height = payload.readUInt32BE(8);
    }
    if (box.type === "irot" && payload.length >= 1) {
      property.rotation = (payload[0] & 0x03) * 90;
    }
    if (box.type === "imir" && payload.length >= 1) {
      property.mirrorAxis = payload[0] & 0x01;
    }
    return property;
  });
}

function parseHeifItemAssociations(buffer, ipmaBox, properties, itemId) {
  if (!ipmaBox || !itemId) return [];
  let cursor = ipmaBox.offset + ipmaBox.headerSize;
  if (cursor + 8 > ipmaBox.end) return [];
  const version = buffer.readUInt8(cursor);
  const flags = buffer.readUIntBE(cursor + 1, 3);
  cursor += 4;
  const entryCount = buffer.readUInt32BE(cursor);
  cursor += 4;

  for (let entry = 0; entry < entryCount && cursor < ipmaBox.end; entry += 1) {
    const currentItemId = version < 1 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);
    cursor += version < 1 ? 2 : 4;
    const associationCount = buffer.readUInt8(cursor);
    cursor += 1;
    const associated = [];
    for (let index = 0; index < associationCount && cursor < ipmaBox.end; index += 1) {
      const raw = flags & 1 ? buffer.readUInt16BE(cursor) : buffer.readUInt8(cursor);
      cursor += flags & 1 ? 2 : 1;
      const propertyIndex = raw & (flags & 1 ? 0x7fff : 0x7f);
      const property = properties[propertyIndex - 1];
      if (property) associated.push(property);
    }
    if (currentItemId === itemId) return associated;
  }
  return [];
}

async function heifOrientation(target) {
  const targetStat = await stat(target);
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(targetStat.size, 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    const topBoxes = readIsoBoxes(buffer);
    const metaBox = topBoxes.find((box) => box.type === "meta");
    if (!metaBox) return null;
    const metaChildren = readIsoBoxes(buffer, metaBox.offset + metaBox.headerSize + 4, metaBox.end);
    const primaryItemId = parseHeifPrimaryItemId(buffer, metaChildren);
    const iprpBox = metaChildren.find((box) => box.type === "iprp");
    if (!iprpBox || !primaryItemId) return null;
    const iprpChildren = readIsoBoxes(buffer, iprpBox.offset + iprpBox.headerSize, iprpBox.end);
    const properties = parseHeifProperties(buffer, iprpChildren.find((box) => box.type === "ipco"));
    const associated = parseHeifItemAssociations(buffer, iprpChildren.find((box) => box.type === "ipma"), properties, primaryItemId);
    const size = associated.find((property) => property.type === "ispe" && property.width && property.height);
    const rotation = associated.find((property) => property.type === "irot");
    const mirror = associated.find((property) => property.type === "imir");
    if (!size && !rotation && !mirror) return null;
    return {
      primaryItemId,
      codedWidth: size?.width || 0,
      codedHeight: size?.height || 0,
      rotation: rotation?.rotation || 0,
      mirrorAxis: mirror?.mirrorAxis,
    };
  } finally {
    await handle.close();
  }
}

async function videoDisplaySize(target) {
  try {
    const output = await spawnBuffered(process.env.FFPROBE_PATH || "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
      "-of",
      "json",
      target,
    ]);
    const data = JSON.parse(output.toString("utf8") || "{}");
    const stream = data.streams?.[0] || {};
    let width = Number(stream.width || 0);
    let height = Number(stream.height || 0);
    const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0);
    if (Math.abs(rotation) % 180 === 90) {
      [width, height] = [height, width];
    }
    return width > 0 && height > 0 ? { width, height, rotation } : null;
  } catch {
    return quickTimeDisplaySize(target).catch(() => null);
  }
}

async function heifSummary(target) {
  const targetStat = await stat(target);
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(targetStat.size, 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    return heifItemSummary(buffer);
  } finally {
    await handle.close();
  }
}

async function heifLivePhotoDetails(target) {
  const summary = await heifSummary(target).catch((error) => ({ error: error.message }));
  const text = await heifMetadataText(target).catch(() => readHeadText(target, 1024 * 1024)).catch(() => "");
  const lowerText = text.toLowerCase();
  const hasLivePhotoHint = /com\.apple\.quicktime\.live-photo-info|livephotometadata|live photo|live-photo|contentidentifier|content identifier/.test(lowerText);
  const hasMotionPhotoHint = /motionphoto=["']1["']|microvideo=["']1["']|microvideooffset|container:item/.test(lowerText);
  const hasApplePhotoMetadata = /apple ios|com\.apple|hdrgainmap|xmp core/.test(lowerText);
  return {
    ...summary,
    hasLivePhotoHint,
    hasMotionPhotoHint,
    hasApplePhotoMetadata,
    contentIdentifiers: extractContentIdentifiers(text),
  };
}

async function quickTimeContentIdentifiers(target) {
  try {
    const output = await spawnBuffered("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format_tags:stream_tags",
      "-of",
      "json",
      target,
    ], { timeoutMs: 5000 });
    const text = output.toString("utf8");
    const identifiers = extractContentIdentifiers(text);
    const data = JSON.parse(text || "{}");
    const values = [];
    const collect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        if (/content.*identifier|asset.*identifier/i.test(key) && typeof nested === "string") values.push(nested);
        if (nested && typeof nested === "object") collect(nested);
      }
    };
    collect(data);
    for (const value of values) {
      for (const identifier of extractContentIdentifiers(value)) identifiers.push(identifier);
    }
    return [...new Set(identifiers.map((identifier) => identifier.toLowerCase()))];
  } catch {
    return [];
  }
}

async function livePhotoSidecarByContentIdentifier(target, rootPath, identifiers = []) {
  const wanted = new Set(identifiers.map((identifier) => identifier.toLowerCase()));
  if (!wanted.size) return null;
  const parsed = parse(target);
  const names = await readdir(parsed.dir).catch(() => []);
  const videoNames = names.filter((name) => fileKind(name) === "video");
  const sameNumber = parsed.name.match(/(\d+)/)?.[1] || "";
  const ordered = videoNames.sort((left, right) => {
    const leftScore = sameNumber && left.includes(sameNumber) ? 0 : 1;
    const rightScore = sameNumber && right.includes(sameNumber) ? 0 : 1;
    return leftScore - rightScore || left.localeCompare(right, "zh-CN");
  });

  for (const name of ordered.slice(0, 200)) {
    const candidate = join(parsed.dir, name);
    const candidateIdentifiers = await quickTimeContentIdentifiers(candidate);
    if (!candidateIdentifiers.some((identifier) => wanted.has(identifier))) continue;
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) continue;
    return { target: candidate, stat: candidateStat, identifiers: candidateIdentifiers };
  }
  return null;
}

async function readHeadText(target, bytes = 512 * 1024) {
  const targetStat = await stat(target);
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(targetStat.size, bytes));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function xmpAttribute(block, name) {
  const match = block.match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : "";
}

async function embeddedMotionPhoto(target, rootPath = "", relativePath = "") {
  const targetStat = await stat(target);
  const text = await readHeadText(target);
  if (!/MotionPhoto=["']1["']/.test(text) && !/MicroVideo=["']1["']/.test(text)) return null;

  const itemBlocks = [...text.matchAll(/<Container:Item\b[\s\S]*?(?:\/>|<\/Container:Item>)/g)].map((match) => match[0]);
  const videoItem = itemBlocks.find((block) => /Item:Mime="video\/mp4"/.test(block));
  if (!videoItem) return null;

  const length = Number(xmpAttribute(videoItem, "Item:Length"));
  const padding = Number(xmpAttribute(videoItem, "Item:Padding") || 0);
  if (!Number.isInteger(length) || length <= 0 || !Number.isFinite(padding) || padding < 0) return null;

  let offset = targetStat.size - padding - length;
  if (offset < 0 || offset >= targetStat.size) return null;

  const handle = await open(target, "r");
  try {
    const probe = Buffer.alloc(64);
    await handle.read(probe, 0, probe.length, offset);
    if (probe.toString("ascii", 4, 8) !== "ftyp") {
      const found = probe.indexOf("ftyp", 0, "ascii");
      if (found >= 4) offset += found - 4;
    }
  } finally {
    await handle.close();
  }

  if (offset < 0 || offset + length > targetStat.size) return null;
  const params = new URLSearchParams({ path: relativePath });
  if (rootPath) params.set("dir", rootPath);
  return {
    offset,
    length,
    videoUrl: `/api/motion-video?${params.toString()}`,
  };
}

async function embeddedMotionVideoInfo(target, motion) {
  try {
    const handle = await open(target, "r");
    try {
      const bytesToRead = Math.min(motion.length, 1024 * 1024);
      const header = Buffer.alloc(bytesToRead);
      await handle.read(header, 0, header.length, motion.offset);
      const tail = Buffer.alloc(bytesToRead);
      await handle.read(tail, 0, tail.length, motion.offset + motion.length - bytesToRead);
      const text = `${header.toString("latin1")}\n${tail.toString("latin1")}`;
      const codec = text.includes("hvc1") || text.includes("hev1")
        ? "hvc1"
        : text.includes("avc1")
          ? "avc1"
          : "";
      return { codec };
    } finally {
      await handle.close();
    }
  } catch {
    return { codec: "" };
  }
}

async function livePhotoPayload(path, rootPath = "") {
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  if (fileKind(target) !== "image") throw new Error("不是图片文件");

  const embeddedMotion = await embeddedMotionPhoto(target, rootPath, path).catch(() => null);
  if (embeddedMotion) {
    const motionInfo = await embeddedMotionVideoInfo(target, embeddedMotion);
    const transcodeParams = new URLSearchParams({ path });
    if (rootPath) transcodeParams.set("dir", rootPath);
    return {
      isLive: true,
      mode: "embedded-motion-photo",
      confidence: "embedded",
      label: "Motion Photo",
      videoPath: path,
      videoCodec: motionInfo.codec,
      videoUrl: embeddedMotion.videoUrl,
      transcodeUrl: `/api/motion-video-transcode?${transcodeParams.toString()}`,
      videoSize: embeddedMotion.length,
      message: "检测到图片内部嵌入的 Motion Photo 视频。",
    };
  }

  const extension = extname(target).toLowerCase();
  let summary = null;
  if ([".heic", ".heif", ".heics", ".heifs"].includes(extension)) {
    summary = await heifLivePhotoDetails(target).catch((error) => ({ error: error.message }));
  }

  if (summary?.contentIdentifiers?.length) {
    const sidecar = await livePhotoSidecarByContentIdentifier(target, rootPath, summary.contentIdentifiers);
    if (sidecar) {
      return livePhotoSidecarPayload({
        path,
        rootPath,
        sidecar,
        confidence: "content-identifier",
        message: "按 Apple Live Photo Content Identifier 找到配套 MOV/MP4。",
        contentIdentifiers: summary.contentIdentifiers,
      });
    }
  }

  if (summary?.hasApplePhotoMetadata) {
    const sidecar = await exactStemSidecarVideo(target);
    if (sidecar) {
      return livePhotoSidecarPayload({
        path,
        rootPath,
        sidecar,
        confidence: "exact-stem-sidecar",
        message: "找到严格同名的 MOV/MP4 动态部分。",
        contentIdentifiers: summary.contentIdentifiers || [],
      });
    }
  }

  if (summary?.hasLivePhotoHint || summary?.hasMotionPhotoHint) {
    const sidecar = await existingSidecarVideo(target);
    if (sidecar) {
      return livePhotoSidecarPayload({
        path,
        rootPath,
        sidecar,
        confidence: "heic-metadata-sidecar",
        message: "HEIC 内部声明为 Live Photo，并找到对应 MOV/MP4 动态部分。",
        contentIdentifiers: summary.contentIdentifiers || [],
      });
    }
  }

  const hasHeifTiles = Number(summary?.itemTypes?.hvc1 || 0) > 1 && Number(summary?.itemTypes?.grid || 0) > 0;
  const hasAuxiliaryImage = Boolean(summary?.itemTypes?.mime || 0) || Boolean(summary?.hasApplePhotoMetadata);
  const mayNeedMissingSidecar = [".heic", ".heif", ".heics", ".heifs"].includes(extension)
    && summary?.hasApplePhotoMetadata
    && !summary?.hasMovieBox
    && !summary?.contentIdentifiers?.length;
  return {
    isLive: false,
    mode: mayNeedMissingSidecar ? "missing-sidecar-suspected" : "none",
    label: mayNeedMissingSidecar ? "疑似缺少动态部分" : "静态图片",
    summary,
    message: mayNeedMissingSidecar
      ? "这个 Apple HEIC 只包含静态主图/辅助图，没有内嵌视频轨道；如果手机上能动，动态 MOV 很可能没有和 HEIC 一起导出到当前目录。"
      : summary && !summary.hasLivePhotoHint && !summary.hasMotionPhotoHint
      ? "HEIC 内部没有声明 Live Photo/Motion Photo 动态信息，也没有可匹配的 Content Identifier。"
      : hasHeifTiles
      ? `没有找到配套 MOV/MP4。这个 HEIC 内部是 HEVC 网格切片静态图${hasAuxiliaryImage ? "，另含辅助图" : ""}，不包含可播放的视频轨道。`
      : "没有找到可播放的 Live Photo 动态部分。",
  };
}

function nfoPathForVideo(relativePath, rootPath = "") {
  const target = documentPath(relativePath, rootPath);
  if (!fileMime(target).startsWith("video/")) {
    throw new Error("不是视频文件");
  }
  const parsed = parse(target);
  return join(parsed.dir, `${parsed.name}.nfo`);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlText(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  if (!match) return "";
  return match[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

function xmlNumber(xml, tagName) {
  const value = Number(xmlText(xml, tagName));
  return Number.isFinite(value) ? value : 0;
}

function xmlBlocks(xml, tagName) {
  return [...String(xml || "").matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "gi"))].map((match) => match[1]);
}

function rootTagName(xml) {
  const match = String(xml || "").match(/<([a-zA-Z][\w:-]*)\b[^>]*>/);
  return match?.[1] || "movie";
}

function upsertXmlTag(xml, tagName, value) {
  const nextTag = `<${tagName}>${xmlEscape(value)}</${tagName}>`;
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?</${tagName}>`, "i");
  if (pattern.test(xml)) return xml.replace(pattern, nextTag);
  const root = rootTagName(xml);
  const closePattern = new RegExp(`</${root}>\\s*$`, "i");
  if (closePattern.test(xml)) return xml.replace(closePattern, `  ${nextTag}\n</${root}>`);
  return `${xml.trim()}\n${nextTag}\n`;
}

function upsertResume(xml, position, total) {
  const resumeXml = `  <resume>\n    <position>${Math.max(0, position).toFixed(3)}</position>\n    <total>${Math.max(0, total).toFixed(3)}</total>\n  </resume>`;
  const pattern = /^[ \t]*<resume\b[^>]*>[\s\S]*?<\/resume>/im;
  if (pattern.test(xml)) return xml.replace(pattern, resumeXml);
  const root = rootTagName(xml);
  const closePattern = new RegExp(`</${root}>\\s*$`, "i");
  if (closePattern.test(xml)) return xml.replace(closePattern, `${resumeXml}\n</${root}>`);
  return `${xml.trim()}\n${resumeXml}\n`;
}

function createKodiNfo(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<movie>\n  <title>${xmlEscape(title)}</title>\n</movie>\n`;
}

function kodiCodecToBrowserCodec(codec) {
  const normalized = String(codec || "").trim().toLowerCase();
  const map = {
    h264: "avc1",
    x264: "avc1",
    avc: "avc1",
    avc1: "avc1",
    hevc: "hvc1",
    h265: "hvc1",
    x265: "hvc1",
    hvc1: "hvc1",
    hev1: "hev1",
    av1: "av01",
    av01: "av01",
    mpeg4: "mp4v",
    "mpeg-4": "mp4v",
    mp4v: "mp4v",
    vp9: "vp09",
    vp09: "vp09",
    aac: "mp4a.40.2",
    mp4a: "mp4a.40.2",
    ac3: "ac-3",
    "ac-3": "ac-3",
    eac3: "ec-3",
    "e-ac-3": "ec-3",
    "ec-3": "ec-3",
  };
  return map[normalized] || "";
}

function kodiCodecDescription(codec) {
  const normalized = String(codec || "").trim().toLowerCase();
  const names = {
    h264: "H.264 / AVC",
    x264: "H.264 / AVC",
    avc: "H.264 / AVC",
    avc1: "H.264 / AVC",
    hevc: "H.265 / HEVC",
    h265: "H.265 / HEVC",
    x265: "H.265 / HEVC",
    hvc1: "H.265 / HEVC",
    hev1: "H.265 / HEVC",
    av1: "AV1",
    av01: "AV1",
    mpeg4: "MPEG-4 Visual",
    mp4v: "MPEG-4 Visual",
    vp9: "VP9",
    aac: "AAC",
    ac3: "Dolby Digital AC-3",
    eac3: "Dolby Digital Plus E-AC-3",
    truehd: "Dolby TrueHD",
    dts: "DTS",
  };
  return names[normalized] || codec || "";
}

function parseKodiStreamDetails(content, target) {
  const streamDetails = xmlBlocks(content, "streamdetails")[0] || "";
  if (!streamDetails) return null;

  const tracks = [];
  const video = xmlBlocks(streamDetails, "video")[0] || "";
  const videoCodec = xmlText(video, "codec");
  const width = xmlNumber(video, "width");
  const height = xmlNumber(video, "height");
  const durationSeconds = xmlNumber(video, "durationinseconds");
  const hdrType = xmlText(video, "hdrtype");
  const browserVideoCodec = kodiCodecToBrowserCodec(videoCodec);
  if (videoCodec) {
    tracks.push({
      codec: browserVideoCodec || videoCodec,
      codecTag: videoCodec,
      description: kodiCodecDescription(videoCodec),
      hdrType,
      height,
      kind: "video",
      source: "kodi-nfo",
      width,
    });
  }

  for (const audio of xmlBlocks(streamDetails, "audio")) {
    const audioCodec = xmlText(audio, "codec");
    if (!audioCodec) continue;
    tracks.push({
      channels: xmlNumber(audio, "channels"),
      codec: kodiCodecToBrowserCodec(audioCodec) || audioCodec,
      codecTag: audioCodec,
      description: kodiCodecDescription(audioCodec),
      kind: "audio",
      language: xmlText(audio, "language"),
      source: "kodi-nfo",
    });
  }

  if (!tracks.length) return null;
  const codecs = tracks.map((track) => track.codec).filter(Boolean);
  return {
    container: extname(target).replace(".", "").toUpperCase() || "unknown",
    durationSeconds: durationSeconds || null,
    isFromNfo: true,
    mime: codecs.length ? `${fileMime(target)}; codecs="${codecs.join(", ")}"` : fileMime(target),
    source: "Kodi NFO",
    tracks,
    warning: browserVideoCodec ? "" : "NFO 中的视频编码值无法映射为浏览器 codec string，已保留原始值。",
  };
}

async function readVideoState(relativePath, rootPath = "") {
  const nfoPath = nfoPathForVideo(relativePath, rootPath);
  const target = documentPath(relativePath, rootPath);
  let content = "";
  let exists = false;
  try {
    content = await readFile(nfoPath, "utf8");
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const resume = content.match(/<resume\b[^>]*>[\s\S]*?<\/resume>/i)?.[0] || "";
  const position = xmlNumber(resume, "position");
  const total = xmlNumber(resume, "total");
  const playcount = xmlNumber(content, "playcount");
  return {
    exists,
    nfoPath: displayPath(nfoPath),
    positionSeconds: position,
    durationSeconds: total,
    watched: playcount > 0,
    playcount,
    lastPlayed: xmlText(content, "lastplayed"),
    mediaInfo: parseKodiStreamDetails(content, target),
  };
}

async function writeVideoState(relativePath, payload, rootPath = "") {
  const target = documentPath(relativePath, rootPath);
  const nfoPath = nfoPathForVideo(relativePath, rootPath);
  const position = Number(payload.positionSeconds || 0);
  const duration = Number(payload.durationSeconds || 0);
  const progressRatio = duration > 0 ? position / duration : 0;
  const watched = Boolean(payload.watched) || (duration > 0 && (progressRatio >= 0.9 || (progressRatio >= 0.8 && duration - position <= 120)));
  let content = "";

  try {
    content = await readFile(nfoPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    content = createKodiNfo(parse(target).name);
  }

  const existingPlaycount = xmlNumber(content, "playcount");
  if (payload.updateResume !== false) {
    content = upsertResume(content, Number.isFinite(position) ? position : 0, Number.isFinite(duration) ? duration : 0);
  }
  content = upsertXmlTag(content, "playcount", watched ? Math.max(1, existingPlaycount) : existingPlaycount);
  if (watched) {
    content = upsertXmlTag(content, "lastplayed", new Date().toISOString().slice(0, 10));
  }
  await writeFile(nfoPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return readVideoState(relativePath, rootPath);
}

function fileHeaders(target, size, url) {
  const headers = {
    "accept-ranges": "bytes",
    "content-length": size,
    "content-type": fileMime(target),
  };
  if (url.searchParams.has("download")) {
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`;
  }
  return headers;
}

function parseRangeHeader(rangeHeader, size) {
  const match = String(rangeHeader || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start;
  let end;
  if (match[1] === "" && match[2] === "") return null;

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function spawnBuffered(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], ...spawnOptions });
    const stdout = [];
    let stderr = "";
    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
    }
    if (input) {
      child.stdin.end(input);
    }
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${code}`));
      }
    });
  });
}

async function jpegDimensions(input) {
  const output = await spawnBuffered("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    "-",
  ], { input });
  const data = JSON.parse(output.toString("utf8") || "{}");
  const stream = data.streams?.[0] || {};
  const width = Number(stream.width || 0);
  const height = Number(stream.height || 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

function heifOrientationAlreadyApplied(orientation, dimensions) {
  if (!orientation || !dimensions || !orientation.codedWidth || !orientation.codedHeight) return true;
  const normalizedRotation = ((orientation.rotation % 360) + 360) % 360;
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    return dimensions.width === orientation.codedHeight && dimensions.height === orientation.codedWidth;
  }
  return true;
}

function heifOrientationFilter(orientation) {
  const filters = [];
  const normalizedRotation = ((orientation?.rotation || 0) % 360 + 360) % 360;
  if (normalizedRotation === 90) filters.push("transpose=2");
  if (normalizedRotation === 180) filters.push("hflip", "vflip");
  if (normalizedRotation === 270) filters.push("transpose=1");
  if (orientation?.mirrorAxis === 0) filters.push("hflip");
  if (orientation?.mirrorAxis === 1) filters.push("vflip");
  return filters.join(",");
}

async function applyHeifOrientationFallback(input, target) {
  const orientation = await heifOrientation(target).catch(() => null);
  const filter = heifOrientationFilter(orientation);
  if (!filter) return input;
  const dimensions = await jpegDimensions(input).catch(() => null);
  if (heifOrientationAlreadyApplied(orientation, dimensions)) return input;
  return spawnBuffered("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mjpeg",
    "-i",
    "pipe:0",
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    "pipe:1",
  ], { input });
}

async function bakeJpegOrientationMetadata(input) {
  return spawnBuffered("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mjpeg",
    "-i",
    "pipe:0",
    "-map_metadata",
    "-1",
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    "pipe:1",
  ], { input });
}

async function heifConvertPreview(target) {
  const tempDir = await mkdtemp(join(tmpdir(), "ldb-heic-"));
  const output = join(tempDir, "preview.jpg");
  try {
    await spawnBuffered("heif-convert", ["-q", "90", target, output]);
    let converted = await readFile(output);
    try {
      converted = await spawnBuffered("magick", [output, "-auto-orient", "jpg:-"]);
    } catch {
      // ImageMagick is optional; fall back to the raw conversion if it is unavailable.
    }
    const oriented = await applyHeifOrientationFallback(converted, target);
    return await bakeJpegOrientationMetadata(oriented).catch(() => oriented);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function fitAspectFromUrl(url) {
  const width = Number(url.searchParams.get("fitWidth") || 0);
  const height = Number(url.searchParams.get("fitHeight") || 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function cropJpegToAspect(input, aspect) {
  if (!aspect) return input;
  const ratio = aspect.width / aspect.height;
  return spawnBuffered("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mjpeg",
    "-i",
    "pipe:0",
    "-vf",
    `crop='if(gt(a,${ratio}),ih*${ratio},iw)':'if(gt(a,${ratio}),ih,iw/${ratio})',scale='min(2400,iw)':-2`,
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], input });
}

async function squareJpegThumbnail(input) {
  return spawnBuffered("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mjpeg",
    "-i",
    "pipe:0",
    "-vf",
    `scale=${thumbnailSize}:${thumbnailSize}:force_original_aspect_ratio=increase,crop=${thumbnailSize}:${thumbnailSize}`,
    "-frames:v",
    "1",
    "-q:v",
    "5",
    "-f",
    "mjpeg",
    "pipe:1",
  ], { input, timeoutMs: 8000 });
}

async function videoThumbnailBufferAt(target, seekSeconds = null) {
  const seekArgs = Number.isFinite(seekSeconds) ? ["-ss", String(seekSeconds)] : [];
  return spawnBuffered("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seekArgs,
    "-i",
    target,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    `scale=${thumbnailSize}:${thumbnailSize}:force_original_aspect_ratio=increase,crop=${thumbnailSize}:${thumbnailSize}`,
    "-q:v",
    "5",
    "-f",
    "mjpeg",
    "pipe:1",
  ], { timeoutMs: 10000 });
}

async function videoThumbnailBuffer(target) {
  try {
    const output = await videoThumbnailBufferAt(target, 1);
    if (output?.length) return output;
  } catch {
    // Fall through to decode from the beginning.
  }
  const output = await videoThumbnailBufferAt(target, null);
  if (output?.length) return output;
  return videoThumbnailBufferAt(target, 0);
}

async function imagePreviewBuffer(target, options = {}) {
  const attempts = [
    {
      name: "heif-convert",
      run: () => heifConvertPreview(target),
    },
    {
      name: "magick",
      run: () => spawnBuffered("magick", [`${target}[0]`, "-auto-orient", "jpg:-"]),
    },
    {
      name: "ffmpeg",
      run: () => spawnBuffered("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", target, "-frames:v", "1", "-f", "mjpeg", "pipe:1"]),
    },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const output = await attempt.run();
      if (output.length > 0) return cropJpegToAspect(output, options.aspect);
      errors.push(`${attempt.name}: empty output`);
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function generateThumbnail(target, targetStat) {
  const kind = fileKind(target);
  if (kind !== "image" && kind !== "video") throw new Error("此文件类型不支持缩略图");
  const thumbPath = join(thumbnailRoot, thumbnailFilename(target, targetStat));
  if (existsSync(thumbPath)) {
    cacheThumbnail(target, targetStat, thumbPath, { width: thumbnailSize, height: thumbnailSize });
    return cachedThumbnail(target, targetStat);
  }

  const output = kind === "image"
    ? await squareJpegThumbnail(await imagePreviewBuffer(target))
    : await videoThumbnailBuffer(target);
  if (!output?.length) throw new Error("缩略图生成为空");

  await mkdir(thumbnailRoot, { recursive: true });
  await writeFile(thumbPath, output);
  cacheThumbnail(target, targetStat, thumbPath, { width: thumbnailSize, height: thumbnailSize });
  return cachedThumbnail(target, targetStat);
}

async function thumbnailPayload(paths, rootPath = "") {
  const requestedPaths = Array.isArray(paths) ? paths.slice(0, 8) : [];
  const thumbnails = [];
  for (const relativePath of requestedPaths) {
    try {
      const target = documentPath(relativePath, rootPath);
      const targetStat = await stat(target);
      if (!targetStat.isFile()) continue;
      const kind = fileKind(target);
      if (kind !== "image" && kind !== "video") continue;
      cacheFileMetadata(target, targetStat);
      const cached = cachedThumbnail(target, targetStat);
      const thumbnail = cached || await generateThumbnail(target, targetStat);
      thumbnails.push({ path: relativePath, thumbnailUrl: thumbnail.url, cached: Boolean(cached) });
    } catch (error) {
      thumbnails.push({ path: relativePath, error: error.message || "缩略图生成失败" });
    }
  }
  return { thumbnails };
}

async function handleImagePreview(request, response, url) {
  const path = url.searchParams.get("path") || "";
  const rootPath = url.searchParams.get("dir") || "";
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  if (fileKind(target) !== "image") throw new Error("不是图片文件");

  if (!needsImagePreview(target)) {
    response.writeHead(302, { location: fileUrl(path, rootPath) });
    response.end();
    return true;
  }

  const image = await imagePreviewBuffer(target, { aspect: fitAspectFromUrl(url) });
  response.writeHead(200, {
    "cache-control": "private, max-age=3600",
    "content-length": image.length,
    "content-type": "image/jpeg",
  });
  response.end(image);
  return true;
}

async function handleMotionVideo(request, response, url) {
  const path = url.searchParams.get("path") || "";
  const rootPath = url.searchParams.get("dir") || "";
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  if (fileKind(target) !== "image") throw new Error("不是图片文件");

  const motion = await embeddedMotionPhoto(target, rootPath, path);
  if (!motion) throw new Error("没有找到内嵌 Motion Photo 视频");

  const baseHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "content-type": "video/mp4",
  };
  const rangeHeader = request.headers.range;
  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, motion.length);
    if (!range) {
      response.writeHead(416, {
        "accept-ranges": "bytes",
        "content-range": `bytes */${motion.length}`,
      });
      response.end();
      return true;
    }
    response.writeHead(206, {
      ...baseHeaders,
      "content-length": range.end - range.start + 1,
      "content-range": `bytes ${range.start}-${range.end}/${motion.length}`,
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(target, { start: motion.offset + range.start, end: motion.offset + range.end }).pipe(response);
    }
    return true;
  }

  response.writeHead(200, {
    ...baseHeaders,
    "content-length": motion.length,
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(target, { start: motion.offset, end: motion.offset + motion.length - 1 }).pipe(response);
  }
  return true;
}

async function handleMotionVideoTranscode(request, response, url) {
  const path = url.searchParams.get("path") || "";
  const rootPath = url.searchParams.get("dir") || "";
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  const motion = await embeddedMotionPhoto(target, rootPath, path);
  if (!motion) throw new Error("没有找到内嵌 Motion Photo 视频");

  const tempDir = await mkdtemp(join(tmpdir(), "ldb-motion-"));
  const tempInput = join(tempDir, "input.mp4");
  await pipeline(
    createReadStream(target, { start: motion.offset, end: motion.offset + motion.length - 1 }),
    createWriteStream(tempInput),
  );

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    tempInput,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "fastdecode",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main",
    "-tag:v",
    "avc1",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
    "-f",
    "mp4",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let errorOutput = "";
  ffmpeg.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString("utf8");
    if (errorOutput.length > 4000) errorOutput = errorOutput.slice(-4000);
  });

  const stop = () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  };
  request.on("aborted", stop);

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "video/mp4",
    "x-motion-transcoded": "1",
  });
  ffmpeg.stdout.pipe(response);
  ffmpeg.on("error", (error) => {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (!response.destroyed) response.destroy(error);
  });
  ffmpeg.on("close", (code) => {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (code !== 0 && !response.destroyed) response.destroy(new Error(errorOutput || `ffmpeg exited with ${code}`));
  });
  return true;
}

function readUint64(buffer, offset) {
  return Number(buffer.readBigUInt64BE(offset));
}

function readBoxHeader(buffer, offset, limit = buffer.length) {
  if (offset + 8 > limit) return null;
  const smallSize = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let size = smallSize;
  let headerSize = 8;
  if (smallSize === 1) {
    if (offset + 16 > limit) return null;
    size = readUint64(buffer, offset + 8);
    headerSize = 16;
  } else if (smallSize === 0) {
    size = limit - offset;
  }
  if (!Number.isFinite(size) || size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, start: offset, bodyStart: offset + headerSize, end: offset + size };
}

function childBoxes(buffer, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(buffer, offset, end);
    if (!box) break;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function topLevelBoxes(buffer) {
  const boxes = childBoxes(buffer, 0, buffer.length);
  if (boxes.some((box) => box.type === "moov")) return boxes;

  const moovBoxes = [];
  for (let offset = 4; offset + 4 < buffer.length; offset += 1) {
    if (buffer.toString("ascii", offset, offset + 4) !== "moov") continue;
    const box = readBoxHeader(buffer, offset - 4, buffer.length);
    if (box?.type === "moov") moovBoxes.push(box);
  }
  return [...boxes, ...moovBoxes];
}

function findChild(buffer, parent, type) {
  return childBoxes(buffer, parent.bodyStart, parent.end).find((box) => box.type === type) || null;
}

function findBoxPath(buffer, parent, path) {
  let current = parent;
  for (const type of path) {
    current = findChild(buffer, current, type);
    if (!current) return null;
  }
  return current;
}

function fixed1616(buffer, offset) {
  return buffer.readUInt32BE(offset) / 65536;
}

function parseTrackHeaderDisplaySize(buffer, trak) {
  const tkhd = findChild(buffer, trak, "tkhd");
  if (!tkhd || tkhd.bodyStart + 84 > tkhd.end) return null;
  const version = buffer[tkhd.bodyStart];
  const matrixOffset = tkhd.bodyStart + (version === 1 ? 52 : 40);
  const widthOffset = matrixOffset + 36;
  const heightOffset = matrixOffset + 40;
  if (heightOffset + 4 > tkhd.end) return null;

  const matrixA = buffer.readInt32BE(matrixOffset);
  const matrixB = buffer.readInt32BE(matrixOffset + 4);
  const matrixC = buffer.readInt32BE(matrixOffset + 12);
  const matrixD = buffer.readInt32BE(matrixOffset + 16);
  let width = fixed1616(buffer, widthOffset);
  let height = fixed1616(buffer, heightOffset);
  let rotation = 0;
  if (Math.abs(matrixB) > Math.abs(matrixA) || Math.abs(matrixC) > Math.abs(matrixD)) {
    [width, height] = [height, width];
    rotation = matrixB > 0 || matrixC < 0 ? 90 : -90;
  }

  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height), rotation } : null;
}

async function quickTimeDisplaySize(target) {
  const targetStat = await stat(target);
  const buffers = await readMediaProbeBuffers(target, targetStat);
  for (const buffer of buffers) {
    const moov = topLevelBoxes(buffer).find((box) => box.type === "moov");
    if (!moov) continue;
    moov.buffer = buffer;
    for (const trak of childBoxes(buffer, moov.bodyStart, moov.end).filter((box) => box.type === "trak")) {
      const handler = findBoxPath(buffer, trak, ["mdia", "hdlr"]);
      const handlerType = handler && handler.bodyStart + 12 <= handler.end ? buffer.toString("ascii", handler.bodyStart + 8, handler.bodyStart + 12) : "";
      if (handlerType !== "vide") continue;
      const size = parseTrackHeaderDisplaySize(buffer, trak);
      if (size) return size;
    }
  }
  return null;
}

function hexByte(value) {
  return value.toString(16).padStart(2, "0");
}

function parseAvcCodec(buffer, sample) {
  for (const box of childBoxes(buffer, sample.bodyStart + 78, sample.end)) {
    if (box.type !== "avcC" || box.bodyStart + 4 > box.end) continue;
    return `avc1.${hexByte(buffer[box.bodyStart + 1])}${hexByte(buffer[box.bodyStart + 2])}${hexByte(buffer[box.bodyStart + 3])}`;
  }
  return "avc1";
}

function codecDescription(codecTag) {
  const names = {
    avc1: "H.264 / AVC",
    avc3: "H.264 / AVC",
    hvc1: "H.265 / HEVC",
    hev1: "H.265 / HEVC",
    av01: "AV1",
    mp4v: "MPEG-4 Visual",
    vp09: "VP9",
    mp4a: "AAC / MPEG-4 Audio",
    "ac-3": "Dolby Digital AC-3",
    "ec-3": "Dolby Digital Plus E-AC-3",
  };
  return names[codecTag] || codecTag;
}

function parseStsd(buffer, stsd, handlerType) {
  if (!stsd || stsd.bodyStart + 8 > stsd.end) return [];
  const entries = [];
  const entryCount = buffer.readUInt32BE(stsd.bodyStart + 4);
  let offset = stsd.bodyStart + 8;
  for (let index = 0; index < entryCount && offset + 8 <= stsd.end; index += 1) {
    const sample = readBoxHeader(buffer, offset, stsd.end);
    if (!sample) break;
    const codecTag = sample.type;
    let codec = codecTag;
    if (codecTag === "avc1" || codecTag === "avc3") codec = parseAvcCodec(buffer, sample);
    if (codecTag === "mp4a") codec = "mp4a.40.2";
    entries.push({
      codec,
      codecTag,
      description: codecDescription(codecTag),
      kind: handlerType === "vide" ? "video" : handlerType === "soun" ? "audio" : handlerType || "track",
    });
    offset = sample.end;
  }
  return entries;
}

function parseHandlerType(buffer, hdlr) {
  if (!hdlr || hdlr.bodyStart + 12 > hdlr.end) return "";
  return buffer.toString("ascii", hdlr.bodyStart + 8, hdlr.bodyStart + 12);
}

function parseMovieDuration(buffer, moov) {
  const mvhd = findChild(buffer, moov, "mvhd");
  if (!mvhd || mvhd.bodyStart + 20 > mvhd.end) return null;
  const version = buffer[mvhd.bodyStart];
  let timescale;
  let duration;
  if (version === 1) {
    if (mvhd.bodyStart + 32 > mvhd.end) return null;
    timescale = buffer.readUInt32BE(mvhd.bodyStart + 20);
    duration = readUint64(buffer, mvhd.bodyStart + 24);
  } else {
    if (mvhd.bodyStart + 20 > mvhd.end) return null;
    timescale = buffer.readUInt32BE(mvhd.bodyStart + 12);
    duration = buffer.readUInt32BE(mvhd.bodyStart + 16);
  }
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return duration / timescale;
}

function parseMp4Metadata(buffers, fileStat, path) {
  const inspectedBytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
  const topLevel = buffers.flatMap((buffer) => topLevelBoxes(buffer).map((box) => ({ ...box, buffer })));
  const ftyp = topLevel.find((box) => box.type === "ftyp");
  const moov = topLevel.find((box) => box.type === "moov");
  const tracks = [];

  if (moov) {
    const boxBuffer = moov.buffer;
    for (const trak of childBoxes(boxBuffer, moov.bodyStart, moov.end).filter((box) => box.type === "trak")) {
      const mdia = findChild(boxBuffer, trak, "mdia");
      const hdlr = mdia ? findChild(boxBuffer, mdia, "hdlr") : null;
      const handlerType = parseHandlerType(boxBuffer, hdlr);
      const stsd = findBoxPath(boxBuffer, trak, ["mdia", "minf", "stbl", "stsd"]);
      tracks.push(...parseStsd(boxBuffer, stsd, handlerType));
    }
  }

  const videoCodecs = tracks.filter((track) => track.kind === "video").map((track) => track.codec).filter(Boolean);
  const audioCodecs = tracks.filter((track) => track.kind === "audio").map((track) => track.codec).filter(Boolean);
  const codecs = [...videoCodecs, ...audioCodecs];

  return {
    container: ftyp ? ftyp.buffer.toString("ascii", ftyp.bodyStart, Math.min(ftyp.bodyStart + 4, ftyp.end)) : extname(path).replace(".", "").toUpperCase(),
    durationSeconds: moov ? parseMovieDuration(moov.buffer, moov) : null,
    inspectedBytes,
    isPartialInspection: inspectedBytes < fileStat.size,
    mime: codecs.length ? `${fileMime(path)}; codecs="${codecs.join(", ")}"` : fileMime(path),
    size: fileStat.size,
    tracks,
  };
}

async function readMediaProbeBuffers(target, fileStat) {
  const configuredChunkMb = Number(process.env.MEDIA_PROBE_CHUNK_MB || 4);
  const chunkSize = Math.max(1, Math.min(64, Number.isFinite(configuredChunkMb) ? configuredChunkMb : 4)) * 1024 * 1024;
  const maxWholeFileProbeBytes = chunkSize;
  if (fileStat.size <= maxWholeFileProbeBytes) return [await readFile(target)];

  const file = await open(target, "r");
  try {
    const head = Buffer.alloc(chunkSize);
    const tail = Buffer.alloc(chunkSize);
    const headRead = await file.read(head, 0, chunkSize, 0);
    const tailRead = await file.read(tail, 0, chunkSize, fileStat.size - chunkSize);
    return [head.subarray(0, headRead.bytesRead), tail.subarray(0, tailRead.bytesRead)];
  } finally {
    await file.close();
  }
}

function mediaInfoCacheKey(target, fileStat) {
  return `${target}|${fileStat.size}|${fileStat.mtimeMs}`;
}

function ffprobeCodecString(stream) {
  const codec = String(stream.codec_name || "").toLowerCase();
  const profile = String(stream.profile || "").toLowerCase();
  if (codec === "h264") {
    if (profile.includes("baseline")) return "avc1.42E01E";
    if (profile.includes("high")) return "avc1.64001F";
    return "avc1.4D401F";
  }
  if (codec === "hevc" || codec === "h265") return "hvc1";
  if (codec === "av1") return "av01";
  if (codec === "vp9") return "vp09";
  if (codec === "mpeg4") return "mp4v";
  if (codec === "aac") return "mp4a.40.2";
  if (codec === "ac3") return "ac-3";
  if (codec === "eac3") return "ec-3";
  return stream.codec_tag_string && stream.codec_tag_string !== "[0][0][0][0]" ? stream.codec_tag_string : codec;
}

function ffprobeDescription(stream) {
  const codec = stream.codec_long_name || stream.codec_name || "";
  const profile = stream.profile && stream.profile !== "unknown" ? ` / ${stream.profile}` : "";
  return `${codec}${profile}`;
}

function ffprobeMediaInfo(target, fileStat) {
  const timeoutMs = Math.max(500, Math.min(15000, Number(process.env.FFPROBE_TIMEOUT_MS || 4000) || 4000));
  const args = [
    "-v",
    "error",
    "-probesize",
    `${Math.max(1, Math.min(64, Number(process.env.MEDIA_PROBE_CHUNK_MB || 4) || 4))}M`,
    "-analyzeduration",
    "1000000",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    target,
  ];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const probe = spawn(process.env.FFPROBE_PATH || "ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      probe.kill("SIGKILL");
    }, timeoutMs);

    probe.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    probe.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    probe.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    probe.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffprobe 超时（${timeoutMs}ms）`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe 退出码 ${code}`));
        return;
      }

      try {
        const data = JSON.parse(stdout || "{}");
        const tracks = (data.streams || [])
          .filter((stream) => stream.codec_type === "video" || stream.codec_type === "audio")
          .map((stream) => ({
            channels: stream.channels || null,
            codec: ffprobeCodecString(stream),
            codecTag: stream.codec_name || stream.codec_tag_string || "",
            description: ffprobeDescription(stream),
            height: stream.height || null,
            kind: stream.codec_type,
            language: stream.tags?.language || "",
            source: "ffprobe",
            width: stream.width || null,
          }));
        const codecs = tracks.map((track) => track.codec).filter(Boolean);
        resolve({
          container: data.format?.format_name || extname(target).replace(".", "").toUpperCase() || "unknown",
          durationSeconds: Number(data.format?.duration || 0) || null,
          inspectedBytes: null,
          isFromFfprobe: true,
          mime: codecs.length && fileMime(target).startsWith("video/")
            ? `${fileMime(target)}; codecs="${codecs.join(", ")}"`
            : fileMime(target),
          probeMs: Date.now() - startedAt,
          size: fileStat.size,
          tracks,
        });
      } catch (error) {
        reject(new Error(`ffprobe 输出无法解析：${error.message}`));
      }
    });
  });
}

function ffprobeSubtitleStreams(target) {
  const timeoutMs = Math.max(500, Math.min(15000, Number(process.env.FFPROBE_TIMEOUT_MS || 4000) || 4000));
  return new Promise((resolve) => {
    const probe = spawn(process.env.FFPROBE_PATH || "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "s",
      "-show_entries",
      "stream=index,codec_name:stream_tags=language,title",
      "-of",
      "json",
      target,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      resolve([]);
    }, timeoutMs);

    probe.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    probe.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    probe.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve([]);
        return;
      }
      try {
        const streams = JSON.parse(stdout || "{}").streams || [];
        resolve(streams.map((stream, relativeIndex) => ({ ...stream, relativeIndex })));
      } catch {
        resolve([]);
      }
    });
  });
}

async function preferredBurnSubtitle(target) {
  if (["0", "false", "off", "none"].includes(String(process.env.TRANSCODE_BURN_SUBTITLES || "auto").toLowerCase())) {
    return null;
  }
  const streams = await ffprobeSubtitleStreams(target);
  if (!streams.length) return null;

  const configuredIndex = Number(process.env.TRANSCODE_SUBTITLE_INDEX);
  if (Number.isInteger(configuredIndex) && configuredIndex >= 0) {
    return streams.find((stream) => stream.relativeIndex === configuredIndex) || null;
  }

  const normalized = (stream) => `${stream.tags?.language || ""} ${stream.tags?.title || ""} ${stream.codec_name || ""}`.toLowerCase();
  return streams.find((stream) => /简|simplified|chs/.test(normalized(stream)))
    || streams.find((stream) => /chi|zho|chs|cht|中文|中字/.test(normalized(stream)))
    || streams[0];
}

async function mediaInfoPayload(path, rootPath = "") {
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  if (fileKind(target) !== "video") throw new Error("不是视频文件");
  cacheFileMetadata(target, targetStat);
  const cacheKey = mediaInfoCacheKey(target, targetStat);
  const cached = mediaInfoCache.get(cacheKey);
  if (cached) {
    return { ...cached, isCached: true };
  }

  const persisted = cachedMediaInfo(target, targetStat);
  if (persisted) {
    mediaInfoCache.set(cacheKey, persisted);
    return persisted;
  }

  try {
    const payload = await ffprobeMediaInfo(target, targetStat);
    mediaInfoCache.set(cacheKey, payload);
    cacheMediaInfo(target, targetStat, payload);
    return payload;
  } catch (error) {
    if (![".mp4", ".m4v", ".mov"].includes(extname(target).toLowerCase())) {
      const payload = {
        container: extname(target).replace(".", "").toUpperCase() || "unknown",
        mime: fileMime(target),
        size: targetStat.size,
        tracks: [],
        warning: `无法探测此容器：${error.message || "ffprobe 不可用"}`,
      };
      mediaInfoCache.set(cacheKey, payload);
      cacheMediaInfo(target, targetStat, payload);
      return payload;
    }

    const buffers = await readMediaProbeBuffers(target, targetStat);
    const payload = parseMp4Metadata(buffers, targetStat, target);
    payload.warning = payload.tracks.length
      ? `ffprobe 不可用，已使用 MP4 快速解析：${error.message || "未知错误"}`
      : payload.isPartialInspection
        ? `ffprobe 不可用，且没有在文件头/文件尾找到可解析的 MP4 轨道信息：${error.message || "未知错误"}`
        : `ffprobe 不可用，且没有找到可解析的 MP4 轨道信息：${error.message || "未知错误"}`;
    mediaInfoCache.set(cacheKey, payload);
    cacheMediaInfo(target, targetStat, payload);
    return payload;
  }
}

function transcodeProfiles() {
  const accel = String(process.env.TRANSCODE_ACCEL || "auto").toLowerCase();
  const vaapiDevice = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
  const profiles = [];

  if (accel === "auto" || accel === "nvidia" || accel === "nvenc") {
    profiles.push({
      name: "NVIDIA NVENC",
      preInputArgs: [],
      filterSuffix: "",
      videoArgs: [
        "-c:v",
        "h264_nvenc",
        "-profile:v",
        "main",
        "-level:v",
        "5.1",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        "-cq",
        "23",
      ],
    });
  }

  if ((accel === "auto" || accel === "vaapi" || accel === "intel") && existsSync(vaapiDevice)) {
    profiles.push({
      name: "VAAPI",
      preInputArgs: [
        "-vaapi_device",
        vaapiDevice,
      ],
      filterSuffix: "format=nv12,hwupload",
      videoArgs: [
        "-c:v",
        "h264_vaapi",
        "-profile:v",
        "main",
        "-level:v",
        "5.1",
        "-qp",
        "23",
      ],
    });
  }

  if (accel === "auto" || accel === "cpu" || !profiles.length) {
    profiles.push({
      name: "CPU libx264",
      preInputArgs: [],
      filterSuffix: "",
      videoArgs: [
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-level:v",
        "5.1",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
      ],
    });
  }

  return profiles;
}

function transcodeVideoFilter(profile, subtitle) {
  const maxHeight = Number(process.env.TRANSCODE_MAX_HEIGHT || 1080);
  const filters = [];
  if (subtitle) {
    filters.push(`[0:v:0][0:s:${subtitle.relativeIndex}]overlay`);
  }
  filters.push("setpts=PTS-STARTPTS");
  if (Number.isFinite(maxHeight) && maxHeight > 0) {
    filters.push(`scale=-2:${Math.max(240, Math.floor(maxHeight))}:force_original_aspect_ratio=decrease`);
  }
  if (profile.filterSuffix) filters.push(profile.filterSuffix);
  return filters.join(",");
}

function ffmpegTranscodeArgs(target, profile, startSeconds = 0, subtitle = null) {
  const seekArgs = startSeconds > 0 ? ["-ss", String(Math.max(0, startSeconds).toFixed(3))] : [];
  const videoFilter = transcodeVideoFilter(profile, subtitle);
  const videoFilterArgs = subtitle
    ? ["-filter_complex", `${videoFilter}[vout]`, "-map", "[vout]"]
    : ["-vf", videoFilter, "-map", "0:v:0"];

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(profile.preInputArgs || []),
    ...seekArgs,
    "-i",
    target,
    "-avoid_negative_ts",
    "make_zero",
    ...videoFilterArgs,
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    ...profile.videoArgs,
    "-tag:v",
    "avc1",
    "-c:a",
    "aac",
    "-af",
    "asetpts=PTS-STARTPTS",
    "-b:a",
    "128k",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
    "-frag_duration",
    "1000000",
    "-f",
    "mp4",
    "pipe:1",
  ];
}

async function handleTranscode(request, response, url) {
  const path = url.searchParams.get("path") || "";
  const rootPath = url.searchParams.get("dir") || "";
  const startSeconds = Math.max(0, Number(url.searchParams.get("start") || 0) || 0);
  const target = documentPath(path, rootPath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("不是文件");
  if (fileKind(target) !== "video") throw new Error("不是视频文件");

  const subtitle = await preferredBurnSubtitle(target);
  const profiles = transcodeProfiles();
  let currentProcess = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (currentProcess && !currentProcess.killed) currentProcess.kill("SIGKILL");
  };

  request.on("aborted", stop);
  response.on("close", stop);

  const tryProfile = (index, previousErrors = []) => {
    if (stopped || response.destroyed) return;
    const profile = profiles[index];
    if (!profile) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: `FFmpeg 转码失败：${previousErrors.join(" | ") || "没有可用编码器"}` });
      } else {
        response.destroy(new Error(previousErrors.join(" | ") || "FFmpeg 转码失败"));
      }
      return;
    }

    const ffmpeg = spawn("ffmpeg", ffmpegTranscodeArgs(target, profile, startSeconds, subtitle), { stdio: ["ignore", "pipe", "pipe"] });
    currentProcess = ffmpeg;
    let started = false;
    let errorOutput = "";

    ffmpeg.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString("utf8");
      if (errorOutput.length > 4000) errorOutput = errorOutput.slice(-4000);
    });

    ffmpeg.stdout.on("data", (chunk) => {
      if (stopped || response.destroyed) return;
      if (!started) {
        started = true;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "video/mp4",
          "x-transcode-encoder": profile.name,
          ...(subtitle ? {
            "x-transcode-subtitle": `${subtitle.relativeIndex}:${subtitle.tags?.language || ""}:${encodeURIComponent(subtitle.tags?.title || "")}`,
          } : {}),
        });
      }
      response.write(chunk);
    });

    ffmpeg.stdout.on("end", () => {
      if (started && !response.destroyed) response.end();
    });

    ffmpeg.on("error", (error) => {
      if (started) {
        if (!response.destroyed) response.destroy(error);
      } else {
        tryProfile(index + 1, [...previousErrors, `${profile.name}: ${error.message}`]);
      }
    });

    ffmpeg.on("close", (code) => {
      if (stopped) return;
      if (code === 0) return;
      const message = `${profile.name}: ${errorOutput || `退出码 ${code}`}`;
      if (started) {
        if (!response.destroyed) response.destroy(new Error(message));
      } else {
        tryProfile(index + 1, [...previousErrors, message]);
      }
    });
  };

  tryProfile(0);

  return true;
}

function listDirectories(root, entries) {
  return entries
    .filter((entry) => entry.isDirectory() && !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: displayPath(join(root, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function workspacePayloadCacheKey(root, rootStat) {
  return `${root}|${rootStat.mtimeMs}|${rootStat.size}`;
}

function rememberWorkspacePayload(cacheKey, payload) {
  workspacePayloadCache.set(cacheKey, payload);
  if (workspacePayloadCache.size <= maxWorkspacePayloadCacheSize) return;
  const oldestKey = workspacePayloadCache.keys().next().value;
  if (oldestKey) workspacePayloadCache.delete(oldestKey);
}

async function workspacePayload() {
  if (!workspaceRoot) {
    return { name: "", path: "", dirs: [], docs: [] };
  }

  const rootStat = await stat(workspaceRoot);
  if (!rootStat.isDirectory()) {
    throw new Error("路径不是文件夹");
  }
  const cacheKey = workspacePayloadCacheKey(workspaceRoot, rootStat);
  const cached = workspacePayloadCache.get(cacheKey);
  if (cached) return cached;

  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const payload = {
    name: basename(workspaceRoot),
    path: displayPath(workspaceRoot),
    resolvedPath: workspaceRoot,
    parentPath: workspaceRoot === parse(workspaceRoot).root ? "" : displayPath(dirname(workspaceRoot)),
    dirs: listDirectories(workspaceRoot, entries),
    docs: await listPreviewFiles(workspaceRoot, entries),
  };
  rememberWorkspacePayload(cacheKey, payload);
  return payload;
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = new URLSearchParams(await readBody(request));
    const next = safeNextPath(body.get("next") || "/");
    if (!authEnabled()) {
      response.writeHead(302, { location: next });
      response.end();
      return true;
    }
    const username = body.get("username") || "";
    const password = body.get("password") || "";
    if (verifyLogin(username, password)) {
      createSession(response);
      response.writeHead(302, { location: next });
      response.end();
    } else {
      sendHtml(response, 401, loginPage("用户名或密码不正确", next));
    }
    return true;
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    clearSession(request, response);
    response.writeHead(302, { location: "/login" });
    response.end();
    return true;
  }

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
    await rememberWorkspace(workspaceRoot);
    sendJson(response, 200, await workspacePayload());
    return true;
  }

  if (url.pathname === "/api/document" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const rootPath = url.searchParams.get("dir") || "";
    const metadata = await documentMetadata(path, rootPath);
    const target = documentPath(path, rootPath);

    if (metadata.kind === "image" || metadata.kind === "pdf" || metadata.kind === "audio" || metadata.kind === "video" || metadata.kind === "file") {
      sendJson(response, 200, {
        ...metadata,
      });
      return true;
    }

    sendJson(response, 200, {
      ...metadata,
      content: await readFile(target, "utf8"),
    });
    return true;
  }

  if (url.pathname === "/api/document-meta" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const rootPath = url.searchParams.get("dir") || "";
    sendJson(response, 200, await documentMetadata(path, rootPath));
    return true;
  }

  if (url.pathname === "/api/file-sizes" && request.method === "POST") {
    const payload = JSON.parse(await readBody(request) || "{}");
    sendJson(response, 200, await fileSizesPayload(payload.paths || [], payload.dir || ""));
    return true;
  }

  if (url.pathname === "/api/thumbnails" && request.method === "POST") {
    const payload = JSON.parse(await readBody(request) || "{}");
    sendJson(response, 200, await thumbnailPayload(payload.paths || [], payload.dir || ""));
    return true;
  }

  if (url.pathname === "/api/media-info" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const rootPath = url.searchParams.get("dir") || "";
    sendJson(response, 200, await mediaInfoPayload(path, rootPath));
    return true;
  }

  if (url.pathname === "/api/index-stats" && request.method === "GET") {
    sendJson(response, 200, {
      ...indexStatements.stats.get(),
      dbPath: displayPath(join(configRoot, "komios.db")),
      thumbnailRoot: displayPath(thumbnailRoot),
    });
    return true;
  }

  if (url.pathname === "/api/live-photo" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const rootPath = url.searchParams.get("dir") || "";
    sendJson(response, 200, await livePhotoPayload(path, rootPath));
    return true;
  }

  if (url.pathname === "/api/image-preview" && request.method === "GET") {
    return handleImagePreview(request, response, url);
  }

  if (url.pathname === "/api/motion-video" && (request.method === "GET" || request.method === "HEAD")) {
    return handleMotionVideo(request, response, url);
  }

  if (url.pathname === "/api/motion-video-transcode" && request.method === "GET") {
    return handleMotionVideoTranscode(request, response, url);
  }

  if (url.pathname === "/api/video-state" && request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const rootPath = url.searchParams.get("dir") || "";
    sendJson(response, 200, await readVideoState(path, rootPath));
    return true;
  }

  if (url.pathname === "/api/video-state" && request.method === "POST") {
    const payload = JSON.parse(await readBody(request) || "{}");
    sendJson(response, 200, await writeVideoState(payload.path || "", payload, payload.dir || ""));
    return true;
  }

  if (url.pathname === "/api/transcode" && request.method === "GET") {
    return handleTranscode(request, response, url);
  }

  if (url.pathname.startsWith("/api/thumb/") && (request.method === "GET" || request.method === "HEAD")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/thumb/".length));
    if (!/^[a-f0-9]{32}\.jpg$/i.test(filename)) throw new Error("缩略图路径无效");
    const target = join(thumbnailRoot, filename);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("缩略图不存在");
    response.writeHead(200, {
      "cache-control": "private, max-age=86400",
      "content-length": targetStat.size,
      "content-type": "image/jpeg",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(target).pipe(response);
    return true;
  }

  if (url.pathname.startsWith("/api/file/") && (request.method === "GET" || request.method === "HEAD")) {
    const path = decodeURIComponent(url.pathname.slice("/api/file/".length));
    const rootPath = url.searchParams.get("dir") || "";
    const target = documentPath(path, rootPath);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new Error("不是文件");
    }

    const headers = fileHeaders(target, targetStat.size, url);
    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, targetStat.size);
      if (!range) {
        response.writeHead(416, {
          "accept-ranges": "bytes",
          "content-range": `bytes */${targetStat.size}`,
        });
        response.end();
        return true;
      }

      const partialHeaders = {
        ...headers,
        "content-length": range.end - range.start + 1,
        "content-range": `bytes ${range.start}-${range.end}/${targetStat.size}`,
      };
      response.writeHead(206, partialHeaders);
      if (request.method === "HEAD") {
        response.end();
      } else {
        createReadStream(target, { start: range.start, end: range.end }).pipe(response);
      }
      return true;
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(target).pipe(response);
    }
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
    if (url.pathname === "/login" && request.method === "GET") {
      const next = safeNextPath(url.searchParams.get("next") || "/");
      if (isAuthenticated(request)) {
        response.writeHead(302, { location: next });
        response.end();
      } else {
        sendHtml(response, 200, loginPage("", next));
      }
      return;
    }

    if (url.pathname !== "/api/login" && !isAuthenticated(request)) {
      rejectUnauthenticated(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/") && (await handleApi(request, response, url))) {
      return;
    }

    await handleStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    sendJson(response, 500, { error: error.message || "服务器错误" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`可米 KomiOS: http://0.0.0.0:${port}`);
  console.log(workspaceRoot ? `Workspace: ${displayPath(workspaceRoot)} (${workspaceRoot})` : "Workspace: not set");
  console.log(`Workspace memory: ${workspaceFilePath}`);
  console.log(`Auth username: ${authState.username}`);
  console.log(`Auth: enabled from ${authState.source}`);
  console.log(`Config database: ${join(configRoot, "komios.db")}`);
  setupLiveReload();
});
