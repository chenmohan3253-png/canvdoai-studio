# CanvDoAI Studio

CanvDoAI Studio 是一个 Windows 桌面端 AI 视频创作工作室，提供创作画布、一键成片、视频重制、素材管理、断点恢复、音轨审查、字幕合成与工程导出。

本仓库仅包含桌面客户端和通用 API 适配层，不包含任何生产 API Key、计费后台、企业授权服务或官方托管接口。CanvDoAI 名称和 Logo 不包含在源码许可证授权范围内。

## Windows 安装包直接下载

- [下载 CanvDoAI Studio 1.1.6 安装包](https://github.com/chenmohan3253-png/canvdoai-studio/releases/download/v1.1.6/CanvDoAI-Studio-1.1.6-Setup.exe)
- [下载 SHA-256 校验文件](https://github.com/chenmohan3253-png/canvdoai-studio/releases/download/v1.1.6/CanvDoAI-Studio-1.1.6-SHA256.txt)
- [查看完整发布说明](https://github.com/chenmohan3253-png/canvdoai-studio/releases/tag/v1.1.6)

安装包适用于 Windows 10/11 x64，已经内置 FFmpeg/FFprobe，不需要另外安装 Node.js、Python或本地大模型。当前安装包尚未进行企业代码签名，Windows SmartScreen 可能显示“未知发布者”；请确认下载来源为本仓库并核对 SHA-256：`B5D5B176BF0E32E1BF5135BC773B29C4E47D8712BBF3F88829747CA39B6021BF`。软件安装后可直接打开，但AI生成需要在“API 接口设置”中填写有效接口和密钥。

## 功能

- 节点式创作画布与跨模块素材联动
- 剧本解析、角色场景定妆、分镜规划与分镜图
- 视频候选版本、作者采用/重做与断点续作
- 长视频拆镜、关键帧分析和按镜头重制
- FFmpeg/FFprobe 媒体处理、音轨审查、底部字幕与时间线合成
- 本地加密 API 配置、项目持久化和迁移包
- OpenAI-compatible 文本、图像、视觉和语音接口适配
- Dispatch/Seedance 风格的视频任务接口适配
- 内置客户可查看的“API 报价”模块
- 内置“购买 API / 联系我们”页面、官方微信二维码和接口设置购买入口

## 下载后如何使用

1. 安装 Windows 版 CanvDoAI Studio。普通安装包用户不需要安装 Node.js、Python、本地大模型或独立显卡环境。
2. 打开左侧“API 接口设置”，依次配置剧本/文本、图片/分镜、视频生成；需要原片分析时再配置视觉模型，需要台词核验时配置语音转写。
3. 每项配置先“保存”，再点击对应的测试按钮读取模型。测试成功只代表接口目录可访问，第一次生成建议用 1～2 个镜头、低分辨率进行小额验收。
4. “AI 一键成片”用于从剧本推进到分镜和成片；“创作画布”用于节点式组合；“视频重制”用于导入原片、拆镜、分析和逐镜头重做。
5. 左侧“API 报价”可以查看当前视频模型参考价；“购买 API / 联系我们”可以放大或保存官方微信二维码。

更完整的操作、断点恢复和错误处理见[完整中文使用手册](docs/完整使用手册.md)。

## 视频模型 API 对外报价

视频生成按照实际成片秒数计费，100 元对应 10000 积分。下表不含视频输入费用；模型、清晰度、声音能力与最终结算以当前接口返回及客服确认为准。

| 视频模型 | 分辨率/质量 | 码率 | 对外价格（元/秒） | 对外积分（积分/秒） |
| --- | --- | --- | ---: | ---: |
| Seedance 2.0 | 480p 标清 | High | 0.352 | 35.2 |
| Seedance 2.0 | 720p 高清 | High | 0.539 | 53.9 |
| Seedance 2.0 | 1080p 全高清 | High | 1.298 | 129.8 |
| Seedance 2.0 | 4K 超高清 | High | 2.662 | 266.2 |
| Seedance 2.0 Fast | 480p 标清 | High | 0.198 | 19.8 |
| Seedance 2.0 Fast | 720p 高清 | High | 0.418 | 41.8 |
| Seedance 2.0 Mini | 480p 标清 | — | 0.132 | 13.2 |
| Seedance 2.0 Mini | 720p 高清 | — | 0.297 | 29.7 |
| Seedance 2.5 | 480p 标清 | High | 0.352 | 35.2 |
| Seedance 2.5 | 720p 高清 | High | 0.792 | 79.2 |
| Seedance 2.5 | 1080p 全高清 | High | 1.969 | 196.9 |

[下载 Excel 版对外报价表](docs/CanvDoAI-API对外客户报价表.xlsx)

## 扫码联系客服

购买或测试剧本、图片、分镜、视频、视觉分析和语音 API，可使用微信扫描下方二维码，或发送邮件至 **chenmomo3253@gmail.com**。添加时建议备注“API购买”或“工作室部署”。请勿通过公开 Issue 提交 API Key、账号密码或客户素材。

<img src="src/assets/canvdoai-wechat-contact.png" alt="CanvDoAI 官方微信二维码" width="360" />

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
- [视频重制本地化部署](docs/视频重制本地化部署.md)：安装包用户是否需要插件、源码构建所需 FFmpeg/FFprobe、可选 PySceneDetect 和验证方法
- [视觉模型自动检测](docs/视觉模型自动检测使用说明.md)：视觉模型读取、实测与错误解释
- [长视频视觉分析与断点恢复](docs/长视频视觉分析与断点恢复说明.md)：拆镜、抽帧、批次分析和恢复机制
- [内置工作流模板](docs/内置工作流模板-1.1.0.md)：各模板的节点、连线与适用场景
- [发布验收标准](docs/发布验收标准.md)：哪些能力已自动验证，哪些必须使用真实供应商接口验收

如果只想使用软件而不参与开发，请从 GitHub Releases 下载 Windows 安装包，安装后按照[“五分钟开始使用”](docs/完整使用手册.md#五分钟开始使用)完成 API 配置。安装包与源码必须使用相同版本号。

## 视频重制需要下载什么插件

- **直接安装正式安装包的用户：不需要另外下载插件。** 发布安装包应已经内置 FFmpeg/FFprobe，负责媒体探测、拆镜、抽帧、转码、音轨处理、字幕和合成。
- **从 GitHub 源码构建的开发者：需要自行准备 FFmpeg/FFprobe。** 从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html)选择符合自身分发许可要求的 Windows 构建，把 `ffmpeg.exe`、`ffprobe.exe` 及许可证材料放入 `vendor/ffmpeg/`。
- **视觉分析不是本地插件。** 原片人物、场景、动作和构图分析需要在软件“API 接口设置”中配置支持图片输入的 OpenAI-compatible 视觉接口。
- **PySceneDetect 是可选服务器增强项，不是当前客户端必装项。** 若工作室要在分析服务器提高复杂转场检测效果，可评估 [PySceneDetect](https://github.com/Breakthrough/PySceneDetect)；接入前仍需要实现服务器适配器，不能仅安装后就认为客户端已经调用。

完整目录结构、部署命令、许可提醒和验收步骤见[视频重制本地化部署说明](docs/视频重制本地化部署.md)。

## FFmpeg

源码测试和打包需要在 `vendor/ffmpeg/` 放置 `ffmpeg.exe`、`ffprobe.exe` 及其许可证。仓库不分发这两个二进制文件，使用者需要自行选择符合其分发场景的 FFmpeg 构建并履行对应 LGPL/GPL 义务。

## 验证

当前自动化覆盖类型检查、状态机、画布拓扑、候选版本、断点恢复、防重复提交、媒体切镜、音轨、字幕、时间线合成及导出。真实供应商生成仍取决于使用者配置的模型、额度和接口兼容性。

## 许可证

源代码按 GNU Affero General Public License v3.0 or later 发布，详见 [LICENSE](LICENSE)。第三方组件许可见 `docs/third-party-notices/`。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中提交 API Key、客户素材或个人信息。

## Code signing policy

本项目正在申请由 SignPath Foundation 提供证书的免费开源代码签名。申请及后续签名只覆盖从本公开仓库、官方版本标签和受控 GitHub Actions 工作流生成的正式发布物。

- [代码签名政策](CODE_SIGNING_POLICY.md)
- [隐私政策](PRIVACY.md)
- Free code signing provided by SignPath.io, certificate by SignPath Foundation
