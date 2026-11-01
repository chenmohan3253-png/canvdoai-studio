# CanvDoAI Studio MCP 调用说明（Windows，v1.1.18）

这份说明用于让同一台电脑上的其他 Codex 项目或聊天操作已安装的 CanvDoAI Studio。MCP 是**本机创作画布控制接口**，不是云端 API，也不等于全平台每个页面都已开放 MCP。Codex 与桌面软件须在同一 Windows 用户会话中运行。

## 1. 先决条件

1. 安装或解压并打开 CanvDoAI Studio v1.1.18，使用期间保持软件运行；便携版须保留整个 `win-unpacked` 文件夹。
2. 软件内按需配置有效的文字、图片、视频 API；仅查看项目、编辑画布、导入本机素材不需要生成 API 额度。
3. 在 Codex 的用户级 `config.toml` 中只配置一次 MCP。**同一台电脑的其他 Codex 项目会共用此配置，不需要把软件或项目文件复制过去。**
4. 不要把 API Key、会话令牌或客户素材写进 `config.toml`、聊天提示词、Git 仓库或本说明。

配置示例（以下路径仅作示范，换成同事电脑上的实际绝对路径）：

```toml
[mcp_servers.canvdoai]
command = 'D:\CanvDoAI Studio\resources\mcp\node.exe'
args = ['D:\CanvDoAI Studio\resources\mcp\mcp-stdio.cjs']
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.canvdoai.tools.run_canvas_node]
approval_mode = "approve"
```

便携版示例若解压到 `D:\CanvDoAI Studio\win-unpacked`，则上述两处路径都要在 `CanvDoAI Studio` 后加上 `\win-unpacked`。无需配置 API Key、端口或固定管道名；MCP 会按当前 Windows 用户重新寻找桌面软件会话。同一台电脑配置一次即可供其 Codex 项目共用，但每位同事的电脑都需自行配置并做只读连通检查。

保存配置后重新启动 Codex 或新开聊天，让工具目录重新加载。先调用 `list_projects` 和 `list_canvases` 做只读检查；若这两个都失败，**不要提交生成任务**。

## 2. 30 项工具

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| 只读 | `list_projects` | 项目、画布数量和最近删除项目 |
| 只读 | `list_canvases` | 画布与最近任务摘要，可按项目筛选 |
| 只读 | `get_canvas` | 指定画布的节点、连线、提示词及版本 |
| 只读 | `list_assets` | 指定项目已归档素材的名称与 ID |
| 只读 | `list_shared_assets` | 仅列出已审核且有复用授权的总库原件 |
| 只读 | `get_task_status` | 任务状态、进度和失败信息 |
| 原任务收片 | `resume_provider_task` | 只传原 `taskId`，按已保存远端 ID 查询并归档既有成品；不接受 force，不创建生成任务。新版本等待状态为 `WAITING_PROVIDER`，会自动续查。见[远端等待与自动收片](远端视频等待与自动收片.md)。 |
| 本机编辑 | `append_canvas_continuation` | 在指定视频节点后增加“实际尾帧提取”与下一镜头节点，并连接下一镜头首帧；只建立流程，不生成 |
| 本机媒体处理 | `extract_video_last_frame` | 从当前项目已归档的视频提取实际解码尾帧，保存图片及来源校验记录；不上传、不生成 |
| 只读 | `get_public_prices` | 软件内公开报价；非供应商实时预检 |
| 只读 | `get_video_route_limits` | GET 当前模型能力目录，返回客户端实际执行的上限和计数单位；不把目录值冒充供应商内部上限 |
| 只读 | `prepare_canvas_video_request` | 预检指定视频节点实际待提交的提示词与参数，并核对项目素材映射；不上传参考图、不提交视频任务 |
| 本机编辑 | `create_project` | 新建隔离的画布项目 |
| 本机编辑 | `create_canvas` | 在项目内按模板建画布 |
| 本机编辑 | `clone_canvas_to_project` | 复制画布及项目内素材记录，不重新生成 |
| 本机编辑 | `import_local_asset` | 导入用户指定的本机 PNG/JPEG/WebP、MP4、MP3/M4A/WAV 文件 |
| 本机编辑 | `update_asset_catalog` | 标注素材所属集数、场景、镜头、角色、审核和授权依据 |
| 需明确确认 | `promote_asset_to_shared` | 把已审核且获准跨项目复用的素材加入总库，需 `confirmShare: true` |
| 本机编辑 | `reference_shared_asset` | 将总库原件按固定内容版本引用到目标项目，获得新的项目 `assetId` |
| 本机编辑 | `update_canvas_node` | 写入剧本、提示词、模型和参数 |
| 本机编辑 | `add_canvas_node` | 增加文字、图片、视频或输出节点 |
| 本机编辑 | `connect_canvas_nodes` | 建立节点连线 |
| 本机编辑 | `attach_canvas_asset` | 把当前项目素材挂到生成节点 |
| 需明确确认 | `archive_project` | 删除画布项目并保留本机可恢复归档；须给完整项目名及 `confirmDelete: true` |
| 需明确确认 | `restore_project` | 从最近删除恢复项目，须给 `confirmRestore: true` |
| 受限维护 | `unlink_provider_form` | 仅在用户明确授权、桥接服务明确启用且本机无运行任务时，按精确任务和媒体清单清理原表单引用；不取消官网任务、不删除素材库、不生成 |
| 只读 | `get_provider_form_unlink` | 查询上述维护任务的实际回执；不会重复提交清理 |
| 只读核对 | `inspect_provider_submission` | 按精确原任务 ID 请求原 worker 核对官网历史卡与上传凭证；协议要求只读，不修改原任务 |
| 只读 | `get_provider_submission_inspection` | 查询上述核对任务的实际回执；无匹配时保持未知 |
| 可能计费 | `run_canvas_node` | 运行节点及必要上游；只有用户明确授权本次 API 消耗时才传 `confirmCost: true` |

除 `run_canvas_node` 外，上述 MCP 操作不向生成供应商提交新生成任务。导入、编辑、复制、尾帧提取和连续镜头编排仍会修改本机项目数据；`unlink_provider_form` 会在严格前置条件下修改已授权的远端表单引用，不能当作只读工具。删除项目只做可恢复归档，不删除共享素材或媒体文件。运行中项目拒绝删除。

## 3. 在另一项 Codex 工作中可直接复制的要求

```text
请通过已配置的 CanvDoAI MCP 操作本机 CanvDoAI Studio。先只读调用 list_projects、list_canvases，确认连接、目标 projectId 和是否有运行任务。每次只在指定项目操作；写入前用 get_canvas 核对 nodeId，用 list_assets(projectId) 核对素材 assetId、集数、镜头、角色与 sha256。带镜头标记的素材，先在目标图片/视频生成节点的 assetContext 标记相同集数、镜头及角色，再调用 attach_canvas_asset。总库原件不能直接挂画布，必须先用 reference_shared_asset 取得目标项目的新 assetId。视频节点完成装配后，先调用 get_video_route_limits(modelId) 与 prepare_canvas_video_request(canvasId,nodeId)，核对最终待提交提示词、附件映射和真实客户端字符门禁；参考素材显示 NOT_STARTED 时不得宣称供应商已接受。不要因网络错误或状态未知重复提交。除非我明确确认本次可能消耗 API 额度，不要调用 run_canvas_node，也不要设置 confirmCost=true。不要删除项目，除非我明确指定项目名称并确认删除。每一步告诉我实际工具结果，不要把工具存在等同于任务成功。
```

典型顺序：`list_projects` → `create_project`（如需）→ `create_canvas` → `get_canvas` → `update_canvas_node` / `add_canvas_node`（填写 `assetContext`）→ `import_local_asset` 或 `reference_shared_asset` → `update_asset_catalog` → `list_assets` 核对 → `attach_canvas_asset` → `get_canvas` 校验 → `get_video_route_limits` → `prepare_canvas_video_request` → 用户确认费用 → `run_canvas_node` → `get_task_status`。跨项目复用必须先完成授权审核、`promote_asset_to_shared`，并在目标项目显式引用。详见[分层素材库操作说明](素材库分层与MCP归档.md)。

## 4. 重要边界

- 目前 MCP 直接覆盖**创作画布、项目素材、视频预检、连续镜头、原任务收片及受限维护的这 30 项操作**。AI 一键成片、视频重制、完整时间线合成、API 设置仍有各自的软件界面或内部 API；不能声称这些工具已控制全平台每个按钮。
- `append_canvas_continuation` 只建立“源视频 → 尾帧提取 → 下一镜头首帧”的依赖；下一镜头提示词留空，实际运行仍需作者填写并确认费用。`extract_video_last_frame` 只接受当前项目已归档且校验值未变化的视频，不能读取任意远程 URL。
- `resume_provider_task` 只续查本机已保存且可唯一匹配的远端任务 ID。账户、节点输入或素材指纹变化时会停止，不能用它绕过费用确认创建新任务。
- `unlink_provider_form`、`get_provider_form_unlink`、`inspect_provider_submission`、`get_provider_submission_inspection` 依赖专用桥接服务协议；表单清理能力默认关闭。工具出现在目录中不等于服务端已部署、已启用或维护已经成功。
- `prepare_canvas_video_request` 只读调用当前模型能力目录，不上传素材，也不分配任务 ID。它的 `capturedRequest.prompt` 是桌面软件将提交给网关的准确文本；如果 `attachmentsPendingUpload=true`，素材只有本地 `assetId`、哈希和槽位，**尚无供应商 `providerAssetId`，不能当作完整供应商请求或成功凭据**。Wan 的 `prompt_extend` 可能在供应商内部继续改写提示词，此工具无法观察供应商内部最终文本。
- `get_video_route_limits` 的 `adapterEnforcedPromptLimit` 使用 JavaScript UTF-16 码元计数；`preparedPromptChars` 是 Unicode 码点数，两者不可混用。伏流目录的 10000 字符由本地适配器补齐；所有路由的 `providerVerifiedPromptLimit` 均保留未知，不应写成供应商已证实。
- `get_public_prices` 是软件内静态公开报价，不是每次任务的最终计费结果。
- `run_canvas_node` 返回任务已接收，不代表视频已生成成功；继续用 `get_task_status` 检查 `SUCCEEDED` / `FAILED`。失败后先看原因与已有远端任务 ID，避免重复付费。
- 同一画布只允许一个 `QUEUED` 或 `RUNNING` 任务，以避免同时改写节点候选和重复运行必要上游。不同画布可并行，但每张画布的 API 调用可能分别计费；并行前先核对现有任务与费用授权。
- v1.1.14 修复了过大参考图的上传兼容性，但供应商真实接口尚未完成付费镜头复测。恢复生产时先只运行一个带参考图的镜头，确认上传与生成都成功后再批量运行。
- 本机素材导入只接受用户明确指定的绝对文件路径，不接受 UNC 网络路径。跨项目素材不能直接挂载，需先审核入总库并显式引用；挂载时若集数、场景、镜头或角色标签与目标节点不符，保存会拒绝。

## 5. 连接故障排查

| 提示 | 检查与处理 |
| --- | --- |
| 工具目录没有 CanvDoAI | 核对 `config.toml` 路径和 `node.exe` / `mcp-stdio.cjs` 是否存在，重启 Codex 或新建聊天 |
| `connect ENOENT \\.\pipe\canvdoai-mcp-...` | 桌面软件未运行、未启动完成，或 Codex 与软件不是同一 Windows 用户；先打开软件，再调用 `list_projects` |
| `Transport closed` | MCP 进程已退出；核对程序文件，重启 Codex 的 MCP 连接，再做只读调用 |
| 旧会话仍只显示 21 或 23 项工具 | 工具目录在会话启动时缓存；升级软件并新开 Codex 聊天后应显示 30 项 |
| `HTTP 422` 或生成失败 | 供应商参数/审核可能不通过；查 `get_task_status`，不要盲目强制重试 |

更新或重装软件前先确认没有运行中的生成任务。项目数据位于当前用户的应用数据目录，安装或更新时不要删除该目录。
