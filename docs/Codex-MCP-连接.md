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
5. 打开 CanvDoAI Studio，先通过 `list_canvases`、`get_canvas`、`get_task_status` 做只读检查；需要生成时再调用 `run_canvas_node`。

Codex 配置字段可核对[官方配置参考](https://developers.openai.com/codex/config-reference)。`run_canvas_node` 会调用配置好的供应商 API，可能计费；必须取得用户对本次费用的明确授权并设置 `confirmCost=true`。不要在状态未知时反复提交，`force=true` 会强制重做目标节点。

## 工具与限制

| 工具 | 作用 |
| --- | --- |
| `list_canvases` | 列出画布、节点摘要及最近任务 |
| `get_canvas` | 读取指定画布的节点参数、提示词与连线 |
| `get_task_status` | 按画布或任务 ID 查看状态和失败原因 |
| `run_canvas_node` | 运行节点及必要上游；不填节点 ID 时运行整张画布 |

MCP 只控制已有画布，不替用户填写 API、创建角色或保证供应商接受每一种模型参数。接口目录测试成功不等于视频生成请求已通过；首次生成建议选单个低成本镜头验收。

桌面软件暂时关闭时，MCP 工具清单仍可加载，但画布调用会提示先打开软件。重新打开桌面软件后，MCP 会在下一次工具调用时获取新的本机会话，不需要为了会话令牌重启 Codex。若当前任务看不到 `canvdoai` 工具，则需重新打开 Codex 并新建任务。

连接限于同一台 Windows 电脑、同一 Windows 用户的本机回环服务和命名管道；不开放公网端口，也不把 API Key 写入 Codex 配置。不要在公开 Issue 中粘贴密钥或客户素材。
