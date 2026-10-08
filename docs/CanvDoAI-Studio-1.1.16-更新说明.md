# CanvDoAI Studio 1.1.16 更新说明

本版继承 [1.1.15 的分层素材库、镜头归属校验与 21 项 MCP 工具](CanvDoAI-Studio-1.1.15-更新说明.md)，并修复 GitHub Actions 云端构建：原先指定的 FFmpeg 自动构建下载地址已失效。工作流现改用发布方保留的 FFmpeg 8.1.2 Windows essentials 历史归档，核验固定 SHA-256 后提取 `ffmpeg.exe`、`ffprobe.exe` 和许可证。CI 与 Release 使用同一来源和校验值。

本机源码通过 322 项自动化测试、TypeScript 检查及 MCP 隔离重连测试。MCP 只覆盖创作画布与素材库，不代表全平台或供应商付费视频生成已完成实测。安装包未进行企业代码签名，Windows 可能提示“未知发布者”；请仅从本仓库 Release 下载并核对同页 SHA-256。
