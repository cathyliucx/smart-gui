# Interview Coder（开源魔改版）

面向技术面试的桌面助手，支持**截图解析、多模态理解（音频+截图）、AI 解题与调试、隐身窗口**等功能。应用完全本地运行，需自备 API Key，私有数据仅在你与模型供应商之间传输。

## 功能概览

### 截图模式
- **截图队列**：全局快捷键随时捕获题面或代码，最多保留 5 张
- **AI 解析与作答**：自动读取截图，生成题目理解、思考过程与最终回答；代码题输出可复制代码块及复杂度说明，选择题给出 ABCD 选项及理由
- **Debug 模式**：将错误截图交给模型输出修复建议、关键问题和优化方向

### 多模态理解模式（新）
- **三种输入模式**：
  - **仅音频** — 监听系统音频，实时转录并发送给模型理解
  - **仅截图** — 在音频模式下直接截图，发送给多模态模型分析
  - **音频+截图** — 同时捕获音频和截图，组合发送给模型一次性理解
- **原生多模态支持**：
  - Gemini：原生支持音频+图片，一次 API 调用直接理解（推荐）
  - OpenAI (GPT-4o)：图片原生支持，音频通过 Whisper 转录后组合
  - Anthropic (Claude)：图片原生支持，音频通过转录文本发送
- **静默/语音两种输出模式**：
  - **静默模式（默认）**：答案仅文本显示，不发出声音
  - **语音模式**：答案生成后自动 TTS 语音播报完整内容，不截断；自动跳过代码块不朗读
  - 可通过界面上的静默/语音按钮一键切换，设置自动保存
- **知识库辅助**：可加载本地文件夹作为个人知识库，模型回答时优先参考

### 通用
- **窗口隐身**：Electron 浮窗默认透明，支持位置、透明度调节
- **多模型支持**：内置 GPT-5、Gemini 2.5 Flash、Claude Sonnet 4.5 等模型，可自定义模型名称
- **自定义中转地址**：所有供应商均支持自定义 Base URL，方便使用中转/代理服务

---

## 运行要求
- Windows 10/11 或 macOS 13+
- Node.js 18+
- 可用的 API Key（OpenAI / Gemini / Anthropic 任一）

## 快速启动

### Windows
```bash
npm install
stealth-run.bat
```

### macOS
```bash
npm install
chmod +x stealth-run.sh
./stealth-run.sh
```

### 开发模式
```bash
npm install
npm run dev
```

### 绿色版打包（免安装 zip）
```bash
# Windows 绿色版
npm run package-win-zip       # zip 压缩包
npm run package-win-portable  # 单 exe 便携版

# macOS 绿色版
npm run package-mac-zip

# Linux 绿色版
npm run package-linux-zip
```

打包产物在 `release/` 目录下，解压即用，不写注册表，不污染系统。

### 安装包打包
```bash
npm run package-win   # Windows NSIS 安装包 + portable + zip
npm run package-mac   # macOS DMG + zip
npm run package       # 当前平台默认格式
```

启动后按 **Ctrl + B** 显示主窗口，在设置面板中填写 API Key 即可使用。

---

## API Key 配置与中转设置

### 基本配置

启动应用 → Ctrl + B 显示窗口 → 点击设置按钮 → 填写 API Key。

应用会根据 Key 格式自动识别供应商：
| Key 前缀 | 自动识别为 |
| --- | --- |
| `sk-ant-...` | Anthropic (Claude) |
| `sk-...` | OpenAI |
| 其他 | Gemini（默认） |

### 中转/代理地址设置（重点）

在中国境内直连 OpenAI、Anthropic、Google 的官方 API 通常不可用。你需要通过**中转服务（Relay/Proxy）**来访问。设置方法如下：

#### 方法一：在应用设置面板中修改

打开设置面板，对应每个供应商都有一个 **Base URL** 输入框，将官方地址替换为你的中转地址即可。

#### 方法二：直接编辑配置文件

配置文件路径：
- **Windows**: `%APPDATA%\interview-coder-v1\config.json`
- **macOS**: `~/Library/Application Support/interview-coder-v1/config.json`

```json
{
  "apiKey": "你的API Key",
  "apiProvider": "gemini",
  "openaiBaseUrl": "https://你的中转域名/v1",
  "geminiBaseUrl": "https://你的中转域名",
  "anthropicBaseUrl": "https://你的中转域名",
  "openaiModel": "gpt-4o",
  "geminiModel": "gemini-2.5-flash",
  "anthropicModel": "claude-sonnet-4-5",
  "language": "python",
  "silentMode": true
}
```

#### 各供应商中转配置详解

**OpenAI 中转**

官方默认地址：`https://api.openai.com/v1`

设置 `openaiBaseUrl` 为中转地址，需保留路径 `/v1`：
```
https://你的中转域名/v1
```

常见中转方案：
- 自建 Cloudflare Worker 反代
- 第三方 API 中转服务（如 api2d、openai-sb 等）
- 自有 VPS 搭建 Nginx 反代

**Gemini 中转**

官方默认地址：`https://generativelanguage.googleapis.com`

设置 `geminiBaseUrl` 为中转地址，**不需要**加路径后缀：
```
https://你的中转域名
```

应用会自动拼接为 `{baseUrl}/models/{modelName}:generateContent?key={apiKey}`

常见中转方案：
- Cloudflare Worker 反代 Google API
- 自有服务器 Nginx 反代：
  ```nginx
  location / {
      proxy_pass https://generativelanguage.googleapis.com;
      proxy_set_header Host generativelanguage.googleapis.com;
      proxy_ssl_server_name on;
  }
  ```

**Anthropic (Claude) 中转**

官方默认地址：`https://api.anthropic.com`

设置 `anthropicBaseUrl` 为中转地址，**不需要**加路径后缀：
```
https://你的中转域名
```

常见中转方案与 OpenAI 类似，用 Cloudflare Worker 或 Nginx 反代。

#### 自建 Cloudflare Worker 中转示例

适用于所有供应商，只需修改 `TARGET` 变量：

```javascript
const TARGET = "https://generativelanguage.googleapis.com"; // 改成对应官方地址

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = new URL(TARGET).hostname;
    url.protocol = "https:";

    const newRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    return fetch(newRequest);
  },
};
```

部署后将 Worker 域名填入对应 Base URL 即可。

#### 配置验证

设置完成后，在应用内点击"验证 API Key"按钮测试连通性。如果返回错误：
- 检查中转地址是否可访问（浏览器直接打开测试）
- 检查 API Key 是否正确
- 检查中转服务是否正确转发了 `Authorization` / `x-api-key` 等请求头

---

## 快捷键

| 功能 | 快捷键 |
| --- | --- |
| 显示/隐藏窗口 | Ctrl + B |
| 捕获截图 | Ctrl + H |
| 处理截图/生成答案 | Ctrl + Enter |
| 删除最新截图 | Ctrl + L |
| 重置会话 | Ctrl + R |
| 移动窗口 | Ctrl + 方向键 |
| 调整透明度 | Ctrl + [ / Ctrl + ] |
| 退出应用 | Ctrl + Q |

## 界面说明

| 页面 | 功能 |
| --- | --- |
| **Queue** | 截图队列，支持删除与重新截图 |
| **Solutions** | 模型输出的思路、代码、复杂度与要点 |
| **Debug** | 上传错误截图，获取修复建议 |
| **多模态理解** | 音频监听 + 截图 + 多模态模型组合分析 |

## 推荐模型选择

| 场景 | 推荐模型 | 理由 |
| --- | --- | --- |
| 多模态（音频+截图） | **Gemini 2.5 Flash** | 原生支持音频+图片，速度快，延迟低 |
| 纯截图解题 | Gemini 2.5 Flash / GPT-4o | 均支持原生视觉 |
| 代码生成质量 | Claude Sonnet 4.5 | 代码生成能力强 |
| 预算敏感 | Gemini 2.5 Flash | 价格最低 |

## 开发与构建

```bash
npm run dev          # 开发调试（热重载）
npm run build        # 生产构建
npm run run-prod     # 运行生产构建
npm run lint         # 代码检查
```

## 常见问题

**窗口不见了？**
应用仍在后台运行。按 Ctrl + B 切换可见性，或在任务管理器结束 electron 进程后重新启动。

**快捷键失效？**
macOS 需在"系统设置 → 隐私与安全性 → 屏幕录制"中勾选终端或 IDE。

**模型调用失败？**
1. 检查 API Key 是否正确、余额是否充足
2. 检查中转地址是否可用（在中国境内直连官方 API 通常不可用）
3. 在设置面板切换其他模型测试

**系统音频无法捕获？**
- macOS：需在"系统设置 → 隐私与安全性 → 屏幕录制"中授权
- Windows：确保未被其他应用独占音频设备

**中转地址格式？**
- OpenAI：需要以 `/v1` 结尾，如 `https://your-proxy.com/v1`
- Gemini / Anthropic：只需域名，不加路径后缀

## 贡献指南
欢迎通过 Issue 或 Pull Request 反馈 bug、扩展功能或改进提示词。提交前请确认：
- 已执行 `npm run lint`
- 相关文档同步更新

---

保持开源、免费与透明是本项目的初衷，愿它帮助你在算法与工程面试中更高效地练习、复盘与提高。
