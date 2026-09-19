# CanvDoAI Studio

CanvDoAI Studio 是一个 Windows 桌面端 AI 视频创作工作室，提供创作画布、一键成片、视频重制、素材管理、断点恢复、音轨审查、字幕合成与工程导出。

本仓库仅包含桌面客户端和通用 API 适配层，不包含任何生产 API Key、计费后台、企业授权服务或官方托管接口。CanvDoAI 名称和 Logo 不包含在源码许可证授权范围内。

## 功能

- 节点式创作画布与跨模块素材联动
- 剧本解析、角色场景定妆、分镜规划与分镜图
- 视频候选版本、作者采用/重做与断点续作
- 长视频拆镜、关键帧分析和按镜头重制
- FFmpeg/FFprobe 媒体处理、音轨审查、底部字幕与时间线合成
- 本地加密 API 配置、项目持久化和迁移包
- OpenAI-compatible 文本、图像、视觉和语音接口适配
- Dispatch/Seedance 风格的视频任务接口适配

## 开发

需要 Node.js 20+ 和 Windows 10/11 x64。

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

接口地址和 Key 必须由使用者在桌面端“API 接口设置”中填写。仓库中的 `example.com` 地址仅为占位符，不能直接生成内容。

## 使用文档

- [完整中文使用手册](docs/完整使用手册.md)：安装、首次配置、接口协议、画布、一键成片、视频重制、断点恢复、备份与故障处理
- [视觉模型自动检测](docs/视觉模型自动检测使用说明.md)：视觉模型读取、实测与错误解释
- [长视频视觉分析与断点恢复](docs/长视频视觉分析与断点恢复说明.md)：拆镜、抽帧、批次分析和恢复机制
- [内置工作流模板](docs/内置工作流模板-1.1.0.md)：各模板的节点、连线与适用场景
- [发布验收标准](docs/发布验收标准.md)：哪些能力已自动验证，哪些必须使用真实供应商接口验收

如果只想使用软件而不参与开发，请从 GitHub Releases 下载 Windows 安装包，安装后按照[“五分钟开始使用”](docs/完整使用手册.md#五分钟开始使用)完成 API 配置。安装包与源码必须使用相同版本号。

## FFmpeg

源码测试和打包需要在 `vendor/ffmpeg/` 放置 `ffmpeg.exe`、`ffprobe.exe` 及其许可证。仓库不分发这两个二进制文件，使用者需要自行选择符合其分发场景的 FFmpeg 构建并履行对应 LGPL/GPL 义务。

## 验证

当前自动化覆盖类型检查、状态机、画布拓扑、候选版本、断点恢复、防重复提交、媒体切镜、音轨、字幕、时间线合成及导出。真实供应商生成仍取决于使用者配置的模型、额度和接口兼容性。

## 许可证

源代码按 GNU Affero General Public License v3.0 or later 发布，详见 [LICENSE](LICENSE)。第三方组件许可见 `docs/third-party-notices/`。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中提交 API Key、客户素材或个人信息。
