# 分层素材库与 Codex MCP 操作（v1.1.16）

## 库的边界

- **项目素材库**：每个 `projectId` 单独列出图片、音频、视频、文字和候选版本。旧素材保留原 `assetId`，不会因为升级而自动搬到别的项目。
- **总素材库**：只保存用户已审核、明确允许跨项目复用并记录授权依据的素材原件。普通项目素材不会自动出现在这里。
- 总库原件不能直接挂画布。用户显式选择目标项目后，软件建立新的项目 `assetId`，保留原件、来源 `assetId` 和内容 `sha256`；底层媒体文件可复用，不会为引用动作重新生成或重新计费。
- 集数、场景、镜头、角色 ID 是归档元数据，不依赖文件名猜测。带这些标签的素材连接到图片/视频节点时，目标节点的 `assetContext` 必须匹配，否则保存拒绝。没有标签的旧素材仍可使用，但 Codex 应要求人工核对，不能宣称已自动锁定身份。

## 软件界面

打开“素材中心”，左侧先选“总素材库”或具体项目。项目库中可按名称、集数、镜头、角色及素材 ID 搜索。点“查看详情”可填写 `E001`、`S01`、`C01` 等标记、审核状态与授权依据。确认审核和复用权并保存后，才可“加入总素材库”。总库页选定目标项目，点“引用到所选项目”，然后使用返回的项目素材继续编辑画布。

画布的图片/视频生成节点有“镜头归属”。素材若标记了集数、场景、镜头或角色，必须先在目标节点填写对应 ID，再选择或连接素材。多角色镜头的角色 ID 用逗号分隔。

## Codex 在其他制作任务中的调用顺序

1. `list_projects` 确定唯一目标 `projectId`；`list_canvases` / `get_canvas` 核对画布和任务。没有连接或状态不明时停止写入。
2. `list_assets({projectId})` 查本项目素材，以 `assetId`、`sha256` 和归档标签为准，不凭文件名选图。新文件需先用 `import_local_asset` 导入目标项目。
3. 仅在用户实际审核后，才用 `update_asset_catalog` 标记 `reviewStatus: "approved"` 并传 `confirmReview: true`。只有用户确认使用权后，才能标记 `reuseAllowed: true`、记录 `rightsNote` 并传 `confirmReuse: true`。
4. 跨项目复用：用户明确确认后 `promote_asset_to_shared({projectId,assetId,confirmShare:true})`；`list_shared_assets` 查总库；`reference_shared_asset({sharedAssetId,targetProjectId})` 获取目标项目的新 `assetId`。原项目和总库原件均不会被改写。
5. `update_canvas_node` 或 `add_canvas_node` 在目标图片/视频节点设置 `assetContext`，例如 `{"episodeId":"E001","shotId":"S01","characterIds":["C01","C02"]}`，再 `attach_canvas_asset` 使用**目标项目的** `assetId`。不匹配时先核实素材，不能随意改标签绕过门禁。
6. `get_canvas` 与 `list_assets` 再核对节点、来源及所选版本。只有用户另行明确授权本次 API 费用，才调用 `run_canvas_node(confirmCost:true)`；引用、标注、挂载本身不产生生成费用。

已有 Codex 聊天可能缓存旧 MCP 工具目录。安装 v1.1.16 并重新打开软件后，新建 Codex 聊天或重载 MCP 连接，再先只读调用 `list_projects`、`list_shared_assets`、`list_assets` 验证。仅看到工具名不代表连接成功；须取得真实返回。不要把 API Key、桌面会话令牌或客户素材写入 Codex 配置及 Git 仓库。

## 边界

这套目录解决的是本机 CanvDoAI 创作画布与素材记录的归属问题。它不自动判断肖像、音乐和图片的版权，也不证明生成素材已经达到成片质量；审核、授权、镜头验收仍需人员确认。软件没有自动移动或删除旧项目素材，媒体文件采用原有内容校验值作为版本标识。
