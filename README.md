# WeChat Companion

> 给 WeChatAgent 用的微信陪伴层：图片记忆、主动回忆、语音回复、唱歌、入站语音。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.2-blue.svg)](https://github.com/147247586/wechat-companion/releases)
![WeChatAgent](https://img.shields.io/badge/host-WeChatAgent-07c160)

这是一个**高级向、需要本机微信环境的源码安装包**，不是标准 DSH 一键插件。

先读这句：

> **必须登录 WeChatAgent Bridge、微信账号和本机 Hook。没有 Bridge，它不能收微信图片/语音，也不能主动发消息。**

## 它解决什么

标准 DSH 插件 API 只能做文本记忆和上下文注入，拿不到微信附件，也不能主动发送。

WeChat Companion 把这些能力放到 Bridge 侧：

| 能力 | 实现 |
|---|---|
| 图片记忆 | Reader 取图 → 本地视觉模型 → 记忆 |
| 主动回忆/主动发言 | Bridge proactive engine |
| 语音发送 | 本机 voice worker + 微信语音气泡 |
| 唱歌 | 预渲染歌曲队列 |
| 入站语音 | Reader + speech-recognition + 本地 SenseVoice |
| 记忆/心情 | 配套 `dsh-companion-memory` 内核 |

## 消息节奏

- 私聊纯文字使用 **2.5 秒合并窗口**；图片使用 **4 秒合并窗口**，图片后 4 秒内的文字会进入同一轮；
- 一次回复最多 **4 条**，避免碎片刷屏；
- 自动语音只在**整轮只有一条回复**时触发，避免文字已经发完后语音才补一句；
- 语音入队记为 `submitted`，不把尚未发出的语音伪装成 `confirmed`。

## 架构

```text
WeChat
  │
  ▼
WeChatAgent Hook / Reader / OneBot
  │
  ├─ text / image / voice / files
  │
  ▼
social-bridge (this repo)
  ├─ proactive-engine
  ├─ media-outbox
  ├─ voice-queue
  └─ dsh plugin client
        │
        ▼
  DSH host (native-context + companion memory)
        │
        ├─ before-context: memory / mood
        └─ after-response: queue / consolidation
```

入站语音：

```text
微信语音
  → Reader 读取本地消息库（type=34）
  → speech-recognition 可选插件
  → 本地 SenseVoice ASR (127.0.0.1:11231)
  → 转写文字
  → 原模型回复
```

## 前置条件

必须全部满足：

- Windows；
- WeChatAgent `0.4.x`；
- WeChat 桌面客户端已登录；
- Bridge 已连接，且存在：
  - `data/workspace/state/social-dsh-token.txt`
  - `data/workspace/state/wechat-io-config.json`
  - `data/workspace/state/chat-history/<account>/history.sqlite`
- Node.js 22+；
- Python 3.11+（入站语音）；
- 图片记忆需要 Ollama + `qwen2.5vl:3b`；
- 入站语音需要 WeChatAgent 可选插件 `speech-recognition`；
- 语音发送需要你自己的本机 voice worker、音色参考和 `voice_config.json`；
- 自动语音需要 voice worker 写入 `state/voice-health.json`；缺少健康标记时只保留显式语音。

## 不包含

为了安全，这个仓库**不包含**：

- 微信聊天数据库；
- 人格文件；
- 音色参考 `*.wav`；
- Bridge token / OneBot token / API key；
- 微信账号、wxid、绝对用户路径；
- 任何私人图片或语音。

## 安装

先确认 WeChatAgent 和 Bridge 已连接、微信已登录。

```powershell
git clone https://github.com/147247586/wechat-companion.git
cd wechat-companion
```

复制配置模板，按本机路径填写：

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

预览：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

确认后安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Apply
```

安装会：

1. 备份现有目标文件；
2. 同步 `payload` 到 workspace 和 app project；
3. 安装/启用 `speech-recognition`（如果本机已有该可选插件）；
4. 配置本地 ASR endpoint；
5. 启动本地 ASR；
6. 创建登录启动项。

## 入站语音

从 WeChatAgent 的可选扩展安装 `speech-recognition`，然后：

```powershell
powershell -ExecutionPolicy Bypass -File data\workspace\scripts\start-local-asr.ps1
```

默认 endpoint：

```text
http://127.0.0.1:11231/v1
```

模型：

```text
sensevoice
```

协议：

```text
openai-transcriptions
```

ASR 模型路径默认指向 `D:\voice-svc\...`，可用环境变量覆盖：

```powershell
$env:WECHAT_ASR_MODEL = 'D:\path\to\sherpa-onnx-sense-voice'
```

音频只在 `127.0.0.1` 处理，不上传。

## 验证

```powershell
node verify.mjs
```

检查：

- DSH health；
- Bridge 日志；
- Reader config；
- 记忆数据库；
- 图片 worker；
- 面板；
- `speech-recognition` 配置；
- 本地 ASR health；
- 已记录语音引用数量；
- 入站语音状态。

## 语音发送

语音发送依赖本机已有链路：

- `wechat-voice/voice_queue_watch.py`
- `voice_bar.py`
- 你自己的 Breeze/SeedVC 配置
- `singing_target.wav` 等音色参考

这些**不包含在本仓库**，也不会被自动下载。

## 隐私

- 不包含 token、账号、人格、音色；
- 不上传聊天记录；
- 入站语音只走本机 ASR；
- 图片记忆依赖本地模型；
- 主动发言需要 Bridge 登录与聊天白名单。

## 限制

- 需要 WeChatAgent / Bridge / Hook，不能只装 DSH；
- 不同 WeChatAgent 版本可能改协议；
- 入站语音依赖 Reader + speech-recognition，缺少任一都会退回“未能识别”占位；
- 语音发送依赖本机 UI 自动化，升级微信可能失效；
- 自动语音需要本机 voice worker 与 health 标记；没有时只能显式发语音；
- 图片 caption 质量取决于本地视觉模型；
- 0.x 版本接口可能调整。

## 故障排查

### 没有图片记忆
检查 Ollama 是否有 `qwen2.5vl:3b`，以及 image worker 是否运行。

### 入站语音没有反应
检查：

- `speech-recognition` 是否启用；
- 是否授予 `audio_read`；
- 当前聊天是否在插件 chats 范围内；
- `http://127.0.0.1:11231/health` 是否返回 200；
- `state/voices/index.json` 是否产生记录。

### 主动发言不发送
检查 Bridge 登录、白名单、静默时段和 proactive 策略。

## 许可

本项目原创部分使用 MIT。  
`payload/components/qq-bridge` 保留其原始 MIT 许可与版权声明。  
WeChatAgent 相关源码与可选扩展遵循其各自许可；使用前请确认你拥有本机部署和修改权限。

## 相关

- 通用记忆内核：https://github.com/147247586/dsh-companion-memory
- WeChatAgent：本机安装

