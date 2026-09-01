# dsh-ssh-remote

**DeepSeek Harness (DSH) agent preset —— 远程 Linux 专用工作模式。**

启动会话后输入一次 SSH 账号密码，之后这个会话里的**一切**都在远端 Linux 服务器上执行：命令走 SSH、文件走 SFTP，本地没有任何 shell / 文件 / 搜索工具——远程执行不是提示词约束，而是工具目录里根本不存在本地工具的结构性强制。同时自动维护终端风格会话日志、托管后台任务，并在 Web GUI 的每个会话里注入一个「SSH 终端」标签页实时回放。

## 功能

### 远端执行工具集（模型可见的全部工具）

**远端（SSH/SFTP）**：

| 工具 | 作用 |
|---|---|
| `ssh_connect` | 密码认证建立连接（支持 keyboard-interactive），密码仅存内存、从不回显、从不落盘 |
| `ssh_bash` | 远端执行命令；每次全新 shell；`workdir` / 超时（默认 120s 上限 600s）；`run_in_background` 转托管后台任务 |
| `ssh_read` / `ssh_write` / `ssh_edit` | SFTP 读写/字面量编辑远端文件（行号窗口、唯一匹配保护、自动建目录） |
| `sftp_upload` / `sftp_download` | 本地会话工作区 ↔ 远端传输（本地路径被限制在工作区内，越界拒绝） |

**本地（仅文件、无执行）**：`read` / `write` / `edit` / `glob` / `grep` —— 复用 DSH 官方沙箱化 fs 工具（`dsh-tool-fs` + `dsh-tool-fs-search`），限定在会话工作区内。会话需要看到本地工作区里有什么、就地编辑本地文件，但**组合里没有任何本地 shell 行**——本地命令执行在结构上不存在。

### 连接稳定性（自动重连 + 每次操作独立 SFTP）

云服务器（NAT / sshd 空闲策略）会静默断开几分钟未活动的 SSH 连接，导致工具调用报「无连接」或「SFTP operation timed out」。本模式内置**透明自动重连**和**每操作全新通道**，断开对模型不可见：

- `ssh_connect` 成功后，凭据只保留在进程内存（`lastCreds`，绝不落盘）；连接断开后，下一次任意工具调用（`ssh_bash` / `ssh_read` / `ssh_write` / `ssh_edit` / `sftp_upload` / `sftp_download`，含后台任务轮询）都会用内存凭据自动重建连接——不需要模型察觉到并重跑 `ssh_connect`
- **探活**：每次工具调用前发一个 10s 上限的无副作用 `true` 探针。死连接（TCP 已断但 ssh2 keepalive 还没察觉、条目残留在内存里）会被探针立即识破，走自动重连后重探一次；不再有「60s 挂起后报错」的窗口
- **同调用内自愈重试**：SFTP 操作（读/写/编辑/传输）失败若判定为连接性原因，自动拆连 → 重连 → **在同一个工具调用内重试一次**，成功即返回，模型完全无感；`ssh_bash` 的**命令**从不自动重跑（避免已执行的命令二次执行），但会拆连让下一次调用重建
- **每次操作独立 SFTP 通道**：通道不复用、操作完即关——一个卡死的通道永远不会污染下一次操作
- **exec 兜底超时**：连 exec 回调都不触发（死连接的另一种表现）时，`timeoutMs + 5s` 内必抛错并拆连，杜绝无限挂起
- **后台任务真正抗断开**：连接抖动**不会**终止托管任务（`setsid` 远程进程继续跑），轮询自动重连后继续读输出，正常完成任务
- 重连是**逐个会话共享的**：同一时刻多个工具调用并发重连，只会发起一次握手
- 每次重连成功在 journal 里记一行 `auto-reconnected to user@host:port after connection loss`；重连失败则给出明确报错并建议重跑 `ssh_connect`
- 可调参数（环境变量覆盖，进程启动时读取）：`DSH_SSH_KEEPALIVE_INTERVAL_MS`（默认 `15000`）、`DSH_SSH_KEEPALIVE_COUNT_MAX`（默认 `6`）、`DSH_SSH_PROBE_TIMEOUT_MS`（默认 `10000`）、`DSH_SSH_EXEC_GRACE_MS`（默认 `5000`）

> 若自动重连仍失败（比如服务器重启后密码失效），报错会明确指向「重跑 `ssh_connect`」。

### 托管后台任务（`run_in_background`）

- 远端以 `setsid` 独立会话启动，SSH 通道断开不影响进程
- 接入 harness jobs 体系：`job_output`（增量流式读取，多字节字节精确） / `job_list` / `job_kill`（杀整个进程组），完成时主动通知模型
- 会话结束自动终止托管任务；手动 `nohup` / `screen` / `tmux` 不受追踪、跨会话存活（两档生命周期有意区分）

### 会话日志（journal）

- 每个会话一个文件（按 SessionId 确定性命名，重连/重启/恢复都追加同一文件；旧的时间戳命名分段文件会在重连时自动按时间序合并收编）
- 终端风格：`[时间] user@host:port $ 命令` + 输出 + `[exit code: N]` 标记；文件操作/传输记录为注释行；连接/断开横幅
- 后台任务两段式记录：启动即记标记行 + 完整输出流式写入 `.ssh-remote/jobs/`（2MB 上限）；结束时补完成块（起止时间、退出状态、末 4KB 尾巴、完整日志指针）
- 全部写入串行化 fire-and-forget，日志失败绝不影响工具执行

### Web GUI 终端面板

- 在每个会话头部的「对话 | 轨迹」旁注入第三个标签 **SSH 终端**（点击接管整个内容区，含输入框；切回即还原）
- 仅在「当前会话运行于本预设」时显示：面包屑标题 → sessionId → 运行时组合（`composedPreset`）精确判定，普通会话完全不可见
- **工作区隔离**：会话内的面板只显示**同一工作区**的 SSH 记录与任务（按当前会话的 `header.cwd` 限定）；不同工作区的 `.ssh-remote` 互不可见。独立全页（`?all=1`，操作员视图）保留全量
- 跨会话同名任务（每个会话的第一个后台任务都是 `ssh-1`）按 `会话/任务ID` 复合身份区分，不互斥不覆盖
- 会话下拉切换（★ 标记当前会话）、终端 / Jobs 双子页（状态、耗时、终止按钮、输出查看）、跳转到命令、终端内 job 行点击跳转、⇱ 反向定位
- 历史记录直接从磁盘 journal 发现渲染——断开、会话结束、宿主重启后全部可看
- 独立全页模式：`http://<host>:<port>/ssh-remote-panel/`
- 浮动右栏作为标签栏不可识别时的自动回退

## 工作原理

```
┌─ preset（agent.cordis.yml + plugin/）─────────────────────────┐
│  组合：persona + 7 个 ssh/sftp 工具 + ask-user + todo + jobs  │
│         + 压缩组；不挂任何本地 shell/文件/搜索工具行            │
│                                                              │
│  plugin/index.js  ── 纯 JS，零 harness 内部依赖               │
│    ├─ ssh2（preset 本地 node_modules，--ignore-scripts 纯 JS）│
│    ├─ 连接按 SessionId 键控，会话结束自动断开                  │
│    ├─ journal 写入 <workspace>/.ssh-remote/                   │
│    └─ 消费宿主 webServer 服务：                                │
│        /ssh-remote-panel/* 路由（面板资产 + JSON API）          │
│        tapIndex 注入面板脚本（同源、随宿主回环绑定）             │
│                                                              │
│  plugin/panel.js/css ── 浏览器侧（无依赖 vanilla JS）          │
│    ├─ 标签注入（ARIA 锚点 + 样式克隆 + 每秒重断言）             │
│    ├─ DOM MutationObserver 即时响应会话切换                    │
│    └─ 每 12s 上报 DOM 结构诊断到 panel-debug.log               │
└──────────────────────────────────────────────────────────────┘
```

「当前会话」判定链：GUI 面包屑标题 → 宿主 `sessionQuery` 标题解析 → sessionId → `agents` + `agentPresets.composedPreset()` 运行时组合确认。不使用会话头部的 `agentPreset` 持久字段（创建时盖默认值，与实际所选预设无关）。

## 安装

前置：已运行的 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh web` 或其他入口），Node ≥ 18。

```powershell
# 1. 放到用户预设目录
git clone https://github.com/Y4nTsing/dsh-ssh-remote.git
Copy-Item -Recurse dsh-ssh-remote "$HOME\.dsh\.agent-presets\ssh-remote"

# 2. 安装唯一依赖（纯 JS 安装，跳过可选原生构建）
cd "$HOME\.dsh\.agent-presets\ssh-remote"
npm install --omit=optional --ignore-scripts

# 3. 重启 DSH 宿主进程，新建会话时选择 ssh-remote 预设
```

Linux / macOS 对应 `~/.dsh/.agent-presets/ssh-remote`。

## 使用

1. 新建会话，预设选择 **ssh-remote**（或你复制时起的名字）
2. 模型会先问你要主机 / 端口 / 账号 / 密码（`ask_user_question`），然后 `ssh_connect`
3. 之后所有命令、文件操作、传输都在远端；说「后台跑」即用托管后台任务
4. 会话头部点 **SSH 终端** 标签实时查看；浏览器开 `http://127.0.0.1:<端口>/ssh-remote-panel/` 是全页模式

## 安全与隐私须知

- SSH 密码只保存在插件进程内存中；但**会经过模型上下文**（问答 + 工具参数），这是「会话开始输入账号密码」交互的固有代价——介意请改用密钥认证思路自行扩展
- `.ssh-remote/` 日志包含完整命令与输出历史（可能含敏感信息），**不要把它提交进仓库**（`.gitignore` 已含）
- 面板路由与 GUI 同源、随宿主回环绑定，无独立鉴权——与 DSH 自身 API 同一信任边界
- 面板 `/transcript`、`/job` 端点做了路径校验：只读已注册工作区 `.ssh-remote/` 下的 `session-*.log` / `dsr-*.log` / `job-*.log`，目录穿越与任意文件读取被拒绝

## 已知限制

- **插件代码变更需要重启宿主进程**：Node ESM 模块缓存按 URL 缓存（composition / 配置变更可热换代，`.js` 不行）。`panel.js` / `panel.css` 按请求从磁盘读取，刷新浏览器即生效
- **GUI 标签注入与前端 DOM 结构耦合**（无官方扩展点）：用 ARIA 锚点 + 重断言尽量稳，前端大改版时自动回退浮动右栏
- 面板诊断日志 `plugin/panel-debug.log` 持续追加（含会话标题等），可随时删除

## 兼容性

在 `@deepseek-ai/dsh@0.1.1-rc.2`（Windows 宿主）上开发与验证；面板与预设机制均为运行时探测式适配，DSH 升级后若失效，诊断日志会给出结构差异线索。

## License

[MIT](./LICENSE)
