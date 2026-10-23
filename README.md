# NapCat-AI-Forward

把 QQ 消息转发给任意 **OpenAI 兼容接口**（OpenAI、DeepSeek、通义千问、Kimi、本地 Ollama 等）的轻量接入层，基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 正向 WebSocket。

**运行时没有任何依赖**，只需要 Node.js 22 或更高版本。

## 功能

- **私聊**：每条消息都回复
- **群聊**：每条消息都看。`auto` 模式下由模型自己决定说话还是沉默；`mention` 模式下只在被 @ 时回复
- **长期记忆**：上下文变长时，较早的对话会被模型压缩成摘要，存进记忆文件，之后的对话都会带上它；重启后从记忆文件和聊天记录恢复
- **聊天记录搜索**：通过 MCP 工具，模型可以按关键词、发送者、时间搜索当前会话的历史消息
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
│   ├── conversation.mjs    每个会话的上下文与记忆压缩
│   ├── llm.mjs             调用模型，包括工具调用循环
│   ├── message.mjs         解析消息、下载图片
│   ├── store.mjs           聊天记录与记忆文件的读写
│   ├── mcp-client.mjs      精简的 MCP 客户端（stdio）
│   └── tools.mjs           把 MCP 工具提供给模型
├── mcp/
│   └── chat-history.mjs    聊天记录搜索 MCP 服务器
├── test/                   测试
└── data/                   运行时生成（已被 git 忽略）
    ├── logs/<会话>.jsonl   聊天记录
    └── memory/<会话>.md    长期记忆
```

会话 ID 的格式是 `group-群号` 或 `private-QQ号`。

## 用 Docker Compose 部署（推荐）

```bash
cp config.example.json config.json   # 至少修改 llm.apiKey、llm.model 和 group.allow
docker compose up -d
docker compose logs napcat           # 在输出里找到 WebUI 的 token
```

然后在浏览器打开 `http://127.0.0.1:6099/webui`，输入 token 后扫码登录 QQ。之后可以用 `docker compose logs -f bridge` 查看本项目的日志。

- **一定要先创建 `config.json` 再启动**，否则 Docker 会自动创建一个同名的空目录。
- NapCat 的登录数据保存在 `data/napcat/`，本项目的聊天记录和记忆保存在 `data/bridge/`。
- WebUI 只绑定在 `127.0.0.1`。在远程服务器上，可以用 `ssh -L 6099:127.0.0.1:6099 你的服务器` 转发到本地再打开。
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
| `memory.keepRecentMessages` | `10` | 压缩时保留最近这么多条原文，其余写进记忆；重启后也从聊天记录里恢复这么多条 |
| `memory.maxMemoryChars` | `2000` | 记忆摘要的长度上限（字） |
| `timezone` | 系统时区 | 提示词和聊天记录搜索使用的时区，例如 `Asia/Shanghai` |
| `dataDir` | `data` | 聊天记录和记忆文件的存放目录 |
| `mcpServers` | `{}` | 要挂载的 MCP 服务器，见下文 |

## 群聊是怎么工作的

每条消息都会记进聊天记录和上下文。群里安静 `debounceSeconds` 秒后（或者最多攒 `maxWaitSeconds` 秒），这一批消息会以"昵称(QQ号)：内容"的格式一起交给模型。有人 @ 机器人时立即处理，回复时会引用那条消息。

- **`auto` 模式**：提示词会告诉模型，只有被 @、被叫名字、被提问，或者确实有价值的内容可以补充时才发言，否则输出 `[NO_REPLY]`。接入层收到 `[NO_REPLY]` 就保持沉默。**注意：这个模式下每一批群消息都会调用一次模型，群越活跃费用越高**，建议用 `group.allow` 限定群，并适当调大 `debounceSeconds`。
- **`mention` 模式**：普通消息只记录、不调用模型；被 @ 时，模型能看到之前的群聊内容再回答。

## 长期记忆

- 上下文超过 `memory.maxContextMessages` 条时，较早的部分（只保留最近 `keepRecentMessages` 条）会连同已有记忆一起交给模型，整理成一份新的记忆，写入 `data/memory/<会话>.md`。之后每次对话，记忆都会附在系统提示词里。
- 记忆文件是普通的 Markdown 文本，可以直接查看、修改或删除。
- 重启后，记忆从文件读回，最近的上下文从聊天记录 `data/logs/<会话>.jsonl` 的末尾恢复。
- 压缩失败时会在下次再试；上下文超过上限的两倍时会丢弃最旧的部分，防止无限增长。

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
- **`conversationArgument`**：指定工具的某个参数由接入层强制填写为当前会话 ID，并且不让模型看到这个参数。内置的聊天记录搜索就靠它保证**模型只能搜到当前会话的记录**，在 A 群里查不到 B 群或私聊的内容。
- 使用工具需要模型支持函数调用（OpenAI 的 `tools` 参数）。如果你的模型不支持，把 `mcpServers` 设为 `{}` 即可。
- 某个 MCP 服务器启动失败时，只会在日志里报错，不影响其他功能。

内置的 `mcp/chat-history.mjs` 提供一个 `search_chat_history` 工具，可以按关键词（多个词用空格分隔，需全部包含）、发送者 QQ 号、起止时间筛选，返回最新的若干条匹配消息。它读取同一份 `config.json` 来找到数据目录和时区，也可以单独给其他 MCP 客户端使用（这时不指定会话就会搜索全部会话）。

## 识图

把 `vision.enabled` 设为 `true` 即可开启。**模型必须支持图片输入**（例如 GPT-4o、通义千问 VL、Gemini、Ollama 上的视觉模型），纯文字模型收到图片会报错。

- 图片由接入层下载后，以 base64 形式发给模型。QQ 图片链接会过期，而且模型服务商往往访问不了 QQ 图床，所以不直接转发链接。
- 回复（引用）一条带图的消息，模型也能看到那张图。
- 下载失败或超过大小限制的图片会被跳过，并在提问里注明。
- 上下文和记忆里只保留"[图片]"占位符，不保存图片本身。因此追问"刚才那张图"时，模型只记得自己之前的描述。
- 表情包（收藏表情、热图、斗图、商城表情等）默认跳过。

## 命令

- `/reset` 或 `/重置`：清空当前会话的短期上下文（群里需要 @ 机器人）。长期记忆和聊天记录不受影响，要彻底遗忘请删除对应的记忆文件。

## 测试

测试会启动模拟的 NapCat、模拟的模型接口和模拟的图床，再运行本项目检查行为。开发依赖（`ws` 和官方 MCP SDK）只用于测试，运行本项目不需要它们：

```bash
npm install
npm test
```

覆盖的内容：私聊、`/reset`、错误处理与断线重连；群聊攒批、模型选择沉默或发言、@ 立即回复、群白名单、`mention` 模式；识图（格式识别、被引用消息的图片、跳过表情包、大小限制、上下文只存占位符）；记忆压缩与重启恢复；聊天记录搜索的各种筛选、与官方 MCP SDK 的双向互通，以及模型通过工具搜索时被限定在当前会话。

这些测试没有连接真实的 QQ。首次部署建议先用小号在测试群里试用。

## 限制

- 只处理文字和图片，语音、视频、文件等会显示为占位符
- 不支持流式输出
- MCP 只支持 stdio 类型的服务器
- 聊天记录搜索是逐行扫描文件，适合个人或小规模使用

## 风险与隐私

- NapCat 不是腾讯官方支持的接入方式，使用它违反 QQ 用户协议，账号有被限制或封禁的风险。请使用小号。
- 本项目会把生效群里的**所有消息**保存到本地聊天记录，并发送给你配置的模型服务商。请告知群成员，并妥善保管 `data/` 目录。

## 为什么不写成 NapCat 插件

NapCat 从 v4.18.6（2026 年 6 月）起，插件加载器只允许官方白名单内的插件 ID，第三方插件会以 `not in official plugin whitelist` 被拒绝加载。因此本项目以独立进程（或独立容器）通过 OneBot 11 WebSocket 接入。
