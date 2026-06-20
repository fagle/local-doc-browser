export function isHtmlDocument(doc) {
  return Boolean(doc && /\.(html|htm)$/i.test(doc.name));
}

export function isTextDocument(doc) {
  return Boolean(doc && (doc.kind === "markdown" || doc.kind === "text"));
}

export function fileTypeLabel(doc) {
  if (doc?.kind === "markdown") return "Markdown";
  if (doc?.kind === "text") return "文本";
  if (doc?.kind === "image") return "图片";
  if (doc?.kind === "pdf") return "PDF";
  if (doc?.kind === "audio") return "音频";
  if (doc?.kind === "video") return "视频";
  const extension = doc?.name?.includes(".") ? doc.name.split(".").pop().toUpperCase() : "文件";
  return extension || "文件";
}

export function mediaAssetFor(doc) {
  if (!doc) {
    return {
      canCopySource: false,
      canDownloadHtml: false,
      canShowMediaInfo: false,
      canTranscode: false,
      downloadLabel: "下载",
      isMediaShell: false,
      isPhoto: false,
      previewKind: "empty",
      typeLabel: "文件",
    };
  }

  const isPhoto = doc.kind === "image";
  const isVideo = doc.kind === "video";
  const isPdf = doc.kind === "pdf";
  const isAudio = doc.kind === "audio";
  const isText = isTextDocument(doc);
  const isHtml = isHtmlDocument(doc);
  let previewKind = "unsupported";
  if (isPhoto && doc.rawUrl) previewKind = "image";
  else if (isPdf && doc.rawUrl) previewKind = "pdf";
  else if (isAudio && doc.rawUrl) previewKind = "audio";
  else if (isVideo && doc.rawUrl) previewKind = "video";
  else if (isText && isHtml) previewKind = "html";
  else if (isText) previewKind = "text";

  return {
    canCopySource: isText,
    canDownloadHtml: isText,
    canShowMediaInfo: isVideo,
    canTranscode: isVideo,
    downloadLabel: isPhoto ? "下载原图" : "下载",
    isAudio,
    isHtml,
    isMediaShell: isVideo || isPdf,
    isPdf,
    isPhoto,
    isText,
    isVideo,
    previewKind,
    typeLabel: fileTypeLabel(doc),
  };
}
