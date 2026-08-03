# Telegram 下载脚本

本目录保存由 BreakZhu 维护、可直接安装的两份 Telegram 脚本及浏览器回归夹具。两份脚本覆盖不同页面，不应在 Telegram Web A 上同时运行。

## 选择脚本

| Telegram 地址 | 安装脚本 | 功能 |
| --- | --- | --- |
| `https://web.telegram.org/a/...` | [Web A 语音与音频下载器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-web-a-audio-downloader.user.js) | 语音、音频、消息视频、视频详情页 |
| 其他 `https://web.telegram.org/...` | [Telegram 受限媒体下载器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-media-downloader.user.js) | 消息图片、视频、媒体详情页 |

`telegram-media-downloader.user.js` 已通过 `@exclude` 排除 `/a/`。Web A 页面只启用 `telegram-web-a-audio-downloader.user.js`，并停用名称类似 `Telegram Media Downloader` 的其他下载脚本。

## 安装迁移说明

迁移后的命名空间为：

```text
https://github.com/BreakZhu/web-audio-download-scripts/telegram
```

迁移后的命名空间会被 Tampermonkey 识别为新的脚本身份。安装新版本后，请在 Tampermonkey 管理面板中停用或删除旧版本，再关闭全部 Telegram 标签页并重新打开。

## Web A 使用方法

1. 等 Telegram 页面和目标消息加载完成。
2. 打开语音、音频或视频；详情视频可在媒体查看器中操作。
3. 点击蓝色圆形下载图标。
4. Chrome 出现“另存为”时选择文件位置，并在保存完成前保持当前 Telegram 标签页打开。

脚本优先使用 Telegram 自带下载按钮；没有原生按钮时，会在当前 Web A 标签页通过 `/a/progressive/document...` 顺序读取文件分块并直接写入所选文件。HTTP 500、超时、分块不连续或用户取消时不会提示伪成功。

## 其他 Telegram Web 版本

消息媒体和详情页工具栏会出现下载图标。脚本跟踪活动详情媒体以及 `src`、`srcset`、`data-src`、`data-video`、`data-image` 的变化，并按服务器实际返回的 `Content-Range` 连续下载视频。

Tampermonkey 脚本菜单可设置消息内按钮位于媒体的右上、左上、右下或左下；刷新页面后生效。

## 常见问题

### 页面没有下载图标

- 确认 `/a/` 页面安装的是 Web A 专用脚本，其他页面安装通用脚本。
- 关闭重复的 Telegram 下载脚本，然后关闭全部 Telegram 标签页并重新进入。
- 等媒体画面或音频控件真正加载出来；详情视频可先播放一秒再重试。

### Chrome 显示“网站出现问题了”或下载返回 500

不要把 `/a/download/document...` 临时地址复制到新标签页。该地址依赖原 Telegram 页面中当前账号、消息文档元数据和 Service Worker 状态，只有文档编号不足以重新构造下载凭据。

在原消息中先确认媒体能够播放，再点击脚本按钮。仍失败时重新打开该消息，只保留一个 Web A 标签页并重试；如果 Telegram 自身也无法加载媒体，需要改用 Telegram Desktop 或等待服务恢复。

### 文件很大

支持 File System Access API 的 Chrome 会边下载边写入磁盘，内存占用不会随完整文件等量增长。页面关闭、账号切换或网络中断都会终止保存。

## 回归夹具

`tests/` 中的 HTML 页面覆盖详情页按钮、活动媒体切换、延迟元数据、Range 连续性、500/超时/取消和桌面/移动布局。仓库根目录运行 `npm test` 可统一执行。
