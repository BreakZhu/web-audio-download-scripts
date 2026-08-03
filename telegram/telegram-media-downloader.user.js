// ==UserScript==
// @name         Telegram 受限媒体下载器
// @namespace    https://github.com/BreakZhu/web-audio-download-scripts/telegram
// @version      1.6.2
// @description  下载 Telegram Web 消息及媒体详情页中的受限图片和视频
// @author       BreakZhu
// @match        https://web.telegram.org/*
// @match        https://*.web.telegram.org/*
// @exclude      https://web.telegram.org/a/*
// @exclude      https://*.web.telegram.org/a/*
// @icon         https://telegram.org/favicon.ico
// @homepageURL  https://github.com/BreakZhu/web-audio-download-scripts/tree/main/telegram
// @supportURL   https://github.com/BreakZhu/web-audio-download-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-media-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-media-downloader.user.js
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // Telegram Web A uses body#root as its managed application tree. Its media
    // support lives in the isolated Web A downloader and must not be mixed with
    // this legacy DOM-injection implementation.
    if (/^\/a(?:\/|$)/.test(window.location.pathname)) return;

    // 配置
    const CONFIG = {
        downloadPath: GM_getValue('downloadPath', 'Telegram'),
        notifyOnDownload: GM_getValue('notifyOnDownload', true),
        buttonPosition: GM_getValue('buttonPosition', 'top-right'), // top-right, top-left, bottom-right, bottom-left
    };

    // 保存配置
    function saveConfig() {
        GM_setValue('downloadPath', CONFIG.downloadPath);
        GM_setValue('notifyOnDownload', CONFIG.notifyOnDownload);
        GM_setValue('buttonPosition', CONFIG.buttonPosition);
    }

    // Content-Range 正则
    const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;
    const VIEWER_ROOT_SELECTOR = [
        '#MediaViewer',
        '.media-viewer-whole',
        '.media-viewer',
        '[class~="MediaViewer"]',
    ].join(', ');
    const VIEWER_TOOLBAR_SELECTOR = [
        '.MediaViewerActions',
        '.media-viewer-topbar .media-viewer-buttons',
        '.media-viewer-buttons',
        '[class*="MediaViewerActions"]',
    ].join(', ');
    const VIEWER_MEDIA_SELECTORS = [
        '.MediaViewerSlide--active video',
        '.MediaViewerSlide--active img',
        '.media-viewer-aspecter video',
        '.media-viewer-aspecter img.thumbnail',
        '.ckin__player video',
        '.MediaViewerContent video',
        '.MediaViewerContent img',
    ];
    const processedMedia = new WeakMap();
    const mediaByButton = new WeakMap();
    let mediaObserver;
    let scanFrame;

    // 正在下载的视频集合（防止重复下载）
    const downloadingVideos = new Set();

    // Hash函数
    const hashCode = (s) => {
        var h = 0, l = s.length, i = 0;
        if (l > 0) {
            while (i < l) {
                h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
            }
        }
        return h >>> 0;
    };

    // 通知
    function notify(title, message) {
        if (!CONFIG.notifyOnDownload) return;
        GM_notification({
            title: title,
            text: message,
            timeout: 2000
        });
    }

    // 创建进度条
    function createProgressBar(videoId, fileName) {
        const isDarkMode = document.querySelector('html').classList.contains('night') ||
                          document.querySelector('html').classList.contains('theme-dark');
        const container = document.getElementById('tg-progress-container');
        document.getElementById('tg-progress-' + videoId)?.remove();

        const item = document.createElement('div');
        item.id = 'tg-progress-' + videoId;
        item.style.cssText = `width:20rem;margin-top:0.4rem;padding:0.6rem;background-color:${isDarkMode ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.6)'};border-radius:8px;`;

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:8px;';

        const title = document.createElement('p');
        title.className = 'filename';
        title.style.cssText = 'margin:0;color:white;font-size:13px;max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        title.innerText = fileName;

        const closeBtn = document.createElement('div');
        closeBtn.className = 'tg-progress-close';
        closeBtn.style.cssText = `cursor:pointer;font-size:1.2rem;color:${isDarkMode ? '#8a8a8a' : 'white'};`;
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => container.removeChild(item);

        const progressBar = document.createElement('div');
        progressBar.className = 'tg-progress-track';
        progressBar.style.cssText = 'background-color:#e2e2e2;position:relative;width:100%;height:1.6rem;border-radius:2rem;overflow:hidden;';

        const counter = document.createElement('p');
        counter.className = 'tg-progress-counter';
        counter.style.cssText = 'position:absolute;z-index:5;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;color:black;font-size:12px;font-weight:bold;';
        counter.innerText = '0%';

        const progress = document.createElement('div');
        progress.className = 'tg-progress-fill';
        progress.style.cssText = 'position:absolute;height:100%;width:0%;background-color:#6093B5;transition:width 0.3s ease;';

        progressBar.appendChild(counter);
        progressBar.appendChild(progress);
        header.appendChild(title);
        header.appendChild(closeBtn);
        item.appendChild(header);
        item.appendChild(progressBar);
        container.appendChild(item);
    }

    // 更新进度
    function updateProgress(videoId, fileName, percent) {
        const item = document.getElementById('tg-progress-' + videoId);
        if (!item) return;
        item.querySelector('p.filename').innerText = fileName;
        const bar = item.querySelector('.tg-progress-fill');
        const text = item.querySelector('.tg-progress-counter');
        text.innerText = percent + '%';
        bar.style.width = percent + '%';
    }

    // 完成进度
    function completeProgress(videoId) {
        const item = document.getElementById('tg-progress-' + videoId);
        if (!item) return;
        const bar = item.querySelector('.tg-progress-fill');
        const text = item.querySelector('.tg-progress-counter');
        text.innerText = '完成';
        bar.style.backgroundColor = '#B6C649';
        bar.style.width = '100%';
    }

    // 中止进度
    function abortProgress(videoId) {
        const item = document.getElementById('tg-progress-' + videoId);
        if (!item) return;
        const bar = item.querySelector('.tg-progress-fill');
        const text = item.querySelector('.tg-progress-counter');
        text.innerText = '失败';
        bar.style.backgroundColor = '#D16666';
        bar.style.width = '100%';
    }

    // 分块下载视频（优化版：并发下载提速）
    async function downloadVideo(url) {
        // 使用URL的hash作为唯一ID
        const videoId = hashCode(url).toString(36);

        // 检查是否已经在下载中（使用Set防止重复）
        if (downloadingVideos.has(videoId)) {
            console.log('[下载] 该视频已在下载中，跳过');
            return;
        }

        // 添加到下载中集合
        downloadingVideos.add(videoId);

        let fileExtension = 'mp4';
        let fileName = videoId + '.' + fileExtension;

        // 提取文件名
        try {
            const metadata = JSON.parse(decodeURIComponent(url.split('/')[url.split('/').length - 1]));
            if (metadata.fileName) fileName = metadata.fileName;
            if (metadata.mimeType) fileExtension = metadata.mimeType.split('/')[1];
        } catch (e) {}

        createProgressBar(videoId, fileName);

        try {
            // 发送第一个Range请求获取文件信息（避免HEAD请求失败）
            console.log('[下载] 开始下载...');
            const firstRes = await fetch(url, {
                method: 'GET',
                headers: { 'Range': 'bytes=0-1' },
                credentials: 'include'
            });

            if (![200, 206].includes(firstRes.status)) {
                throw new Error(`HTTP ${firstRes.status}`);
            }

            // 获取MIME类型
            const mime = firstRes.headers.get('Content-Type')?.split(';')[0];
            if (mime && mime.startsWith('video/')) {
                fileExtension = mime.split('/')[1];
                if (!fileName.includes('.')) {
                    fileName = videoId + '.' + fileExtension;
                }
            }

            // 检查是否支持Range请求
            const contentRange = firstRes.headers.get('Content-Range');

            // 返回200时首个响应已经是完整文件，不再重复请求。
            if (firstRes.status === 200) {
                console.log('[下载] 已取得完整文件响应');
                const blob = await firstRes.blob();

                completeProgress(videoId);

                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = fileName;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 100);

                notify('下载完成', fileName);
                downloadingVideos.delete(videoId);
                return;
            }

            // 不支持Range时改用普通请求。
            if (!contentRange) {
                await firstRes.body?.cancel().catch(() => undefined);
                console.log('[下载] 服务器不支持Range，使用直接下载模式');
                const res = await fetch(url, { credentials: 'include' });
                if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();

                completeProgress(videoId);

                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = fileName;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 100);

                notify('下载完成', fileName);
                downloadingVideos.delete(videoId);
                return;
            }

            // 解析Content-Range获取总大小
            const rangeMatch = contentRange.match(contentRangeRegex);
            if (!rangeMatch) {
                throw new Error('无法解析Content-Range');
            }

            const totalSize = parseInt(rangeMatch[3]);
            console.log(`[下载] 文件大小: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
            await firstRes.body?.cancel().catch(() => undefined);

            // 按服务端实际返回的 Content-Range 顺序续传。
            // Telegram 可能缩小请求范围，不能假定每次都返回完整的2MB。
            console.log('[下载] 使用连续分块下载');
            const chunkSize = 2 * 1024 * 1024;
            const chunks = [];
            let downloadedSize = 0;
            let chunkIndex = 0;

            while (downloadedSize < totalSize) {
                const requestedEnd = Math.min(downloadedSize + chunkSize - 1, totalSize - 1);
                const res = await fetch(url, {
                    method: 'GET',
                    headers: { 'Range': `bytes=${downloadedSize}-${requestedEnd}` },
                    credentials: 'include'
                });

                if (res.status !== 206) {
                    await res.body?.cancel().catch(() => undefined);
                    throw new Error(`分块${chunkIndex}下载失败: HTTP ${res.status}`);
                }

                const responseRange = res.headers.get('Content-Range')?.match(contentRangeRegex);
                if (!responseRange) {
                    await res.body?.cancel().catch(() => undefined);
                    throw new Error(`分块${chunkIndex}缺少有效的Content-Range`);
                }

                const responseStart = Number(responseRange[1]);
                const responseEnd = Number(responseRange[2]);
                const responseTotal = Number(responseRange[3]);
                if (responseStart !== downloadedSize || responseEnd < responseStart || responseTotal !== totalSize) {
                    await res.body?.cancel().catch(() => undefined);
                    throw new Error(`分块${chunkIndex}范围不连续`);
                }

                const part = await res.blob();
                const expectedSize = responseEnd - responseStart + 1;
                if (part.size !== expectedSize) {
                    throw new Error(`分块${chunkIndex}大小不完整`);
                }

                chunks.push(part);
                downloadedSize = responseEnd + 1;
                chunkIndex += 1;

                const percent = Math.round((downloadedSize * 100) / totalSize);
                updateProgress(videoId, fileName, percent);
                console.log(`[下载] 分块 ${chunkIndex} 完成 (${percent}%)`);
            }

            // 合并所有分块
            console.log('[下载] 合并分块中...');
            const blob = new Blob(chunks, { type: `video/${fileExtension}` });
            console.log(`[下载] 合并完成，总大小: ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

            if (blob.size !== totalSize) throw new Error('合并后的文件大小不完整');

            const blobUrl = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            setTimeout(() => URL.revokeObjectURL(blobUrl), 100);

            completeProgress(videoId);
            notify('下载完成', fileName);
        } catch (error) {
            console.error('[下载错误]', error);
            abortProgress(videoId);
            notify('下载失败', error.message);
        } finally {
            // 从下载中集合移除
            downloadingVideos.delete(videoId);
        }
    }

    // Canvas捕获图片
    async function captureImage(imgElement) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = imgElement.naturalWidth || imgElement.width;
                canvas.height = imgElement.naturalHeight || imgElement.height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(imgElement, 0, 0);

                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(URL.createObjectURL(blob));
                    } else {
                        reject(new Error('Canvas转换失败'));
                    }
                }, 'image/png', 1.0);
            } catch (error) {
                reject(error);
            }
        });
    }

    // 备用下载
    async function fallbackDownload(url, filename, mediaType, sourceElement) {
        try {
            let blobUrl;

            // 视频 - 使用分块下载
            if (mediaType === 'video') {
                await downloadVideo(url);
                return;
            }

            // 图片 - 使用Canvas
            if (mediaType === 'image' && sourceElement && sourceElement.tagName === 'IMG') {
                if (!sourceElement.complete) {
                    await new Promise((resolve, reject) => {
                        sourceElement.onload = resolve;
                        sourceElement.onerror = () => reject(new Error('图片加载失败'));
                        setTimeout(() => reject(new Error('超时')), 10000);
                    });
                }
                blobUrl = await captureImage(sourceElement);
            }
            // Blob URL
            else if (url.startsWith('blob:') || url.startsWith('data:')) {
                blobUrl = url;
            }
            // 普通下载
            else {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                blobUrl = URL.createObjectURL(blob);
            }

            // 下载
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            setTimeout(() => {
                if (!url.startsWith('data:') && !url.startsWith('blob:')) {
                    URL.revokeObjectURL(blobUrl);
                }
            }, 100);

            notify('下载完成', filename);
        } catch (error) {
            console.error('[下载错误]', error);
            throw error;
        }
    }

    // 下载媒体
    async function downloadMedia(url, mediaType, sourceElement = null) {
        const timestamp = Date.now();
        const ext = mediaType === 'video' ? 'mp4' : 'jpg';
        const baseFilename = `telegram_${mediaType}_${timestamp}.${ext}`;

        try {
            await fallbackDownload(url, baseFilename, mediaType, sourceElement);
        } catch (error) {
            notify('下载失败', error.message);
        }
    }

    // 获取最佳质量URL
    function getBestQualityUrl(element, mediaType) {
        if (mediaType === 'video') {
            if (element.getAttribute('src')) return element.src;
            const sources = Array.from(element.querySelectorAll('source[src]'))
                .filter((source) => source.getAttribute('src'));
            if (sources.length) {
                const selected = sources.find((source) => source.src === element.currentSrc);
                return (selected || sources[0]).src;
            }
            return element.getAttribute('data-src') || element.getAttribute('data-video');
        } else {
            const srcset = element.srcset;
            if (srcset) {
                const sources = srcset.split(',').map(s => s.trim().split(' '));
                const sorted = sources.sort((a, b) => {
                    const sizeA = parseInt(a[1]) || 0;
                    const sizeB = parseInt(b[1]) || 0;
                    return sizeB - sizeA;
                });
                if (sorted.length > 0) return sorted[0][0];
            }

            if (element.src) return element.src;
            return element.getAttribute('data-src') || element.getAttribute('data-image');
        }
    }

    // 检测聊天列表
    function isInChatListOrSidebar(element) {
        return element.closest('.chat-list') ||
               element.closest('.chatlist') ||
               element.closest('[class*="ChatList"]') ||
               element.closest('[class*="DialogList"]') ||
               element.closest('.sidebar') ||
               element.closest('[class*="Sidebar"]');
    }

    function getViewerRoot(element) {
        return element.closest(VIEWER_ROOT_SELECTOR);
    }

    function findActiveViewerMedia(viewer) {
        for (const selector of VIEWER_MEDIA_SELECTORS) {
            const media = viewer.querySelector(selector);
            if (!(media instanceof HTMLVideoElement || media instanceof HTMLImageElement)) continue;
            if (media.closest('[hidden], [aria-hidden="true"]')) continue;
            return media;
        }
        return undefined;
    }

    function clearViewerButton(viewer) {
        const button = viewer.querySelector('.tg-download-btn--viewer');
        if (!(button instanceof HTMLButtonElement)) return;
        mediaByButton.delete(button);
        button.remove();
    }

    // 检测真实媒体内容
    function isActualMediaContent(element) {
        return Boolean(
            getViewerRoot(element) ||
            element.closest('.message-media, [class*="MessageMedia"], .bubble .media-container')
        );
    }

    function updateDownloadButton(button, mediaElement, mediaUrl, mediaType) {
        const label = mediaType === 'video' ? '下载视频' : '下载图片';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.dataset.mediaType = mediaType;
        button.dataset.mediaUrl = mediaUrl;
        mediaByButton.set(button, { mediaElement, mediaUrl, mediaType });
    }

    // 创建下载按钮
    function createDownloadButton(mediaElement, mediaUrl, mediaType, isViewer = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tg-download-btn${isViewer ? ' tg-download-btn--viewer' : ''}`;
        button.innerHTML = `
            <svg class="tg-download-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
        `;
        button.dataset.position = CONFIG.buttonPosition;
        updateDownloadButton(button, mediaElement, mediaUrl, mediaType);

        button.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            const media = mediaByButton.get(button);
            if (!media) return;
            const viewer = button.closest(VIEWER_ROOT_SELECTOR);
            const latestUrl = getBestQualityUrl(media.mediaElement, media.mediaType);
            if ((viewer && findActiveViewerMedia(viewer) !== media.mediaElement) || !latestUrl) {
                notify('下载失败', '当前媒体尚未加载完成');
                scheduleMediaScan();
                return;
            }
            if (latestUrl !== media.mediaUrl) {
                updateDownloadButton(button, media.mediaElement, latestUrl, media.mediaType);
            }
            await downloadMedia(latestUrl, media.mediaType, media.mediaElement);
        });

        return button;
    }

    function mountViewerButton(viewer, button) {
        const toolbar = viewer.querySelector(VIEWER_TOOLBAR_SELECTOR);
        if (toolbar) {
            if (button.classList.contains('tg-download-btn--floating')) {
                button.classList.remove('tg-download-btn--floating');
            }
            if (button.parentElement !== toolbar) toolbar.prepend(button);
            return;
        }

        if (!button.classList.contains('tg-download-btn--floating')) {
            button.classList.add('tg-download-btn--floating');
        }
        if (button.parentElement !== viewer) viewer.appendChild(button);
    }

    // 处理媒体元素
    function processMediaElement(element, mediaType) {
        const viewer = getViewerRoot(element);
        if (!viewer && isInChatListOrSidebar(element)) return;
        if (!isActualMediaContent(element)) return;
        if (viewer && findActiveViewerMedia(viewer) !== element) return;

        const url = getBestQualityUrl(element, mediaType);
        if (!url) {
            if (viewer) clearViewerButton(viewer);
            return;
        }

        if (viewer) {
            let button = viewer.querySelector('.tg-download-btn--viewer');
            if (!(button instanceof HTMLButtonElement)) {
                button = createDownloadButton(element, url, mediaType, true);
            } else {
                updateDownloadButton(button, element, url, mediaType);
            }
            mountViewerButton(viewer, button);
            processedMedia.set(element, { url, button });
            return;
        }

        let container = element.closest(
            '.media-viewer-content, .message-media, [class*="MessageMedia"], .bubble .media-container'
        ) || element.parentElement;
        if (!container) return;

        const previous = processedMedia.get(element);
        if (previous?.url === url && previous.button?.isConnected) return;

        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        let button = container.querySelector(':scope > .tg-download-btn:not(.tg-download-btn--viewer)');
        if (!(button instanceof HTMLButtonElement)) {
            button = createDownloadButton(element, url, mediaType);
        } else {
            updateDownloadButton(button, element, url, mediaType);
        }
        container.appendChild(button);
        processedMedia.set(element, { url, button });
    }

    function scanMedia() {
        scanFrame = undefined;

        document.querySelectorAll(VIEWER_ROOT_SELECTOR).forEach((viewer) => {
            const media = findActiveViewerMedia(viewer);
            if (media instanceof HTMLVideoElement) processMediaElement(media, 'video');
            if (media instanceof HTMLImageElement) processMediaElement(media, 'image');
            if (!media) clearViewerButton(viewer);
        });

        document.querySelectorAll('video, img').forEach((media) => {
            if (getViewerRoot(media)) return;
            processMediaElement(media, media instanceof HTMLVideoElement ? 'video' : 'image');
        });
    }

    function scheduleMediaScan() {
        if (scanFrame) return;
        scanFrame = window.requestAnimationFrame(scanMedia);
    }

    // 观察器
    function startObserving() {
        mediaObserver = new MutationObserver(scheduleMediaScan);
        mediaObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset', 'data-src', 'data-video', 'data-image', 'class'],
        });
        document.addEventListener('loadedmetadata', scheduleMediaScan, true);
        document.addEventListener('load', scheduleMediaScan, true);
        document.addEventListener('click', () => window.setTimeout(scheduleMediaScan, 0), true);
        window.addEventListener('hashchange', scheduleMediaScan);
        scheduleMediaScan();
    }

    // CSS样式
    function addStyles() {
        if (document.getElementById('tg-downloader-styles')) return;
        const style = document.createElement('style');
        style.id = 'tg-downloader-styles';
        style.textContent = `
            .tg-download-btn {
                appearance: none;
                position: absolute;
                top: 10px;
                right: 10px;
                width: 36px;
                height: 36px;
                padding: 0;
                border: 0;
                border-radius: 50%;
                display: grid;
                place-items: center;
                color: #ffffff;
                background: rgba(51, 144, 236, 0.94);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
                cursor: pointer;
                z-index: 1000;
                transition: background-color 120ms ease, transform 120ms ease;
            }
            .tg-download-btn:hover {
                background: #2481cc;
                transform: translateY(-1px);
            }
            .tg-download-btn:focus-visible {
                outline: 2px solid #ffffff;
                outline-offset: 2px;
            }
            .tg-download-btn[data-position='top-left'] { right: auto; left: 10px; }
            .tg-download-btn[data-position='bottom-right'] { top: auto; bottom: 10px; }
            .tg-download-btn[data-position='bottom-left'] {
                top: auto;
                right: auto;
                bottom: 10px;
                left: 10px;
            }
            .tg-download-btn--viewer {
                position: relative;
                inset: auto;
                flex: 0 0 36px;
                margin-inline: 4px 0;
                color: rgba(255, 255, 255, 0.92);
                background: rgba(0, 0, 0, 0.24);
                box-shadow: none;
                z-index: 2;
            }
            .tg-download-btn--viewer.tg-download-btn--floating {
                position: fixed;
                top: max(12px, env(safe-area-inset-top));
                right: max(64px, calc(env(safe-area-inset-right) + 64px));
                margin: 0;
                background: rgba(51, 144, 236, 0.94);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
                z-index: 2147483000;
            }
            .tg-download-btn-icon { width: 18px; height: 18px; fill: currentColor; }
            @media (prefers-reduced-motion: reduce) {
                .tg-download-btn { transition: none; }
            }
        `;
        document.head.appendChild(style);
    }

    // 进度条容器
    function setupProgressContainer() {
        if (document.getElementById('tg-progress-container')) return;
        const container = document.createElement('div');
        container.id = 'tg-progress-container';
        container.style.cssText = 'position:fixed;bottom:0;right:0;z-index:9999;';
        document.body.appendChild(container);
    }

    // 注册菜单命令
    function registerMenuCommands() {
        GM_registerMenuCommand('📍 按钮位置: 右上角', () => {
            CONFIG.buttonPosition = 'top-right';
            saveConfig();
            alert('✅ 按钮位置已设置为：右上角\n\n刷新页面后生效');
        });

        GM_registerMenuCommand('📍 按钮位置: 左上角', () => {
            CONFIG.buttonPosition = 'top-left';
            saveConfig();
            alert('✅ 按钮位置已设置为：左上角\n\n刷新页面后生效');
        });

        GM_registerMenuCommand('📍 按钮位置: 右下角', () => {
            CONFIG.buttonPosition = 'bottom-right';
            saveConfig();
            alert('✅ 按钮位置已设置为：右下角\n\n刷新页面后生效');
        });

        GM_registerMenuCommand('📍 按钮位置: 左下角', () => {
            CONFIG.buttonPosition = 'bottom-left';
            saveConfig();
            alert('✅ 按钮位置已设置为：左下角\n\n刷新页面后生效');
        });
    }

    // 初始化
    function init() {
        addStyles();
        setupProgressContainer();
        startObserving();
        registerMenuCommands();
        console.log('[Telegram下载器] v1.6.2 已加载');
        console.log('[配置] 按钮位置:', CONFIG.buttonPosition);
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
