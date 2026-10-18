# 不二布丁光子 · dsh-notpdpton

个人专属的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件包（PACK）。

这个仓库是一个 **bundle 包**：它在 DSH 的 Plugins 页面显示为一张卡片「不二布丁光子」，
卡片下方列出两个可以**各自独立开关**的组件。每个组件都是一个独立的 npm 包，
拥有自己的 Host 半边、浏览器半边、图标和多语言文案。

| 组件 | 包名 | 能力 |
| --- | --- | --- |
| 异常中断恢复 | `dsh-notpdpton-recover` | 会话非正常结束时，在输入框上方显示提示与「继续」按钮 |
| 窗口位置与尺寸记忆 | `dsh-notpdpton-window` | 重新打开应用时，窗口回到关闭时的位置与大小 |

## 能力说明

### 异常中断恢复

Host 半边注册一个名为 `interruption` 的 session projection（`ctx.sessionProjections.register`），
把持久化的会话日志折叠成浏览器需要的少量状态：

1. 这个会话是否**非正常结束**（崩溃、重启、刷新页面，而不是用户主动点停止）；
2. 它当时**进行到哪一步**，包括待办列表。

折叠放在 projection 里而不是浏览器里，是因为浏览器只持有一页滑动的事件窗口，
而 projection 每次都能看到全部已提交事件。该 projection 声明为 `wire` 视图，
算好的结果会被框架缓存并推送到客户端。

判定「主动停止 vs 异常中断」的依据是会话日志中的信号组合，而不是猜测——
`test/explain-aborts.mjs` 与 `test/scan-signals.mjs` 用真实的会话数据验证这套判别逻辑。

浏览器半边贡献三个位置：

- `conversation.input.dock` —— 输入框正上方的整宽区域（order `-10`，排在 todo/goal/queue dock 之上）
- `settings.section` —— 插件包自己的设置页「不二布丁光子」
- `notpdpton.settings.group` —— 上面那个设置页的子槽位，每个子功能往里塞自己的开关块

### 窗口位置与尺寸记忆

纯浏览器侧功能。Electron 主进程用硬编码的 bounds 创建 BrowserWindow 且不暴露任何
geometry IPC，Host 半边跑在普通 Node 子进程里也够不到窗口；但工作区文档**就是**那个窗口的
顶层文档，所以 `window.moveTo()` / `window.resizeTo()` 能直接作用到真实的 BrowserWindow。

几个实现上必须知道的点（完整推导见 [`docs/window-state.md`](docs/window-state.md)）：

- **坐标是错的，要修正**：带隐藏标题栏 + overlay 时，renderer 读到的
  `screenX/outerWidth` 与真实窗口矩形差一个固定的内缩量。因此放置逻辑是对「请求值」
  做修正循环，而不是直接拿测量值去 `moveTo`。
- **测量比计算难**：同一任务里 `moveTo` 后立刻读会**回显**刚请求的值；Windows 的移动动画
  会让间隔几十毫秒的两次读数互相矛盾。所以只在几何稳定后才接受测量
  （连续 `WINDOW_STABLE_READS = 5` 次读数一致）。
- **最大化不是用户选择**：关闭时处于最大化状态，重开时回到**最大化之前**的尺寸。
- **恢复发生在 `show()` 之后**：客户端半边要等页面加载完才运行，此时窗口已经可见，
  所以大幅跳位时可能看到一瞬间的重新摆放。这一点无法从客户端半边消除。

## 安装

本仓库包含三个包：包本身和 `recover/`、`window/` 两个组件目录。把三者都链接到
你的 DSH profile 里，并把**包本身**加进 bundle 列表：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-notpdpton": "link:../dsh-notpdpton",
    "dsh-notpdpton-recover": "link:../dsh-notpdpton/recover",
    "dsh-notpdpton-window": "link:../dsh-notpdpton/window"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-notpdpton"
      ]
    }
  }
}
```

只有包本身是 bundle（带 `dsh.bundle.patch` 和 `cordis.patch.yml`）；两个组件包
不带 patch，也不进 bundle 列表——它们由包的 `cordis.patch.yml` 逐行插入：

```yaml
- insert:
    - id: dsh-notpdpton-recover
      name: 'dsh-notpdpton-recover'
    - id: dsh-notpdpton-window
      name: 'dsh-notpdpton-window'
```

装好后在 DSH 的 Plugins 页面会看到一张卡「不二布丁光子」，下面两行组件各带开关。

> 之所以是两个独立包而不是同一个包里的两个子路径：一行的浏览器半边是按该行的
> **包根**去找 `package.json` 的 `dsh.client` 的，扫描要求**精确包名**，
> 所以 `dsh-notpdpton/window` 这样的子路径行拿不到组件 UI；而一个包最多只能贡献
> 一个浏览器模块（模块表以包名为键，第二个活跃来源是硬性组合错误）。

## 目录结构

```
dsh-notpdpton/           包本身（bundle）
├── index.js             Host 半边（刻意为空：包不注册任何能力）
├── cordis.patch.yml     把两个组件插进 Loader 的 patch
├── package.json
├── icon.svg             包在 Plugins 页面的图标
├── locale/              包自己的多语言文案（卡片标题与描述）
├── docs/
│   └── window-state.md  窗口记忆功能的完整设计笔记与实测数据
├── recover/             组件：异常中断恢复（dsh-notpdpton-recover）
│   ├── index.js         Host 半边：interruption projection
│   ├── client.js        浏览器半边：dock 提示 + 设置页
│   └── locale/
├── window/              组件：窗口位置与尺寸记忆（dsh-notpdpton-window）
│   ├── index.js         Host 半边（刻意为空：纯浏览器功能）
│   ├── client.js        浏览器半边：测量、修正、持久化
│   └── locale/
└── test/                离线验证脚本（见下）
```

## 验证

`test/` 下的脚本都是**离线**的：不需要启动 DSH，直接 `node` 跑。
它们执行的是**真正发布的文件**（通过 shim `window.__ModuleLoader__` 捕获入口），
而不是另写一份副本，所以验证的就是会装进 profile 的那份代码。

```bash
cd test
node verify-manifest.mjs          # 清单、patch、locales、图标、exports 的一致性总审计
node verify-metadata.mjs          # 模拟插件管理器的显示元数据读取
node verify-icons.mjs             # 每个图标的样式符合性与渲染审计
node verify-layout.mjs            # dock 布局规则的静态审计
node verify-host-resolution.mjs   # Host 为每行解析的每个资源是否可达
node verify-client.mjs            # 客户端半边：槽位注册、词典、渲染出的文案
node verify-continue.mjs          # 「继续」动作与各子功能开关
node verify-window-state.mjs      # 窗口放置：测量、修正循环、持久化、最大化处理
node verify-fold.mjs              # interruption 折叠（对真实会话日志，只读）
node verify-repair.mjs            # 崩溃会话的重开序列
node dump-session.mjs <id>        # 逐事件解释某个会话的判定结果
node explain-session.mjs <id>     # 为什么这个会话有/没有「继续」按钮
node explain-aborts.mjs <id>      # 区分主动停止与刷新/重启导致的中断
node scan-signals.mjs             # 在全部真实会话上扫描判别信号
```

## 提交签名

本仓库的提交使用 GPG 签名：

```bash
git config commit.gpgsign true
git config user.signingkey <你的密钥 ID>
git config gpg.program "C:/Program Files/GnuPG/bin/gpg.exe"   # Windows：别用 Git 自带的 gpg
```

> Windows 上 `git` 默认调用的 `git\usr\bin\gpg.exe` 连不上原生 GnuPG 安装的 keyboxd，
> 会直接报 `can't connect to the keyboxd`。显式指定原生 `gpg.exe` 即可。

## 许可

[MIT](LICENSE) © Archer Wei
