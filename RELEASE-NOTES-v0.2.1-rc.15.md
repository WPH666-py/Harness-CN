# HarScience 0.2.1-rc.15 — Harness 科研理工版

HarScience 是 Harness 的第一个分版：同一个底座，换成科研理工的一套插件与运行时。它和 Harness-CN 共用内核，但面向数学建模、工科题解、学术检索与科学计算。

## 安装

1. 下载 `HarScience_0.2.1-rc.15_x64-setup.exe`（推荐）或 `HarScience_0.2.1-rc.15_x64_zh-CN.msi`，双击安装。
2. 首次启动需要离线包：下载 `HarScience-seed-0.2.1-rc.15.tar.zst.part1` … `part7`（共 7 个分卷），放进**安装目录**下的 `data\desktop\seed\downloads\`（本机是 `D:\Harness\HarScience\data\desktop\seed\downloads\`），重启应用。
3. 也可以下载后用 PowerShell 按序号拼接成整包再放进同一目录：

```powershell
$parts = Get-ChildItem 'HarScience-seed-0.2.1-rc.15.tar.zst.part*' | Sort-Object { [int]($_.Name -replace '.*\.part','') }
$out = [IO.File]::Create("$PWD\HarScience-seed-0.2.1-rc.15.tar.zst")
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Dispose() }
$out.Dispose()
```

分卷清单（按序号）：

  'HarScience-seed-0.2.1-rc.15.tar.zst.part1',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part2',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part3',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part4',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part5',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part6',
  'HarScience-seed-0.2.1-rc.15.tar.zst.part7',

## 与 Harness-CN 0.2.1-rc.15 的差别

- 插件表按分版过滤：办公与 IM 一套（Office、GenUI、IM 机器人、邮件、WeChat、QQ 机器人、WorkBuddy Connect、通知提醒、Trae/Qoder 连接、聊天导入迁移）在 HarScience 里不装入，科研理工一套全部保留。
- 鲸鱼娘表情包 `dsh-meme 0.1.56` 随包内置，以本地归档安装 —— 离线机器不会再因为 `github:` 规格无法解析而丢掉它。
- 启动横幅、窗口标题、安装包与桌面快捷方式图标都换成 HarScience（`icons/harscience.ico`，由 `HarScience.png` 生成六种尺寸）。
- 首次启动会在后台准备三套科研运行时，全部优先走国内镜像，失败才回落到上游：
  - **Python 基础层**（python-build-standalone 3.13 + numpy / Pillow / sympy / mpmath 轮子）：npmmirror → 南京大学镜像 → GitHub；轮子走清华 TUNA → files.pythonhosted。
  - **MinGW C++**（winlibs GCC 16.2.0，含 g++ 与 mingw32-make）：南京大学镜像 → GitHub。
  - **R 4.6.2**：清华 TUNA → 中科大 → CRAN 官方。CRAN 只发布 Inno Setup 安装包，没有便携 ZIP，所以这一项是静默运行安装程序；需要提权的环境下会失败并在日志里记一行 `runtimes: r stopped (…)`，下次启动重试。
  - 下载与安装都在窗口之后进行，日志里能看到 `runtimes: <组件> trying <url>` / `ready` / `stopped (<原因>)`，装好后标记落在 `<安装目录>\data\runtimes\<组件>\`。
- 编辑器一侧沿用 rc.14 的能力：多标签可编辑、Ctrl+S 保存、关闭即保存、图片预览、编码嗅探（UTF-8 / UTF-16 / GB18030，非 UTF-8 以只读方式显示）、行号栏与当前行淡蓝光标带、三栏 1 px 实线分隔、长行横向滚动。
- 对话区在输入框上方留出 28 px 余量：长回答的最后一段不会再贴着输入卡上沿、落进它的淡出带里。
- 侧栏的启动日志行、窗口标题、托盘提示都跟着分版走，HarScience 里不会再出现 `Harness-CN` 字样。

## 已知

- REA 插件（逆向小工具）首次使用时另需约 800 MiB 运行时（Node、JDK、Ghidra 等），同样在后台自动下载；它的 IDA / Hopper / Kuna 集成需要自备授权软件。
- `runtimes` 的 R 组件依赖安装程序静默安装：首次启动会在桌面上弹一次 UAC 授权框，点「是」即可；拒绝或超时的话日志里是 `runtimes: r stopped (installer exited with code 97)`，下次启动会自动重试。Python 与 MinGW 是纯解压，不会提权。
- 首次启动还会给内置 Python 装上 `chemcore` 与 `rdkit`（化学工作台要用），同样优先走清华镜像；断网时化学工作台会提示「本地计算服务没起来」。
- 打包机与上次相同的三处手工设置已固化进构建脚本：`DSH_CLIENT_COMMIT_HASH` / `DSH_CLIENT_VERSION` 由脚本推导，`TEMP` 指向可写目录，WiX 失败时用 `-sval` 重链 MSI。
- `sharp` 的安装脚本被 pnpm 忽略（上游已知），`dsh-free-vision` 的构建脚本同理，不影响启动。
- 离线包约 560–600 MiB，`store-archives` 体积仍是 Harness-CN 的两倍左右，原因未查清。

## 校验

SHA-256 见 `publish-harscience-0.2.1-rc.15-manifest.json`，与本页附件同批上传。
