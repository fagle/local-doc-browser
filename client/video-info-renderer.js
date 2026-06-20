export function createVideoInfoRenderer({
  escapeHtml,
  formatBytes,
  formatDuration,
  resumePositionFromState,
}) {
  function supportLabel(value) {
    if (value === "probably") return "浏览器大概率支持";
    if (value === "maybe") return "浏览器可能支持";
    return "浏览器未声明支持";
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

  function videoSupportLabel(info) {
    if (!info) return { text: "正在分析编码兼容性", needsTranscode: true, loading: true };
    const support = nativeVideoSupport(info);
    if (support === "probably") return { text: "浏览器大概率可原始播放", needsTranscode: false };
    if (support === "maybe") return { text: "浏览器可能可原始播放", needsTranscode: false };
    return { text: "建议使用转码播放", needsTranscode: true };
  }

  function nfoMediaInfoIsEnough(info) {
    if (!info?.isFromNfo) return false;
    const video = info.tracks?.find((track) => track.kind === "video");
    if (!video?.codec) return false;
    if (String(video.codec).toLowerCase() === String(video.codecTag || "").toLowerCase()) return false;
    return true;
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

  return {
    nativeVideoSupport,
    nfoMediaInfoIsEnough,
    renderMediaInfo,
    renderVideoDecisionContent,
    videoSupportLabel,
  };
}
