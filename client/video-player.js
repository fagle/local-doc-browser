export function createVideoPlayerController({
  apiFetch,
  cancelMediaProbe,
  els,
  escapeHtml,
  formatDuration,
  getCurrentWorkspacePath,
  isVideo,
  readMediaInfo,
  readVideoState,
  scopedQuery,
}) {
  let pendingTranscodeSeekTimer = null;
  let transcodeControlsHideTimer = null;
  let lastProgressSaveAt = 0;

  function status(message) {
    const target = els.preview.querySelector(".video-preview") || els.preview;
    target.insertAdjacentHTML("beforeend", `<div class="media-info-panel media-info-warning transcode-status">${escapeHtml(message)}</div>`);
  }

  function cleanup(video) {
    if (pendingTranscodeSeekTimer) {
      clearTimeout(pendingTranscodeSeekTimer);
      pendingTranscodeSeekTimer = null;
    }
    if (transcodeControlsHideTimer) {
      clearTimeout(transcodeControlsHideTimer);
      transcodeControlsHideTimer = null;
    }
    if (video?.dataset.mediaSourceUrl) {
      URL.revokeObjectURL(video.dataset.mediaSourceUrl);
      delete video.dataset.mediaSourceUrl;
    }
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

  function updateControls(video, doc) {
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

  function showControls(host) {
    if (!host) return;
    host.classList.add("show-transcode-controls");
    if (transcodeControlsHideTimer) clearTimeout(transcodeControlsHideTimer);
  }

  function isPointerNearControls(host, event) {
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

  function scheduleHideControls(host, delay = 2500) {
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
    if (shouldPlay) video.play().catch((error) => status(error.message || "播放失败。"));
  }

  function stepSeek(video, doc, seconds) {
    restartTranscodeAt(video, doc, transcodeCurrentTime(video) + seconds);
  }

  function togglePlayback(video) {
    if (video.paused) video.play().catch((error) => status(error.message || "播放失败。"));
    else video.pause();
  }

  function toggleFullscreen(host) {
    if (!document.fullscreenElement) {
      host.requestFullscreen?.().catch((error) => status(error.message || "无法进入全屏。"));
    } else {
      document.exitFullscreen?.();
    }
  }

  function ensureControls(video, doc) {
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
    const reveal = () => showControls(host);
    const revealThenHide = () => {
      showControls(host);
      scheduleHideControls(host);
    };
    const blurControl = (event) => event.currentTarget.blur();
    const syncPointerHotZone = (event) => {
      const nearControls = isPointerNearControls(host, event);
      host.dataset.transcodePointerNear = nearControls ? "true" : "false";
      if (nearControls) reveal();
      else scheduleHideControls(host);
    };

    host.addEventListener("pointermove", syncPointerHotZone);
    host.addEventListener("pointerleave", () => {
      host.dataset.transcodePointerNear = "false";
      scheduleHideControls(host);
    });
    host.addEventListener("focusin", reveal);
    host.addEventListener("focusout", () => scheduleHideControls(host, 800));
    host.addEventListener("keydown", revealThenHide);
    controls.addEventListener("pointerenter", () => {
      host.dataset.transcodePointerNear = "true";
      reveal();
    });
    controls.addEventListener("pointerleave", () => {
      host.dataset.transcodePointerNear = "false";
      scheduleHideControls(host);
    });

    playButton.addEventListener("click", (event) => {
      blurControl(event);
      revealThenHide();
      togglePlayback(video);
    });

    backButton.addEventListener("click", (event) => {
      blurControl(event);
      revealThenHide();
      stepSeek(video, doc, -10);
    });

    forwardButton.addEventListener("click", (event) => {
      blurControl(event);
      revealThenHide();
      stepSeek(video, doc, 10);
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
      updateControls(video, doc);
    });

    volumeSlider.addEventListener("input", () => {
      revealThenHide();
      video.volume = Math.max(0, Math.min(1, Number(volumeSlider.value || 0)));
      video.muted = video.volume === 0;
      updateControls(video, doc);
    });

    fullscreenButton.addEventListener("click", (event) => {
      blurControl(event);
      revealThenHide();
      toggleFullscreen(host);
    });

    updateControls(video, doc);
    revealThenHide();
  }

  async function saveProgress(doc, video, { immediate = false, ended = false } = {}) {
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
        dir: getCurrentWorkspacePath(),
        path: doc.path,
        positionSeconds: position,
        durationSeconds: Number.isFinite(duration) ? duration : 0,
        watched,
      }),
    });
    const state = await response.json().catch(() => null);
    if (response.ok && state && !state.error) doc.videoState = state;
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

  function attachProgress(video, doc) {
    video.addEventListener("timeupdate", () => {
      updateControls(video, doc);
      saveProgress(doc, video).catch(() => {});
    });
    video.addEventListener("pause", () => {
      updateControls(video, doc);
      saveProgress(doc, video, { immediate: true }).catch(() => {});
    });
    video.addEventListener("play", () => {
      updateControls(video, doc);
    });
    video.addEventListener("loadedmetadata", () => {
      updateControls(video, doc);
    });
    video.addEventListener("volumechange", () => {
      updateControls(video, doc);
    });
    video.addEventListener("ended", () => {
      updateControls(video, doc);
      saveProgress(doc, video, { immediate: true, ended: true }).catch(() => {});
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

  function restoreRawProgress(video, doc) {
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

  function play(doc, { mode = "transcode", startSeconds = 0, autoplay = true } = {}) {
    cancelMediaProbe();
    cleanup(els.preview.querySelector("video[data-preview-video]"));
    els.preview.innerHTML = `
      <div class="video-preview">
        <video controls preload="metadata" data-preview-video></video>
      </div>
    `;
    const video = els.preview.querySelector("video[data-preview-video]");
    attachProgress(video, doc);
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
        restoreRawProgress(video, doc);
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
        status(message);
      });
    }
  }

  function startTranscodedPlayback(video, doc, startSeconds = 0) {
    cleanup(video);
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
        updateControls(video, doc);
      })
      .catch(() => {});
    video.src = `/api/transcode?${scopedQuery({ path: doc.path, start })}`;
    video.load();
    ensureControls(video, doc);
  }

  async function toggleMode(doc, video, preferredMode = "") {
    if (!video) {
      const state = await readVideoState(doc).catch(() => doc.videoState);
      play(doc, { mode: preferredMode || "transcode", startSeconds: resumePositionFromState(state) });
      return;
    }
    els.preview.querySelectorAll(".transcode-status").forEach((item) => item.remove());
    const isTranscoded = video.dataset.transcoded === "true";
    await saveProgress(doc, video, { immediate: true }).catch(() => {});
    video.pause();
    if (isTranscoded) {
      cleanup(video);
      els.preview.querySelector(".transcode-controls")?.remove();
      video.controls = true;
      video.dataset.transcoded = "false";
      video.dataset.resumeOffset = "0";
      delete video.dataset.transcodeStart;
      delete video.dataset.originalDuration;
      video.src = doc.rawUrl;
      els.transcodeVideo.textContent = "转码播放";
      video.load();
      restoreRawProgress(video, doc);
    } else {
      const state = await readVideoState(doc).catch(() => doc.videoState);
      startTranscodedPlayback(video, doc, resumePositionFromState(state));
      els.transcodeVideo.textContent = "原始播放";
    }
    video.play().catch((error) => {
      const message = error?.message ? `浏览器没有自动开始播放：${error.message}。请点击播放器播放按钮。` : "浏览器没有自动开始播放，请点击播放器播放按钮。";
      status(message);
    });
  }

  function handleKeyboard(event, doc, video, host) {
    const isTranscoded = video.dataset.transcoded === "true";
    const step = event.shiftKey ? 60 : 10;

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      togglePlayback(video);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isTranscoded) stepSeek(video, doc, -step);
      else video.currentTime = Math.max(0, video.currentTime - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (isTranscoded) stepSeek(video, doc, step);
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
      return false;
    }
    if (isTranscoded) {
      showControls(host);
      scheduleHideControls(host);
      updateControls(video, doc);
    }
    return true;
  }

  return {
    cleanup,
    handleKeyboard,
    play,
    resumePositionFromState,
    restoreRawProgress,
    saveProgress,
    startTranscodedPlayback,
    status,
    toggleMode,
  };
}
