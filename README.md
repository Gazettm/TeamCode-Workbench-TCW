# TeamCode-Workbench-TCW

## 0.4 Git 协作版本

本地工作区支持从 GitHub 克隆、查看差异、切换分支、选择文件提交、获取远程状态、推送和快进更新。在「设置」选择仓库，填写仓库级 Git 姓名和邮箱。私有仓库访问由本机 Git 凭据或 SSH 配置处理。

在「协作项目」绑定本机仓库后，任务负责人可创建或关联任务分支。提交验收前会检查该分支的本地改动和最近获取的推送状态。协作服务继续使用 0.3.0。

Windows 免安装版位于 release/0.4.1/TCW-win32-x64/TCW.exe。0.4.1 增加改动文件全选、中文状态和提交条件提示。源码构建和本机启动命令见 [0.4 交接记录](docs/0.4-progress.md)。

## 0.3 任务协作版本

新增任务发布与指派、唯一领取、开始、提交验收、委派复核、组长通过或退回、截止显示、项目动态及受约束成员移除。保持 0.2 的账号项目和本地备注。任务和动态须手动刷新。

升级前先停止原服务并备份本机数据库。在仓库根目录用 JDK 21 执行以下命令。已构建 0.3.0 JAR 时可直接运行第二行。

~~~powershell
mvn -f server/pom.xml package
.\scripts\Start-LocalServer.ps1
~~~

在 PowerShell 输入启动命令来运行脚本文件。逐行粘贴脚本正文会使 $PSScriptRoot 为空，导致启动失败。保持启动窗口打开，另开 PowerShell 可检查服务是否就绪。

~~~powershell
Invoke-RestMethod http://127.0.0.1:8080/api/health
~~~

返回 version 为 0.3.0、status 为 ready 后，可打开 release/0.3/TCW-win32-x64/TCW.exe，在客户端设置中连接 http://127.0.0.1:8080。Flyway 启动时应用 V2 迁移并保留已有账号和项目。

接口见 [0.3 API](docs/0.3-api.md)，交接见 [0.3 记录](docs/0.3-progress.md)，详细说明位于工作空间 `版本文档/0.3`。Git 写操作留到 0.4；实时与未读尚未实现。

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
