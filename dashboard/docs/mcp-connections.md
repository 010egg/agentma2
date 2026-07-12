# MCP 连接与数据库查询

AgentMa 支持租户自助连接远程 Streamable HTTP/SSE MCP。平台不运行用户提供的 stdio 进程，也不把认证信息写进 Agent 可读的 workspace。

## 路径 A：上传数据文件

适合静态报表、离线数据和一次性分析。

1. 上传 `.sqlite`、`.db`、`.csv`、`.xls` 或 `.xlsx`。
2. 平台把表格数据转换为受控 SQLite。
3. Agent 通过 `mcp__datasource__query_datasource` 执行只读 `SELECT` / `WITH` 查询。

这条路径不需要网络连接，也不适合持续变化的在线数据库。

## 路径 B：远程数据库 MCP（推荐）

适合 Postgres、MySQL、Supabase、Neon、PlanetScale 或 SaaS 数仓等在线数据源。

1. 在自己可控的环境部署可信的数据库 MCP 服务，或使用云厂商提供的托管 MCP endpoint。服务应使用 Streamable HTTP；遗留服务可用 SSE。
2. 在数据库侧创建专用只读账号。不要给 MCP 使用写权限、DDL 权限或管理员账号。
3. 为 MCP endpoint 配置独立 Bearer token 或 API key。数据库连接串保留在自己的 MCP 服务中，不交给 AgentMa。
4. 打开 AgentMa 的“工具 → MCP 连接”页签，填写名称（例如 `mydb`）、HTTPS URL 和认证 header。
5. 点击“测试”，检查服务器名称和工具列表。远程工具描述是不可信输入，只连接你确认可信的 MCP。
6. 打开 Agent 模板编辑器，勾选 `mydb`。每个模板最多选择 8 个 MCP 服务器。
7. 运行 Agent 后，工具以 `mcp__mydb__<tool>` 形式出现。

私有连接只有创建者和租户管理员可见。发布连接后，租户内其他用户可以使用同一认证能力；发布前必须确认只读账号及其查询范围适合共享。取消发布后，其他用户的 run 会跳过该连接并记录 warning，不会借用创建者的私有凭据。

## 路径 C：平台直连数据库（规划中）

未来可在 datasource 中加入 Postgres/MySQL 连接串型数据源，并复用只读 SQL、行数上限和审计规则。这会让平台直接托管数据库凭据并承担数据库出网安全责任，需要独立安全评审，本期不提供。

## 部署安全

- `AGENTMA_SECRETS_KEY` 必须是 32 字节 base64。带认证 header 的连接在缺少该变量时拒绝保存，不会明文降级。
- 公网 MCP 默认必须使用 HTTPS。
- 私网、回环和链路本地目标默认拒绝。受控内网部署需用 `AGENTMA_MCP_HOST_ALLOWLIST` 显式列出主机；HTTP 还需同时设置 `AGENTMA_MCP_ALLOW_HTTP=1`。
- 创建、编辑、测试和每次 run 组装都会重新校验 URL。DNS rebinding 仍属于残余风险，生产部署应结合出站防火墙或代理限制可访问网段。
- `lastCheckOk` 只用于界面状态，不是授权结论。运行时 MCP 宕机时，该服务器工具可能缺席，但不应导致整个 Agent run 失败。
