export function createPreviewRenderers({
  els,
  escapeHtml,
  fileTypeLabel,
  formatBytes,
  getTitle,
  isMarkdown,
  languageFromFilename,
  renderCodeBlock,
  renderMarkdown,
  renderStartPage,
  titleFromName,
}) {
  function renderEmptyPreview({ workspaceName }) {
    els.docPath.textContent = "未选择文档";
    els.docTitle.textContent = workspaceName ? "没有文件" : "打开一个文件夹";
    els.preview.innerHTML = workspaceName
      ? '<div class="empty-state">当前文件夹里没有文件</div>'
      : renderStartPage();
  }

  function renderPdfPreview(doc) {
    els.docTitle.textContent = doc.name;
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame";
    frame.title = `${doc.name} 预览`;
    frame.src = doc.rawUrl;
    els.preview.replaceChildren(frame);
  }

  function renderAudioPreview(doc) {
    els.docTitle.textContent = doc.name;
    els.preview.innerHTML = `
      <div class="file-preview">
        <div class="file-preview-icon">音频</div>
        <h3>${escapeHtml(doc.name)}</h3>
        <p>${escapeHtml(doc.mime || fileTypeLabel(doc))} · ${formatBytes(doc.size || 0)}</p>
        <audio controls src="${escapeHtml(doc.rawUrl)}"></audio>
      </div>
    `;
  }

  function renderUnsupportedFilePreview(doc) {
    els.docTitle.textContent = doc.name;
    els.preview.innerHTML = `
      <div class="file-preview">
        <div class="file-preview-icon">${escapeHtml(fileTypeLabel(doc))}</div>
        <h3>${escapeHtml(doc.name)}</h3>
        <p>${escapeHtml(doc.mime || "application/octet-stream")} · ${formatBytes(doc.size || 0)}</p>
        <p>此文件类型不支持内嵌预览。点击右上角“下载”保存文件。</p>
      </div>
    `;
  }

  function renderHtmlPreview(doc) {
    els.docTitle.textContent = titleFromName(doc.name);
    if (!doc.content) {
      els.preview.innerHTML = '<div class="empty-state">选择文件后读取内容</div>';
      return;
    }
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame";
    frame.title = `${doc.name} 预览`;
    frame.sandbox = "allow-scripts";
    frame.src = doc.rawUrl;
    els.preview.replaceChildren(frame);
  }

  function renderTextPreview(doc) {
    els.docTitle.textContent = doc.content ? (isMarkdown(doc) ? getTitle(doc.content, doc.name) : titleFromName(doc.name)) : titleFromName(doc.name);
    if (!doc.content) {
      els.preview.innerHTML = '<div class="empty-state">选择文件后读取内容</div>';
      return;
    }
    els.preview.innerHTML = isMarkdown(doc)
      ? renderMarkdown(doc.content)
      : renderCodeBlock(doc.content, languageFromFilename(doc.name), "source-preview");
  }

  function renderVideoShell(doc, renderVideoDecision) {
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
  }

  return {
    renderAudioPreview,
    renderEmptyPreview,
    renderHtmlPreview,
    renderPdfPreview,
    renderTextPreview,
    renderUnsupportedFilePreview,
    renderVideoShell,
  };
}
