# AGENTS.md

Electron 外壳：在 Hyprland/Omarchy（以及任何带 StatusNotifier 托盘的 Linux 桌面）上，把夸克网盘网页版（pan.quark.cn）包装成原生感窗口。`README.md` 是面向用户的文档（**中文**，项目所有者要求全部 `.md` 文档以中文维护）。本项目为**非官方**社区项目，显示名为 `Kuafu`（夸父）。

## 仓库事实
- 无构建系统、无打包器、无测试、无 lint、无 CI、无锁文件。`npm install` 只是给没有系统 `electron43` 的机器装 Electron。
- 不是 git 仓库（没有 `.git`）——不要依赖 git 历史或回滚。
- `src/main.js` 就是整个应用：窗口、托盘、主题、权限、下载、单实例。标题栏是本地的独立页面（`src/titlebar/`），运行在 `BrowserWindow` 中；真正的网站在下方独立的 `WebContentsView` 里。改一层永远不会影响另一层。
- 文件夹下载（网页版拒绝的功能）在 `src/quark-download.js`，由 `main.js` 触发；`src/view-preload.js` 在站点视图中检测网站"网页端不支持文件夹下载"的提示。
- **显示名与内部名**：界面/文档显示名为 `Kuafu`（夸父）；但 `package.json` 的 `name` 保持 `quark-cloud` —— 用户数据目录（`~/.config/quark-cloud`）、单实例标识与登录会话都依赖它，改名会让所有用户需要重新扫码登录。不要改。（历史显示名：Quark Cloud → QuarkCloud for Linux → Kuafu，均已废弃。）

## 运行与验证
- `bash run.sh` 是唯一的真实启动方式：按 `electron43 → electron → electron39…electron36 → node_modules/` 顺序查找 Electron（兼容任意发行版），并传入 `--ozone-platform-hint=auto --enable-wayland-ime --wayland-text-input-version=3 --class=quark-cloud`。这些参数必须保留——Hyprland 窗口规则和中文输入法依赖它们。
- `INSTALL.md` 是面向所有发行版/桌面（Debian、Fedora、GNOME、KDE……）的中文安装教程；安装流程或依赖包名有变化时同步更新它。
- `electron .` / `npm run dev` 会缺少 `--class` 和 IME 参数，只适合快速检查。`--dev` 参数是死代码，没有地方读取它。
- `Ctrl+R`/`F5`/`F12` 作用于**站点视图**，不是标题栏。标题栏 HTML/CSS/JS 的改动需要重启应用（无热重载）。手动验证：运行、观察终端输出、使用 devtools。

## 易碎接线（改前必读）
- `TITLEBAR_HEIGHT`（`src/main.js`）必须等于 `#bar { height }`（`src/titlebar/titlebar.css`）；站点视图按该常量下移，数值漂移会裁切或留缝。
- 标题栏 ↔ 主进程的 IPC 全部经过 `window.qc`（`src/preload.js`）。新增通道必须同时加 `main.js` 处理器和 `preload.js` 入口。渲染器是沙箱 + 上下文隔离：标题栏代码里没有 `require()`。
- 不要在不理解的情况下删除：
  - `buildUA()` Chrome UA 伪装——网站拒绝 Electron 的 UA（登录/反爬）。
  - `IN_APP_HOSTS` 正则——域外链接会被有意交给系统浏览器。
  - `setPermissionRequestHandler`/`setPermissionCheckHandler` 白名单——刻意保持最小（无摄像头/麦克风、无静默剪贴板读取），且仅限夸克域名。
  - `openExternalSafely()`——只有 http/https/mailto 能进入 `shell.openExternal`；页面 URL 不可信，绝不能原样传入。
  - IPC 发送方校验（`fromTitlebar`/`fromSiteView`）与标题栏导航锁定。
- 主题颜色用正则（不是 TOML 解析器）从 `~/.local/state/omarchy/current/theme/colors.toml` 读取，启动时读一次、每 20 秒轮询；文件缺失时有 `FALLBACK_COLORS` 兜底。标题栏 CSS 变量由 `readThemeColors()` 设置。

## 文件夹下载（`src/quark-download.js`）
- 网页版拒绝下载文件夹（"网页端不支持文件夹下载"）；本模块模仿 PC 客户端调用夸克私有接口：`drive-pc.quark.cn/1/clouddrive/file/sort`（递归列表）与 `/file/download`（`{fids}` → 签名 `download_url`），始终带 `pr=ucpro&fr=pc`。
- 每次调用都必须带 `credentials: 'include'`（API 与 CDN 都一样）：默认 same-origin 模式下 Electron **不会**把会话 Cookie 发给 `drive-pc.quark.cn`，接口会返回 31001 "require login [guest]"——看起来像登录过期，其实不是。Cookie 来自默认会话（应用内登录），不额外存储任何凭据。
- PC 客户端 UA（`CLIENT_UA`）是关键：普通浏览器 UA 会得到 23018（风控）。
- `download_url` 是签名直链、会过期：按 50 个一批获取，失败时对单个文件刷新一次。无断点续传；文件原样覆盖。
- 触发入口：标题栏 ⬇（`folder:download` IPC）、`Ctrl+Shift+D`、托盘菜单，以及 `src/view-preload.js` 检测到网站拒绝提示时的自动询问。
- 目标文件夹来自视图 URL 的 hash（`#/list/all/<fid>-<name>/…`，取最后一段）；根目录（fid `0`）会被拒绝；分享页面不支持。
- 不碰 UI 的端到端检查：把 `~/.config/quark-cloud/` 里的 `Cookies`、`Cookies-journal`、`Local State`、`Preferences` 复制到临时目录，用一个 `--user-data-dir=<临时目录>` 的小 Electron 脚本 require 本模块并使用 `_internal.{listFolder,apiDownloadLinks,downloadFile}`。一次同时验证登录态 + API + CDN，而真实应用可以照常运行。

## 安全说明
- Electron 的 Linux 构建不链接 libsecret：Chromium 把 Cookie 值**未加密**存储（`~/.config/quark-cloud/Cookies` 是明文 `value` 列，`Local State` 无 os_crypt 密钥），即使 gnome-keyring 在运行也一样。请把该目录视同夸克密码（不要同步/备份；`uninstall.sh --purge` 会销毁它）。同用户进程本来就能读取会话——这是 Electron/Linux 的既有限制，不是本应用的 bug。
- 标题栏页面不允许离开本地文件、不允许打开窗口（它的 preload 是特权 IPC 桥）；站点视图对页面不暴露任何东西。
- 文件夹下载会清洗文件名，并用 `O_NOFOLLOW` 写入（目标处若为符号链接则拒绝写入）。

## 状态 / 安装 / 打包
- 运行数据在 `~/.config/quark-cloud`（Electron userData）：登录 Cookie、`settings.json`（窗口几何、首次隐藏标记、downloadDir）。**永远不要写入仓库**；只有 `bash uninstall.sh --purge` 会删除它。
- `bash install.sh` 写入指向本目录绝对路径的桌面启动器（`Kuafu.desktop`，并顺带清理旧版 `QuarkCloud for Linux.desktop`、`Quark Cloud.desktop`）与图标——不复制任何项目文件，所以移动目录后启动器会失效，需要重新运行。
- `bash package.sh` 用 sed 从 `package.json` 读取版本号，把除 `dist/`、`node_modules/`、`.git/` 之外的全部文件打包为 `dist/Kuafu-<版本>.tar.gz`。发布前先在 `package.json` 里升版本号。
