# HarScience 0.2.1-rc.16

> 科研理工版：把数学建模、工科题解、化学结构、文献阅读放进同一个工作台。
> 这一版把「化学工作台」从 Python/RDKit 内核换成纯 Node 内核 —— 装完就能用，不再需要本机 Python。

## 这一版改了什么

- **化学工作台不再依赖 Python**：面板的分子性质、结构校验、标准化、格式转换（SMILES / 分子式）、子结构匹配、Tanimoto 相似度、批量清洗与去重，全部由一个内置的纯 Node 内核现算，不再外挂 `chemcore.cli`。之前出现过的「chemcore 自检 没有输出（退出码 9009）」在这版里不会再有 —— 那是面板去找 `python3`，而本机只有微软商店的占位符。
- **InChI / InChIKey 暂不支持**：这两种格式需要 InChI 原生库，纯 Node 内核不带；点这两个按钮会明确告诉你原因，而不是编一个假值。需要 InChI 的场合请继续用外部工具。
- **大分子解析照常可用**：多肽（单字母 / 三字母）、HELM、IDT 与 DNA / RNA 序列都能转成结构，算分子式与分子量；「自动」这一档不猜裸字母串，会提示明确选类型。
- **逆合成仍需自己接后端**：插件配置里填 `retroCommand` 指向你的逆合成服务；没配时会直接说明「未配置」，不再假装在跑。
- **关闭窗口默认退出程序**：点右上角 × 就是真的关掉（rc.15 已发布过这一条，这里再确认一次）。想让它在托盘里常驻，右键托盘图标选「关闭窗口后：保留后台 ✔」，这个选择会记住。
- 其余内容与 rc.15 一致：Python / MinGW / R 三套运行时按需下载（优先国内镜像）、鲸鱼娘表情包、编辑器、工作站（IDE）模式、余额显示等。

## 安装

1. 下载本页的 `HarScience_0.2.1-rc.16_x64-setup.exe`（推荐）或 `.msi`；
2. 离线安装：把 `HarScience-seed-0.2.1-rc.16.tar.zst.part1…part4` 全部下载到同一个目录，安装后在
   `安装目录\data\desktop\seed\downloads\` 里放好（文件名保持 `.part1`、`.part2`… 的数字后缀，程序会按数字顺序拼接）；
3. 第一次启动会自己准备运行时：
   - Python 3.13 + numpy/pillow/sympy，来自 npmmirror / 清华 PyPI 镜像；
   - MinGW-w64 g++ 16.2，来自南京大学镜像；
   - R 4.6.2：**会在桌面上弹一次 UAC 授权框，点「是」即可**。后台进程的提权请求会被系统自动拒绝，日志里就是
     `runtimes: r stopped (installer exited with code 97)`，下次启动会自动重试。
4. 化学工作台开箱可用，不用再装任何 Python 包。

## 已知

- R 的安装需要一次管理员授权（见上）；不想装 R 可以忽略，其余功能不受影响。
- InChI / InChIKey 转换需要原生 InChI 库，本版未内置。
- 逆合成页签需要自备后端（`retroCommand`）。
- 离线包约 460 MB，分 4 卷上传（单卷上限 64 MB）。

## 校验

发布页的 `publish-harscience-0.2.1-rc.16-manifest.json` 里记录了每个分卷的字节数与 sha256；整包 sha256 也在里面。装完可以在
`安装目录\data\desktop\seed\downloads\` 用 `certutil -hashfile <文件> SHA256` 对一遍。
