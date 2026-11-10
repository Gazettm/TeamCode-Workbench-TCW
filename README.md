# TeamCode-Workbench-TCW
Team Task &amp; Code Collaboration System

## 0.2 桌面客户端和本机协作服务

已有本地工作区、Git 状态和个人备注。0.2 增加账号、私有项目、多项目切换、邀请码和成员列表。任务流程在 0.3 增加。

客户端开发需要 Node.js 22.12+、npm 和 Git for Windows。在仓库目录执行：

```powershell
npm ci
npm run dev
```

运行共享协作还需要 JDK 21、Maven 和 MySQL 8.0。确认 `mvn -v` 使用 JDK 21，然后在独立 PowerShell 终端执行：

```powershell
mvn -f server/pom.xml package
.\scripts\Start-LocalServer.ps1
```

脚本在本机启动独立 MySQL（33316）及 API（8080），不会使用已有数据库；保持终端运行。客户端“设置”填 `http://localhost:8080` 后测试连接，在“协作项目”注册账号。停止用 Ctrl+C 或 ` .\scripts\Start-LocalServer.ps1 -Stop `。每个人各自启动 localhost 不会共享数据。

`npm test` 检查本机工作区；`npm run smoke` 在构建后检查桌面。`npm run pack` 生成 Windows x64 免安装目录（分发时保留整个目录）。后端单独运行，免安装目录不包含数据库。

详见 [0.2 交接记录](docs/0.2-progress.md) 和 [0.2 API](docs/0.2-api.md)。工作空间另有 `版本文档/0.2`；旧版记录见 [0.1 开发记录](docs/0.1-progress.md)。

## 开发文档

- [开发规划（组员版）](开发文档/开发规划-组员版.md)
