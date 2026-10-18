# 不二布丁光子 · dsh-notpdpton

个人专属的 DeepSeek Harness 插件包。

本包是一个 bundle：在 DSH 的 Plugins 页面显示为一张卡片「不二布丁光子」，
卡片下列出两个可独立开关的组件。每个组件都是独立的包，拥有自己的 Host 半边、
浏览器半边、图标与多语言文案。

| 组件 | 包名 | 能力 |
| --- | --- | --- |
| 异常中断恢复 | `dsh-notpdpton-recover` | 会话非正常结束时，在输入框上方显示提示与「继续」按钮 |
| 窗口位置与尺寸记忆 | `dsh-notpdpton-window` | 重开应用时，窗口回到关闭时的位置与大小 |

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
| `settings.section` | 插件包的设置页「不二布丁光子」 |
| `notpdpton.settings.group` | 上述设置页的子槽位，各组件在此各自添加开关块 |

点击「继续」会填入一条接续指令：告知模型上次会话未正常结束、中断于第几轮，
并附带未完成的任务清单。开关「提示手动停止的会话」关闭后，仅提示非用户主动结束的会话。

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

## 安装

将三个包链接到 DSH profile，并把**包本身**加入 bundle 列表：

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

两个组件包不带 patch，也不进入 bundle 列表，由包的 `cordis.patch.yml` 逐行插入：

```yaml
- insert:
    - id: dsh-notpdpton-recover
      name: 'dsh-notpdpton-recover'
    - id: dsh-notpdpton-window
      name: 'dsh-notpdpton-window'
```

## 目录结构

```
dsh-notpdpton/
├── index.js             Host 半边（包本身不注册能力）
├── cordis.patch.yml     插入两个组件的 Loader patch
├── package.json
├── icon.svg             Plugins 页面的卡片图标
├── locale/              卡片标题与描述
├── docs/
│   └── window-state.md  窗口记忆功能的设计文档
├── recover/             dsh-notpdpton-recover
│   ├── index.js         Host 半边：interruption 投影
│   ├── client.js        浏览器半边：提示条与设置页
│   └── locale/
├── window/              dsh-notpdpton-window
│   ├── index.js         Host 半边
│   ├── client.js        浏览器半边：测量、放置、持久化
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
