# YouTube 实时音频抓取器

`youtube-audio-capture.user.js` 使用浏览器的 `captureStream()` 和 `MediaRecorder`，实时录制当前 YouTube 视频正在播放的音轨。它不解析 YouTube 的签名算法，也不请求隐藏的音频下载地址。

## 安装

[点击安装 YouTube 实时音频抓取器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/youtube/youtube-audio-capture.user.js)

适用页面包括 YouTube 视频、Shorts、移动网页和 YouTube Music。推荐 Chrome + Tampermonkey；其他浏览器只有同时支持媒体流捕获和 Opus `MediaRecorder` 时才能工作。

## 使用

1. 打开 YouTube 视频并开始播放。
2. 点击播放器控制栏中的音频抓取图标。
3. Chrome 支持“另存为”时，先选择输出文件。
4. 保持视频播放；脚本从开始点击的时刻实时抓取声音。
5. 再次点击同一图标停止，等待文件写入完成。

当前媒体播放结束、媒体源被替换或播放器节点被替换时，脚本会停止并保存已捕获的数据。YouTube 的迷你播放器继续使用同一媒体元素时，站内导航不会中断抓取；关闭标签页前应手动停止并等待保存完成。

## 输出格式

脚本优先保存 `audio/webm;codecs=opus`，浏览器不支持时尝试 Ogg Opus。文件扩展名通常为 `.webm` 或 `.ogg`，不会伪装成 MP3。需要 MP3 时，应在保存后用可信的本地音频工具转换。

## 工作方式与限制

- 抓取按实际播放时间进行：录制十分钟内容需要播放十分钟。
- 只保存开始与停止之间由当前媒体元素输出的音频，不补抓开始前的片段。
- 支持文件流写入时，数据分段直接写入所选文件；不支持“另存为”接口时，脚本会在内存中累积数据后触发普通浏览器下载，因此只建议短时间录制。
- 普通浏览器下载回退达到约 256 MB 时会自动停止并保存，避免内存无限增长。
- 视频必须已经取得音轨。提示“尚未取得音轨”时，先播放视频，再点击抓取按钮。
- 加密或受 DRM 保护的媒体不会被绕过。
- 网站播放器结构可能变化；按钮消失时可刷新页面，并在 Issues 中提供页面类型和控制台错误。

## 隐私与合规

录制完全发生在当前浏览器标签页，脚本不上传音频或浏览记录。请只录制你拥有或获准保存的内容，并遵守 YouTube 条款、版权规则和当地法律。

## 开发验证

`tests/youtube-audio-capture.fixture.html` 使用模拟媒体流、`MediaRecorder` 和文件写入接口，验证 YouTube 与 YouTube Music 控件挂载、顺序写入、普通下载回退、播放器切换、重复注入和原生原型不被修改。仓库根目录运行 `npm test` 可在桌面与移动视口执行。
