# 用 Codex 控制 CanvDoAI（本机 MCP）

CanvDoAI Studio 提供本机 MCP 工具，让 Codex 查看画布、查询任务，或在明确授权费用后运行画布节点。此功能使用安装包内置的 Node.js 运行时，不要求客户额外安装 Node.js；API Key 仍由桌面软件保管。

## 连接步骤

1. 安装新版 CanvDoAI Studio，在软件的“API 接口设置”保存需要使用的接口和密钥。
2. 找到实际安装目录中的 `resources\mcp\node.exe` 和 `resources\mcp\mcp-stdio.cjs`。
3. 编辑当前 Windows 用户的 `%USERPROFILE%\.codex\config.toml`，按实际安装路径填写：

```toml
[mcp_servers.canvdoai]
command = "D:\\CanvDoAI Studio\\resources\\mcp\\node.exe"
args = ["D:\\CanvDoAI Studio\\resources\\mcp\\mcp-stdio.cjs"]
startup_timeout_sec = 15
tool_timeout_sec = 120

[mcp_servers.canvdoai.tools.run_canvas_node]
approval_mode = "prompt"
```

4. 完全退出并重新打开 Codex，启动一个新任务，确认工具列表中有 `canvdoai`。旧任务可能仍沿用创建时的工具清单。
5. 打开 CanvDoAI Studio，先通过 `list_projects` 查看项目；可用 `create_project` 新建项目，再用 `create_canvas` 在该项目内创建画布。模板只是初始骨架：使用 `get_canvas` 取得节点 ID，用 `update_canvas_node` 填写完整剧本及参数，用 `add_canvas_node`、`connect_canvas_nodes` 逐镜扩展。参考文件先由 `import_local_asset` 归档，再用 `attach_canvas_asset` 挂载。检查 `get_task_status` 后，需要生成时再调用 `run_canvas_node`。

Codex 配置字段可核对[官方配置参考](https://developers.openai.com/codex/config-reference)。`run_canvas_node` 会调用配置好的供应商 API，可能计费；必须取得用户对本次费用的明确授权并设置 `confirmCost=true`。不要在状态未知时反复提交，`force=true` 会强制重做目标节点。

## 工具与限制

| 工具 | 作用 |
| --- | --- |
| `list_projects` | 列出本机项目及各项目画布数量 |
| `create_project` | 创建独立项目，不调用生成 API |
| `create_canvas` | 指定 `projectId`、名称和模板，在该项目内创建画布，不调用生成 API |
| `clone_canvas_to_project` | 显式把旧画布及已有本地版本复制到目标项目；不是自动复用，不会重新提交生成任务 |
| `list_canvases` | 列出画布、节点摘要及最近任务；可用 `projectId` 过滤 |
| `get_canvas` | 读取指定画布的节点参数、提示词与连线 |
| `update_canvas_node` | 写入剧本、提示词、模型、时长、画幅和分辨率等允许字段 |
| `add_canvas_node`、`connect_canvas_nodes` | 把专业短剧的六节点起始模板扩展成逐镜头画布 |
| `list_assets`、`import_local_asset`、`attach_canvas_asset` | 查看本项目素材，归档用户明确指定的本机文件，并挂载到画布的参考/首帧/尾帧槽 |
| `get_public_prices` | 读取软件内公开的 Seedance 报价；并非实时预检，未列出的模型不报估价 |
| `get_task_status` | 按画布或任务 ID 查看状态和失败原因 |
| `run_canvas_node` | 运行节点及必要上游；不填节点 ID 时运行整张画布 |

项目创建后获得唯一 `projectId`，同名项目会拒绝；画布归属不能直接改到另一项目。新项目只能选用本项目素材，旧版项目和迁移包仍保留并可访问。旧的 8 秒测试镜头不会自动进入新项目；如需复用，先确认画布与人物符合正式制作，再显式调用 `clone_canvas_to_project`。复制会为素材建立目标项目记录，原画布不变。`import_local_asset` 仅接受本机绝对路径的 PNG/JPEG/WebP（最多 20 MB）、MP3/M4A（最多 64 MB）、MP4（最多 128 MB）；不读取网络路径。

专业短剧模板初始只有六个节点，并不会自动拆出 13 个视频镜头；需按分镜逐镜添加和连接。当前画布输出节点只交付其直接连接的一个素材，不会自动把多个镜头剪成整部影片。多镜头最终合成仍需使用软件的一键成片/时间线功能，不能把 `run_canvas_node` 的“整张画布运行”误解为自动剪辑成片。MCP 不替用户填写 API 或保证供应商接受每一种模型参数。接口目录测试成功不等于视频生成请求已通过；首次生成建议选单个低成本镜头验收。

桌面软件暂时关闭时，MCP 工具清单仍可加载，但画布调用会提示先打开软件。重新打开桌面软件后，MCP 会在下一次工具调用时获取新的本机会话，不需要为了会话令牌重启 Codex。若当前任务看不到 `canvdoai` 工具，则需重新打开 Codex 并新建任务。

连接限于同一台 Windows 电脑、同一 Windows 用户的本机回环服务和命名管道；不开放公网端口，也不把 API Key 写入 Codex 配置。不要在公开 Issue 中粘贴密钥或客户素材。
