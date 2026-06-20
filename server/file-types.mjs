import { basename, extname } from "node:path";

export const staticTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".md": "text/markdown;charset=utf-8",
};

export const textExtensions = new Set([
  ".bat", ".bash", ".c", ".cmd", ".conf", ".cpp", ".cs", ".css", ".csv", ".env",
  ".go", ".h", ".hpp", ".htm", ".html", ".ini", ".java", ".js", ".json", ".jsonc",
  ".jsx", ".kt", ".kts", ".log", ".markdown", ".md", ".mjs", ".nfo", ".php",
  ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".srt", ".swift", ".toml", ".ts",
  ".tsx", ".txt", ".vue", ".vtt", ".xml", ".yaml", ".yml",
]);

export const textFilenames = new Set([
  ".dockerignore", ".editorconfig", ".env", ".env.example", ".gitattributes",
  ".gitignore", ".nomedia", ".npmrc", "dockerfile", "license", "makefile", "readme",
]);

export const imageTypes = new Map([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"],
  [".heic", "image/heic"], [".heics", "image/heic-sequence"], [".heif", "image/heif"],
  [".heifs", "image/heif-sequence"], [".ico", "image/x-icon"], [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"], [".png", "image/png"], [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

export const mediaTypes = new Map([
  [".aac", "audio/aac"], [".flac", "audio/flac"], [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"], [".oga", "audio/ogg"], [".ogg", "audio/ogg"],
  [".wav", "audio/wav"], [".m4v", "video/mp4"], [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"], [".mp4", "video/mp4"], [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

export const fileTypes = new Map([
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

export const ignoredDirectoryNames = new Set([
  ".git", ".gradle", ".modelscope-cache", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".venv", "__pycache__", "node_modules",
]);

export function fileKind(filename) {
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

export function fileMime(filename) {
  const name = basename(filename).toLowerCase();
  if (textFilenames.has(name)) return "text/plain;charset=utf-8";
  return fileTypes.get(extname(filename).toLowerCase()) || "application/octet-stream";
}
