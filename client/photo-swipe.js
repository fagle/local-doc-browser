export function createPhotoSwipeController({
  els,
  escapeHtml,
  getCurrentWorkspacePath,
  currentDoc,
  imageSequenceState,
  isImage,
  loadDoc,
  onFullscreenChange = () => {},
  selectDoc,
}) {
  let transitioning = false;
  let suppressClickUntil = 0;
  let swipeStart = null;
  let swipeGesture = null;
  let pinchGesture = null;
  let pinchState = { scale: 1, x: 0, y: 0 };
  let gestureResetTimer = null;
  const preloadedImages = new Map();
  const preloadInFlight = new Map();
  const preloadQueue = new Map();
  const maxPreloadedImages = 18;
  const maxPreloadInFlight = 2;
  let preloadSequence = 0;

  function isMobileViewport() {
    return window.matchMedia("(max-width: 820px)").matches;
  }

  function isFullscreen() {
    return document.body.classList.contains("mobile-photo-fullscreen");
  }

  function setFullscreen(enabled, options = {}) {
    const next = Boolean(enabled && isMobileViewport() && currentDoc() && isImage(currentDoc()));
    const previous = isFullscreen();
    document.body.classList.toggle("mobile-photo-fullscreen", next);
    resetPinchZoom();
    if (previous !== next) onFullscreenChange(next, options);
  }

  function toggleFullscreen() {
    setFullscreen(!isFullscreen(), { history: true });
  }

  function slideImageMarkup(src, alt = "", marker = "") {
    const markerAttr = marker ? ` data-slide-slot="${escapeHtml(marker)}"` : "";
    const content = src
      ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="photo-slide-image" draggable="false">`
      : `<div class="image-preview-spinner" aria-hidden="true"></div>`;
    const placeholderClass = src ? "" : " photo-slide-placeholder";
    return `<div class="photo-slide-panel${placeholderClass}"${markerAttr}>${content}</div>`;
  }

  function cacheKey(doc) {
    return `${getCurrentWorkspacePath()}\n${doc?.path || ""}`;
  }

  function rememberPreloadedImage(key, url) {
    if (!url) return;
    if (preloadedImages.has(key)) preloadedImages.delete(key);
    preloadedImages.set(key, url);
    while (preloadedImages.size > maxPreloadedImages) {
      const oldestKey = preloadedImages.keys().next().value;
      if (!oldestKey) break;
      preloadedImages.delete(oldestKey);
    }
  }

  function jpegFallbackUrl(url) {
    if (!url || !url.includes("/api/image-preview")) return "";
    const fallback = new URL(url, window.location.origin);
    if (fallback.searchParams.get("format") === "jpeg") return "";
    fallback.searchParams.set("format", "jpeg");
    return `${fallback.pathname}${fallback.search}`;
  }

  function previewUrlWithPriority(url, priority) {
    if (!url || !url.includes("/api/image-preview")) return url || "";
    const next = new URL(url, window.location.origin);
    next.searchParams.set("priority", String(priority));
    return `${next.pathname}${next.search}`;
  }

  function decodeImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          height: image.naturalHeight || 0,
          url,
          width: image.naturalWidth || 0,
        });
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error("image decode failed"));
      };
      image.decoding = "async";
      image.onload = finish;
      image.onerror = fail;
      image.src = url;
      image.decode?.().then(finish).catch(() => {});
    });
  }

  async function runPreload(doc, key, priority = 0) {
    await loadDoc(doc);
    const url = previewUrlWithPriority(doc.previewUrl || doc.rawUrl || "", priority);
    if (!url) return "";
    try {
      const decoded = await decodeImage(url);
      if (decoded.width > 0 && decoded.height > 0) doc.imageSize = { width: decoded.width, height: decoded.height };
      rememberPreloadedImage(key, url);
      return url;
    } catch {
      const fallback = jpegFallbackUrl(url);
      if (!fallback) return "";
      const decoded = await decodeImage(fallback);
      if (decoded.width > 0 && decoded.height > 0) doc.imageSize = { width: decoded.width, height: decoded.height };
      rememberPreloadedImage(key, fallback);
      return fallback;
    }
  }

  function pumpPreloadQueue() {
    while (preloadInFlight.size < maxPreloadInFlight && preloadQueue.size) {
      const next = [...preloadQueue.entries()]
        .sort((a, b) => b[1].priority - a[1].priority || a[1].sequence - b[1].sequence)[0];
      if (!next) return;
      const [key, item] = next;
      preloadQueue.delete(key);
      startPreloadTask(key, item);
    }
  }

  function startPreloadTask(key, item) {
    const task = runPreload(item.doc, key, item.priority).catch(() => "").finally(() => {
      preloadInFlight.delete(key);
      pumpPreloadQueue();
    });
    preloadInFlight.set(key, task);
    task.then(item.resolve, item.reject);
    return task;
  }

  function preloadImage(doc, { immediate = false, priority = 0 } = {}) {
    if (!doc || !isImage(doc)) return "";
    const key = cacheKey(doc);
    const cached = preloadedImages.get(key);
    if (cached) return cached;
    if (preloadInFlight.has(key)) return preloadInFlight.get(key);
    if (preloadQueue.has(key)) {
      const item = preloadQueue.get(key);
      if (priority > item.priority) item.priority = priority;
      item.doc = doc;
      if (immediate) {
        preloadQueue.delete(key);
        return startPreloadTask(key, item);
      }
      pumpPreloadQueue();
      return item.promise;
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    preloadQueue.set(key, {
      doc,
      priority,
      promise,
      reject: rejectPromise,
      resolve: resolvePromise,
      sequence: preloadSequence += 1,
    });
    if (immediate) {
      // Foreground selections should start immediately without cancelling background preloads.
      const item = preloadQueue.get(key);
      preloadQueue.delete(key);
      return startPreloadTask(key, item);
    }
    pumpPreloadQueue();
    return promise;
  }

  function preloadedImageUrl(doc) {
    return preloadedImages.get(cacheKey(doc)) || "";
  }

  function waitForNextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function clearTransitionState() {
    if (gestureResetTimer) {
      clearTimeout(gestureResetTimer);
      gestureResetTimer = null;
    }
    els.preview.querySelectorAll(".photo-slide-track").forEach((track) => track.remove());
    els.preview.querySelectorAll(".is-photo-transitioning").forEach((frame) => {
      frame.classList.remove("is-photo-transitioning");
    });
    swipeStart = null;
    swipeGesture = null;
    transitioning = false;
  }

  function pinchMediaElements() {
    const frame = els.preview.querySelector("[data-motion-media-frame]");
    if (!frame) return [];
    return [...frame.querySelectorAll(":scope > img[data-live-photo-image], :scope > video[data-live-photo-video], :scope > .live-photo-player")];
  }

  function clampPan(value, scale, viewportSize) {
    if (scale <= 1) return 0;
    const max = Math.max(0, (viewportSize * (scale - 1)) / 2);
    return Math.max(-max, Math.min(max, value));
  }

  function applyPinchZoom(state = pinchState) {
    const frame = els.preview.querySelector("[data-motion-media-frame]");
    const shell = els.preview.querySelector("[data-live-photo-shell]");
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const scale = Math.max(1, Math.min(4, state.scale || 1));
    const x = clampPan(state.x || 0, scale, rect.width || window.innerWidth);
    const y = clampPan(state.y || 0, scale, rect.height || window.innerHeight);
    pinchState = { scale, x, y };
    const active = scale > 1.01;
    shell?.classList.toggle("is-pinched-photo", active);
    for (const element of pinchMediaElements()) {
      element.style.transformOrigin = "center center";
      element.style.transform = active ? `translate3d(${x}px, ${y}px, 0) scale(${scale})` : "";
      element.style.willChange = active ? "transform" : "";
    }
  }

  function resetPinchZoom() {
    pinchGesture = null;
    pinchState = { scale: 1, x: 0, y: 0 };
    els.preview.querySelector("[data-live-photo-shell]")?.classList.remove("is-pinched-photo");
    for (const element of pinchMediaElements()) {
      element.style.transform = "";
      element.style.transformOrigin = "";
      element.style.willChange = "";
    }
  }

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchMidpoint(touches) {
    const [a, b] = touches;
    return {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    };
  }

  function startPinch(event) {
    if (!isMobileViewport() || !currentDoc() || !isImage(currentDoc()) || transitioning) return false;
    if (event.touches.length < 2) return false;
    event.preventDefault();
    clearTransitionState();
    const midpoint = touchMidpoint(event.touches);
    pinchGesture = {
      base: { ...pinchState },
      midpoint,
      distance: Math.max(1, touchDistance(event.touches)),
    };
    swipeStart = null;
    swipeGesture = null;
    return true;
  }

  function armGestureReset() {
    if (gestureResetTimer) clearTimeout(gestureResetTimer);
    gestureResetTimer = setTimeout(() => {
      if (swipeGesture || transitioning) clearTransitionState();
    }, 1200);
  }

  function clearGestureReset() {
    if (!gestureResetTimer) return;
    clearTimeout(gestureResetTimer);
    gestureResetTimer = null;
  }

  function preloadAdjacent(doc = currentDoc()) {
    if (!doc || !isImage(doc)) return;
    const { items, index } = imageSequenceState(doc);
    if (!items.length || index < 0) return;
    [
      { doc: items[index - 1], priority: 80 },
      { doc: items[index + 1], priority: 80 },
      { doc: items[index - 2], priority: 60 },
      { doc: items[index + 2], priority: 60 },
    ].filter((item) => item.doc).forEach((item) => {
      preloadImage(item.doc, { priority: item.priority });
    });
  }

  function swipeTarget(deltaX, doc = currentDoc()) {
    const direction = deltaX < 0 ? 1 : -1;
    const { previous, next } = imageSequenceState(doc);
    const target = direction < 0 ? previous : next;
    return { direction, target };
  }

  function createSlideTrack(direction, target) {
    const frame = els.preview.querySelector("[data-motion-media-frame]");
    const currentImage = els.preview.querySelector("[data-live-photo-image]");
    if (!frame || !currentImage || !target) return null;

    const current = currentDoc();
    const currentSrc = currentImage.currentSrc || currentImage.src || current?.previewUrl || current?.rawUrl || "";
    const targetPreload = preloadImage(target, { immediate: true, priority: 90 });
    const targetSrc = preloadedImageUrl(target);
    const targetReady = Promise.resolve(targetPreload).catch(() => "");
    const track = document.createElement("div");
    track.className = `photo-slide-track ${direction > 0 ? "to-next" : "to-previous"}`;
    track.innerHTML = direction > 0
      ? `${slideImageMarkup(currentSrc, current?.name, "current")}${slideImageMarkup(targetSrc, target.name, "target")}`
      : `${slideImageMarkup(targetSrc, target.name, "target")}${slideImageMarkup(currentSrc, current?.name, "current")}`;
    targetReady.then((readySrc) => {
      if (!readySrc || !track.isConnected) return;
      const targetPanel = track.querySelector('[data-slide-slot="target"]');
      if (!targetPanel) return;
      const existingImage = targetPanel.querySelector("img.photo-slide-image");
      if (existingImage) {
        if ((existingImage.currentSrc || existingImage.src) !== readySrc) existingImage.src = readySrc;
        return;
      }
      const image = document.createElement("img");
      image.src = readySrc;
      image.alt = target.name;
      image.className = "photo-slide-image";
      image.draggable = false;
      targetPanel.classList.remove("photo-slide-placeholder");
      targetPanel.replaceChildren(image);
    });
    frame.classList.add("is-photo-transitioning");
    frame.append(track);
    return { frame, ready: targetReady, track, width: frame.getBoundingClientRect().width || window.innerWidth };
  }

  function animateTransition(direction, target) {
    if (!target || transitioning) {
      if (target) selectDoc(target.id);
      return;
    }

    transitioning = true;
    const slide = createSlideTrack(direction, target);
    if (!slide) {
      clearTransitionState();
      selectDoc(target.id);
      return;
    }
    const { frame, ready, track, width } = slide;
    if (direction < 0) track.style.transform = `translate3d(${-width}px, 0, 0)`;
    requestAnimationFrame(() => {
      track.classList.add("is-animating");
      track.style.transform = direction > 0 ? `translate3d(${-width}px, 0, 0)` : "translate3d(0, 0, 0)";
    });

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      track.removeEventListener("transitionend", finish);
      await ready;
      if (!track.isConnected) return;
      await selectDoc(target.id);
      await waitForNextPaint();
      if (!track.isConnected) return;
      track.remove();
      frame.classList.remove("is-photo-transitioning");
      swipeStart = null;
      swipeGesture = null;
      transitioning = false;
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 360);
  }

  function handleSwipe(start, end) {
    const doc = currentDoc();
    if (!doc || !isImage(doc) || !start || !end) return;
    if (els.preview.querySelector("[data-live-photo-shell]")?.classList.contains("is-zoomed-photo")) return;
    if (els.preview.querySelector("[data-live-photo-shell]")?.classList.contains("is-pinched-photo")) return;
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    if (Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    const { direction, target } = swipeTarget(deltaX, doc);
    if (!target) return;
    if (isMobileViewport()) animateTransition(direction, target);
    else selectDoc(target.id);
  }

  function onTouchStart(event) {
    if (startPinch(event)) return;
    if (!transitioning && els.preview.querySelector(".photo-slide-track")) {
      clearTransitionState();
    }
    if (transitioning && !els.preview.querySelector(".photo-slide-track")) {
      clearTransitionState();
    }
    if (event.touches.length !== 1 || !currentDoc() || !isImage(currentDoc()) || transitioning) {
      swipeStart = null;
      swipeGesture = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    swipeGesture = null;
  }

  function onTouchMove(event) {
    if (pinchGesture || event.touches.length >= 2) {
      if (!pinchGesture && !startPinch(event)) return;
      if (!pinchGesture || event.touches.length < 2) return;
      event.preventDefault();
      const nextDistance = Math.max(1, touchDistance(event.touches));
      const nextMidpoint = touchMidpoint(event.touches);
      const scale = Math.max(1, Math.min(4, pinchGesture.base.scale * (nextDistance / pinchGesture.distance)));
      applyPinchZoom({
        scale,
        x: pinchGesture.base.x + nextMidpoint.x - pinchGesture.midpoint.x,
        y: pinchGesture.base.y + nextMidpoint.y - pinchGesture.midpoint.y,
      });
      suppressClickUntil = Date.now() + 450;
      return;
    }
    if (!swipeStart || event.touches.length !== 1) return;
    const doc = currentDoc();
    if (!doc || !isImage(doc)) return;
    if (els.preview.querySelector("[data-live-photo-shell]")?.classList.contains("is-zoomed-photo")) return;
    if (els.preview.querySelector("[data-live-photo-shell]")?.classList.contains("is-pinched-photo")) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - swipeStart.x;
    const deltaY = touch.clientY - swipeStart.y;
    if (!swipeGesture) {
      if (Math.abs(deltaX) < 10) return;
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.1) return;
      const { direction, target } = swipeTarget(deltaX, doc);
      if (!target) return;
      const slide = createSlideTrack(direction, target);
      if (!slide) return;
      swipeGesture = { ...slide, direction, target, latestDeltaX: deltaX };
      transitioning = true;
      armGestureReset();
      if (slide && direction < 0) slide.track.style.transform = `translate3d(${-slide.width}px, 0, 0)`;
    }

    event.preventDefault();
    const { direction, track, width } = swipeGesture;
    const constrainedDelta = direction > 0
      ? Math.max(-width, Math.min(0, deltaX))
      : Math.max(0, Math.min(width, deltaX));
    swipeGesture.latestDeltaX = constrainedDelta;
    const offset = direction > 0 ? constrainedDelta : -width + constrainedDelta;
    track.classList.remove("is-animating");
    track.style.transform = `translate3d(${offset}px, 0, 0)`;
  }

  function onTouchEnd(event) {
    if (pinchGesture) {
      suppressClickUntil = Date.now() + 450;
      if (event.touches.length >= 2) return;
      pinchGesture = null;
      if (pinchState.scale < 1.04) resetPinchZoom();
      return;
    }
    if (!swipeStart || !event.changedTouches.length) {
      if (swipeGesture) clearTransitionState();
      return;
    }
    clearGestureReset();
    const touch = event.changedTouches[0];
    const elapsed = Date.now() - swipeStart.time;
    const end = { x: touch.clientX, y: touch.clientY };
    const start = swipeStart;
    swipeStart = null;
    if (swipeGesture) {
      const { direction, target, track, frame, ready, width, latestDeltaX } = swipeGesture;
      swipeGesture = null;
      suppressClickUntil = Date.now() + 450;
      const moved = Math.abs(latestDeltaX || 0);
      const shouldCommit = moved > Math.min(140, width * 0.24) || (elapsed < 280 && moved > 48);
      track.classList.add("is-animating");
      track.style.transform = shouldCommit
        ? (direction > 0 ? `translate3d(${-width}px, 0, 0)` : "translate3d(0, 0, 0)")
        : (direction > 0 ? "translate3d(0, 0, 0)" : `translate3d(${-width}px, 0, 0)`);
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        track.removeEventListener("transitionend", finish);
        if (shouldCommit) await ready;
        if (!track.isConnected) return;
        if (shouldCommit) {
          await selectDoc(target.id);
          await waitForNextPaint();
          if (!track.isConnected) return;
        }
        track.remove();
        frame.classList.remove("is-photo-transitioning");
        transitioning = false;
      };
      track.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 360);
      return;
    }
    if (elapsed > 900) return;
    handleSwipe(start, end);
  }

  function onTouchCancel() {
    pinchGesture = null;
    clearTransitionState();
  }

  function suppressesClick() {
    return Date.now() < suppressClickUntil;
  }

  function bind() {
    els.preview.addEventListener("touchstart", onTouchStart, { passive: false });
    els.preview.addEventListener("touchmove", onTouchMove, { passive: false });
    els.preview.addEventListener("touchend", onTouchEnd, { passive: true });
    els.preview.addEventListener("touchcancel", onTouchCancel, { passive: true });
    els.preview.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
    els.preview.addEventListener("gesturechange", (event) => event.preventDefault(), { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true, capture: true });
    window.addEventListener("resize", () => {
      if (!isMobileViewport()) setFullscreen(false);
    });
  }

  return {
    bind,
    handleSwipe,
    getPreloadedImageUrl: preloadedImageUrl,
    isFullscreen,
    isMobileViewport,
    preloadAdjacent,
    preloadImage,
    setFullscreen,
    suppressesClick,
    toggleFullscreen,
  };
}
