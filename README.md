# TeamCode-Workbench-TCW
Team Task &amp; Code Collaboration System

## 0.1 本地客户端

已实现：Electron 桌面窗口、已有 Git 仓库导入、目录浏览、个人备注本地保存、Git 分支与改动状态、服务地址配置。

需要 Node.js >= 22.12、npm、Git for Windows。在仓库目录执行：

```powershell
npm ci
npm run dev
```

`npm test` 运行核心检查，`npm run smoke` 运行真实桌面检查（先 build），`npm run pack` 生成 Windows x64 免安装目录。关闭窗口即退出，未保存备注会提示。共享项目、任务、Git 写操作和 AI 尚未实现。

详细说明保存在工作空间的 `版本文档/0.1`；随代码交接见 [0.1 开发记录](docs/0.1-progress.md)。

## 开发文档

- [开发规划（组员版）](开发文档/开发规划-组员版.md)
