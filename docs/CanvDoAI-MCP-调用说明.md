# CanvDoAI Studio MCP 调用说明（Windows，v1.1.16）

这份说明用于让同一台电脑上的其他 Codex 项目或聊天操作已安装的 CanvDoAI Studio。MCP 是**本机创作画布控制接口**，不是云端 API，也不等于全平台每个页面都已开放 MCP。Codex 与桌面软件须在同一 Windows 用户会话中运行。

## 1. 先决条件

1. 安装并打开 CanvDoAI Studio v1.1.16，使用期间保持软件运行。
2. 软件内按需配置有效的文字、图片、视频 API；仅查看项目、编辑画布、导入本机素材不需要生成 API 额度。
3. 在 Codex 的用户级 `config.toml` 中只配置一次 MCP。**同一台电脑的其他 Codex 项目会共用此配置，不需要把软件或项目文件复制过去。**
4. 不要把 API Key、会话令牌或客户素材写进 `config.toml`、聊天提示词、Git 仓库或本说明。

本机已验证的配置（安装目录不同则替换绝对路径）：

```toml
[mcp_servers.canvdoai]
command = 'D:\CanvDoAI-MCP-Runtime\node.exe'
args = ['D:\CanvDoAI Studio\resources\mcp\mcp-stdio.cjs']
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.canvdoai.tools.run_canvas_node]
approval_mode = "approve"
```

若另一台电脑没有独立的 `D:\CanvDoAI-MCP-Runtime\node.exe`，可把 `command` 改成安装包自带的 `D:\CanvDoAI Studio\resources\mcp\node.exe`。安装路径不是 D 盘时也要同步改 `args`。无需配置 API Key、端口或固定管道名；MCP 会按当前 Windows 用户重新寻找桌面软件会话。本机已配置好用户级 MCP，同一台电脑的其他项目无需重复配置。

保存配置后重新启动 Codex 或新开聊天，让工具目录重新加载。先调用 `list_projects` 和 `list_canvases` 做只读检查；若这两个都失败，**不要提交生成任务**。

## 2. 21 项工具

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| 只读 | `list_projects` | 项目、画布数量和最近删除项目 |
| 只读 | `list_canvases` | 画布与最近任务摘要，可按项目筛选 |
| 只读 | `get_canvas` | 指定画布的节点、连线、提示词及版本 |
| 只读 | `list_assets` | 指定项目已归档素材的名称与 ID |
| 只读 | `list_shared_assets` | 仅列出已审核且有复用授权的总库原件 |
| 只读 | `get_task_status` | 任务状态、进度和失败信息 |
| 只读 | `get_public_prices` | 软件内公开报价；非供应商实时预检 |
| 本机编辑 | `create_project` | 新建隔离的画布项目 |
| 本机编辑 | `create_canvas` | 在项目内按模板建画布 |
| 本机编辑 | `clone_canvas_to_project` | 复制画布及项目内素材记录，不重新生成 |
| 本机编辑 | `import_local_asset` | 导入用户指定的本机 PNG/JPEG/WebP、MP4、MP3/M4A 文件 |
| 本机编辑 | `update_asset_catalog` | 标注素材所属集数、场景、镜头、角色、审核和授权依据 |
| 需明确确认 | `promote_asset_to_shared` | 把已审核且获准跨项目复用的素材加入总库，需 `confirmShare: true` |
| 本机编辑 | `reference_shared_asset` | 将总库原件按固定内容版本引用到目标项目，获得新的项目 `assetId` |
| 本机编辑 | `update_canvas_node` | 写入剧本、提示词、模型和参数 |
| 本机编辑 | `add_canvas_node` | 增加文字、图片、视频或输出节点 |
| 本机编辑 | `connect_canvas_nodes` | 建立节点连线 |
| 本机编辑 | `attach_canvas_asset` | 把当前项目素材挂到生成节点 |
| 需明确确认 | `archive_project` | 删除画布项目并保留本机可恢复归档；须给完整项目名及 `confirmDelete: true` |
| 需明确确认 | `restore_project` | 从最近删除恢复项目，须给 `confirmRestore: true` |
| 可能计费 | `run_canvas_node` | 运行节点及必要上游；只有用户明确授权本次 API 消耗时才传 `confirmCost: true` |

除 `run_canvas_node` 外，上述 MCP 操作不向生成供应商提交新任务。导入、编辑、复制仍会修改本机项目数据；删除只做可恢复归档，不删除共享素材或媒体文件。运行中项目拒绝删除。

## 3. 在另一项 Codex 工作中可直接复制的要求

```text
请通过已配置的 CanvDoAI MCP 操作本机 CanvDoAI Studio。先只读调用 list_projects、list_canvases，确认连接、目标 projectId 和是否有运行任务。每次只在指定项目操作；写入前用 get_canvas 核对 nodeId，用 list_assets(projectId) 核对素材 assetId、集数、镜头、角色与 sha256。带镜头标记的素材，先在目标图片/视频生成节点的 assetContext 标记相同集数、镜头及角色，再调用 attach_canvas_asset。总库原件不能直接挂画布，必须先用 reference_shared_asset 取得目标项目的新 assetId。不要因网络错误或状态未知重复提交。除非我明确确认本次可能消耗 API 额度，不要调用 run_canvas_node，也不要设置 confirmCost=true。不要删除项目，除非我明确指定项目名称并确认删除。每一步告诉我实际工具结果，不要把工具存在等同于任务成功。
```

典型顺序：`list_projects` → `create_project`（如需）→ `create_canvas` → `get_canvas` → `update_canvas_node` / `add_canvas_node`（填写 `assetContext`）→ `import_local_asset` 或 `reference_shared_asset` → `update_asset_catalog` → `list_assets` 核对 → `attach_canvas_asset` → `get_canvas` 校验 → 用户确认费用 → `run_canvas_node` → `get_task_status`。跨项目复用必须先完成授权审核、`promote_asset_to_shared`，并在目标项目显式引用。详见[分层素材库操作说明](素材库分层与MCP归档.md)。

## 4. 重要边界

- 目前 MCP 直接覆盖**创作画布及其素材库的这 21 项操作**。AI 一键成片、视频重制、完整时间线合成、API 设置和供应商实时模型目录仍有各自的软件界面或内部 API；不能声称这些工具已控制全平台每个按钮。
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
| 旧会话只显示 17 项工具 | 工具目录在会话启动时缓存；升级软件并新开 Codex 聊天后应显示 21 项 |
| `HTTP 422` 或生成失败 | 供应商参数/审核可能不通过；查 `get_task_status`，不要盲目强制重试 |

更新或重装软件前先确认没有运行中的生成任务。项目数据位于当前用户的应用数据目录，安装或更新时不要删除该目录。
