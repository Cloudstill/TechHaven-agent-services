# TechHaven Agent Services

独立维护 Gateway、BFF、Bridge、MCP 与 Agent 数据库迁移。前端通过同源 `/gateway/*` 接口接入；本仓库不包含 React 页面或前端构建依赖。

## 安装与检查

Node.js >= 22.12，推荐与 CI 相同的 Node 24。每个服务使用自己的 package-lock.json。

```sh
npm run install:services
npm run check
npm run check:ports
npm run build
npm run package:release
```

`check` 包含类型检查、单测和 mock/fake-legacy 冒烟。真实 PostgreSQL、旧后端和 dsh 联调另行验证，不能用 mock 成功代替。

## 本地启动

```sh
npm run dev:stack
```

默认只构建、启动 Gateway；不需要前端仓库。可通过 `TECHHAVEN_GATEWAY_TOKEN` 配置服务端令牌。若未配置，启动器使用仅在内存中的随机令牌。
需要联合启动时，显式设置 `TECHHAVEN_FRONTEND_ROOT` 为前端仓库的绝对路径；启动器将同一开发令牌传给 Vite，并启用前端 `VITE_AGENT_ENABLED=true`。此开发代理使用固定测试身份，只用于本机联调。

## 边界和部署

- Gateway 默认 3091、BFF 3092、Bridge 3093；MCP 通常使用 stdio。
- 前端独立构建发布；本仓库的发布包只有四个服务、contracts、迁移和服务脚本。
- `scripts/deploy-server.ps1 -PackageOnly` 可只打包；远端激活脚本不再检查或更新前端目录。
- 现有激活脚本管理 Gateway/BFF 的启动与回滚。Bridge、MCP worker 和数据库迁移仍需按实际配置部署；打包齐全不等于真实链路已部署。
- 生产 `/gateway/*` 由 Nginx + BFF 验证当前用户并注入可信身份。禁止让前端持有 Gateway 管理令牌；参见 `scripts/nginx-techhaven.conf.example`。
- 不运行数据库迁移、不推送或发布，直到确定目标环境。

## 接口版本

`contracts/index.d.ts` 是服务端契约源。前端保存同版本的只读副本，使用 SHA-256 清单检查同步；契约变化必须在双方 PR 中审查，不能通过跨仓库相对路径隐式引用。当前导出版本为 0.1.0。

本仓库从 TechHaven 集成分支 `c0ed51f` 的文件状态提取，原项目许可证保留。来源与逐文件哈希见 `SOURCE_MANIFEST.json`。
`docs/ARCHITECTURE.md`、`docs/ROADMAP.md`、`docs/TH-RFC-001-agent-engine.md` 和生产检查报告保留为拆分前的设计/验证记录，其中一体化目录示例不能直接作为本仓库的启动说明；以本 README 为准。
