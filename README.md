<div align="center">

# AGY Dock (`AGY-Dock` v2.10.0)

**AGY Dock**（原 *AGY Plugin Manager* / `AGY-Launcher`）是一个专为 **Google Antigravity IDE** 打造的解耦式 Windows 桌面控制中心、进程管家与 Chrome DevTools Protocol（CDP）桥接启动器。

**简体中文** | [English](README_EN.md)

[项目简介](#项目简介) · [插件接入规范](PLUGIN_INTEGRATION.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md) · [提交官方插件](.github/ISSUE_TEMPLATE/submit-official-plugin.yml) · [提交第三方插件](.github/ISSUE_TEMPLATE/submit-third-party-plugin.yml)

</div>

---

## 项目简介

AGY Dock 可以干净地启动 **Google Antigravity IDE** 并按需注入代理配置，同时调度各类外部插件，全程不修改宿主 IDE 的原版程序文件（`Antigravity.exe`、`app.asar` 或 `version.dll`）。

### 核心功能

- **纯净宿主机隔离**：用户数据（`plugins.json`、`plugins/`、`logs/`、`account-quota-cache.json`）统一存放在 `%LOCALAPPDATA%\AGY-Plugin-Manager`（当程序旁存在 `plugins.json` 或 `.portable` 时自动切换为便携模式），与安装包自带程序文件彻底分离。
- **双轨插件市场**：
  - **官方市场**（[`plugins-catalog.json`](plugins-catalog.json)）：收录经过审核或专为 AGY Dock 维护的官方认证插件。
  - **第三方市场**（[`third-party-catalog.json`](third-party-catalog.json)）：收录托管在外部 GitHub 仓库的社区插件，自带两级静态安全扫描（`Low` / `Medium` / `High` 风险评级 + 敏感权限标签），并支持添加自定义私有仓库源。
  - **一键提交插件**：支持通过 GitHub Issue 表单或应用内**快捷提交（Quick Submit）**流程提交官方或第三方插件，自动完成发布包校验与上游版本同步。
- **多运行时支持与安全桥接**：
  - 支持 `node-cdp`、`exe-cdp`、`node-companion`、`ps-companion`、`py-companion` 及 `custom` 类型插件。
  - **Manager 安全进程桥接**：伴随进程类插件可通过本地回环接口（`AGY_BRIDGE_URL`）按权限执行本地操作，避免直接放开无限制的宿主系统权限。
- **工作区、额度与存储管理工具**：
  - 实时查看 Antigravity 配额与遥测状态、原生扩展清单、自动识别 IDE 与本地代理客户端、内置交互式**存储管理（Storage Manager）**（支持按树状图/列表清理 AGY 本地数据与项目文件），以及无打扰的更新提醒。

---

## 相关文档

| 文档 | 说明 |
| :--- | :--- |
| [`PLUGIN_INTEGRATION.md`](PLUGIN_INTEGRATION.md) | 完整的插件架构、`agy-plugin.json` 清单规范、双轨市场标准、`settings.html` SDK 与伴随进程安全桥接协议。 |
| [`CHANGELOG.md`](CHANGELOG.md) | 桌面端应用、插件市场、安全扫描器与启动器的完整版本更新记录。 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 向插件市场提交插件及向 AGY Dock 贡献代码的快速指南。 |

---

## 官方市场目录与内置插件包

AGY Dock 在 [`AGY-Launcher/plugin-packages/`](AGY-Launcher/plugin-packages/) 目录提供标准 `.zip` 示例插件包，并在 [`plugins-catalog.json`](plugins-catalog.json) 发布官方市场目录：

| 插件 ID | 名称 | 类型 | 简介 |
| :--- | :--- | :--- | :--- |
| `office-viewer` | Antigravity Office Viewer | `node-cdp` | 通过 Antigravity CDP 提供 Word、Excel、PowerPoint 与离线 PDF 高清实时预览面板。 |
| `antigravity-hans` | Antigravity Hans | `node-cdp` | 纯 Node.js 动态汉化引擎，实时翻译 Antigravity 界面、Agent 面板与 Swarm 看板。 |
| `agy-telemetry` | Antigravity Telemetry | `node-cdp` | 极简会话输出速度、缓存命中率与上下文使用占比实时监控浮窗。 |
| `agy-quota-badge` | Antigravity Quota Badge | `node-cdp` | 在模型选择器旁显示 5 小时与周额度徽章，支持悬停查看重置倒计时与自定义配色。 |
| `agy-pixel-pets` | AGY Pixel Pets | `node-cdp` | 硬件加速的交互式像素桌面宠物，可随 Antigravity AI 活动状态实时互动。 |
| `obsidian-prism-lite` | Obsidian Prism Lite | `node-cdp` | 轻量级光学界面美化插件，内置多套深浅配色主题、动效与侧栏快捷控制。 |

每个插件包根目录均包含 `agy-plugin.json` 清单文件（`schemaVersion: 1`）。完整打包与分发规范请参阅 [`PLUGIN_INTEGRATION.md`](PLUGIN_INTEGRATION.md)。

---

## 安装与快速上手

### 方式一：独立 Windows 安装包（推荐）

1. 下载或自行构建 `dist-release/AGY-Dock-Setup-v2.10.0.exe`。
2. 运行安装向导：
   - 自动扫描本机 `Antigravity.exe` 安装位置（也可手动浏览指定）。
   - 默认将纯净的管理端程序安装到 `%LOCALAPPDATA%\AGY-Plugin-Manager`，升级时自动保留现有配置与已装插件。
   - 自动创建**桌面**和**开始菜单**快捷方式（`AGY Dock`），安装完成后立即启动。
3. 支持自动化或 CI 静默安装：
   ```powershell
   .\AGY-Dock-Setup-v2.10.0.exe /S
   ```

### 方式二：安装插件（插件市场或拖拽安装包）

1. 打开 **AGY Dock**，直接在**插件市场**（官方或第三方标签页）点击安装所需插件。
2. 也可以进入**我的插件**页面，直接将 `.zip`、`.agypkg` 或 `.agy-plugin` 压缩包拖入窗口（或点击**安装插件包**）。
3. AGY Dock 会自动校验压缩包路径（拦截路径穿越风险）、检查 `agy-plugin.json`、按需执行静态安全扫描，并将文件解压到 `plugins/<id>/` 后登记到 `plugins.json`。

---

## 自动识别、存储清理与更新服务

- **Antigravity IDE 自动识别**：从运行中进程、Windows 注册表（`Uninstall`、`App Paths`、URL 协议）、常见默认安装路径（`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`）及快捷方式中自动定位 `Antigravity.exe`。
- **本地代理自动识别**：自动读取 Windows 网络设置（`ProxyEnable` / `ProxyServer`）、环境变量及常见代理客户端（`Clash`、`Mihomo`、`Clash Verge`、`FlClash`、`v2ray`、`xray`、`sing-box`、`Hiddify`、`Shadowsocks`），一键预填按需代理参数，绝不修改全局系统代理。
- **存储管理**：可在 **AGY 本地数据** 与 **项目文件** 之间切换，直观查看大体积目录、浏览子文件夹并安全清理缓存，同时完整保护已登记的项目根目录。
- **更新服务**：在启动时、每隔 15 分钟以及在**设置**中手动检查时请求 `https://www.haoanlab.xyz`；旧版 `ahmustudyhelper.xyz` 配置在迁移期间仍保持兼容。

---

## 开发与源码构建

### 环境准备

- Node.js 22+ 与 npm
- Rust 稳定版工具链（`x86_64-pc-windows-msvc`）及 Tauri v2 Windows 编译环境
- Python 3.11+（用于打包插件压缩包）

### 从源码启动

```powershell
npm ci
npm run tauri:dev
```

### 打包标准插件包

```powershell
cd AGY-Launcher
python scripts/package_plugins.py
```

### 本地安全扫描插件包

```powershell
node scripts/scan-plugin.mjs path/to/plugin.zip
```

### 构建 Windows 桌面端与安装程序

```powershell
node scripts/build.mjs windows x64
```

构建产物会输出到 `dist-release/AGY-Dock-Setup-v<VERSION>.exe`。

### 运行测试

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
node --test AGY-Launcher/tests/process-manager.test.mjs
```
