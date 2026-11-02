# Harness-CN 0.2.1-rc.17

> 全量版：30 多个插件的内置发行版。
> 这一版修了三件用户实际碰到的事：IDE 文件树点不开子文件夹、R 非得装安装包、化学工作台不再依赖 Python。

## 这一版改了什么

- **IDE / 工作站的文件树可以逐级展开了**（对标 Trae）：之前只有根目录能展开，点文件夹没反应。原因是每个子文件夹的展开状态读的是「它所在那一层」的标志位，所以点下去状态写进了仓库、界面却永远不重绘。现在每一行订阅自己的路径，点一下就展开，再点一下收起，箭头图标和 `aria-expanded` 也跟着变。
- **R 语言不再需要安装包**：不再调用 CRAN 的 Inno Setup 安装程序，因此不会弹 UAC、也不会再出现 `runtimes: r stopped (installer exited with code 97)`。改成和 Python、MinGW 一样的做法——下载可移植的 `portable-r` ZIP，解包到 `data\runtimes\r` 后直接用；来源依次是国内 GitHub 加速镜像（ghfast / gh-proxy / ghproxy），最后才是 GitHub 本体。
- **化学工作台（dsh-chem-ui 0.0.2）不再依赖 Python**：分子性质、结构校验、标准化、格式转换（SMILES / 分子式）、子结构匹配、Tanimoto 相似度、批量清洗与去重全部由内置的纯 Node 内核现算，不再 spawn `python3`，之前那句「chemcore 自检 没有输出（退出码 9009）」不会再出现。
- **化学工作台的「画板」页签能打开了**：面板要把 Ketcher 塞进 `<iframe>` 再把结构读回来，跨源会被浏览器挡掉，所以这份编辑器必须由程序自己发。之前插件不自带、自带的下载脚本又是坏的（`url is not defined`），于是 `/chem/ketcher/*` 一直是 503、页签上写着「未配置 ketcherDir」。现在随包内置 Ketcher 3.18.0 的精简构建（30 MB，只保留 `index.html` 真正引用的入口和 chunk），启动时用 `CHEM_KETCHER_DIR` 指给插件，离线可用。
- **REA 插件的说明框改成浅色**：这个框原来的配色是插件里写死的深色（卡片 `#171a20`、按钮 `#4f8cff`），放在浅色页面上就是一块黑。现在卡片白底、正文 `#1f2328`、代码块浅灰、主按钮淡蓝底深蓝字，遮罩也调淡了。
- **InChI / InChIKey 暂不支持**：纯 Node 内核不带 InChI 原生库，点这两个按钮会说明原因而不是编一个假值。
- 其余与 rc.16 一致：关闭窗口默认退出、余额显示、鲸鱼娘表情包、编辑器多标签、工作站（IDE）模式、离线种子。

## 安装

1. 下载本页的 `Harness-CN_0.2.1-rc.17_x64-setup.exe`（推荐）或 `.msi`；
2. 离线安装：把 `Harness-CN-seed-0.2.1-rc.17.tar.zst.part1…part9` 全部下载到同一个目录，安装后放进
   `安装目录\data\desktop\seed\downloads\`（文件名保持 `.part1`、`.part2`… 的数字后缀，程序按数字顺序拼接）；
3. 需要科研计算能力时，第一次启动会自己准备运行时，全部是「下载解压」，不需要管理员权限：
   Python 3.13（npmmirror / 清华 PyPI）、MinGW-w64 g++ 16.2（南京大学镜像）、R 4.3.3 portable-r（国内 GitHub 加速镜像）。

## 已知

- R 走可移植包，版本是 4.3.3；需要 4.6 请自装官方版。
- InChI / InChIKey 转换需要原生 InChI 库，本版未内置。
- 逆合成页签需要自备后端（`retroCommand`）。
- 离线包分 9 卷上传（单卷上限 64 MB）。

## 校验

发布页的 manifest 里记录了每个分卷的字节数与 sha256；整包 sha256 也在里面。装完可以在
`安装目录\data\desktop\seed\downloads\` 用 `certutil -hashfile <文件> SHA256` 对一遍。
