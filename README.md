# starReport

starReport 是一个用于自动生成和管理指定 GitHub 仓库 star、commit、issue 等活跃度报告的 Node.js 工具，支持 MCP 协议服务，集成大模型智能分析，并可自动推送到飞书群。

## 主要功能特性

- **GitHub 仓库活跃度监控**：自动采集指定仓库的 star 数、commit 数、issue 数等数据，支持日报和周报统计。
- **自动推送报告**：可将日报、周报和智能分析结果自动推送到飞书群，方便团队同步。
- **MCP 服务支持**：通过 MCP 协议（stdio）对外提供数据查询、报告生成、AI 分析、消息推送等能力，便于集成到自动化平台。
- **智能分析**：集成大模型（如 OpenAI/智谱），对历史数据进行趋势分析、总结和表格可视化，支持自定义问题分析。
- **SSE 实时流式分析**：支持 HTTP SSE 实时返回智能分析内容，适合前端实时展示。
- **Webhook 问答**：兼容飞书 webhook，支持群聊提问并返回智能分析结果。
- **定时任务**：内置定时任务，每天/每周自动采集数据并推送报告，无需人工干预。
- **灵活配置**：支持通过环境变量和 MCP 配置灵活指定监控仓库、推送方式和大模型参数。

## 安装方法

1. 克隆仓库：
   ```bash
   git clone https://github.com/hu-qi/starReport.git
   ```
2. 进入项目目录并安装依赖：
   ```bash
   cd starReport
   npm install
   ```

## 使用说明

1. 配置环境变量：
   复制 `.env.example` 为 `.env`，并根据需要填写相关配置。
2. 运行项目：
   ```bash
   node index.js
   ```

### MCP Server 配置示例

如需通过 MCP 协议启动服务，可参考如下配置：

```json
{
  "mcpServers": {
    "starReport-server": {
      "command": "npx",
      "args": [
        "-y",
        "star-report",
        "mcp-server"
      ],
      "env": {
        "GITHUB_TOKEN": "<你的 GitHub Token>",
        "FEISHU_WEBHOOK": "<你的飞书 Webhook>",
        "REPORT_REPOS": "<repo1,repo2,repo3>",
        "API_KEY": "<你的 API Key>",
        "API_BASE_URL": "<API Base URL>",
        "API_MODEL": "<模型名称>",
        "DATA_FILE":"<数据存放可读性的文件路径，如path/to/writable/directory/data.json>"
      }
    }
  }
}
```

如果是本地运行则替换 `command` 和 `args`：
```json
"command": "node",
"args": [
  "index.js",
  "mcp-server"
],
```

- `command`：启动命令，通常为 `npx`。
- ：命令行参数，`star-report mcp-server` 启动 MCP 服务。
- `env`：环境变量配置，需根据实际情况填写。
  - `GITHUB_TOKEN`：GitHub 访问令牌。
  - `FEISHU_WEBHOOK`：飞书群机器人 Webhook。
  - `REPORT_REPOS`：监控的 GitHub 仓库列表，逗号分隔。
  - `API_KEY`、`API_BASE_URL`、`API_MODEL`：大模型相关配置。

请勿在公开场合泄露敏感信息。

## 功能演示

- MCP tools：
![MCP 工具](https://github.com/hu-qi/starReport/blob/main/screenshots/mcp-tools.png)

- 列举功能：
![func-list](https://github.com/hu-qi/starReport/blob/main/screenshots/func-list.png)

- 飞书消息推送：
![feishu-push](https://github.com/hu-qi/starReport/blob/main/screenshots/feishu-push.png)

## 许可证

本项目基于 MIT 许可证开源。 