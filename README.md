# NapCat-AI-Forward

把 QQ 消息转发给任意 **OpenAI 兼容接口**（OpenAI、DeepSeek、通义千问、Kimi、本地 Ollama 等）的超轻量接入层，基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 正向 WebSocket。

整个接入层只有一个文件 `bridge.mjs`，约 120 行，**没有任何依赖**，只需要 Node.js 22 或更高版本（使用 Node 内置的 `WebSocket` 和 `fetch`）。

- **私聊**：每条消息都回复
- **群聊**：只在机器人被 @ 时回复，并引用原消息；整个群共用一份上下文，每条消息前带上发言人名字
- 每个会话保留最近 20 条对话；发送 `/reset` 或 `/重置` 清空上下文
- 可选的群白名单；自动过滤推理模型输出的 `<think>…</think>`
- 断线 5 秒后自动重连；模型接口出错时把错误信息回复给用户，并从历史里撤掉这次提问

## 用 Docker Compose 部署（推荐）

`compose.yaml` 同时启动 NapCat 和 `bridge.mjs`（使用官方 `node:22-alpine` 镜像，不需要构建）。两者通过 compose 内部网络通信，OneBot 的 3001 端口不会暴露到宿主机。

```bash
cp .env.example .env     # 填写 WEBUI_TOKEN、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL
docker compose up -d
```

然后在浏览器打开 `http://127.0.0.1:6099/webui` 扫码登录 QQ，再用 `docker compose logs -f bridge` 查看接入层日志。

- WebUI 只绑定在 `127.0.0.1`。在远程服务器上，可以用 `ssh -L 6099:127.0.0.1:6099 你的服务器` 转发到本地再打开。
- 要使用宿主机上的 Ollama，把 `LLM_BASE_URL` 设为 `http://host.docker.internal:11434/v1`。
- NapCat 的 `MODE: ws` 模板默认 **WebSocket token 为空**。建议在 WebUI 的"网络配置"里给名为 `ws` 的 WebSocket 服务端设置一个 token，并在 `.env` 里填上相同的 `ONEBOT_TOKEN`。
- 宿主机不需要 X11 或 Wayland：NapCat 镜像在容器内部自带虚拟显示（Xvfb）。

## 不用 Docker 直接运行

NapCat 需要开启一个 WebSocket 服务端（消息格式 `array`，这是默认值）。

```bash
ONEBOT_WS=ws://127.0.0.1:3001 LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node bridge.mjs
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ONEBOT_WS` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端地址 |
| `ONEBOT_TOKEN` | 空 | 与 NapCat 中设置的 token 一致 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容接口地址，会请求 `{LLM_BASE_URL}/chat/completions` |
| `LLM_API_KEY` | 空 | 接口密钥 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `SYSTEM_PROMPT` | `你是一个简洁友好的 QQ 助手。` | 系统提示词 |
| `HISTORY_MESSAGES` | `20` | 每个会话保留的最近消息条数 |
| `ALLOW_GROUPS` | 空（所有群） | 允许回复的群号，用逗号分隔 |

## 测试

`test/bridge.test.mjs` 会启动一个模拟的 NapCat（OneBot 11 WebSocket 服务端）和一个模拟的 OpenAI 接口，然后运行 `bridge.mjs` 并检查它的行为。测试需要开发依赖 `ws`（只用来搭建模拟服务端，`bridge.mjs` 本身不依赖它）：

```bash
npm install
npm test
```

覆盖的行为：@ 判断、私聊、群白名单、`/reset`、过滤思考内容、token 传递、接口报错时的回复与历史回滚、断线重连。

这些测试没有连接真实的 QQ。首次部署建议先用小号在测试群里试用。

## 限制

- 只处理文字消息，图片等其他内容会被忽略
- 不支持流式输出
- 对话历史保存在内存中，重启后丢失

## 风险提示

NapCat 不是腾讯官方支持的接入方式，使用它违反 QQ 用户协议，账号有被限制或封禁的风险。请使用小号。聊天内容会发送给你配置的模型服务商。

## 为什么不写成 NapCat 插件

NapCat 从 v4.18.6（2026 年 6 月）起，插件加载器只允许官方白名单内的插件 ID，第三方插件会以 `not in official plugin whitelist` 被拒绝加载。因此本项目以独立进程（或独立容器）通过 OneBot 11 WebSocket 接入。
