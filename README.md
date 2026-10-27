# 不二布丁光子 · dsh-notpdpton

个人专属的 DeepSeek Harness 插件包。

本包是一个 bundle：在 DSH 的 Plugins 页面显示为一张卡片「不二布丁光子」，
卡片下列出三个可独立开关的组件。每个组件都是独立的包，拥有自己的 Host 半边、
浏览器半边、图标与多语言文案。

| 组件 | 包名 | 能力 |
| --- | --- | --- |
| 异常中断恢复 | `dsh-notpdpton-recover` | 会话非正常结束时，在输入框上方显示提示与「继续」按钮 |
| 窗口位置与尺寸记忆 | `dsh-notpdpton-window` | 重开应用时，窗口回到关闭时的位置与大小 |
| 网络代理 | `dsh-notpdpton-proxy` | DSH 自身的网络请求走代理，并把代理信息告知模型 |

## 组件

### 异常中断恢复

Host 半边向 `ctx.sessionProjections` 注册名为 `interruption` 的投影，把会话日志
折叠为浏览器所需的少量状态：

- 该会话是否正常结束，以及未正常结束的原因（进程异常退出、重启或连接中断、
  任务出错、输出达到长度上限、任务被阻止、被手动停止）；
- 中断发生在第几轮；
- 中断时的任务清单（待处理 / 进行中 / 已完成）。

投影以 `wire` 视图声明，结果由框架缓存后推送到客户端。

浏览器半边贡献三个位置：

| 槽位 | 内容 |
| --- | --- |
| `conversation.input.dock` | 输入框上方的提示条：中断原因、轮次、任务清单，以及「继续」按钮 |
| `settings.section` | 插件包的设置页「不二布丁光子」，标题后标注包名与版本 |
| `notpdpton.settings.group` | 上述设置页的子槽位，各组件在此各自添加开关块 |

点击「继续」会填入一条接续指令：告知模型上次会话未正常结束、中断于第几轮，
并附带未完成的任务清单。开关「提示手动停止的会话」关闭后，仅提示非用户主动结束的会话。

设置页标题行在名称之后显示包名与版本（`dsh-notpdpton` · `v1.1.6`），与插件市场
标题的写法一致，便于反馈问题时截图即带上版本。浏览器半边读不到 `package.json`，
版本是 `recover/client.js` 中的常量，由 `test/verify-manifest.mjs` 与包清单比对，
忘记升版本会让校验变红。

### 窗口位置与尺寸记忆

浏览器侧功能。工作区文档即主窗口的顶层文档，因此 `window.moveTo()` 与
`window.resizeTo()` 可直接作用于 BrowserWindow（窗口由 Electron 主进程以固定
bounds 创建，未暴露 geometry IPC，Host 半边无法触及）。

行为：

- 重开应用时，窗口回到关闭时的位置与尺寸；
- 关闭时处于最大化状态，则以最大化之前的尺寸打开——最大化是临时状态，不是用户选定的摆放；
- 位置与尺寸保存在 `localStorage`，每次启动恢复一次（`sessionStorage` 标记），
  页面刷新不会覆盖用户刚刚调整的大小；
- 尺寸不低于 DSH 原生窗口最小值。

渲染进程读到的窗口矩形与真实窗口矩形存在固定的内缩差，因此放置采用对请求值的修正
循环：以测量值作为起点，按残差迭代请求，直至收敛或达到上限。设计细节与实测数据见
[`docs/window-state.md`](docs/window-state.md)。

### 网络代理

Host 侧功能。生效通道是 `node:http.setGlobalProxyFromEnv()`，它同时覆盖两条出站栈：
undici 的全局 dispatcher（`fetch`，即模型 API、`web_fetch`、HTTP MCP）与
`http(s).globalAgent`（自己构造请求的 SDK）。

| 能力 | 说明 |
| --- | --- |
| 代理来源 | 自动 / 系统代理 / 自定义 / 环境变量 / 直连，五种取值 |
| 协议 | `http://`、`https://`、`socks5://`（实验特性） |
| 认证 | 用户名 + 密码；密码存入 DSH 凭据库，不写配置文件、不进进程环境变量 |
| 排除 | 自定义跳过列表；本机回环地址始终直连，不可关闭。设置页输入框直接填入当前生效的排除列表 |
| 告知模型 | 独立的会话提示词注入开关；代理控制关闭时说明「未接管网络」，不会静默消失 |
| 提示词可改 | 设置页用**同一个框**编辑模板/查看实际注入文本；空模板直接填入带占位符的初始模板，可自定义模板（占位符由当前策略填充） |
| Shell 变量 | 按告知级别注入 `DSH_PROXY_URL` 等变量；与提示词开关互相独立 |

传给 `setGlobalProxyFromEnv()` 的是一个**合成环境对象**而非 `process.env`：
密码因此从不进入进程环境，也就不会被 shell 工具的子进程继承。

设置存在 profile 目录下的 `notpdpton-proxy.json`，由设置页的「网络代理」块管理，
保存即时生效，无需重启。配置区顶部显示当前已应用状态，来源和地址按需展开；
认证、会话提示词与 Shell、高级设置分组收纳。「启用代理」与「会话提示词注入」是两个
独立开关：前者只改路由，后者只改提示词。修改统一通过「保存并应用」提交，
「测试已保存配置」不会把未保存的输入当作生效配置。
设计细节、覆盖范围与限制见 [`proxy.md`](<docs/proxy.md>)。

## 安装

### 从 Git 仓库安装

在 DSH 的 Plugins 页选择安装，填入仓库地址：

```text
https://github.com/notpdpton/dsh-notpdpton
```

安装器会用 pnpm 拉取仓库，并把 `dsh-notpdpton` 加入当前 profile。根包通过
仓库内的相对 `file:` 依赖携带三个组件，因此组件不需要先发布到 npm；装好后
在 bundle 列表中选择 `dsh-notpdpton` 即可。

### 本地开发安装

开发源码时，把仓库和三个组件包链接到 profile，并把**包本身**加入 bundle 列表：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-notpdpton": "link:../dsh-notpdpton",
    "dsh-notpdpton-recover": "link:../dsh-notpdpton/recover",
    "dsh-notpdpton-window": "link:../dsh-notpdpton/window",
    "dsh-notpdpton-proxy": "link:../dsh-notpdpton/proxy"
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

三个组件包不带 patch，也不进入 bundle 列表，由包的 `cordis.patch.yml` 逐行插入：

```yaml
- insert:
    - id: dsh-notpdpton-recover
      name: 'dsh-notpdpton-recover'
    - id: dsh-notpdpton-window
      name: 'dsh-notpdpton-window'
    - id: dsh-notpdpton-proxy
      name: 'dsh-notpdpton-proxy'
```

四个包都不依赖任何第三方 npm 包，也不声明对宿主包的 peer 依赖（根包的
`dependencies` 只以 `file:` 指向仓库内的三个组件；三个组件包不声明依赖）：

- Host 半边只 import `node:` 内置模块，插件因此能从 profile 之外的目录直接加载；
- 浏览器半边只从模块表取 `react`，而 shell 已经 seed 了它；
- 组件之间不用 `dsh.client.inject` 排序。每块界面都通过
  `ctx.slots.inject('<slot>', ...)` 等待自己的槽位声明：提供者晚到就等待，
  提供者未启用则那块界面不出现，但这不会让组件本身加载失败或互相级联。

`test/verify-manifest.mjs` 把这组“无多余依赖约束”的声明当作不变量校验，
加回 peer 依赖或包级加载顺序会让校验变红。

## 目录结构

```
dsh-notpdpton/
├── index.js             Host 半边（包本身不注册能力）
├── cordis.patch.yml     插入三个组件的 Loader patch
├── package.json
├── icon.svg             Plugins 页面的卡片图标
├── locale/              卡片标题与描述
├── docs/
│   ├── window-state.md  窗口记忆功能的设计文档
│   └── proxy.md         网络代理功能的设计文档
├── recover/             dsh-notpdpton-recover
│   ├── index.js         Host 半边：interruption 投影
│   ├── client.js        浏览器半边：提示条与设置页
│   └── locale/
├── window/              dsh-notpdpton-window
│   ├── index.js         Host 半边
│   ├── client.js        浏览器半边：测量、放置、持久化
│   └── locale/
├── proxy/               dsh-notpdpton-proxy
│   ├── index.js         Host 半边：策略解析、安装、提示词、RPC
│   ├── client.js        浏览器半边：设置页的「网络代理」块
│   └── locale/
└── test/                离线验证脚本
```

## 验证

`test/` 下的脚本均为离线运行，不需要启动 DSH。它们加载实际发布的文件
（通过 shim `window.__ModuleLoader__` 捕获入口）进行校验。

```bash
cd test

# 结构与资源
node verify-manifest.mjs          # 清单、patch、locales、图标、exports 的一致性
node verify-metadata.mjs          # 插件管理器的显示元数据解析
node verify-icons.mjs             # 图标样式符合性与渲染
node verify-host-resolution.mjs   # Host 为每行解析的资源是否可达

# 浏览器半边
node verify-client.mjs            # 槽位注册、词典、渲染文案
node verify-layout.mjs            # 提示条布局规则
node verify-continue.mjs          # 「继续」动作与子功能开关
node verify-window-state.mjs      # 窗口放置：测量、修正循环、持久化、最大化

# 网络代理
node verify-proxy.mjs             # 解析、脱敏、提示词、真实路由、持久化、设置块
node verify-proxy-ui.mjs          # 设置表单的状态转换（草稿、保存、凭据、探针）
node verify-proxy-route.mjs       # 宿主路由与密码通道的端到端行为
node watch-proxy.mjs [port]       # 起一个会打印每次请求的假代理，用于手动联调

# 会话判定
node verify-fold.mjs              # interruption 投影（对真实会话日志，只读）
node verify-repair.mjs            # 崩溃会话的重开序列
node dump-session.mjs <id>        # 逐事件输出某会话的结构
node explain-session.mjs <id>     # 某会话为何显示／不显示「继续」
node explain-aborts.mjs <id>      # 主动停止与刷新／重启中断的区分
node scan-signals.mjs             # 扫描全部会话的判别信号
```

## 许可

[MIT](LICENSE) © Archer Wei
