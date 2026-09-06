# Agent 服务独立部署

请先阅读 [仓库入口](../README.md)。前端构建与发布由前端仓库负责。

Linux 服务管理和迁移说明分别见 scripts/、[数据库文档](agent-db/README.md) 与各 services/*/README.md。

只打包示例（不上传、不启动服务器）：

```powershell
./scripts/deploy-server.ps1 -Server localhost -User deploy -DeployRoot /srv/techhaven-agent -PackageOnly
```

真实部署去掉 -PackageOnly 并指定目标 SSH 参数。激活脚本启动 Gateway/BFF，初始配置为 mock。Bridge、MCP worker、dsh、PostgreSQL 和生产权限链必须单独配置验证。数据库迁移不随发布自动执行。
