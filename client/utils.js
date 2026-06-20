export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatBytes(value) {
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

export function titleFromName(name = "") {
  return String(name).replace(/\.[^.]+$/i, "");
}

export function getTitle(content = "", fallback = "") {
  const heading = String(content).match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : titleFromName(fallback);
}

export function isMarkdown(doc) {
  return doc?.kind === "markdown" || /\.(md|markdown)$/i.test(doc?.name || "");
}

export function isImage(doc) {
  return doc?.kind === "image";
}

export function isPdf(doc) {
  return doc?.kind === "pdf";
}

export function isAudio(doc) {
  return doc?.kind === "audio";
}

export function isVideo(doc) {
  return doc?.kind === "video";
}

export function isHeicLike(doc) {
  return Boolean(doc && doc.kind === "image" && /\.(heic|heics|heif|heifs)$/i.test(doc.name));
}

export function isMovLike(doc) {
  return Boolean(doc && doc.kind === "video" && /\.(mov|m4v|mp4)$/i.test(doc.name));
}

export function pathDirectory(path = "") {
  const normalized = String(path || "").replaceAll("\\", "/");
  return normalized.includes("/") ? normalized.split("/").slice(0, -1).join("/") : "";
}

export function splitWorkspacePath(path = "") {
  const raw = String(path || "").trim();
  if (!raw) return { root: "", separator: "/", segments: [] };
  const windowsDrive = raw.match(/^([a-zA-Z]:)[\\/]*(.*)$/);
  if (windowsDrive) {
    return {
      root: windowsDrive[1],
      separator: "\\",
      segments: windowsDrive[2].split(/[\\/]+/).filter(Boolean),
    };
  }
  const isUnc = raw.startsWith("\\\\") || raw.startsWith("//");
  if (isUnc) {
    const segments = raw.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean);
    const root = segments.length >= 2 ? `\\\\${segments[0]}\\${segments[1]}` : "\\\\";
    return { root, separator: "\\", segments: segments.slice(2) };
  }
  const isAbsolutePosix = raw.startsWith("/");
  return {
    root: isAbsolutePosix ? "/" : "",
    separator: "/",
    segments: raw.split(/[\\/]+/).filter(Boolean),
  };
}

export function joinWorkspacePath(root, segments, separator) {
  if (!root) return segments.join(separator);
  if (root === "/") return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
  if (root.startsWith("\\\\")) return [root, ...segments].join("\\");
  return segments.length ? `${root}${separator}${segments.join(separator)}` : root;
}
