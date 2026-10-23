# NapCat-AI-Forward

把 QQ 消息转发给任意 **OpenAI 兼容接口**（OpenAI、DeepSeek、通义千问、Kimi、本地 Ollama 等）的轻量接入层，基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 正向 WebSocket。

**运行时没有任何依赖**，只需要 Node.js 22 或更高版本。

## 功能

- **私聊**：每条消息都回复
- **群聊**：每条消息都看。`auto` 模式下由模型自己决定说话还是沉默；`mention` 模式下只在被 @ 时回复
- **长期记忆**：上下文变长时，较早的对话会被模型压缩成摘要，存进记忆文件，之后的对话都会带上它；重启后从记忆文件和 QQ 里的最近消息恢复
- **聊天记录搜索**：通过 MCP 工具，模型可以按关键词、发送者、时间搜索当前会话的历史消息。记录直接通过 NapCat 从 QQ 读取，**本项目不在本地保存任何聊天记录**
- **全局会话**（可选）：所有群和私聊共用一份上下文和记忆，所有消息按到达顺序逐批处理
- **任意 MCP 服务器**：可以挂载其他 stdio 类型的 MCP 服务器，把它们的工具交给模型使用
- **识图**（可选）：消息里的图片，以及被回复的那条消息里的图片，都会发给模型
- 所有配置都写在一个 `config.json` 里

## 目录结构

```
├── config.example.json     配置模板，复制成 config.json 使用
├── compose.yaml            用 Docker 同时运行 NapCat 和本项目
├── src/
│   ├── index.mjs           入口
│   ├── config.mjs          读取并校验 config.json
│   ├── onebot.mjs          与 NapCat 的 WebSocket 连接（断线重连、调用接口）
│   ├── bot.mjs             消息处理：攒批、让模型决定是否回复、发送回复
│   ├── conversation.mjs    会话的上下文、处理队列与记忆压缩
│   ├── llm.mjs             调用模型，包括工具调用循环
│   ├── message.mjs         解析消息、下载图片
│   ├── history.mjs         通过 NapCat 从 QQ 读取历史消息
│   ├── store.mjs           记忆文件的读写
│   ├── time.mjs            时间格式化
│   ├── mcp-client.mjs      精简的 MCP 客户端（stdio）
│   └── tools.mjs           把 MCP 工具提供给模型
├── mcp/
│   └── chat-history.mjs    聊天记录搜索 MCP 服务器（通过 NapCat 读取）
├── test/                   测试
└── data/                   运行时生成（已被 git 忽略）
    └── memory/<会话>.md    长期记忆（本项目唯一写入磁盘的内容；全局模式下是 global.md）
```

会话 ID 的格式是 `group-群号` 或 `private-QQ号`。

## 从零开始安装（Docker Compose，推荐）

下面以一台全新的 Linux 服务器（Ubuntu 或 Debian）为例。Windows 和 Mac 见本节末尾。

### 准备

- 一台能联网的 Linux 服务器，x86 或 ARM 均可。NapCat 要运行完整的 QQ 客户端，建议至少 2 GB 内存。
- 一个用来当机器人的 **QQ 小号**，以及手机 QQ（用来扫码登录）。
- 一个 OpenAI 兼容接口的地址、API Key 和模型名。

### 1. 安装 git 和 Docker

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://get.docker.com | sudo sh
sudo docker compose version     # 能输出版本号就说明装好了
```

**服务器在国内时：**

- 官方源可能很慢，安装 Docker 那一步可以换成：
  ```bash
  curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun
  ```
- 从 Docker Hub 拉取镜像经常失败，需要配置镜像加速器。云服务商一般都提供（例如阿里云"容器镜像服务"里有专属加速地址）。把它写进 `/etc/docker/daemon.json`，然后执行 `sudo systemctl restart docker`：
  ```json
  { "registry-mirrors": ["https://你的加速地址"] }
  ```
  网上的公共加速地址变动频繁，这里不列具体地址。

### 2. 下载项目

```bash
git clone https://github.com/UF4007/NapCat-AI-Forward.git
cd NapCat-AI-Forward
```

访问 GitHub 很慢时，也可以在网页上下载 ZIP 包，上传到服务器后解压。

### 3. 填写配置

```bash
cp config.example.json config.json
nano config.json
```

**一定要先创建 `config.json` 再启动**，否则 Docker 会自动创建一个同名的空目录，接入层就无法启动。

至少要修改这几项（完整说明见[配置说明](#配置说明)）：

| 配置项 | 改成什么 |
|---|---|
| `llm.baseUrl` | 你的接口地址，例如 `https://api.deepseek.com/v1` |
| `llm.apiKey` | 你的 API Key |
| `llm.model` | 模型名，例如 `deepseek-chat` |
| `group.allow` | 要让机器人生效的群号，例如 `[12345678]`。**模板里的 `123456789` 只是占位符** |
| `bot.name` | 机器人的名字（可选） |

- 模型**不支持工具调用**时，把 `mcpServers` 改成 `{}`。
- 识图默认关闭，模型支持看图时再把 `vision.enabled` 改成 `true`。

在 nano 里按 `Ctrl+O` 再按回车保存，按 `Ctrl+X` 退出。

### 4. 启动

```bash
sudo docker compose up -d
```

第一次启动要下载 NapCat 和 Node.js 的镜像，需要等一会儿。

### 5. 登录 QQ

**最简单的方法：直接扫日志里的二维码。**

```bash
sudo docker compose logs -f napcat
```

日志里出现"请扫描下面的二维码"后，下方会用字符画出一个二维码，用手机 QQ 登录**小号**扫码即可（按 `Ctrl+C` 退出日志）。终端里的二维码扫不出来时，把日志里"二维码解码URL"后面的链接复制到任意在线二维码生成网站，生成后再扫。

**也可以用 WebUI 登录：**

1. 找到 WebUI 的 token：
   ```bash
   sudo docker compose logs napcat | grep -i 'WebUi Token'
   ```
2. WebUI 只对服务器本机开放。在**你自己的电脑**上（不是服务器上）打开终端，建立一条 SSH 隧道，并保持这个窗口开着。登录服务器用的端口和密钥照常加上，例如 `-p 端口`、`-i 私钥路径`：
   ```bash
   ssh -L 6099:127.0.0.1:6099 用户名@服务器IP
   ```
3. 在你电脑的浏览器里打开 `http://127.0.0.1:6099/webui`，输入 token，然后用手机 QQ 扫码登录。

### 6. 确认能用

```bash
sudo docker compose logs -f bridge
```

- 看到 `connected to ws://napcat:3001` 说明接入层已经连上 NapCat。
- QQ 登录之前，日志里会每 5 秒出现一次 `cannot connect to ws://napcat:3001, retrying in 5s`，这是正常的，登录后会自动连上。
- 用另一个 QQ 号私聊机器人，或者在生效的群里 @ 它，看它是否回复。

### 日常操作

| 要做的事 | 命令 |
|---|---|
| 修改 `config.json` 后生效 | `sudo docker compose restart bridge` |
| 更新本项目 | `git pull && sudo docker compose restart bridge` |
| 更新 NapCat | `sudo docker compose pull napcat && sudo docker compose up -d` |
| 查看日志 | `sudo docker compose logs -f bridge` |
| 停止 | `sudo docker compose down` |

长期记忆保存在 `data/bridge/`，QQ 登录数据（以及 QQ 客户端自己的消息记录）保存在 `data/napcat/`。迁移或备份时带上整个 `data/` 目录即可。

### Windows 和 Mac

先安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 和 Git，然后从第 2 步开始照做。命令前不需要加 `sudo`，也不需要 SSH 隧道，直接在本机浏览器打开 WebUI。

### 补充说明

- 两个容器通过 compose 内部网络通信，OneBot 的 3001 端口不会暴露到宿主机。
- 宿主机不需要 X11 或 Wayland：NapCat 镜像在容器内部自带虚拟显示（Xvfb）。
- 要使用宿主机上的 Ollama，把 `llm.baseUrl` 设为 `http://host.docker.internal:11434/v1`。

## 不用 Docker 直接运行

NapCat 需要开启一个 WebSocket 服务端（消息格式 `array`，这是默认值）。把 `config.json` 里的 `onebot.url` 改成 `ws://127.0.0.1:3001`，然后：

```bash
node src/index.mjs config.json
```

## 配置说明

完整示例见 [`config.example.json`](config.example.json)。没写的配置项会使用下面的默认值。文件里的相对路径都以 `config.json` 所在目录为基准。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `onebot.url` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端地址；Docker 部署时为 `ws://napcat:3001` |
| `onebot.token` | 空 | 与 NapCat 中设置的 token 一致 |
| `llm.baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容接口地址，会请求 `{baseUrl}/chat/completions` |
| `llm.apiKey` | 空 | 接口密钥 |
| `llm.model` | `gpt-4o-mini` | 模型名 |
| `llm.timeoutSeconds` | `120` | 单次请求超时 |
| `llm.maxToolRounds` | `5` | 每次回复最多连续调用几轮工具 |
| `llm.maxConcurrentRequests` | `4` | 所有会话合计，最多同时向模型发出几个请求 |
| `bot.name` | 空 | 机器人的名字，会写进提示词，群友叫这个名字时模型更容易接话 |
| `bot.systemPrompt` | `你是一个简洁友好的 QQ 助手。` | 系统提示词（人设） |
| `private.enabled` | `true` | 是否回复私聊 |
| `private.allow` | `[]` | 允许私聊的 QQ 号；空表示所有人 |
| `group.reply` | `auto` | `auto`：由模型决定是否回复；`mention`：只在被 @ 时回复 |
| `group.allow` | `[]` | 生效的群号；**空表示所有群** |
| `group.debounceSeconds` | `8` | 群里安静这么多秒后，把攒下的消息一起交给模型 |
| `group.maxWaitSeconds` | `30` | 群里一直有人说话时，最多攒这么久就处理一次 |
| `vision.enabled` | `false` | 是否识图，模型需要支持图片输入 |
| `vision.stickers` | `false` | 是否连表情包一起识别 |
| `vision.maxImages` | `4` | 每批消息最多处理几张图片 |
| `vision.maxImageMB` | `10` | 单张图片的大小上限 |
| `memory.maxContextMessages` | `40` | 上下文超过这么多条时触发压缩 |
| `memory.maxContextChars` | `12000` | 上下文超过这么多字时也触发压缩 |
| `memory.keepRecentMessages` | `10` | 压缩时最多保留最近这么多条原文（且不超过 `maxContextChars` 的一半），其余写进记忆；重启后也从 QQ 拉取这么多条最近的消息 |
| `memory.maxMemoryChars` | `2000`（全局模式 `4000`） | 记忆的长度上限（字），超出时会被精简或截断，见[长期记忆](#长期记忆) |
| `memory.maxBatchMessages` | `30` | 一批最多交给模型多少条消息，多出的较早消息会被省略 |
| `memory.maxMessageChars` | `1000` | 单条消息在上下文里最多保留多少字（QQ 里仍是全文） |
| `history.maxScanMessages` | `1000` | 每次搜索聊天记录时，最多往前查看多少条消息 |
| `conversation.mode` | `separate` | `separate`：每个群、每个私聊各自独立；`global`：所有群和私聊共用一个会话，见[全局会话模式](#全局会话模式) |
| `timezone` | 系统时区 | 提示词和聊天记录搜索使用的时区，例如 `Asia/Shanghai` |
| `dataDir` | `data` | 长期记忆文件的存放目录 |
| `mcpServers` | `{}` | 要挂载的 MCP 服务器，见下文 |

## 群聊是怎么工作的

每条消息都会记进上下文。群里安静 `debounceSeconds` 秒后（或者最多攒 `maxWaitSeconds` 秒），这一批消息会以"昵称(QQ号)：内容"的格式一起交给模型。有人 @ 机器人时立即处理，回复时会引用那条消息。

- **`auto` 模式**：提示词会告诉模型，只有被 @、被叫名字、被提问，或者确实有价值的内容可以补充时才发言，否则输出 `[NO_REPLY]`。接入层收到 `[NO_REPLY]` 就保持沉默。**注意：这个模式下每一批群消息都会调用一次模型，群越活跃费用越高**，建议用 `group.allow` 限定群，并适当调大 `debounceSeconds`。
- **`mention` 模式**：普通消息只记录、不调用模型；被 @ 时，模型能看到之前的群聊内容再回答。

## 长期记忆

- 上下文超过 `memory.maxContextMessages` 条，或者超过 `memory.maxContextChars` 字时，较早的部分会连同已有记忆一起交给模型，整理成一份新的记忆，写入 `data/memory/<会话>.md`。只保留最近的几条原文：最多 `keepRecentMessages` 条，并且总字数不超过 `maxContextChars` 的一半。之后每次对话，记忆都会附在系统提示词里。
- **记忆分成两部分**：
  - **人物与长期事实**：每个人的称呼、身份、性格、偏好，以及长期有效的约定。这部分不会因为时间久远而被删减，只在过时或被推翻时修改。
  - **近期经过**：按日期从近到远记录发生过的事，**越久远越简略**。最近三天保留细节，三天到两周前每天一两句，更早的只留下至今仍有影响的结论。
- 为了让模型分清新旧，交给它整理的聊天记录按日期分段，并注明当前时间。
- **记忆有硬上限**：模型整理出的记忆超过 `maxMemoryChars` 字时，会再请它精简一次；仍然超出（或请求失败）时，按整行截断到上限以内。因为最久远的经过排在最后，截掉的总是最旧的内容。记忆文件比上限长时（比如手动改过，或者调小了上限），读入时也会截断。所以记忆不会越滚越大。
- 记忆文件是普通的 Markdown 文本，可以直接查看、修改或删除。
- 重启后，记忆从文件读回；某个会话第一次收到消息时，接入层会通过 NapCat 从 QQ 拉取它之前最近的 `keepRecentMessages` 条消息作为上下文。
- 压缩失败时会在下次再试；上下文超过上限的两倍时会直接丢弃最旧的部分（QQ 里仍然保留），防止无限增长。

## 请求的排队、大小与并发

- **同一个会话内是串行的**：一个群或一个私聊同一时间只有一个请求在跑，回复、工具调用和记忆压缩都排在同一个队列里。请求进行中收到的消息（包括 @）会先排队，等当前请求结束后作为下一批处理。
- **不同会话之间是并行的**，但所有会话合计最多同时有 `llm.maxConcurrentRequests` 个模型请求，避免触发服务商的频率限制。全局会话模式下所有群和私聊共用一个队列，见[全局会话模式](#全局会话模式)。
- **刷屏时只看最新的消息**：一批消息超过 `memory.maxBatchMessages` 条时，只把最新的这么多条交给模型，较早的替换成一句"期间还有 N 条较早的消息已省略"。最近一条 @ 机器人的消息总会保留。被省略的消息仍在 QQ 里，模型可以用聊天记录搜索工具查看。
- **过长的内容会被截断**：单条消息在上下文里最多保留 `maxMessageChars` 字，一整批最多占 `maxContextChars` 的一半。QQ 里始终是全文。
- **请求被拒绝时自动恢复**：如果模型接口以 400、413 或 422 拒绝请求（通常是上下文超过了模型的上限），会先把上下文缩短到 `maxContextChars` 的四分之一再试；还不行就只带当前这批消息、截到单条消息的长度，并且不带长期记忆再试。这样即使 `maxContextChars` 或 `maxMemoryChars` 设得比模型实际能接受的还大，会话也不会一直卡住。

## 全局会话模式

默认（`"conversation": { "mode": "separate" }`）每个群、每个私聊都是独立的会话：上下文、记忆、请求队列互不相干，在 A 群说的话 B 群的机器人不知道。

改成 `"conversation": { "mode": "global" }` 后，所有群和私聊合并成**一个会话**：

- **共用一份上下文**：每条消息前会加上来源，例如 `[group-123456] 小明(10001)：内容`、`[private-10001] 小明(10001)：内容`，机器人自己的发言也会记成 `[group-123456] 回复内容`。模型因此知道谁在哪里说了什么，可以在私聊里接着群里的话题聊。
- **回复只发回原处**：每次交给模型的是某一个群（或私聊）里攒下的一批新消息，提示词会写明"这批新消息来自哪里"，回复只会发到那里。模型偶尔照抄 `[group-…]` 标签时，接入层会把它去掉。
- **严格按顺序处理**：所有群和私聊共用一个队列，同一时间只有一个模型请求（`llm.maxConcurrentRequests` 实际不起作用）。各个群仍然各自攒批（`debounceSeconds` / `maxWaitSeconds` 照常生效），攒好的批次按顺序排队。消息多的时候不会丢，但后面的批次要等前面的处理完，**群越多、越活跃，回复越慢**。
- **共用一份记忆**：记忆文件只有一个，`data/memory/global.md`，由所有群和私聊的较早聊天整理而来，每条会注明来自哪个群或私聊。因为要装下所有会话，`memory.maxMemoryChars` 在这个模式下默认是 4000。原来按会话分开的记忆文件不会被读取，也不会被删除。
- **聊天记录搜索由模型指定会话**：模型可以搜索任何允许范围内（`group.allow` / `private.allow`）的群和私聊，`conversationArgument` 在这个模式下不生效。
- **`/reset` 清空的是全局上下文**：任何允许的群里有人 @ 机器人发 `/reset`，所有群和私聊的短期上下文都会被清空。
- 重启后，每个群或私聊第一次收到消息时，会把它在 QQ 里最近的几条消息追加到共用的上下文里。

注意隐私：这个模式下，**一个群里的内容可能会被机器人在另一个群或私聊里说出来**。只在所有群成员都能接受的情况下使用。

## MCP 工具

`mcpServers` 的写法与常见的 MCP 客户端一致，每一项都会作为子进程启动（目前只支持 stdio 类型）：

```json
"mcpServers": {
  "chat_history": {
    "command": "node",
    "args": ["mcp/chat-history.mjs", "config.json"],
    "conversationArgument": "conversation"
  }
}
```

- 每个工具都会以 `服务器名__工具名` 的名字提供给模型，可选的 `env` 字段可以给子进程传环境变量。
- **`conversationArgument`**：指定工具的某个参数由接入层强制填写为当前会话 ID，并且不让模型看到这个参数。内置的聊天记录搜索就靠它保证**模型只能搜到当前会话的记录**，在 A 群里查不到 B 群或私聊的内容。全局会话模式下这一项不生效，由模型自己指定会话。
- 使用工具需要模型支持函数调用（OpenAI 的 `tools` 参数）。如果你的模型不支持，把 `mcpServers` 设为 `{}` 即可。
- 某个 MCP 服务器启动失败时，只会在日志里报错，不影响其他功能。

内置的 `mcp/chat-history.mjs` 提供一个 `search_chat_history` 工具，可以按关键词（多个词用空格分隔，需全部包含）、发送者 QQ 号、起止时间筛选，返回最新的若干条匹配消息。

- **不读本地文件**：它自己连接 NapCat，用 `get_group_msg_history` / `get_friend_msg_history` 从最新的消息开始往前翻页，在本地按条件筛选。因此能搜到本项目部署之前的消息，QQ 里有多少就能翻到多少。
- 每次搜索最多往前查看 `history.maxScanMessages` 条（默认 1000）；超出时会告诉模型更早的消息没有搜索，模型可以用 `since`/`until` 缩小范围再查。
- 它读取同一份 `config.json` 获取 NapCat 地址、时区和群白名单，只允许搜索 `group.allow` / `private.allow` 范围内的会话，并且必须指定会话。也可以单独给其他 MCP 客户端使用。

## 识图

把 `vision.enabled` 设为 `true` 即可开启。**模型必须支持图片输入**（例如 GPT-4o、通义千问 VL、Gemini、Ollama 上的视觉模型），纯文字模型收到图片会报错。

- 图片由接入层下载后，以 base64 形式发给模型。QQ 图片链接会过期，而且模型服务商往往访问不了 QQ 图床，所以不直接转发链接。
- 回复（引用）一条带图的消息，模型也能看到那张图。
- 下载失败或超过大小限制的图片会被跳过，并在提问里注明。
- 上下文和记忆里只保留"[图片]"占位符，不保存图片本身。因此追问"刚才那张图"时，模型只记得自己之前的描述。
- 表情包（收藏表情、热图、斗图、商城表情等）默认跳过。

## 命令

- `/reset` 或 `/重置`：清空当前会话的短期上下文（群里需要 @ 机器人；全局会话模式下清空的是所有群和私聊共用的上下文）。长期记忆不受影响，要彻底遗忘请删除对应的记忆文件（QQ 里的消息记录不受本项目影响）。

## 测试

测试会启动模拟的 NapCat、模拟的模型接口和模拟的图床，再运行本项目检查行为。开发依赖（`ws` 和官方 MCP SDK）只用于测试，运行本项目不需要它们：

```bash
npm install
npm test
```

覆盖的内容：私聊、`/reset`、错误处理与断线重连；群聊攒批、模型选择沉默或发言、@ 立即回复、群白名单、`mention` 模式；识图（格式识别、被引用消息的图片、跳过表情包、大小限制、上下文只存占位符）；记忆压缩（按条数和按字数、按日期分段、两部分结构的提示词、超长记忆的精简与按行截断、读入时截断）与重启后从 QQ 恢复上下文、不在本地写入聊天记录；请求进行中刷屏、超长消息截断、请求被拒绝后的逐级重试（最后一次不带记忆）、模型持续出错时上下文不会无限增长、全局并发上限；聊天记录搜索（通过 NapCat 翻页、各种筛选、白名单、扫描上限、标准输出只有协议消息）、与官方 MCP SDK 的双向互通，以及模型通过工具搜索时被限定在当前会话；全局会话模式（共用带来源标签的上下文、回复发回原处、单一队列按顺序处理、单一记忆文件、模型自选会话搜索但受白名单限制）。

这些测试没有连接真实的 QQ。首次部署建议先用小号在测试群里试用。

## 限制

- 只处理文字和图片，语音、视频、文件等会显示为占位符
- 不支持流式输出
- MCP 只支持 stdio 类型的服务器
- 聊天记录搜索是逐页向 NapCat 拉取后在本地筛选，查得越久远越慢；每次最多查看 `history.maxScanMessages` 条

## 风险与隐私

- NapCat 不是腾讯官方支持的接入方式，使用它违反 QQ 用户协议，账号有被限制或封禁的风险。请使用小号。
- 本项目不在本地保存聊天记录，但生效群里的**所有消息**都会发送给你配置的模型服务商，长期记忆文件里也会有对话内容的摘要。请告知群成员，并妥善保管 `data/` 目录。
- 开启全局会话模式后，不同群和私聊的内容会互相可见（见上文）。

## 为什么不写成 NapCat 插件

NapCat 从 v4.18.6（2026 年 6 月）起，插件加载器只允许官方白名单内的插件 ID，第三方插件会以 `not in official plugin whitelist` 被拒绝加载。因此本项目以独立进程（或独立容器）通过 OneBot 11 WebSocket 接入。
