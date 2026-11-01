# 精确表单引用清理

此入口是有状态维护，不是生成或取消入口。只有用户明确批准清理某原任务的指定媒体引用后才调用。

## 部署要求

客户端增加 `unlink_provider_form` 和只读 `get_provider_form_unlink`。本机仍使用现有 MCP session 认证；软件内部沿已经配置的 videoBase/videoKey 发请求，不向助手暴露密钥，也不读取服务器私有配置文件。

桥接服务须同时部署 `client_form_unlink.py` 及对应 server 路由，并由管理员明确设置 `client_form_unlink_enabled=true`。默认关闭，旧服务或未启用时拒绝操作。新路由继续要求既有 client Bearer 认证，不开放无认证清理或通用 operator 代理。原 `/operator/` 的 worker 身份及 loopback 限制不变。

## 调用顺序

1. 负责人已单独决定仅结束原任务的本地跟踪，并完成数据库备份/审计。不把这称作官网取消。
2. 明确确认实际原 sourceJobId 与全部待清理媒体 ID、kind、role。不能猜、不能接受空列表或混入其他任务。
3. `unlink_provider_form({sourceJobId, expectedRefs:[{website_media_id,kind,role}], confirmUnlink:true})`。
4. 用返回的 id 调用 `get_provider_form_unlink({maintenanceJobId:id})` 查询；不可当作失败后重新生成。
5. 必须实际 `status=validated`、`removed_count` 与授权数量一致、`submitted=false`、`library_files_deleted=false`、`billing_mode=no_generation`，才宣告清理成功并交回制作总控。

桥接严格比对原取消审计、原始完整备份中的行及提交凭证、当前原行与媒体归属、同一服务器 worker 的实时表单、空队列；对同一原任务和媒体列表使用确定性幂等键。回执未到前 removed_count 是 null，不冒报 0 或成功。

客户端协议：认证 GET `/v1/maintenance/form-unlink/capabilities`；认证 POST `/v1/maintenance/form-unlink`（仅 sourceJobId/expectedRefs/confirmUnlink）；认证 GET `/v1/maintenance/form-unlink/{maintenanceJobId}`。

不接受 force、任意 request、模型/提示词、删除素材库、生成许可或官网取消参数。清理沿现有 prepare_only + cleanup_only 流程，无法获得 permit_submit/submitted/result 事件许可。所有代码测试仅用临时库及模拟传输；测试通过不等于已部署或实际清理成功。
