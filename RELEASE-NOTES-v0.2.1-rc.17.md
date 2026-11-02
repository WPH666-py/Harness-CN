# HarScience 0.2.1-rc.17

> 科研理工版：把数学建模、工科题解、化学结构、文献阅读放进同一个工作台。
> 这一版修了三件用户实际碰到的事：IDE 文件树点不开子文件夹、R 非得装安装包、科研版菜单里多余的 QQ 群管理。

## 这一版改了什么

- **IDE / 工作站的文件树可以逐级展开了**（对标 Trae）：之前只有根目录能展开，点文件夹没反应。原因是每个子文件夹的展开状态读的是「它所在那一层」的标志位，所以点下去状态写进了仓库、界面却永远不重绘。现在每一行订阅自己的路径，点一下就展开，再点一下收起，箭头图标和 `aria-expanded` 也跟着变。
- **R 语言不再需要安装包**：不再调用 CRAN 的 Inno Setup 安装程序，因此不会弹 UAC、也不会再出现 `runtimes: r stopped (installer exited with code 97)`。改成和 Python、MinGW 一样的做法——下载可移植的 `portable-r` ZIP（CRAN 官方二进制做的可重定位打包，Windows 上没有官方 ZIP），解包到 `data\runtimes\r` 后直接用；来源依次是国内 GitHub 加速镜像（ghfast / gh-proxy / ghproxy），最后才是 GitHub 本体。
- **科研版菜单去掉了「QQ 群管理」**：科研版不带 IM 插件，那个入口点开是空页面，删掉；办公全量版（Harness-CN）仍然保留。
- **化学工作台继续免 Python**：rc.16 引入的纯 Node 内核照旧，分子性质、校验、标准化、格式转换、子结构、相似度、批量清洗都在本机现算。
- 其余与 rc.16 一致：关闭窗口默认退出、余额显示、鲸鱼娘表情包、编辑器多标签、离线种子。

## 安装

1. 下载本页的 `HarScience_0.2.1-rc.17_x64-setup.exe`（推荐）或 `.msi`；
2. 离线安装：把 `HarScience-seed-0.2.1-rc.17.tar.zst.part1…part6` 全部下载到同一个目录，安装后放进
   `安装目录\data\desktop\seed\downloads\`（文件名保持 `.part1`、`.part2`… 的数字后缀，程序按数字顺序拼接）；
3. 第一次启动会自己准备运行时，全部是「下载解压」，不再需要管理员权限：
   - Python 3.13 + numpy/pillow/sympy，来自 npmmirror / 清华 PyPI 镜像；
   - MinGW-w64 g++ 16.2，来自南京大学镜像；
   - R 4.3.3（portable-r 可移植版），来自国内 GitHub 加速镜像；
4. 化学工作台开箱可用，不用再装任何 Python 包。

## 已知

- R 走可移植包，版本是 4.3.3（Windows 上没有 CRAN 官方的免安装包，更新版本要等上游）；需要用 4.6 的话仍可自己装官方版。
- InChI / InChIKey 转换需要原生 InChI 库，本版未内置。
- 逆合成页签需要自备后端（`retroCommand`）。
- 离线包分 6 卷上传（单卷上限 64 MB）。

## 校验

发布页的 `publish-harscience-0.2.1-rc.17-manifest.json` 里记录了每个分卷的字节数与 sha256；整包 sha256 也在里面。装完可以在
`安装目录\data\desktop\seed\downloads\` 用 `certutil -hashfile <文件> SHA256` 对一遍。
