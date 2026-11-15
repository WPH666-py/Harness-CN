# Harness-CN 0.1.5-rc.14（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版为 rc.13 的补丁：**「休闲食品商城」补上遗漏的第 9 个商品**，其余功能与 rc.13 相同。

> **关于版本号**：本发行版的 `0.1.5-rc.14` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.14_x64-setup.exe` | 27.46 MB（28,796,246 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.14.tar.zst` | 78.79 MB（82,617,788 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
80912A884DACEDEBFA22E006C8DCBBFEF7C00633123C24130FCF25FD891EC7D7  Harness-CN_0.1.5-rc.14_x64-setup.exe
87E37DCA9B7C1F009210C04AD764C0615A8672CF18D3D0D515CFDE72B0F263AD  Harness-CN-seed-0.1.5-rc.14.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 商城补上第 9 个商品

rc.13 里商城只呈现了 **8 个商品**。原因是我把「青食精制/铁锌/特制钙奶饼干（迷你包装）」当成了没有链接的重复项：
当时收到的是 8 个链接、9 个产品描述，我把多出来的那一项去掉了。第 9 个商品的链接补上后，
商城现在完整呈现 **9 个商品**，每项都有独立的商品图、名称与购买链接，链接两两不重复。

| # | 商品 | 链接尾号 |
| --- | --- | --- |
| 1 | 青食不加蔗糖钙奶饼干（咸味/原味） | `lA8lZezJNq` |
| 2 | 青食夹心饼干（蓝莓/草莓/牛奶/巧克力） | `ahGuNYjRpL` |
| 3 | 青食生椰/香椰/金椰黄油饼干 | `z9M8OzjX3I` |
| 4 | 青食动物饼干 / 字母饼干 | `EwNOTuUVKR` |
| 5 | 青食菠萝豆（鸡蛋菠萝豆） | `K5qgUNwvMY` |
| 6 | 青食 1950 版钙奶饼干（铁锌/钙奶 多口味） | `Xt9qw1Tc0P` |
| 7 | **青食精制/铁锌/特制钙奶饼干（迷你包装）** | **`fptDgcMjqA`** |
| 8 | 青食黑松露火腿苏打饼干 | `2C49YaILEg` |
| 9 | 青食幼滑/颗粒花生酱（小罐装） | `jxPTKChL41` |

第 7 项的商品图重新从原始素材压缩生成（800px 宽、质量 82，151 KB），未使用任何缩略图或二次压缩的图。
商城图片合计 **0.92 MB**（9 张），安装包比 rc.13 增大 0.15 MB。

### 其余内容与 rc.13 相同

- 插件管理页为只读的**内置插件**（无安装、升级、卸载入口）。
- 顶部菜单：**作者信息**、**休闲食品商城**、**评价与反馈**。
- 更新链路修复（rc.12 引入）：安装程序由 shell 以 `CREATE_BREAKAWAY_FROM_JOB` 启动，
  不再被应用退出时的 job object 终止。

## 本次发布的验证方式

- 目录自检：**9 个条目、9 个链接（两两唯一）、9 张图（引用与文件一一对应，无缺失、无未使用）**。
- 资源目录确认含 `biscuit-calcium-mini.jpg`（151 KB），9 张图合计 0.92 MB 已进安装包。
- `pnpm run typecheck`：0 错误。Rust 重新编译通过（2m26s）。
- 完整流程重跑：`build:official` → `release:pack` → `prepare:packages` → `prepare:seed` → `prepare:shell` → `tauri build`。

**未做**：安装后逐个点开商城页肉眼确认 9 张图的排版效果。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板不出现（本基线未声明 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计不可用（需要基线无法设置的 `ignorable` 标记），检测与拦截不受影响。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
