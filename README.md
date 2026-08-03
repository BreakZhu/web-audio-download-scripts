# Web Audio Download Scripts

用于 Chrome + Tampermonkey 的媒体保存脚本集合。当前包含 Telegram Web 媒体下载和 YouTube 当前播放音频的实时抓取功能。

## 脚本

| 目录 | 脚本 | 当前版本 | 用途 |
| --- | --- | --- | --- |
| `telegram/` | `telegram-web-a-audio-downloader.user.js` | 1.5.1 | Telegram Web A 的语音、音频、消息视频和视频详情页 |
| `telegram/` | `telegram-media-downloader.user.js` | 1.6.2 | 除 Web A 外的 Telegram Web 图片、视频和媒体详情页 |
| `youtube/` | `youtube-audio-capture.user.js` | 1.0.0 | 实时录制当前 YouTube 播放音轨并保存为 Opus 音频 |

Telegram 的安装、适用页面和故障排查见 [telegram/README.md](./telegram/README.md)，YouTube 的使用方式和限制见 [youtube/README.md](./youtube/README.md)。

## 直接安装

先安装 Tampermonkey，再按页面类型只安装需要的脚本：

- [安装 Telegram Web A 下载器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-web-a-audio-downloader.user.js)
- [安装其他 Telegram Web 版本下载器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/telegram/telegram-media-downloader.user.js)
- [安装 YouTube 实时音频抓取器](https://raw.githubusercontent.com/BreakZhu/web-audio-download-scripts/main/youtube/youtube-audio-capture.user.js)

从旧 Telegram 项目迁移后，脚本的 `@namespace` 已改为本仓库地址。Tampermonkey 会把它识别为新的脚本身份；安装新版本前应停用或删除旧命名空间版本，避免同一页面重复运行。

## 项目结构

```text
web-audio-download-scripts/
├── telegram/
│   ├── telegram-media-downloader.user.js
│   ├── telegram-web-a-audio-downloader.user.js
│   └── tests/
├── youtube/
│   ├── youtube-audio-capture.user.js
│   └── tests/
├── scripts/
│   ├── check-userscripts.mjs
│   └── run-fixtures.mjs
├── LICENSE
└── package.json
```

## 开发与验证

项目没有运行时依赖。测试工具需要 Node.js 22 或更高版本，以及本机 Chrome/Chromium：

```bash
npm run check
npm test
```

`npm run check` 检查所有用户脚本的 JavaScript 语法、元数据和新命名空间。`npm test` 还会启动临时本地服务器和无头浏览器，在桌面与移动视口运行三个页面夹具。找不到 Chrome 时可设置 `CHROME_BIN`。

## 使用边界

脚本只在浏览器本地运行，不上传媒体或使用记录。请只保存你拥有、获准保存或当地法律允许保存的内容，并遵守对应网站的服务条款。YouTube 脚本不会解密 DRM 内容，也不提供签名解析或服务端媒体地址绕过。

## License

[MIT](./LICENSE)

