# 极九 Seedance 2.5 接入说明

依据：[极九 API 接入文档](https://newapi.jijiucanvas.com/docs/)；价格及当前上架状态请查[站内定价页](https://newapi.jijiucanvas.com/pricing)。此文件不含 API Key。

## 在 CanvDoAI 中配置

1. 打开“API 接口设置 → 视频生成”，协议选择“极九 Seedance · `/v1/videos`”。
2. 视频 Base URL 填 `https://newapi.jijiucanvas.com`（不是 `/v1/chat/completions`）。在软件密码框中填写你自己的视频 API Key，保存。不要把 Key 写进项目提示词或仓库。
3. 点击“测试视频接口 / 读取模型”。当前适配 `SD2.5特价30-10-10-线路一`、`SD2.5特价30-10-10-线路三` 和 `稳定seedance-2.5全参E`；**只有当前令牌的 `/v1/models` 实际返回的型号才能选择**。令牌分组必须在极九站内设置；请求体里的 `group` 不会切换分组。
4. 带参考图时，须配置**独立的素材上传服务**，该服务的 `POST /v1/assets` 应接收 multipart 文件并返回可由视频服务下载的公网 HTTPS `cdn_url`。极九文档没有声明本地素材上传端点，CanvDoAI 不会把极九视频 Key 转发给素材上传服务。没有上传服务时可先做纯文字生成；不能把本机路径或 `127.0.0.1` 当参考图 URL。
5. 在画布中选模型、时长、分辨率、画幅，关闭未验证的“生成声音”开关，挂载参考图片后先做只读预检，再运行一次。提交超时或结果未知时，不要再次点击生成；按已保存任务 ID 查询。

## 10 秒、720p、16:9 参考图示例

`SD2.5特价30-10-10-线路三` 使用 `images` 数组：

```json
{
  "model": "SD2.5特价30-10-10-线路三",
  "prompt": "以参考人像为人物身份依据：窗边柔和晨光，人物自然抬头望向镜头并轻轻转身，发丝随微风细微摆动。镜头平稳缓慢推近，真实肤质，五官与发型保持一致，背景简洁，无文字、无字幕、无水印。",
  "seconds": 10,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "images": ["https://你的素材服务/可直接下载的参考图.jpg"]
}
```

创建用 `POST /v1/videos`，从响应 `id` 取任务号；随后每 5–10 秒用 `GET /v1/videos/{id}` 查询。`status=completed` 后，用相同令牌从 `GET /v1/videos/{id}/content` 下载文件。**不要使用** `/v1/video/generations`、`/v1/videos/generations` 或 `/v1/chat/completions` 生成视频。`线路一` 同样用 `images`；`稳定seedance-2.5全参E` 用 `image_refs`，不可混填。

## 费用和来源说明

模型可能按次或按秒计费，实际以服务商提交时价格与账单为准，不以本说明作为实时报价。`/v1/models` 可证明令牌能看到客户模型名；完成任务返回的模型字段和本地视频文件可作为调用记录，但**不能独立证明底层确由火山引擎官方 Seedance 2.5 执行，也不能证明用户令牌是火山官方直签 Key**。本接入使用的是 `newapi.jijiucanvas.com` 网关令牌；若需官方来源证明，请向网关服务商索取上游服务商、渠道、原始任务号和账单或官方可核验凭据。
