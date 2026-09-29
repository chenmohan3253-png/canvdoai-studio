# 在另一个 Codex 任务使用本机 CanvDoAI（v1.1.14）

本机软件已安装在 `D:\CanvDoAI Studio`，用户级 MCP 配置已经指向 `D:\CanvDoAI Studio\resources\mcp\mcp-stdio.cjs`。同一台电脑、同一 Windows 用户下的其他 Codex 任务无需再次安装或复制密钥。使用时保持 CanvDoAI Studio 打开。

先把以下文字复制到目标任务：

```text
请使用本机已配置的 CanvDoAI MCP 继续这个任务，先不要提交生成。先实际调用 list_projects、list_canvases 和 get_task_status，确认 MCP 能连上、目标项目与画布的 ID、现有节点及是否有 QUEUED/RUNNING 任务；不要仅凭工具列表判断连接正常。

根据本任务原有的项目名称和制作要求选择目标项目，不要误用其他项目。用 get_canvas 核对现有剧本、参考素材连线、模型、分辨率、比例、时长和已保存的候选；需要修改时再使用 update_canvas_node、add_canvas_node、connect_canvas_nodes 或 attach_canvas_asset。导入本机素材前，先核对文件绝对路径和项目归属。不要重建已经存在的画布，也不要重复提交结果未知的远端任务。

本机 CanvDoAI 已更新到 v1.1.14，修复了大参考图的 /v1/assets 上传兼容性。对之前因 HTTP 400 或 fetch failed 失败的镜头，先只选择一个镜头做验收。只有确认本任务已有明确的本次 API 额度授权、画布参数正确、没有同一镜头的运行任务时，才调用 run_canvas_node（confirmCost=true）。返回“已接收”不算完成；随后用 get_task_status 查看最终 SUCCEEDED/FAILED，失败就报告具体 failureStage 与错误，不要自动批量重试。单镜头真实成功后再按本任务要求推进其他镜头。

若出现 Transport closed 或 connect ENOENT，请先确认 CanvDoAI 桌面程序正在运行，再重新连接或新开 Codex 聊天，先重试只读调用；不要提交生成。请汇报实际工具结果和下一步，而不是推测状态。
```

当前 MCP 直接控制的是创作画布；AI 一键成片、视频重制和完整时间线合成不在这套 17 项画布工具的直接覆盖范围内。旧聊天可能只缓存 15 项工具目录，但其中的项目、画布、任务读取以及节点编辑/运行仍可用；若需要归档/恢复项目工具，请新开聊天刷新目录。

同一画布只能有一个排队或运行中的任务；运行另一镜头前应等待本画布当前任务结束。不同画布可以并行，但各自可能消耗 API 额度。参考图上传修复尚未经过真实供应商验收时，建议先完成一个镜头的端到端验证，再扩大并行量。

详细工具说明见 [CanvDoAI-MCP-调用说明.md](CanvDoAI-MCP-调用说明.md)。
