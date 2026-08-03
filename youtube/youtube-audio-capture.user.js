// ==UserScript==
// @name         YouTube 实时音频抓取器
// @namespace    https://github.com/BreakZhu/web-audio-download-scripts/youtube
// @version      1.0.0
// @description  使用浏览器媒体流实时保存当前 YouTube 视频的音频
// @author       BreakZhu
// @match        https://youtube.com/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @homepageURL  https://github.com/BreakZhu/web-audio-download-scripts/tree/main/youtube
// @supportURL   https://github.com/BreakZhu/web-audio-download-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/youtube/youtube-audio-capture.user.js
// @updateURL    https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/youtube/youtube-audio-capture.user.js
// @grant        none
// @run-at       document-idle
// @sandbox      raw
// @noframes
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const VERSION = '1.0.0';
    const INSTANCE_KEY = Symbol.for('youtube-audio-capture.instance');
    const BUTTON_ID = 'yt-audio-capture-button';
    const STYLE_ID = 'yt-audio-capture-style';
    const TOAST_ID = 'yt-audio-capture-toast';
    const AUDIO_BITS_PER_SECOND = 192000;
    const AUDIO_TRACK_READY_TIMEOUT = 2000;
    const MEMORY_CAPTURE_LIMIT = 256 * 1024 * 1024;
    const MIME_CANDIDATES = [
        { mimeType: 'audio/webm;codecs=opus', baseMime: 'audio/webm', extension: 'webm' },
        { mimeType: 'audio/ogg;codecs=opus', baseMime: 'audio/ogg', extension: 'ogg' },
        { mimeType: 'audio/webm', baseMime: 'audio/webm', extension: 'webm' },
        { mimeType: 'audio/ogg', baseMime: 'audio/ogg', extension: 'ogg' },
    ];
    const VIDEO_SELECTORS = [
        'ytd-reel-video-renderer[is-active] video',
        'ytd-shorts[is-active] video',
        '#movie_player video.html5-main-video',
        '.html5-video-player video.html5-main-video',
        'ytmusic-player video',
        'ytmusic-player-page video',
        'ytmusic-player-bar video',
        'video.html5-main-video',
    ];
    const MUSIC_CONTROL_SELECTORS = [
        'ytmusic-player-bar .right-controls-buttons',
        'ytmusic-player-bar #right-controls',
        'ytmusic-player-bar .right-controls',
        'ytmusic-player-bar .middle-controls-buttons',
        'ytmusic-player-bar .middle-controls',
    ];

    let activeSession;
    let button;
    let destroyed = false;
    let lastUrl = window.location.href;
    let mutationObserver;
    let refreshFrame;
    let startOperation = 0;
    let starting = false;
    let toast;
    let toastTimer;

    const previousInstance = window[INSTANCE_KEY];
    if (previousInstance?.version === VERSION) {
        previousInstance.refresh?.();
        return;
    }
    previousInstance?.destroy?.();

    function sanitizeFileName(value) {
        const sanitized = String(value || '')
            .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[. ]+$/g, '')
            .trim()
            .slice(0, 160);
        return sanitized || `youtube-audio-${Date.now()}`;
    }

    function buildOutputFileName(value, extension) {
        const sanitized = sanitizeFileName(value)
            .replace(/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i, '');
        return `${sanitized}.${extension}`;
    }

    function getVideoTitle() {
        const title = document.querySelector([
            'h1.ytd-watch-metadata yt-formatted-string',
            'ytd-reel-video-renderer[is-active] h2',
            'ytmusic-player-bar .title',
        ].join(', '))?.textContent?.trim();
        if (title) return title;
        return document.title
            .replace(/\s+-\s+YouTube(?:\s+Music)?\s*$/i, '')
            .replace(/^YouTube\s+Music\s+-\s+/i, '')
            .trim();
    }

    function chooseAudioFormat() {
        if (typeof window.MediaRecorder !== 'function') return undefined;
        if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
            return MIME_CANDIDATES[0];
        }
        return MIME_CANDIDATES.find(({ mimeType }) => window.MediaRecorder.isTypeSupported(mimeType));
    }

    function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function waitForAudioTrack(audioTracks, media, operation) {
        const deadline = performance.now() + AUDIO_TRACK_READY_TIMEOUT;
        while (audioTracks.every((track) => track.muted === true)) {
            if (destroyed || operation !== startOperation) {
                throw new DOMException('Audio capture was cancelled', 'AbortError');
            }
            if (media.paused || media.ended || audioTracks.every((track) => track.readyState === 'ended')) {
                throw new Error('视频未在播放，请播放后重试');
            }
            if (performance.now() >= deadline) {
                throw new Error('音轨当前不可抓取，请确认视频有声音后重试');
            }
            await wait(50);
        }
        if (media.paused || media.ended || audioTracks.every((track) => track.readyState === 'ended')) {
            throw new Error('视频未在播放，请播放后重试');
        }
    }

    function isUsableVideo(video) {
        return video instanceof HTMLVideoElement && video.isConnected && !video.ended;
    }

    function isVisibleVideo(video) {
        if (!isUsableVideo(video)) return false;
        const style = window.getComputedStyle(video);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = video.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth;
    }

    function pickVideo(candidates) {
        return candidates.find((video) => !video.paused) ||
            candidates.find(isVisibleVideo) || candidates[0];
    }

    function findActiveVideo() {
        const visited = new Set();
        const preferred = [];
        for (const selector of VIDEO_SELECTORS) {
            for (const video of document.querySelectorAll(selector)) {
                if (visited.has(video)) continue;
                visited.add(video);
                if (isUsableVideo(video)) preferred.push(video);
            }
        }

        const preferredVideo = pickVideo(preferred);
        if (preferredVideo) return preferredVideo;

        const fallback = [];
        for (const video of document.querySelectorAll('video')) {
            if (visited.has(video)) continue;
            visited.add(video);
            if (isUsableVideo(video)) fallback.push(video);
        }
        return fallback.length === 1 ? fallback[0] : undefined;
    }

    function findRightControls(video) {
        if (window.location.hostname === 'music.youtube.com') {
            for (const selector of MUSIC_CONTROL_SELECTORS) {
                const controls = document.querySelector(selector);
                if (controls) return controls;
            }
        }

        const player = video?.closest('.html5-video-player, #movie_player');
        const localControls = player?.querySelector('.ytp-right-controls');
        if (localControls) return localControls;

        const youtubeControls = document.querySelector([
            'ytd-reel-video-renderer[is-active] .ytp-right-controls',
            '#movie_player .ytp-right-controls',
            '.html5-video-player .ytp-right-controls',
        ].join(', '));
        if (youtubeControls) return youtubeControls;

        for (const selector of MUSIC_CONTROL_SELECTORS) {
            const controls = document.querySelector(selector);
            if (controls) return controls;
        }
        return undefined;
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${BUTTON_ID} {
                align-items: center;
                appearance: none;
                background: transparent;
                border: 0;
                box-sizing: border-box;
                cursor: pointer;
                display: inline-flex;
                flex: 0 0 48px;
                justify-content: center;
                position: relative;
                width: 48px;
                min-width: 48px;
                height: 100%;
                padding: 0;
                color: #fff;
                vertical-align: top;
            }
            ytmusic-player-bar #${BUTTON_ID} {
                align-self: center;
                flex-basis: 40px;
                width: 40px;
                min-width: 40px;
                height: 40px;
            }
            #${BUTTON_ID} .yt-audio-capture-icon {
                position: absolute;
                left: 50%;
                top: 50%;
                width: 22px;
                height: 22px;
                transform: translate(-50%, -50%);
                fill: none;
                stroke: currentColor;
                stroke-width: 1.9;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            #${BUTTON_ID}[data-state='recording'] { color: #ff4e45; }
            #${BUTTON_ID}[data-state='recording']::after {
                content: '';
                position: absolute;
                right: 8px;
                top: 8px;
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: #ff4e45;
                box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.42);
            }
            #${BUTTON_ID}:disabled { cursor: wait; opacity: 0.62; }
            #${TOAST_ID} {
                position: fixed;
                left: 50%;
                bottom: max(24px, env(safe-area-inset-bottom));
                z-index: 2147483647;
                max-width: min(460px, calc(100vw - 32px));
                padding: 9px 13px;
                border-radius: 6px;
                color: #fff;
                background: rgba(32, 33, 36, 0.96);
                box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
                font: 500 13px/1.4 Roboto, Arial, sans-serif;
                overflow-wrap: anywhere;
                opacity: 0;
                pointer-events: none;
                transform: translate(-50%, 8px);
                transition: opacity 140ms ease, transform 140ms ease;
            }
            #${TOAST_ID}[data-visible='true'] {
                opacity: 1;
                transform: translate(-50%, 0);
            }
            #${TOAST_ID}[data-kind='error'] { background: rgba(181, 38, 38, 0.97); }
            @media (prefers-reduced-motion: reduce) {
                #${TOAST_ID} { transition: none; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function ensureToast() {
        if (toast?.isConnected) return;
        toast = document.getElementById(TOAST_ID) || document.createElement('div');
        toast.id = TOAST_ID;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        (document.body || document.documentElement).appendChild(toast);
    }

    function showToast(message, isError = false, duration = 2600) {
        ensureToast();
        window.clearTimeout(toastTimer);
        toast.textContent = message;
        toast.dataset.kind = isError ? 'error' : 'normal';
        toast.dataset.visible = 'true';
        toastTimer = window.setTimeout(() => {
            if (toast) toast.dataset.visible = 'false';
        }, duration);
    }

    function setButtonState(state) {
        if (!button) return;
        const labels = {
            idle: '抓取当前视频音频',
            preparing: '正在准备音频抓取',
            recording: '停止并保存音频',
            stopping: '正在停止并保存音频',
        };
        const label = labels[state] || labels.idle;
        button.dataset.state = state;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
        button.disabled = state === 'preparing' || state === 'stopping';
    }

    function handleButtonClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (activeSession) {
            void stopActiveSession('manual');
        } else if (!starting) {
            void startCapture();
        }
    }

    function ensureButton() {
        if (button) return button;
        button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'ytp-button';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('yt-audio-capture-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        for (const pathData of [
            'M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2',
            'M7 7.5v3m10-3v3M4 9v1m16-1v1',
        ]) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            svg.appendChild(path);
        }
        button.appendChild(svg);
        button.addEventListener('click', handleButtonClick);
        setButtonState('idle');
        return button;
    }

    function mountButton() {
        ensureStyle();
        ensureToast();
        const video = findActiveVideo();
        const controls = findRightControls(video);
        if (!video || !controls) {
            button?.remove();
            return;
        }

        const currentButton = ensureButton();
        document.querySelectorAll(`#${BUTTON_ID}`).forEach((candidate) => {
            if (candidate !== currentButton) candidate.remove();
        });
        if (currentButton.parentElement !== controls) controls.prepend(currentButton);
    }

    function scheduleRefresh() {
        if (destroyed || refreshFrame) return;
        refreshFrame = window.requestAnimationFrame(refresh);
    }

    function refresh() {
        refreshFrame = undefined;
        if (destroyed) return;

        if (window.location.href !== lastUrl) lastUrl = window.location.href;
        if (activeSession) {
            const currentVideo = findActiveVideo();
            if (!activeSession.media.isConnected || (currentVideo && currentVideo !== activeSession.media)) {
                void stopActiveSession('navigation');
            }
        }
        mountButton();
    }

    function canUseSavePicker() {
        return window.self === window.top && window.isSecureContext &&
            typeof window.showSaveFilePicker === 'function';
    }

    function openSavePicker(fileName, format) {
        if (!canUseSavePicker()) return undefined;
        const options = {
            suggestedName: fileName,
            excludeAcceptAllOption: true,
            types: [{
                description: 'Opus audio',
                accept: { [format.baseMime]: [`.${format.extension}`] },
            }],
        };
        try {
            return Promise.resolve(window.showSaveFilePicker(options))
                .then((handle) => ({ handle }), (error) => ({ error }));
        } catch (error) {
            return Promise.resolve({ error });
        }
    }

    async function abortWritable(writable) {
        if (!writable) return;
        try {
            if (typeof writable.abort === 'function') await writable.abort();
        } catch {
            // The browser may already have closed or discarded the temporary file.
        }
    }

    function stopStreamTracks(...streams) {
        const tracks = new Set();
        for (const stream of streams) {
            for (const track of stream?.getTracks?.() || []) tracks.add(track);
        }
        tracks.forEach((track) => {
            try {
                track.stop();
            } catch {
                // A track can already be ended when MediaRecorder stops itself.
            }
        });
    }

    function handleRecorderData(session, event) {
        const chunk = event.data;
        if (!chunk || !chunk.size) return;
        session.byteCount += chunk.size;

        if (!session.writable) {
            session.chunks.push(chunk);
            if (session.byteCount >= MEMORY_CAPTURE_LIMIT && !session.stopRequested) {
                if (!destroyed) showToast('已达到内存录制上限，正在保存');
                requestSessionStop(session, 'memory-limit');
            }
            return;
        }

        session.writeChain = session.writeChain
            .then(() => session.writable.write(chunk))
            .catch((error) => {
                session.writeError ||= error;
                requestSessionStop(session, 'write-error');
            });
    }

    function handleRecorderError(session, event) {
        session.recordError ||= event.error || new Error('浏览器音频录制失败');
        requestSessionStop(session, 'recorder-error');
    }

    function triggerBlobDownload(blob, fileName) {
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = fileName;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }

    function removeSessionListeners(session) {
        session.recorder.removeEventListener('dataavailable', session.onData);
        session.recorder.removeEventListener('error', session.onError);
        session.recorder.removeEventListener('stop', session.onStop);
        session.media.removeEventListener('ended', session.onEnded);
        session.media.removeEventListener('emptied', session.onEmptied);
        for (const track of session.audioTracks) {
            track.removeEventListener?.('ended', session.onTrackEnded);
        }
    }

    async function finalizeSession(session) {
        if (session.finalizePromise) return session.finalizePromise;
        window.clearTimeout(session.stopWatchdog);
        session.finalizePromise = (async () => {
            removeSessionListeners(session);

            let saved = false;
            try {
                await session.writeChain;
                if (session.recordError) throw session.recordError;
                if (session.writeError) throw session.writeError;
                if (!session.byteCount) throw new Error('没有捕获到音频数据');

                if (session.writable) {
                    await session.writable.close();
                    session.writableClosed = true;
                } else {
                    const blob = new Blob(session.chunks, { type: session.mimeType });
                    if (!blob.size) throw new Error('没有捕获到音频数据');
                    triggerBlobDownload(blob, session.fileName);
                }
                saved = true;
                if (!destroyed) {
                    const message = session.writable ? '音频已保存' : '已交给浏览器下载';
                    showToast(`${message}: ${session.fileName}`);
                }
            } catch (error) {
                await abortWritable(session.writableClosed ? undefined : session.writable);
                console.error('[YouTube 实时音频抓取器]', error);
                if (!destroyed) showToast(error?.message || '音频保存失败', true, 4200);
            } finally {
                stopStreamTracks(session.captureStream, session.audioStream);
                session.chunks.length = 0;
                if (activeSession === session) activeSession = undefined;
                if (!destroyed) {
                    setButtonState('idle');
                    scheduleRefresh();
                }
                session.resolveDone({ saved });
            }
        })();
        return session.finalizePromise;
    }

    async function startCapture() {
        if (destroyed || starting || activeSession) return;
        const media = findActiveVideo();
        if (!media) {
            showToast('未找到当前视频', true);
            return;
        }
        if (media.mediaKeys) {
            showToast('受保护内容无法抓取', true);
            return;
        }
        if (typeof media.captureStream !== 'function') {
            showToast('当前浏览器不支持实时音频抓取', true);
            return;
        }
        if (media.paused) {
            showToast('请先播放视频，再开始抓取音频', true);
            return;
        }

        const format = chooseAudioFormat();
        if (!format) {
            showToast('当前浏览器不支持 Opus 音频录制', true);
            return;
        }

        const operation = ++startOperation;
        const fileName = buildOutputFileName(getVideoTitle(), format.extension);
        const pickerPromise = openSavePicker(fileName, format);
        let captureStream;
        let audioStream;
        let writable;
        let outputName = fileName;
        starting = true;
        setButtonState('preparing');

        try {
            const pickerResult = await (pickerPromise || Promise.resolve(undefined));
            if (destroyed || operation !== startOperation) return;
            if (pickerResult?.error?.name === 'AbortError') {
                showToast('已取消音频抓取');
                return;
            }
            if (pickerResult?.handle) {
                outputName = sanitizeFileName(pickerResult.handle.name || fileName);
                if (!outputName.toLowerCase().endsWith(`.${format.extension}`)) {
                    throw new Error(`文件名必须使用 .${format.extension} 扩展名`);
                }
                try {
                    writable = await pickerResult.handle.createWritable();
                } catch (error) {
                    throw new Error(`无法写入所选文件: ${error?.message || '权限被拒绝'}`);
                }
            } else if (pickerResult?.error) {
                console.warn('[YouTube 实时音频抓取器] 文件选择器不可用，改用浏览器下载', pickerResult.error);
                showToast('文件选择器不可用，将改用浏览器下载');
            }

            if (destroyed || operation !== startOperation) {
                await abortWritable(writable);
                return;
            }
            if (media.paused || media.ended) throw new Error('视频未在播放，请播放后重试');

            captureStream = media.captureStream();
            const audioTracks = captureStream?.getAudioTracks?.() || [];
            if (!audioTracks.length) {
                throw new Error('尚未取得音轨，请先播放视频后重试');
            }
            await waitForAudioTrack(audioTracks, media, operation);
            if (!media.isConnected || findActiveVideo() !== media) {
                throw new Error('当前视频已经切换，请重新开始抓取');
            }
            audioStream = new MediaStream(audioTracks);
            const recorder = new MediaRecorder(audioStream, {
                mimeType: format.mimeType,
                audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
            });
            let resolveDone;
            const done = new Promise((resolve) => {
                resolveDone = resolve;
            });
            const session = {
                audioTracks,
                audioStream,
                byteCount: 0,
                captureStream,
                chunks: [],
                done,
                fileName: outputName,
                finalizePromise: undefined,
                media,
                mimeType: recorder.mimeType || format.mimeType,
                recorder,
                recordError: undefined,
                resolveDone,
                stopRequested: false,
                stopWatchdog: undefined,
                writable,
                writableClosed: false,
                writeChain: Promise.resolve(),
                writeError: undefined,
            };
            session.onData = (event) => handleRecorderData(session, event);
            session.onError = (event) => handleRecorderError(session, event);
            session.onStop = () => {
                window.clearTimeout(session.stopWatchdog);
                if (!destroyed) setButtonState('stopping');
                void finalizeSession(session);
            };
            session.onEnded = () => void stopActiveSession('ended');
            session.onEmptied = () => void stopActiveSession('source-change');
            session.onTrackEnded = () => requestSessionStop(session, 'track-ended');
            recorder.addEventListener('dataavailable', session.onData);
            recorder.addEventListener('error', session.onError);
            recorder.addEventListener('stop', session.onStop);
            media.addEventListener('ended', session.onEnded);
            media.addEventListener('emptied', session.onEmptied);
            for (const track of audioTracks) {
                track.addEventListener?.('ended', session.onTrackEnded, { once: true });
            }

            try {
                recorder.start(1000);
            } catch (error) {
                recorder.removeEventListener('dataavailable', session.onData);
                recorder.removeEventListener('error', session.onError);
                recorder.removeEventListener('stop', session.onStop);
                media.removeEventListener('ended', session.onEnded);
                media.removeEventListener('emptied', session.onEmptied);
                for (const track of audioTracks) {
                    track.removeEventListener?.('ended', session.onTrackEnded);
                }
                throw error;
            }
            activeSession = session;
            starting = false;
            setButtonState('recording');
            showToast('已开始实时抓取音频');
        } catch (error) {
            stopStreamTracks(captureStream, audioStream);
            await abortWritable(writable);
            if (operation === startOperation && !destroyed) {
                console.error('[YouTube 实时音频抓取器]', error);
                showToast(error?.message || '无法开始音频抓取', true, 4200);
            }
        } finally {
            if (operation === startOperation && !activeSession) {
                starting = false;
                if (!destroyed) setButtonState('idle');
            }
        }
    }

    async function stopActiveSession(reason) {
        startOperation += 1;
        starting = false;
        const session = activeSession;
        if (!session) {
            if (!destroyed) setButtonState('idle');
            return undefined;
        }

        return requestSessionStop(session, reason);
    }

    function requestSessionStop(session, reason) {
        session.stopReason ||= reason;
        if (session.stopRequested || session.finalizePromise) return session.done;
        session.stopRequested = true;
        if (!destroyed) setButtonState('stopping');
        session.stopWatchdog = window.setTimeout(() => {
            if (session.finalizePromise) return;
            session.recordError ||= new Error('浏览器没有完成音频录制停止操作');
            void finalizeSession(session);
        }, 5000);

        if (session.recorder.state !== 'inactive') {
            try {
                session.recorder.stop();
            } catch (error) {
                session.recordError ||= error;
                window.clearTimeout(session.stopWatchdog);
                void finalizeSession(session);
            }
        }
        return session.done;
    }

    function handleNavigationStart() {
        if (starting) {
            startOperation += 1;
            starting = false;
            setButtonState('idle');
        }
        scheduleRefresh();
    }

    function handleNavigationFinish() {
        lastUrl = window.location.href;
        scheduleRefresh();
    }

    function handlePageHide() {
        void stopActiveSession('pagehide');
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        startOperation += 1;
        window.clearTimeout(toastTimer);
        if (refreshFrame) window.cancelAnimationFrame(refreshFrame);
        mutationObserver?.disconnect();
        document.removeEventListener('yt-navigate-start', handleNavigationStart);
        document.removeEventListener('yt-navigate-finish', handleNavigationFinish);
        document.removeEventListener('ytmusic-navigate-finish', handleNavigationFinish);
        document.removeEventListener('yt-page-data-updated', scheduleRefresh);
        window.removeEventListener('popstate', handleNavigationStart);
        window.removeEventListener('pagehide', handlePageHide);
        button?.removeEventListener('click', handleButtonClick);
        button?.remove();
        toast?.remove();
        document.getElementById(STYLE_ID)?.remove();
        void stopActiveSession('destroy');
        if (window[INSTANCE_KEY] === instance) delete window[INSTANCE_KEY];
    }

    function initialize() {
        if (destroyed) return;
        ensureStyle();
        ensureToast();
        mutationObserver = new MutationObserver(scheduleRefresh);
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('yt-navigate-start', handleNavigationStart);
        document.addEventListener('yt-navigate-finish', handleNavigationFinish);
        document.addEventListener('ytmusic-navigate-finish', handleNavigationFinish);
        document.addEventListener('yt-page-data-updated', scheduleRefresh);
        window.addEventListener('popstate', handleNavigationStart);
        window.addEventListener('pagehide', handlePageHide);
        refresh();
        console.info(`[YouTube 实时音频抓取器] v${VERSION} 已加载`);
    }

    const instance = { version: VERSION, refresh: scheduleRefresh, destroy };
    Object.defineProperty(window, INSTANCE_KEY, {
        configurable: true,
        enumerable: false,
        value: instance,
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
