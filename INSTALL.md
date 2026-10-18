# 安装教程（各 Linux 发行版通用）

[README](README.md) 的快速开始以 Omarchy/Hyprland 为例；本文面向**所有常见 Linux 发行版与桌面环境**：Arch 系、Debian/Ubuntu、Fedora、openSUSE，以及 GNOME、KDE、XFCE、Cinnamon、Sway 等。

> Kuafu（夸父）是**非官方**项目（夸克网盘 / Quark Cloud），与夸克官方无任何隶属关系。

## 总览

| 项目 | 要求 |
|---|---|
| 桌面 | 任意带图形界面的 Linux（X11 与 Wayland 均可，启动器自动适配） |
| 托盘 | 需要 StatusNotifier 托盘：KDE/Cinnamon 内置；GNOME 需扩展；XFCE 需插件（见下文） |
| Electron | ≥ 37。**二选一**：发行版包管理器（方法 B）或项目内 npm 安装（方法 A） |
| 磁盘/网络 | 首次 npm 安装约需下载 100–200 MB |

## 方法 A：项目内 npm 安装（通用，推荐）

只要系统能装 Node.js 就能用，适合 Debian/Ubuntu/Fedora/openSUSE 等仓库里没有 Electron 的发行版。

### 1. 安装 Node.js（≥ 18）

```bash
# Arch / Manjaro / EndeavourOS / Omarchy
sudo pacman -S nodejs npm

# Debian / Ubuntu / Linux Mint
sudo apt install nodejs npm

# Fedora
sudo dnf install nodejs npm

# openSUSE
sudo zypper install nodejs npm
```

用 `node -v` 检查版本；若低于 18（例如 Ubuntu 22.04 自带的 12），任选一种升级：

```bash
# 方式一：NodeSource 官方源（Debian / Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 方式二：nvm（任意发行版；版本号如有更新以 nvm 仓库 README 为准）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 22
```

### 2. 获取项目并安装 Electron

```bash
git clone https://github.com/Echeq/Kuafu.git ~/kuafu
cd ~/kuafu
npm install
```

（没有 git？在 GitHub 页面下载 ZIP，或解压发行版 tar 包，效果相同。）

> **中国大陆网络加速**：Electron 二进制默认从 GitHub 下载，可能很慢。改用国内镜像：
>
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

### 3. 安装托盘依赖（选你的发行版执行）

```bash
# Arch 系
sudo pacman -S libayatana-appindicator

# Debian / Ubuntu / Mint
sudo apt install libayatana-appindicator3-1

# Fedora
sudo dnf install libayatana-appindicator-gtk3

# openSUSE
sudo zypper install libayatana-appindicator3-1
```

极简系统（自己装的 WM、没有完整桌面）若报缺少 `libnss3`、`libgbm1`、`libasound2` 等，按报错提示逐个安装即可。

### 4. 注册启动器并启动

```bash
bash install.sh     # 写入桌面启动器与图标（指向本目录）
```

之后在应用菜单里搜索 **Kuafu** 打开（或运行 `bash run.sh`）。首次启动用手机夸克 App 扫码登录。

## 方法 B：发行版仓库的 Electron（免 Node.js）

系统里已经有 `electron` 可执行文件时，可跳过 npm 步骤：

```bash
# Arch / Manjaro / EndeavourOS
sudo pacman -S electron

# Omarchy
omarchy pkg add electron43

# 其他发行版先搜索一下（Debian/Fedora/openSUSE 视版本而定）
apt search electron     # 或 dnf search electron / zypper search electron
```

装完后同样执行 `bash install.sh`，再用 `bash run.sh` 或应用菜单启动。

> `run.sh` 会自动按 **electron43 → electron → 项目内 node_modules** 的顺序查找 Electron，无需手动配置。

## 各桌面环境的托盘设置

| 桌面 | 情况 | 需要做什么 |
|---|---|---|
| KDE Plasma | 内置支持 | 无 |
| Cinnamon | 内置支持 | 无 |
| GNOME | 默认没有托盘 | 装扩展 `gnome-shell-extension-appindicator`（Arch、Debian、Fedora 包名相同），注销重新登录后在"扩展"里启用 |
| XFCE | 需插件 | 装 `xfce4-statusnotifier-plugin`（Arch：`sudo pacman -S xfce4-statusnotifier-plugin`），再在面板里添加"状态通知区域" |
| MATE / LXQt | 面板基本内置 | 若没有，加装 indicator 小程序/插件 |
| Sway / Hyprland / i3 等平铺 WM | 取决于状态栏 | 用 Waybar（带 tray 模块）或 Polybar 等支持 SNI 的状态栏承载 |

## 首次使用速览

| 操作 | 方式 |
|---|---|
| 打开 / 聚焦 | 应用菜单搜 "Kuafu"，或运行 `bash run.sh` |
| 收进托盘 | 窗口右上角 ✕ / −（标题栏由应用自绘） |
| 真正退出 | 托盘菜单 → Quit；或 Ctrl+Q |
| 下载整个文件夹 | 标题栏 ⬇ 或 Ctrl+Shift+D |
| 刷新 / 开发者工具 | Ctrl+R 或 F5 / F12 |

完整功能说明见 [README](README.md)。

## 可选：开机自启

```bash
mkdir -p ~/.config/autostart
cp ~/.local/share/applications/Kuafu.desktop ~/.config/autostart/
```

## 更新版本

```bash
cd ~/kuafu
git pull
bash install.sh   # 目录移动过、或换了发行版时执行
```

## 常见问题

| 现象 | 处理 |
|---|---|
| `Error: Electron not found` | 执行方法 A 的 `npm install`，或方法 B 安装系统包 |
| 托盘没有图标 | 见上文"各桌面环境的托盘设置"；GNOME 装扩展后需注销重登 |
| npm 下载超时或极慢 | 使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install` |
| 无法输入中文 | 确保 fcitx5（或 ibus）正在运行；启动器在 Wayland 下已带 `--enable-wayland-ime` |
| 应用菜单里的图标点了没反应 | 项目目录被移动过：进新目录重新执行 `bash install.sh` |
| 找不到关闭/最小化按钮 | 正常：标题栏由应用自绘，按钮在窗口右上角 |
| 卸载 | `bash uninstall.sh`（加 `--purge` 同时删除登录会话） |
