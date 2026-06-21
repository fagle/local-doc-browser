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

export function createLivePhotoController({
  apiFetch,
  currentDoc,
  escapeHtml,
  getPreviewRenderVersion,
  jpegPreviewFallbackUrl,
  livePhotosKitUrl,
  optimisticLivePhotoInfo,
  readLivePhotoInfo,
}) {
  let livePhotosKitLoader = null;

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

  function setLivePhotoBadgeState(shell, state = "idle") {
    const button = shell?.querySelector("[data-live-photo-action='play']");
    const icon = button?.querySelector(".live-photo-play-icon");
    if (!button || !icon) return;
    button.classList.toggle("is-starting", state === "starting");
    button.classList.toggle("is-playing", state === "playing");
    button.setAttribute("aria-busy", state === "starting" ? "true" : "false");
    if (state === "starting") {
      icon.textContent = "";
      button.title = "正在准备动态照片";
    } else if (state === "playing") {
      icon.textContent = "■";
      button.title = "停止动态照片";
    } else {
      icon.textContent = "▶";
      button.title = button.dataset.defaultTitle || "播放动态照片";
    }
  }

  function stopPlayback(shell, options = {}) {
    setLivePhotoBadgeState(shell, "idle");
    shell?.classList.remove("is-starting-live");
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

  function resetVideoStartState(shell, video, renderFallbackTimer) {
    if (renderFallbackTimer) clearTimeout(renderFallbackTimer);
    video?.remove();
    shell.classList.remove("is-starting-live");
    shell.classList.remove("is-playing-live");
    setLivePhotoBadgeState(shell, "idle");
  }

  function startLivePhotoVideo(shell, info, videoUrl, options = {}) {
    const image = shell.querySelector("[data-live-photo-image]");
    const frame = shell.querySelector("[data-motion-media-frame]") || shell;
    if (!image || !videoUrl) return;
    stopPlayback(shell);
    const isOverlayPlayback = info.mode === "embedded-motion-photo" || info.mode === "sidecar";
    shell.classList.add("is-playing-live");
    shell.classList.add("is-starting-live");
    setLivePhotoBadgeState(shell, "starting");
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
      shell.classList.remove("is-starting-live");
      setLivePhotoBadgeState(shell, "playing");
      if (isOverlayPlayback) video.classList.add("ready");
    };
    const handleFailure = () => {
      if (renderFallbackTimer) clearTimeout(renderFallbackTimer);
      if (info.transcodeUrl && videoUrl !== info.transcodeUrl && shell.contains(video)) {
        video.remove();
        startLivePhotoVideo(shell, info, info.transcodeUrl);
      } else {
        resetVideoStartState(shell, video, renderFallbackTimer);
      }
    };
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady, { once: true });
    video.addEventListener("error", handleFailure, { once: true });
    video.addEventListener("ended", () => {
      resetVideoStartState(shell, video, renderFallbackTimer);
    });
    image.hidden = false;
    frame.append(video);
    video.play().catch(handleFailure);
  }

  function startLivePhotoVideoFallback(shell, info) {
    startLivePhotoVideo(shell, info, info.videoUrl);
  }

  async function startLivePhotosKitPlayback(shell, info) {
    const image = shell.querySelector("[data-live-photo-image]");
    const frame = shell.querySelector("[data-motion-media-frame]") || shell;
    if (!image || !info?.videoUrl) return false;
    stopPlayback(shell);
    shell.classList.add("is-starting-live");
    setLivePhotoBadgeState(shell, "starting");
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
      stopPlayback(shell);
      startLivePhotoVideo(shell, info, info.transcodeUrl || info.videoUrl);
    });
    player.addEventListener?.("canplay", () => {
      shell.classList.remove("is-starting-live");
      setLivePhotoBadgeState(shell, "playing");
    });
    player.addEventListener?.("playing", () => {
      shell.classList.remove("is-starting-live");
      setLivePhotoBadgeState(shell, "playing");
    });
    player.addEventListener?.("ended", () => {
      shell.classList.remove("is-starting-live");
      shell.classList.remove("is-playing-live");
      setLivePhotoBadgeState(shell, "idle");
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

  function applyLivePhotoControls(shell, toolbar, info) {
    if (!info?.isLive || !info.videoUrl) {
      toolbar.hidden = true;
      toolbar.innerHTML = "";
      return false;
    }

    shell.classList.add("has-live-photo");
    const mobilePhotoViewport = Boolean(window.matchMedia?.("(max-width: 820px)")?.matches);
    const badgeLabel = mobilePhotoViewport
      ? "实况"
      : (info.mode === "embedded-motion-photo" ? "Motion" : "Live");
    const badgeTitle = info.message || "播放动态照片";
    toolbar.hidden = false;
    toolbar.innerHTML = `
      <button type="button" class="live-photo-badge" data-live-photo-action="play" title="${escapeHtml(badgeTitle)}" data-default-title="${escapeHtml(badgeTitle)}" aria-busy="false">
        <span class="live-photo-play-icon" aria-hidden="true">▶</span><span>${escapeHtml(badgeLabel)}</span>
      </button>
    `;
    const togglePlayback = async () => {
      if (shell.querySelector("[data-live-photo-player]") || shell.querySelector("video[data-live-photo-video]")) stopPlayback(shell);
      else {
        shell.classList.add("is-starting-live");
        setLivePhotoBadgeState(shell, "starting");
        try {
          await startLivePhotoPlayback(shell, info);
        } catch {
          shell.classList.remove("is-starting-live");
          setLivePhotoBadgeState(shell, "idle");
        }
      }
    };
    toolbar.querySelector("[data-live-photo-action='play']")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await togglePlayback();
    });
    const frame = shell.querySelector("[data-motion-media-frame]");
    if (frame) {
      frame.classList.toggle("is-interactive-motion", !mobilePhotoViewport);
      frame.tabIndex = mobilePhotoViewport ? -1 : 0;
      frame.title = mobilePhotoViewport
        ? "点击进入全屏查看"
        : (info.mode === "embedded-motion-photo" ? "点击播放 Motion Photo" : "点击播放 Live Photo");
      frame.onclick = mobilePhotoViewport ? null : async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await togglePlayback();
      };
      frame.onkeydown = mobilePhotoViewport ? null : (event) => {
        if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
        event.preventDefault();
        event.stopPropagation();
        togglePlayback();
      };
    }
    return true;
  }

  function applyLivePhotoDetectingControl(toolbar) {
    if (!toolbar) return;
    toolbar.hidden = false;
    toolbar.innerHTML = `
      <span class="live-photo-badge is-detecting" title="正在检测动态照片" aria-label="正在检测动态照片">
        <span class="live-photo-play-icon" aria-hidden="true"></span>
      </span>
    `;
  }

  function syncLiveToolbarInsets(image, frame) {
    if (!image?.naturalWidth || !image?.naturalHeight || !frame) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const frameRatio = rect.width / rect.height;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    if (imageRatio > frameRatio) {
      contentHeight = rect.width / imageRatio;
    } else {
      contentWidth = rect.height * imageRatio;
    }
    const left = Math.max(0, (rect.width - contentWidth) / 2);
    const top = Math.max(0, (rect.height - contentHeight) / 2);
    frame.style.setProperty("--live-photo-content-left", `${left.toFixed(2)}px`);
    frame.style.setProperty("--live-photo-content-top", `${top.toFixed(2)}px`);
    frame.style.setProperty("--live-photo-content-right", `${left.toFixed(2)}px`);
    frame.style.setProperty("--live-photo-content-bottom", `${top.toFixed(2)}px`);
  }

  function bindImagePreviewLifecycle({ doc, image, frame, shell, toolbar, renderVersion }) {
    const optimisticInfo = optimisticLivePhotoInfo(doc);
    if (optimisticInfo) doc.livePhotoInfo = optimisticInfo;
    const liveInfoPromise = readLivePhotoInfo(doc)
      .then((info) => {
        doc.livePhotoInfo = info;
        return info;
      })
      .catch(() => null);

    let liveControlsShown = false;
    let imageLoadHandled = false;
    let liveInfoSettled = false;
    const isCurrentRender = () => renderVersion === getPreviewRenderVersion() && currentDoc()?.id === doc.id;
    const showLiveControls = (info) => {
      if (!imageLoadHandled || liveControlsShown || !info?.isLive || !shell || !toolbar || !isCurrentRender()) return;
      liveControlsShown = applyLivePhotoControls(shell, toolbar, info);
    };
    const showDetectingControl = () => {
      if (!imageLoadHandled || liveControlsShown || liveInfoSettled || optimisticInfo || !toolbar || !isCurrentRender()) return;
      applyLivePhotoDetectingControl(toolbar);
    };
    const syncFrame = () => {
      if (!image?.naturalWidth || !image?.naturalHeight || !frame) return;
      frame.style.setProperty("--media-aspect-ratio", String(image.naturalWidth / image.naturalHeight));
      syncLiveToolbarInsets(image, frame);
    };
    const finishImageLoad = () => {
      if (imageLoadHandled) return;
      imageLoadHandled = true;
      syncFrame();
      frame?.classList.remove("is-loading-preview");
      showLiveControls(optimisticInfo || doc.livePhotoInfo);
      showDetectingControl();
    };

    liveInfoPromise.then((info) => {
      liveInfoSettled = true;
      if (!info?.isLive && !liveControlsShown && toolbar && isCurrentRender()) {
        toolbar.hidden = true;
        toolbar.innerHTML = "";
      }
      showLiveControls(info);
    });
    image?.addEventListener("load", finishImageLoad, { once: true });
    image?.addEventListener("error", () => {
      const fallbackUrl = jpegPreviewFallbackUrl(image?.getAttribute("src") || "");
      if (fallbackUrl && image.dataset.jpegFallback !== "true") {
        image.dataset.jpegFallback = "true";
        image.src = fallbackUrl;
        return;
      }
      frame?.classList.add("is-preview-error");
      frame?.classList.remove("is-loading-preview");
    });
    if (image?.complete && image.naturalWidth) finishImageLoad();
    image?.decode?.().then(finishImageLoad).catch(() => {});
    const imageReadyPoll = setInterval(() => {
      if (!isCurrentRender() || imageLoadHandled) {
        clearInterval(imageReadyPoll);
        return;
      }
      if (image?.complete && image.naturalWidth) {
        clearInterval(imageReadyPoll);
        finishImageLoad();
      }
    }, 80);
    frame?.__livePhotoResizeObserver?.disconnect?.();
    if (frame && window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(() => {
        if (!isCurrentRender()) {
          resizeObserver.disconnect();
          return;
        }
        syncLiveToolbarInsets(image, frame);
      });
      frame.__livePhotoResizeObserver = resizeObserver;
      resizeObserver.observe(frame);
    }
  }

  return {
    bindImagePreviewLifecycle,
    stopPlayback,
  };
}
