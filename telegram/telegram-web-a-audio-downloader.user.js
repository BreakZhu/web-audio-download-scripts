// ==UserScript==
// @name         Telegram Web A 语音与音频下载器
// @namespace    https://github.com/BreakZhu/web-audio-download-scripts/telegram
// @version      1.5.1
// @description  在 Telegram Web A 页面加载完成后安全下载语音、音频和视频
// @author       BreakZhu
// @match        https://web.telegram.org/a/*
// @match        https://*.web.telegram.org/a/*
// @icon         https://telegram.org/favicon.ico
// @homepageURL  https://github.com/BreakZhu/web-audio-download-scripts/tree/main/telegram
// @supportURL   https://github.com/BreakZhu/web-audio-download-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-web-a-audio-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-web-a-audio-downloader.user.js
// @grant        none
// @run-at       document-idle
// @sandbox      raw
// @noframes
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const VERSION = '1.5.1';
    const INSTANCE_KEY = Symbol.for('tgwa-safe-media-downloader.instance');
    const LEGACY_INSTANCE_KEY = Symbol.for('tgwa-audio-downloader.instance');
    const HOST_ID = 'tgwa-safe-media-download-root';
    const DOWNLOAD_HOST_ID = 'tgwa-safe-media-download-context';
    const CONFLICTING_DOWNLOADER_ID = 'tel-downloader-progress-bar-container';
    const AUDIO_SELECTOR = '.Message.message-list-item[data-message-id] .Audio';
    const INLINE_VIDEO_SELECTOR = '.Message.message-list-item[data-message-id] .media-inner video.full-media';
    const PENDING_VIDEO_SELECTOR = '.Message.message-list-item[data-message-id] .media-inner:has(.message-media-duration)';
    const VIEWER_ACTIVE_VIDEO_SELECTOR = [
        '.MediaViewerSlide--active .VideoPlayer video',
        '.MediaViewerSlide--active video',
    ].join(', ');
    const VIEWER_VIDEO_SELECTOR = VIEWER_ACTIVE_VIDEO_SELECTOR
        .split(', ')
        .map((selector) => `#MediaViewer ${selector}`)
        .join(', ');
    const TARGET_SELECTOR = `${AUDIO_SELECTOR}, ${INLINE_VIDEO_SELECTOR}, ${PENDING_VIDEO_SELECTOR}, ${VIEWER_VIDEO_SELECTOR}`;
    const STATE_RETRY_DELAYS = [0, 700, 700, 700, 700, 700, 700, 700];
    const DOWNLOAD_PART_SIZE = 512 * 1024;
    const DOWNLOAD_STALL_TIMEOUT = 20000;
    const MIME_EXTENSIONS = new Map([
        ['audio/aac', 'aac'],
        ['audio/flac', 'flac'],
        ['audio/m4a', 'm4a'],
        ['audio/mp4', 'm4a'],
        ['audio/mpeg', 'mp3'],
        ['audio/ogg', 'ogg'],
        ['audio/opus', 'opus'],
        ['audio/wav', 'wav'],
        ['audio/webm', 'webm'],
        ['video/mp4', 'mp4'],
        ['video/quicktime', 'mov'],
        ['video/webm', 'webm'],
        ['video/x-matroska', 'mkv'],
    ]);

    let activeTarget;
    let button;
    let downloadHost;
    let host;
    let shadowRoot;
    let toast;
    let toastTimer;
    let positionFrame;
    let refreshTimer;
    let viewerObserver;
    let operationId = 0;
    let destroyed = false;
    let legacyInstanceDetected = false;
    const metadataByElement = new WeakMap();
    const metadataPromises = new WeakMap();

    const previousInstance = window[INSTANCE_KEY];
    if (previousInstance?.version === VERSION) {
        previousInstance.refresh?.();
        return;
    }
    if (previousInstance?.destroy) {
        previousInstance.destroy();
    } else if (previousInstance || window[LEGACY_INSTANCE_KEY]) {
        legacyInstanceDetected = true;
    }

    function delay(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    function normalizeMimeType(value) {
        return String(value || '').split(';', 1)[0].trim().toLowerCase();
    }

    function sanitizeFileName(value) {
        const sanitized = String(value || '')
            .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
            .trim();
        return sanitized || undefined;
    }

    function getAccountSlot(source) {
        let value;
        try {
            value = new URL(source || window.location.href, window.location.href).searchParams.get('account');
        } catch {
            // The current page URL remains the authoritative fallback.
        }
        value ||= new URL(window.location.href).searchParams.get('account');
        const slot = Number(value || 1);
        return Number.isInteger(slot) && slot > 1 ? slot : 1;
    }

    function getChatId() {
        return window.location.hash.match(/^#(-?\d+)/)?.[1];
    }

    function getMessageId(target) {
        return target.message?.dataset.messageId;
    }

    function getDocumentIdFromSource(source) {
        if (!source) return undefined;
        try {
            return new URL(source, window.location.href).pathname
                .match(/\/(?:progressive|download)\/document(-?\d+)/)?.[1];
        } catch {
            return undefined;
        }
    }

    function getMediaSource(target) {
        const media = target.element instanceof HTMLMediaElement
            ? target.element
            : target.element.querySelector('video, audio');
        if (!(media instanceof HTMLMediaElement)) return '';
        return media.currentSrc || media.src || media.querySelector('source[src]')?.src || '';
    }

    function normalizeMediaMetadata(media) {
        if (!media || typeof media !== 'object') return undefined;
        if (!['audio', 'voice', 'video', 'document'].includes(media.mediaType)) return undefined;

        const id = media.id === undefined ? '' : String(media.id);
        if (!/^-?\d+$/.test(id)) return undefined;

        return {
            id,
            mediaType: media.mediaType,
            fileName: sanitizeFileName(media.fileName),
            mimeType: normalizeMimeType(media.mimeType),
        };
    }

    function getMessageFromGlobal(global, chatId, messageId) {
        if (!global || !chatId || !messageId) return undefined;
        return global.messages?.byChatId?.[chatId]?.byId?.[messageId];
    }

    function findMetadataInGlobal(global, target) {
        const chatId = getChatId();
        const messageId = getMessageId(target);
        const message = getMessageFromGlobal(global, chatId, messageId);
        if (!message) return undefined;

        const content = message.content || {};
        let media;
        if (target.kind === 'video') {
            media = content.video ||
                (content.document?.innerMediaType === 'video' ? content.document : undefined);
        } else {
            media = content.audio || content.voice || content.video;
        }

        if (!media && content.webPage?.id) {
            const webPage = global.messages?.webPageById?.[content.webPage.id];
            media = target.kind === 'video' ? webPage?.video : webPage?.audio;
        }
        return normalizeMediaMetadata(media);
    }

    function readIndexedDbValue(databaseName, storeName, key) {
        return new Promise((resolve) => {
            let settled = false;
            let timer;
            const finish = (value, database) => {
                if (settled) {
                    database?.close();
                    return;
                }
                settled = true;
                window.clearTimeout(timer);
                database?.close();
                resolve(value);
            };

            timer = window.setTimeout(() => finish(undefined), 1400);
            try {
                const request = window.indexedDB.open(databaseName);
                request.onupgradeneeded = () => request.transaction?.abort();
                request.onerror = () => finish(undefined);
                request.onsuccess = () => {
                    const database = request.result;
                    if (!database.objectStoreNames.contains(storeName)) {
                        finish(undefined, database);
                        return;
                    }
                    try {
                        const transaction = database.transaction(storeName, 'readonly');
                        const getRequest = transaction.objectStore(storeName).get(key);
                        getRequest.onerror = () => finish(undefined, database);
                        getRequest.onsuccess = () => finish(getRequest.result, database);
                    } catch {
                        finish(undefined, database);
                    }
                };
            } catch {
                finish(undefined);
            }
        });
    }

    async function readCurrentMetadata(target, source) {
        if (typeof window.getGlobal === 'function') {
            try {
                const live = findMetadataInGlobal(window.getGlobal(), target);
                if (live) return live;
            } catch {
                // Production Telegram builds normally do not expose getGlobal.
            }
        }

        const slot = getAccountSlot(source);
        const key = slot > 1 ? `tt-global-state_${slot}` : 'tt-global-state';
        const cachedGlobal = await readIndexedDbValue('tt-data', 'store', key);
        return findMetadataInGlobal(cachedGlobal, target);
    }

    async function resolveMetadata(target, source) {
        const sourceId = getDocumentIdFromSource(source);
        if (sourceId) {
            const metadata = await Promise.race([
                readCurrentMetadata(target, source),
                delay(400).then(() => undefined),
            ]);
            return metadata || { id: sourceId, mediaType: target.kind };
        }

        for (const wait of STATE_RETRY_DELAYS) {
            if (wait) await delay(wait);
            if (destroyed || !target.element.isConnected) return undefined;
            const metadata = await readCurrentMetadata(target, source);
            if (metadata) return metadata;
        }
        return undefined;
    }

    function getMetadataCacheKey(target, source) {
        return [
            getMessageId(target) || '',
            getDocumentIdFromSource(source) || source || '',
        ].join('|');
    }

    function getCachedMetadata(target, source) {
        const cached = metadataByElement.get(target.element);
        return cached?.key === getMetadataCacheKey(target, source) ? cached.metadata : undefined;
    }

    function getMetadata(target, source) {
        const cacheKey = getMetadataCacheKey(target, source);
        const cached = metadataByElement.get(target.element);
        if (cached?.key === cacheKey) return Promise.resolve(cached.metadata);

        let pending = metadataPromises.get(target.element);
        if (pending?.key !== cacheKey) {
            const promise = resolveMetadata(target, source)
                .then((metadata) => {
                    if (metadata && metadataPromises.get(target.element)?.promise === promise) {
                        metadataByElement.set(target.element, { key: cacheKey, metadata });
                    }
                    return metadata;
                })
                .finally(() => {
                    if (metadataPromises.get(target.element)?.promise === promise) {
                        metadataPromises.delete(target.element);
                    }
                });
            pending = { key: cacheKey, promise };
            metadataPromises.set(target.element, pending);
        }
        return pending.promise;
    }

    function getTargetFromElement(element) {
        if (!(element instanceof Element)) return undefined;
        const viewer = element.closest('#MediaViewer');
        const matched = element.closest(TARGET_SELECTOR) || viewer?.querySelector(VIEWER_ACTIVE_VIDEO_SELECTOR);
        if (!matched) return undefined;

        const audio = matched.matches('.Audio') ? matched : matched.closest('.Audio');
        const targetElement = audio || matched;
        const message = targetElement.closest('.Message.message-list-item[data-message-id]');
        const kind = targetElement instanceof HTMLVideoElement || targetElement.matches('.media-inner')
            ? 'video' : 'audio';
        const targetViewer = viewer || targetElement.closest('#MediaViewer');
        if (!message && !targetViewer) return undefined;

        const oneTimeRoot = audio || message || targetElement;
        if (oneTimeRoot.classList.contains('non-interactive') ||
            oneTimeRoot.querySelector?.('.icon-view-once, .flame') ||
            oneTimeRoot.closest('.OneTimeMediaModal, .one-time-media-modal')) return undefined;

        return { element: targetElement, message, kind, viewer: targetViewer };
    }

    function isVisibleTarget(target) {
        if (!target?.element.isConnected) return false;
        const rect = target.element.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth;
    }

    function findInitialTarget() {
        const viewer = document.querySelector(VIEWER_VIDEO_SELECTOR);
        const viewerTarget = getTargetFromElement(viewer);
        if (isVisibleTarget(viewerTarget)) return viewerTarget;

        for (const element of document.querySelectorAll(
            `${AUDIO_SELECTOR}, ${INLINE_VIDEO_SELECTOR}, ${PENDING_VIDEO_SELECTOR}`
        )) {
            const target = getTargetFromElement(element);
            if (isVisibleTarget(target)) return target;
        }
        return undefined;
    }

    function setButtonState(state, label) {
        if (!button) return;
        button.dataset.state = state;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = state === 'busy';
    }

    function showToast(message, isError = false, duration = 3200) {
        if (!toast) return;
        window.clearTimeout(toastTimer);
        toast.textContent = message;
        toast.dataset.kind = isError ? 'error' : 'normal';
        toast.classList.add('is-visible');
        toastTimer = window.setTimeout(() => toast?.classList.remove('is-visible'), duration);
    }

    function positionButton() {
        positionFrame = undefined;
        if (!button) return;
        if (!isVisibleTarget(activeTarget)) {
            activeTarget = undefined;
            button.hidden = true;
            host?.removeAttribute('data-active-kind');
            return;
        }

        const rect = activeTarget.element.getBoundingClientRect();
        const size = 36;
        const gap = 8;
        let left;
        let top;
        const viewer = activeTarget.viewer || activeTarget.element.closest('#MediaViewer');
        const viewerHead = viewer?.querySelector('.media-viewer-head');
        const headRect = viewerHead?.getBoundingClientRect();
        if (headRect?.width > size && headRect.height >= size) {
            const actions = viewerHead.querySelector('.MediaViewerActions, .MediaViewerActions-mobile');
            const actionsRect = actions?.getBoundingClientRect();
            const preferredLeft = actionsRect?.width
                ? actionsRect.left - size - 4
                : headRect.right - size - gap;
            left = Math.max(headRect.left + gap, preferredLeft);
            top = headRect.top + (headRect.height - size) / 2;
            button.dataset.context = 'viewer';
        } else if (activeTarget.kind === 'audio') {
            const fitsRight = rect.right + gap + size <= window.innerWidth - gap;
            const fitsLeft = rect.left - gap - size >= gap;
            left = fitsRight ? rect.right + gap : fitsLeft ? rect.left - gap - size : rect.right - size - gap;
            top = rect.top + (rect.height - size) / 2;
            delete button.dataset.context;
        } else {
            left = rect.right - size - gap;
            top = rect.top + gap;
            delete button.dataset.context;
        }

        button.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - size - gap))}px`;
        button.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - size - gap))}px`;
        button.hidden = false;
        host.dataset.activeKind = activeTarget.kind;
        const label = activeTarget.kind === 'video' ? '下载视频' : '下载语音或音频';
        if (!['busy', 'done', 'error'].includes(button.dataset.state)) {
            setButtonState('ready', label);
        }
    }

    function schedulePosition() {
        if (positionFrame || destroyed) return;
        positionFrame = window.requestAnimationFrame(positionButton);
    }

    function scheduleRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refresh, 0);
    }

    function mutationTouchesViewer(mutation) {
        if (mutation.target instanceof Element && mutation.target.closest('#MediaViewer')) return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
            node instanceof Element &&
            (node.matches('#MediaViewer') || Boolean(node.querySelector('#MediaViewer')))
        );
    }

    function mountUiForTarget(target) {
        if (!host) return;
        const viewer = target?.viewer || target?.element.closest('#MediaViewer');
        const parent = viewer || document.documentElement;
        if (host.parentNode !== parent) parent.appendChild(host);
    }

    function selectTargetFromEvent(event) {
        const target = getTargetFromElement(event.target);
        if (!target) return;
        mountUiForTarget(target);
        if (activeTarget?.element !== target.element) {
            activeTarget = target;
            void getMetadata(target, getMediaSource(target));
        }
        schedulePosition();
    }

    function findNativeDownloadButton(target) {
        if (target.kind === 'audio') {
            const nativeButton = target.element.querySelector('.download-button');
            return nativeButton instanceof HTMLButtonElement &&
                !/cancel/i.test(nativeButton.getAttribute('aria-label') || '') ? nativeButton : undefined;
        }

        const scope = target.viewer || target.element.closest('#MediaViewer') || target.element.closest('.media-inner');
        for (const icon of scope?.querySelectorAll('.MediaViewerActions .icon-download, button .icon-download') || []) {
            const candidate = icon.closest('button, a');
            if (candidate && !candidate.matches('.tel-download, .tg-download-btn')) return candidate;
        }
        return undefined;
    }

    function startNativeDownload(target) {
        const nativeButton = findNativeDownloadButton(target);
        if (!nativeButton) return false;
        nativeButton.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            view: window,
        }));
        nativeButton.click();
        return true;
    }

    function buildFileName(target, metadata, source, mimeType) {
        const original = sanitizeFileName(metadata?.fileName);
        if (original) return original;

        const messageId = String(getMessageId(target) || Date.now()).replace(/[^\w-]/g, '_');
        const documentId = metadata?.id || getDocumentIdFromSource(source);
        const normalizedMime = normalizeMimeType(metadata?.mimeType || mimeType);
        let extension = MIME_EXTENSIONS.get(normalizedMime);
        if (!extension) {
            extension = metadata?.mediaType === 'voice' ? 'ogg' :
                target.kind === 'video' ? 'mp4' : 'mp3';
        }
        const prefix = metadata?.mediaType === 'voice' ? 'voice' : target.kind;
        return `${documentId || `${prefix}_${messageId}`}.${extension}`;
    }

    function createTelegramDownloadUrl(documentId, fileName, source) {
        if (!/^-?\d+$/.test(String(documentId))) throw new Error('媒体编号无效');
        const url = new URL(`./download/document${documentId}`, window.location.href);
        url.searchParams.set('download', '');
        const slot = getAccountSlot(source);
        if (slot > 1) url.searchParams.set('account', String(slot));
        url.searchParams.set('filename', fileName);
        return url.href;
    }

    function createTelegramProgressiveUrl(documentId, source) {
        if (!/^-?\d+$/.test(String(documentId))) throw new Error('媒体编号无效');
        const url = new URL(`./progressive/document${documentId}`, window.location.href);
        const slot = getAccountSlot(source);
        if (slot > 1) url.searchParams.set('account', String(slot));
        return url.href;
    }

    function canStreamToFile() {
        return window.self === window.top && window.isSecureContext &&
            typeof window.showSaveFilePicker === 'function';
    }

    function openSaveFilePicker(target, source) {
        if (!canStreamToFile()) return undefined;

        const metadata = getCachedMetadata(target, source);
        const suggestedName = buildFileName(target, metadata, source);
        try {
            return window.showSaveFilePicker({ suggestedName })
                .then((handle) => ({ handle }))
                .catch((error) => ({ error }));
        } catch (error) {
            return Promise.resolve({ error });
        }
    }

    function formatDownloadProgress(receivedBytes, totalBytes) {
        if (!totalBytes) return '正在保存文件';
        const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
        return `正在保存文件 ${percent}%`;
    }

    function createMediaNotReadyError() {
        return new Error('Telegram 尚未在当前标签页载入此文件。请先播放音频或视频 1 秒，再点下载；不要打开临时下载网址');
    }

    function parseContentRange(response, expectedStart) {
        const match = response.headers.get('Content-Range')
            ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        if (!match) throw new Error('Telegram 返回了无效的文件分块');

        const start = Number(match[1]);
        const end = Number(match[2]);
        const total = Number(match[3]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            !Number.isSafeInteger(total) || start !== expectedStart || end < start || end >= total) {
            throw new Error('Telegram 返回的文件分块不连续');
        }
        return { start, end, total };
    }

    async function streamTelegramDownload(progressiveUrl, fileHandle) {
        const abortController = new AbortController();
        let stallTimer;
        const resetStallTimer = () => {
            window.clearTimeout(stallTimer);
            stallTimer = window.setTimeout(() => abortController.abort(), DOWNLOAD_STALL_TIMEOUT);
        };

        let reader;
        let writable;
        try {
            let offset = 0;
            let totalBytes;
            let receivedBytes = 0;

            while (totalBytes === undefined || offset < totalBytes) {
                resetStallTimer();
                const response = await window.fetch(progressiveUrl, {
                    cache: 'no-store',
                    credentials: 'same-origin',
                    headers: {
                        Range: `bytes=${offset}-${offset + DOWNLOAD_PART_SIZE - 1}`,
                    },
                    signal: abortController.signal,
                });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => undefined);
                    if (response.status === 500) throw createMediaNotReadyError();
                    throw new Error(`Telegram 下载服务返回错误 (${response.status})`);
                }
                if (response.status !== 206 || !response.body) {
                    await response.body?.cancel().catch(() => undefined);
                    throw new Error('Telegram 没有返回可保存的文件分块');
                }

                const range = parseContentRange(response, offset);
                if (totalBytes !== undefined && range.total !== totalBytes) {
                    await response.body.cancel().catch(() => undefined);
                    throw new Error('Telegram 返回的文件大小发生变化');
                }
                totalBytes = range.total;
                writable ||= await fileHandle.createWritable();
                reader = response.body.getReader();

                let partBytes = 0;
                while (true) {
                    resetStallTimer();
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                    partBytes += value.byteLength;
                    receivedBytes += value.byteLength;
                    setButtonState('busy', formatDownloadProgress(receivedBytes, totalBytes));
                }
                reader = undefined;
                if (partBytes !== range.end - range.start + 1) {
                    throw new Error('Telegram 返回的文件分块不完整');
                }
                offset = range.end + 1;
            }

            await writable.close();
            writable = undefined;
        } catch (error) {
            await reader?.cancel().catch(() => undefined);
            await writable?.abort().catch(() => undefined);
            if (error?.name === 'AbortError') throw createMediaNotReadyError();
            throw error;
        } finally {
            window.clearTimeout(stallTimer);
        }
    }

    function createDownloadAnchor(url, fileName) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = 'none';
        anchor.rel = 'noopener';
        anchor.dataset.tgwaSafeDownload = 'true';
        downloadHost.appendChild(anchor);
        host.dataset.lastDownloadUrl = url;
        host.dataset.lastDownloadName = fileName;
        anchor.click();
        window.setTimeout(() => anchor.remove(), 1000);
    }

    function downloadBlobSource(target, source) {
        const dataMimeType = source.match(/^data:([^;,]+)/i)?.[1] || '';
        const metadata = getCachedMetadata(target, source);
        const fileName = buildFileName(target, metadata, source, dataMimeType);
        createDownloadAnchor(source, fileName);
        return fileName;
    }

    async function waitForServiceWorkerController(downloadUrl, timeout = 3000) {
        if (!navigator.serviceWorker) return false;

        const hasController = navigator.serviceWorker.controller ? true : await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                navigator.serviceWorker.removeEventListener('controllerchange', handleChange);
                resolve(value);
            };
            const handleChange = () => finish(Boolean(navigator.serviceWorker.controller));
            const timer = window.setTimeout(() => finish(Boolean(navigator.serviceWorker.controller)), timeout);
            navigator.serviceWorker.addEventListener('controllerchange', handleChange, { once: true });
        });
        if (!hasController) return false;

        const controllerUrl = navigator.serviceWorker.controller?.scriptURL;
        if (controllerUrl) {
            try {
                if (!new URL(controllerUrl, window.location.href).pathname.startsWith('/a/')) return false;
            } catch {
                return false;
            }
        }

        if (navigator.serviceWorker.ready?.then) {
            const registration = await Promise.race([
                navigator.serviceWorker.ready.catch(() => undefined),
                delay(timeout).then(() => undefined),
            ]);
            if (registration?.scope && !downloadUrl.startsWith(registration.scope)) return false;
        }
        return true;
    }

    async function downloadResolvedTarget(target, savePickerPromise) {
        const source = getMediaSource(target);
        if (/^(?:blob:|data:(?:audio|video)\/)/i.test(source)) {
            return { fileName: downloadBlobSource(target, source) };
        }

        const [metadata, savePickerResult] = await Promise.all([
            getMetadata(target, source),
            savePickerPromise || Promise.resolve(undefined),
        ]);
        if (savePickerResult?.error?.name === 'AbortError') return { cancelled: true };
        if (savePickerResult?.error) throw savePickerResult.error;

        const documentId = metadata?.id || getDocumentIdFromSource(source);
        if (!documentId) {
            throw new Error('Telegram 尚未完成媒体加载，请先播放或打开媒体，等待几秒后重试');
        }

        const fileName = buildFileName(target, metadata, source);
        const downloadUrl = createTelegramDownloadUrl(documentId, fileName, source);
        const progressiveUrl = createTelegramProgressiveUrl(documentId, source);
        if (!await waitForServiceWorkerController(progressiveUrl)) {
            throw new Error('Telegram Web A 下载服务尚未就绪，请完整刷新页面后再试');
        }
        if (savePickerResult?.handle) {
            host.dataset.lastDownloadUrl = progressiveUrl;
            host.dataset.lastDownloadName = savePickerResult.handle.name || fileName;
            host.dataset.lastDownloadMode = 'stream';
            await streamTelegramDownload(progressiveUrl, savePickerResult.handle);
            return { fileName: savePickerResult.handle.name || fileName };
        }

        host.dataset.lastDownloadMode = 'browser';
        createDownloadAnchor(downloadUrl, fileName);
        return { fileName };
    }

    async function handleDownload() {
        if (!activeTarget || button?.dataset.state === 'busy') return;
        const currentOperation = ++operationId;
        const target = activeTarget;
        if (startNativeDownload(target)) {
            setButtonState('done', '已调用 Telegram 原始文件下载');
            showToast('已调用 Telegram 原始文件下载');
            window.setTimeout(() => {
                if (!button || destroyed || currentOperation !== operationId) return;
                const label = activeTarget?.kind === 'video' ? '下载视频' : '下载语音或音频';
                setButtonState('ready', label);
            }, 2200);
            return;
        }

        const source = getMediaSource(target);
        const savePickerPromise = /^(?:blob:|data:(?:audio|video)\/)/i.test(source)
            ? undefined : openSaveFilePicker(target, source);
        setButtonState('busy', '正在等待 Telegram 完成媒体加载');
        const waitingToast = window.setTimeout(() => {
            showToast('正在等待 Telegram 完成媒体加载，请保持当前页面打开', false, 5000);
        }, 900);

        try {
            const result = await downloadResolvedTarget(target, savePickerPromise);
            if (result.cancelled) {
                const label = target.kind === 'video' ? '下载视频' : '下载语音或音频';
                setButtonState('ready', label);
                return;
            }
            setButtonState('done', savePickerPromise ? '文件已保存' : '已交给浏览器下载');
            showToast(savePickerPromise ? `已保存: ${result.fileName}` : `已开始下载: ${result.fileName}`);
        } catch (error) {
            console.error('[Telegram Web A 安全下载器]', error);
            setButtonState('error', error?.message || '下载失败');
            showToast(error?.message || '下载失败', true, 5000);
        } finally {
            window.clearTimeout(waitingToast);
            window.setTimeout(() => {
                if (!button || destroyed || currentOperation !== operationId) return;
                const label = activeTarget?.kind === 'video' ? '下载视频' : '下载语音或音频';
                setButtonState('ready', label);
            }, 2200);
        }
    }

    function createUi() {
        downloadHost = document.createElement('div');
        downloadHost.id = DOWNLOAD_HOST_ID;
        downloadHost.setAttribute('aria-hidden', 'true');
        downloadHost.style.cssText = [
            'position:fixed',
            'width:0',
            'height:0',
            'overflow:hidden',
            'pointer-events:none',
        ].join(';');

        host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = [
            'position:fixed',
            'inset:0',
            'width:100vw',
            'height:100vh',
            'margin:0',
            'padding:0',
            'border:0',
            'background:transparent',
            'z-index:2147483646',
            'pointer-events:none',
        ].join(';');
        shadowRoot = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            *, *::before, *::after { box-sizing: border-box; }
            .download-button {
                appearance: none;
                position: fixed;
                width: 36px;
                height: 36px;
                padding: 0;
                border: 0;
                border-radius: 50%;
                display: grid;
                place-items: center;
                color: #ffffff;
                background: #3390ec;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
                cursor: pointer;
                pointer-events: auto;
                transition: background-color 120ms ease, transform 120ms ease, opacity 120ms ease;
            }
            .download-button:hover { background: #2481cc; transform: translateY(-1px); }
            .download-button:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
            .download-button:disabled { cursor: wait; opacity: 0.78; }
            .download-icon {
                position: relative;
                width: 18px;
                height: 18px;
            }
            .download-icon::before {
                content: '';
                position: absolute;
                left: 8px;
                top: 1px;
                width: 2px;
                height: 10px;
                border-radius: 1px;
                background: currentColor;
            }
            .download-icon::after {
                content: '';
                position: absolute;
                left: 4px;
                top: 6px;
                width: 10px;
                height: 10px;
                border-right: 2px solid currentColor;
                border-bottom: 2px solid currentColor;
                transform: rotate(45deg);
            }
            .download-button[data-state='busy'] .download-icon {
                width: 16px;
                height: 16px;
                border: 2px solid currentColor;
                border-right-color: transparent;
                border-radius: 50%;
                animation: spin 700ms linear infinite;
            }
            .download-button[data-state='busy'] .download-icon::before,
            .download-button[data-state='busy'] .download-icon::after { display: none; }
            .download-button[data-state='done'] { background: #16894b; }
            .download-button[data-state='error'] { background: #c93f3f; }
            .download-tray {
                position: absolute;
                left: 4px;
                right: 4px;
                bottom: 1px;
                height: 2px;
                border-radius: 1px;
                background: currentColor;
            }
            .toast {
                position: fixed;
                left: 50%;
                bottom: max(16px, env(safe-area-inset-bottom));
                transform: translate(-50%, 8px);
                width: max-content;
                max-width: min(480px, calc(100vw - 32px));
                padding: 10px 14px;
                border-radius: 6px;
                color: #ffffff;
                background: rgba(33, 42, 51, 0.96);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
                font: 500 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                overflow-wrap: anywhere;
                opacity: 0;
                pointer-events: none;
                transition: opacity 150ms ease, transform 150ms ease;
            }
            .toast[data-kind='error'] { background: rgba(177, 49, 49, 0.97); }
            .toast.is-visible { opacity: 1; transform: translate(-50%, 0); }
            @keyframes spin { to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) {
                .download-button, .toast { transition: none; }
                .download-button[data-state='busy'] .download-icon { animation-duration: 1400ms; }
            }
        `;

        button = document.createElement('button');
        button.type = 'button';
        button.className = 'download-button';
        button.dataset.state = 'ready';
        button.hidden = true;
        button.innerHTML = '<span class="download-icon" aria-hidden="true"><span class="download-tray"></span></span>';
        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        button.addEventListener('mousedown', (event) => event.stopPropagation());
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleDownload();
        });

        toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        shadowRoot.append(style, button, toast);
        document.documentElement.append(downloadHost, host);
    }

    function refresh() {
        if (destroyed) return;
        const viewerTarget = getTargetFromElement(document.querySelector(VIEWER_VIDEO_SELECTOR));
        if (isVisibleTarget(viewerTarget)) {
            activeTarget = viewerTarget;
        } else if (!isVisibleTarget(activeTarget)) {
            activeTarget = findInitialTarget();
        }
        if (activeTarget) void getMetadata(activeTarget, getMediaSource(activeTarget));
        mountUiForTarget(activeTarget);
        schedulePosition();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        window.clearTimeout(toastTimer);
        if (positionFrame) window.cancelAnimationFrame(positionFrame);
        window.clearTimeout(refreshTimer);
        document.removeEventListener('pointerover', selectTargetFromEvent, true);
        document.removeEventListener('pointerdown', selectTargetFromEvent, true);
        document.removeEventListener('focusin', selectTargetFromEvent, true);
        document.removeEventListener('click', scheduleRefresh, true);
        document.removeEventListener('keyup', scheduleRefresh, true);
        document.removeEventListener('scroll', schedulePosition, true);
        window.removeEventListener('resize', schedulePosition);
        window.removeEventListener('hashchange', scheduleRefresh);
        window.visualViewport?.removeEventListener('resize', schedulePosition);
        window.visualViewport?.removeEventListener('scroll', schedulePosition);
        viewerObserver?.disconnect();
        host?.remove();
        downloadHost?.remove();
    }

    function initialize() {
        if (destroyed || document.getElementById(HOST_ID)) return;
        createUi();
        document.addEventListener('pointerover', selectTargetFromEvent, true);
        document.addEventListener('pointerdown', selectTargetFromEvent, true);
        document.addEventListener('focusin', selectTargetFromEvent, true);
        document.addEventListener('click', scheduleRefresh, true);
        document.addEventListener('keyup', scheduleRefresh, true);
        document.addEventListener('scroll', schedulePosition, true);
        window.addEventListener('resize', schedulePosition);
        window.addEventListener('hashchange', scheduleRefresh);
        window.visualViewport?.addEventListener('resize', schedulePosition);
        window.visualViewport?.addEventListener('scroll', schedulePosition);
        viewerObserver = new MutationObserver((mutations) => {
            if (mutations.some(mutationTouchesViewer)) scheduleRefresh();
        });
        viewerObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'open', 'src'],
        });
        refresh();

        if (legacyInstanceDetected) {
            showToast('检测到旧版脚本仍在当前标签页运行，请完整刷新一次 Telegram 页面', true, 8000);
        } else if (document.getElementById(CONFLICTING_DOWNLOADER_ID)) {
            showToast('检测到另一个 Telegram Media Downloader，请在油猴中停用它并刷新页面', true, 8000);
        }
        console.info(`[Telegram Web A 安全下载器] v${VERSION} 已在页面加载完成后启动`);
    }

    const instance = { version: VERSION, refresh, destroy };
    Object.defineProperty(window, INSTANCE_KEY, {
        configurable: true,
        enumerable: false,
        value: instance,
    });

    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize, { once: true });
    }
})();
