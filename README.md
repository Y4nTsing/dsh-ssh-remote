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
- **小操作的预算与自愈对齐**：`ssh_read` / `ssh_write` / `ssh_edit` 的 `ToolDefinition.timeoutMs` 是 300s——它们的恢复路径是 60s SFTP 超时 + 探活/重连 + 60s 重试，原来的 120s 会被 harness 的 tool-call-timeout 策略先杀，重试永远没机会落地，模型只能看到一句 `tool call timed out after 120000ms`
- **每次操作独立 SFTP 通道**：通道不复用、操作完即关——一个卡死的通道永远不会污染下一次操作
- **exec 兜底超时**：连 exec 回调都不触发（死连接的另一种表现）时，`timeoutMs + 5s` 内必抛错并拆连，杜绝无限挂起
- **前台命令的结束不再由远端决定**：ssh2 只在**对端**发 CHANNEL_CLOSE 时才 emit `close`，而 OpenSSH 在 exec 子进程还活着时不会关闭该 session 通道（也不实现 SSH `signal` 请求）——过去一条卡住的远端命令会让 `ssh_bash` 自己的 `timeoutMs` 和用户的打断同时失效，整轮对话只能等远端命令自己结束。现在超时后最多再等 `DSH_SSH_KILL_SETTLE_GRACE_MS`（默认 `5000`）就本地结束该调用并断开该连接（下一次调用照常自动重连），用户打断则立即结束
- **前台命令正常结束也不再等通道关闭**：后台子进程（`setsid nohup … &`）还活着时 OpenSSH 同样不发 CHANNEL_CLOSE，过去这类命令会把 `ssh_bash` 拖到自己的超时——实测 `sleep 30` 的命令跑满 120.6s、`sleep 110` 的跑满 180.6s，而前台部分 30–110s 就结束了。现在命令尾部追加一个 `__DSH_SSH_EXIT__` 哨兵，shell 打印它即结算并保留通道，后台进程照常存活；`exec`、语法错误等打印不出哨兵的命令回退到上面的 close/超时路径
- **传输可被中断**：`ssh_read` / `ssh_write` / `ssh_edit` / `sftp_upload` / `sftp_download` 把调用方的取消信号一路传到 SFTP 层——用户打断时立刻结束该工具调用，并关掉这条 SFTP 通道、断开连接（下一次调用照常自动重连），不必再等操作自己的硬超时；打断**不会**触发自愈重试（重试只用于连接性问题）。代价：被中断的上传会在远端留下一个部分写入的文件
- **传输没有时长上限，只有"没进度"上限**：`sftp_upload` / `sftp_download` 用 ssh2 每个 chunk 的进度回调（`step`）驱动一个空闲计时器——**只要还在传就一直传**，慢链路/大文件不会在固定 180s 被砍（那个绝对上限已删除）；连续 `DSH_SFTP_STALL_TIMEOUT_MS`（默认 `60000`）零进度才判定链路死。传输窗口默认 16 个 32KiB chunk（`DSH_SFTP_TRANSFER_CONCURRENCY`）而非 ssh2 的 64：窗口越大吞吐越高，但**首个进度信号的等待也越久**（2MiB 窗口在慢链路上足以被误判为停滞）。工具侧预算同步提到 1 小时（`DSH_SFTP_TOOL_TIMEOUT_MS`），由 harness 的 tool-call-timeout 策略兜底
- **后台任务真正抗断开**：连接抖动**不会**终止托管任务（`setsid` 远程进程继续跑），轮询自动重连后继续读输出，正常完成任务
- 重连是**逐个会话共享的**：同一时刻多个工具调用并发重连，只会发起一次握手
- 每次重连成功在 journal 里记一行 `auto-reconnected to user@host:port after connection loss`；重连失败则给出明确报错并建议重跑 `ssh_connect`
- 可调参数（环境变量覆盖，进程启动时读取）：`DSH_SSH_KEEPALIVE_INTERVAL_MS`（默认 `15000`）、`DSH_SSH_KEEPALIVE_COUNT_MAX`（默认 `6`）、`DSH_SSH_PROBE_TIMEOUT_MS`（默认 `10000`）、`DSH_SSH_EXEC_GRACE_MS`（默认 `5000`）、`DSH_SSH_KILL_SETTLE_GRACE_MS`（默认 `5000`）

> 若自动重连仍失败（比如服务器重启后密码失效），报错会明确指向「重跑 `ssh_connect`」。

### 托管后台任务（`run_in_background`）

- 远端以 `setsid` 独立会话启动，SSH 通道断开不影响进程
- 接入 harness jobs 体系：`job_output`（增量流式读取，多字节字节精确） / `job_list` / `job_kill`（杀整个进程组），完成时主动通知模型
- 注册遵守 harness 契约：`owner` 用**会话 id**（`exec.agent.id`，不是 Agent 对象——注册表用 `agents.get(owner)` 找活着的 Agent，传对象会报 `session "[object Object]" has no live agent`），并带上 `toolCall: { callId, rootCallId }`；面板的 `job_kill` 同样以会话 id 作为 caller
- 输出通过注册表下发的 `JobHandle.append`（`run(handle)`）进入 harness 输出环——`job_output` 读的就是它（插件自己的 `readOutput()` 不属于契约、无人调用），面板读数则继续走自己的 tail 与 job 日志
- 会话结束自动终止托管任务；手动 `nohup` / `screen` / `tmux` 不受追踪、跨会话存活（两档生命周期有意区分）

### 会话日志（journal）

- 每个会话一个文件（按 SessionId 确定性命名，重连/重启/恢复都追加同一文件；旧的时间戳命名分段文件会在重连时自动按时间序合并收编）
- 终端风格：命令**发起时**先写 `[时间] user@host:port $ 命令` 头行（面板立刻能看到正在跑什么），结束后补输出与 `[exit code: N]` 标记；文件操作/传输记录为注释行；连接/断开横幅
- 后台任务两段式记录：启动即记标记行 + 完整输出流式写入 `.ssh-remote/jobs/`（2MB 上限）；结束时补完成块（起止时间、退出状态、末 4KB 尾巴、完整日志指针）
- 全部写入串行化 fire-and-forget，日志失败绝不影响工具执行

### Web GUI 终端面板

- **官方 `conversation.view` 视图标签**（宿主插件的客户端模块经 slots 系统注册）：标签由 GUI 自己渲染、生命周期由 React 管理——切换会话即卸载、切回即全新挂载；不打 DOM 补丁、不按秒重断言、页面加载零面板开销（不点开标签就什么都不运行）
- **严格按会话显示**：门卫组件（session 作用域）拿当前会话 id → 后端按 journal 存在性精确判定 → **动态注册/注销**视图条目——只有跑过 ssh-remote 的会话才出现「SSH 终端」标签，其他会话只有「对话 | 轨迹」（注册表响应式刷新，官方机制，无 DOM hack）
- 视图内容 = 独立面板页的 iframe（`?session=` 预选锁定当前会话）：会话下拉、终端 / Jobs 双子页、跳转命令、⇱ 反向定位
- **工作区隔离**：会话内的面板只显示**同一工作区**的 SSH 记录与任务（按当前会话的 `header.cwd` 限定）；不同工作区的 `.ssh-remote` 互不可见。独立全页（`?all=1`，操作员视图）保留全量
- 跨会话同名任务（每个会话的第一个后台任务都是 `ssh-1`）按 `会话/任务ID` 复合身份区分，不互斥不覆盖
- 历史记录直接从磁盘 journal 发现渲染——断开、会话结束、宿主重启后全部可看
- 独立全页模式：`http://<host>:<port>/ssh-remote-panel/`

## 工作原理

`package.json` 的 `dsh.bundle.patch` 让 profile 把**这一个包**当作 bundle 组合；包里同时住着三个角色：

```
┌─ 包根 dsh-ssh-remote ─────────────────────────────────────────┐
│  lib/index.js       宿主半边：/ssh-remote-panel/* 路由         │
│                     （panel.js/css 资产 + JSON API + /diag）   │
│  lib/client.js      客户端模块（dsh.client + exports./client） │
│                     → conversation.view 的「SSH 终端」标签     │
│  lib/panel.js/css   浏览器侧面板（无依赖 vanilla JS）          │
│  cordis.patch.yml   两行 insert：面板行 + preset 行            │
└───────────────────────────────────────────────────────────────┘
          ▲ 同进程 globalThis.__dsrSshRemotePanel（活状态）
          │ 磁盘 .ssh-remote/（journal、jobs 输出）
┌─ preset/plugin/index.js（包内子导出 ./preset/plugin）─────────┐
│  组合：persona + 7 个 ssh/sftp 工具 + ask-user + todo + jobs  │
│         + 压缩组；不挂任何本地 shell/文件/搜索工具行           │
│    ├─ ssh2（本包 dependencies，纯 JS）                        │
│    ├─ 连接按 SessionId 键控，会话结束自动断开                  │
│    ├─ journal 写入 <workspace>/.ssh-remote/                   │
│    └─ 托管后台任务注册进 harness jobs（owner = 会话 id）       │
└───────────────────────────────────────────────────────────────┘
```

面板行在 bundle patch 里写的是**精确包名** `dsh-ssh-remote`：客户端模块扫描按精确 specifier 建表（`exactPackageSpecifier`），子路径行能挂上路由但**永远不出标签**；preset 的插件行走 `./preset/plugin` 子导出，和官方 plugin row 一样经 node_modules 解析。

「当前会话」判定链：GUI 面包屑标题 → 宿主 `sessionQuery` 标题解析 → sessionId → `agents` + `agentPresets.composedPreset()` 运行时组合确认。不使用会话头部的 `agentPreset` 持久字段（创建时盖默认值，与实际所选预设无关）。

## 安装

前置：已运行的 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh web` 或其他入口）、pnpm、Node ≥ 18。

DSH `0.1.7` 起预设改用 **bundle 模型**：本仓库自身就是一个可安装的 bundle（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），profile 按 `dsh.profile.bundles` 组合它。**包根同时是宿主面板**，所以一条命令就装完了面板与预设两边——不再需要手工拷贝文件，也不需要改 profile 的 `cordis.patch.yml`。

```bash
# 一条命令：写进 profile 的 dependencies，并把本包加进 dsh.profile.bundles
dsh plugin --profile web add "github:Y4nTsing/dsh-ssh-remote"

# 重启 dsh 宿主进程（Node ESM 按 URL 缓存 .js，代码不能热换）
# 之后新建会话时预设选 SSH Remote Mode
```

Linux / macOS / Windows 同一条命令；`dsh plugin` 会把不是它自己的参数整体交给 pnpm，所以仓库是本地的也可以：

```bash
dsh plugin --profile web add "link:/path/to/dsh-ssh-remote"
```

**从旧布局升级**（`@local/dsh-ssh-remote-preset` + 手工拷贝的 `dsh-plugin-ssh-remote-panel`）：

```bash
dsh plugin --profile web remove @local/dsh-ssh-remote-preset
dsh plugin --profile web add "github:Y4nTsing/dsh-ssh-remote"

# 清掉旧的手工副本，以及 profile patch 里那段 ssh-remote-panel insert
rm -rf ~/.dsh/profiles/web/plugins/dsh-plugin-ssh-remote-panel
rm -rf ~/.dsh/profiles/web/node_modules/dsh-plugin-ssh-remote-panel
# 重启 dsh
```

> 面板资产（`panel.js` / `panel.css`）从本包自己的 `lib/` 读取，随包安装，不再有"拷到哪儿"的问题。

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
- 面板诊断日志 `lib/panel-debug.log`（本包 `lib/` 内）持续追加（含会话标题等），可随时删除

## 兼容性

- `2.x`（2026-10-21）：**包根改为宿主面板 + 客户端模块**，agent preset 的插件移到包内 `./preset/plugin` 子导出，两行 insert 都写进本包的 `cordis.patch.yml`——一条 `dsh plugin add` 装完两边，撤销了 `host-plugin/` 目录与"手工拷贝 + 合并 profile patch"的安装步骤。升级需重装（见「安装」里的旧布局迁移）
- `@deepseek-ai/dsh@0.1.7-rc.2`：**预设改为 bundle 模型**——`~/.dsh/.agent-presets/` 目录不再被读取，预设和普通插件 bundle 一样经 `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 组合（见「安装」）。面板宿主插件同步改为**自包含**：`panel.js` / `panel.css` / `panel-debug.log` 都在它自己的 `lib/` 目录，不再回退到旧的 `.agent-presets` 路径
- `@deepseek-ai/dsh@0.1.5-rc.2`（Windows 宿主）：**预设作用域不再解析监听中的 webServer**——preset 行里 `ctx.get('webServer')` 拿到的实例路由永远到不了端口（实测：注册成功日志 + 路由 404 并存）。面板后端因此搬进 `host-plugin/`（宿主组合插件，经 profile 的 `cordis.patch.yml` 挂载），preset 侧只通过 `globalThis.__dsrSshRemotePanel` 发布活状态。0.1.5 同时给 GUI 加了启动 token + 签名 cookie 认证（面板具名路由不受影响，与 GUI 同源同信任边界）
- `@deepseek-ai/dsh@0.1.1-rc.2`：最初开发与验证版本，面板后端当时直接由 preset 行注册
- 面板与预设机制均为运行时探测式适配，DSH 升级后若失效，`panel-debug.log` 会给出结构差异线索

## License

[MIT](./LICENSE)
