#!/usr/bin/env node
import fs from "fs";
import fetch from "node-fetch";
import schedule from "node-schedule";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

dotenv.config();

const GITHUB_REPOS = process.env.REPORT_REPOS.split(",");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;

// LLM 配置
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || "https://api.openai.com/v1";
const API_MODEL = process.env.API_MODEL || "gpt-4o";

// 文件存储数据 - 默认当前目录的 data.json
const DATA_FILE = process.env.DATA_FILE || "data.json";

// 内存存储作为备选方案
let memoryData = {};

// ========== 工具函数 ==========

const checkFileSystemAccess = () => {
  try {
    const testFile = DATA_FILE + '.test';
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch (e) {
    return false;
  }
};

const fetchRepoStats = async (repo) => {
  const headers = {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "User-Agent": "nodejs-monitor"
  };

  // 获取 repo 信息
  const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  const repoData = await repoRes.json();

  // 获取 commit 数（只能用 commits API，因为 repo 的 commit_count 不准确）
  const commitsRes = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers });
  const commits = commitsRes.headers.get("link")?.match(/&page=(\d+)>; rel="last"/);
  const commitCount = commits ? parseInt(commits[1]) : 0;

  // 获取 issue 数
  const issuesRes = await fetch(`https://api.github.com/search/issues?q=repo:${repo}+type:issue+state:open`, { headers });
  const issuesData = await issuesRes.json();

  return {
    stars: repoData.stargazers_count,
    commits: commitCount,
    issues: issuesData.total_count
  };
};

const loadData = () => {
  try {
    // 首先尝试从文件加载
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, "utf-8");
      if (content.trim()) {
        const data = JSON.parse(content);
        // 同步到内存
        memoryData = { ...data };
        return data;
      }
    }
  } catch (e) {
    console.warn(`无法从文件加载数据 (${DATA_FILE}):`, e.message);
    console.log("将使用内存存储模式");
  }

  // 如果文件加载失败，返回内存数据
  return Object.keys(memoryData).length > 0 ? memoryData : {};
};

const saveData = (data) => {
  // 总是保存到内存
  memoryData = { ...data };

  try {
    // 尝试保存到文件
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`数据已保存到文件: ${DATA_FILE}`);
  } catch (e) {
    console.warn(`无法保存到文件 (${DATA_FILE}):`, e.message);
    console.log("数据已保存到内存，下次重启将丢失");

    // 如果是权限问题，尝试保存到 /tmp
    if (e.code === 'EROFS' || e.code === 'EACCES') {
      try {
        const tmpFile = `/tmp/starReport_data_${Date.now()}.json`;
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        console.log(`数据已备份到: ${tmpFile}`);
      } catch (tmpError) {
        console.warn("无法创建临时备份文件:", tmpError.message);
      }
    }
  }
};

const sendFeishuMessage = async (content) => {
  const cardContent = {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "padding": "12px 12px 12px 12px",
      "elements": [
        {
          "tag": "markdown",
          "content": content,
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px"
        }
      ]
    }
  }
  await fetch(FEISHU_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card: cardContent })
  });
};

// ========== 每日任务 ==========

const dailyJob = async () => {
  const data = loadData();
  const today = new Date().toISOString().split("T")[0];
  data[today] = data[today] || {};

  let report = `【GitHub 仓库日报】\n日期：${today}\n`;

  for (const repo of GITHUB_REPOS) {
    const stats = await fetchRepoStats(repo);

    const prevDate = Object.keys(data).sort().reverse().find(date => data[date][repo]);
    const prevStats = prevDate ? data[prevDate][repo] : { stars: 0, commits: 0, issues: 0 };

    const diffStars = stats.stars - prevStats.stars;
    const diffCommits = stats.commits - prevStats.commits;
    const diffIssues = stats.issues - prevStats.issues;

    data[today][repo] = stats;

    report += `\n🔗 ${repo}\n⭐️ Stars: ${stats.stars} (+${diffStars})\n` +
      `🔨 Commits: ${stats.commits} (+${diffCommits})\n` +
      `🐛 Issues: ${stats.issues} (+${diffIssues})\n`;
  }

  saveData(data);
  // await sendFeishuMessage(report);
  return report;
};

// ========== 每周任务（周三 20:00） ==========

const weeklyJob = async () => {
  const data = loadData();
  const dates = Object.keys(data).sort().reverse().slice(0, 7);

  let report = `【GitHub 仓库周报】\n日期：${dates[dates.length - 1]} ~ ${dates[0]}\n`;

  for (const repo of GITHUB_REPOS) {
    const firstDay = data[dates[dates.length - 1]]?.[repo] || { stars: 0, commits: 0, issues: 0 };
    const lastDay = data[dates[0]]?.[repo] || { stars: 0, commits: 0, issues: 0 };

    const diffStars = lastDay.stars - firstDay.stars;
    const diffCommits = lastDay.commits - firstDay.commits;
    const diffIssues = lastDay.issues - firstDay.issues;

    report += `\n🔗 ${repo}\n⭐️ Stars: ${lastDay.stars} (+${diffStars})\n` +
      `🔨 Commits: ${lastDay.commits} (+${diffCommits})\n` +
      `🐛 Issues: ${lastDay.issues} (+${diffIssues})\n`;
  }

  await sendFeishuMessage(report);
  return report;
};

// ========== OpenAI 智能分析 ==========

const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: API_BASE_URL
});

const generateAnalysis = async (data, question = null) => {
  // 使用 BMAD 风格的结构化提示词
  const systemPrompt = `# GitHub 仓库数据分析专家

## 角色定义
你是一位资深的 GitHub 仓库数据分析专家，具备以下专业能力：
- 深度理解开源项目生态和发展规律
- 精通数据可视化和趋势分析技术
- 擅长从复杂数据中提取关键洞察
- 具备丰富的项目管理和技术决策经验

## 核心职责
1. **数据解读**：准确解析 GitHub 仓库的各项指标数据
2. **趋势分析**：识别项目发展趋势和关键变化点
3. **洞察提取**：从数据中发现有价值的业务洞察
4. **建议输出**：基于分析结果提供可行的改进建议

## 分析框架
采用多维度分析方法：
- **定量分析**：基于数据指标的统计分析
- **定性分析**：结合行业经验的深度解读
- **对比分析**：横向和纵向的数据对比
- **预测分析**：基于历史数据的趋势预测

## 输出标准
- 使用专业的数据分析术语
- 提供清晰的数据可视化表格
- 突出关键发现和异常点
- 给出具体可执行的建议`;

  const userPrompt = question
    ? `## 分析任务

### 背景信息
我需要对以下 GitHub 仓库数据进行专业分析，并回答特定问题。

### 数据集
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

### 用户问题
${question}

### 分析要求
请按照以下结构进行分析：

1. **数据概览**
   - 数据时间范围和覆盖仓库
   - 关键指标汇总

2. **针对性分析**
   - 围绕用户问题的深度分析
   - 相关数据的详细解读

3. **趋势洞察**
   - 数据变化趋势识别
   - 关键变化点分析

4. **可视化展示**
   - 制作数据对比表格
   - 突出显示重要指标

5. **结论与建议**
   - 回答用户问题的核心结论
   - 基于分析的可行建议`
    : `## 分析任务

### 背景信息
我需要对以下 GitHub 仓库数据进行全面的专业分析。

### 数据集
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

### 分析要求
请按照以下结构进行全面分析：

1. **数据概览**
   - 数据时间范围和覆盖仓库
   - 关键指标汇总统计

2. **趋势分析**
   - Stars 增长趋势分析
   - Commits 活跃度变化
   - Issues 处理情况评估

3. **对比分析**
   - 不同仓库间的横向对比
   - 时间维度的纵向对比
   - 关键指标的相关性分析

4. **可视化展示**
   - 制作详细的数据对比表格
   - 突出显示异常值和关键变化

5. **深度洞察**
   - 项目健康度评估
   - 发展瓶颈识别
   - 增长机会分析

6. **专业建议**
   - 基于数据的改进建议
   - 未来发展策略建议`;

  const completion = await openai.chat.completions.create({
    model: API_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  return completion.choices[0].message.content;
};

// ========== MCP Server 实现 ==========

const createMcpServer = () => {
  const server = new Server(
    {
      name: 'starReport-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 列出可用工具
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_repo_data',
          description: '获取 GitHub 仓库的历史数据',
          inputSchema: {
            type: 'object',
            properties: {
              repo: {
                type: 'string',
                description: '仓库名称（可选，不提供则返回所有仓库数据）'
              }
            }
          }
        },
        {
          name: 'generate_daily_report',
          description: '生成今日 GitHub 仓库活跃度报告',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'generate_weekly_report',
          description: '生成本周 GitHub 仓库活跃度报告',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'ai_analysis',
          description: '使用 AI 对仓库数据进行智能分析',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '要分析的具体问题（可选）'
              }
            }
          }
        },
        {
          name: 'send_feishu_message',
          description: '发送消息到飞书群',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: '要发送的消息内容'
              }
            },
            required: ['message']
          }
        }
      ]
    };
  });

  // 处理工具调用
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'get_repo_data': {
          const data = loadData();
          if (args.repo) {
            const repoData = {};
            Object.keys(data).forEach(date => {
              if (data[date][args.repo]) {
                repoData[date] = { [args.repo]: data[date][args.repo] };
              }
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(repoData, null, 2)
                }
              ]
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2)
              }
            ]
          };
        }

        case 'generate_daily_report': {
          const report = await dailyJob();
          return {
            content: [
              {
                type: 'text',
                text: report
              }
            ]
          };
        }

        case 'generate_weekly_report': {
          const report = await weeklyJob();
          return {
            content: [
              {
                type: 'text',
                text: report
              }
            ]
          };
        }

        case 'ai_analysis': {
          const data = loadData();
          const analysis = await generateAnalysis(data, args.question);
          return {
            content: [
              {
                type: 'text',
                text: analysis
              }
            ]
          };
        }

        case 'send_feishu_message': {
          await sendFeishuMessage(args.message);
          return {
            content: [
              {
                type: 'text',
                text: '消息已成功发送到飞书群'
              }
            ]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  });

  return server;
};

// ========== SSE Server 实现 ==========

const createSseServer = () => {
  const app = express();
  app.use(express.json());

  // SSE 实时流式分析
  app.get("/mcp-sse", async (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Cache-Control"
    });
    res.flushHeaders();

    try {
      // 先发送连接确认
      res.write(`data: {"type": "connection", "message": "Connected to MCP analysis service"}\n\n`);

      const data = loadData();

      // 使用 BMAD 风格的结构化提示词（SSE 版本）
      const systemPrompt = `# GitHub 仓库数据分析专家（实时分析）

## 角色定义
你是一位资深的 GitHub 仓库数据分析专家，专门提供实时数据分析服务，具备以下专业能力：
- 深度理解开源项目生态和发展规律
- 精通数据可视化和趋势分析技术
- 擅长从复杂数据中快速提取关键洞察
- 具备丰富的项目管理和技术决策经验
- 能够提供流式、结构化的分析报告

## 核心职责
1. **实时数据解读**：快速准确解析 GitHub 仓库的各项指标数据
2. **动态趋势分析**：实时识别项目发展趋势和关键变化点
3. **即时洞察提取**：从数据中快速发现有价值的业务洞察
4. **流式建议输出**：基于分析结果提供可行的改进建议

## 分析框架
采用快速多维度分析方法：
- **定量分析**：基于数据指标的统计分析
- **定性分析**：结合行业经验的深度解读
- **对比分析**：横向和纵向的数据对比
- **预测分析**：基于历史数据的趋势预测

## 输出标准
- 使用专业的数据分析术语
- 提供清晰的数据可视化表格
- 突出关键发现和异常点
- 给出具体可执行的建议
- 保持流式输出的连贯性和可读性`;

      const userPrompt = `## 实时分析任务

### 背景信息
我需要对以下 GitHub 仓库数据进行全面的专业实时分析。

### 数据集
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

### 分析要求
请按照以下结构进行全面的实时流式分析：

1. **数据概览**
   - 数据时间范围和覆盖仓库
   - 关键指标汇总统计

2. **趋势分析**
   - Stars 增长趋势分析
   - Commits 活跃度变化
   - Issues 处理情况评估

3. **对比分析**
   - 不同仓库间的横向对比
   - 时间维度的纵向对比
   - 关键指标的相关性分析

4. **可视化展示**
   - 制作详细的数据对比表格
   - 突出显示异常值和关键变化

5. **深度洞察**
   - 项目健康度评估
   - 发展瓶颈识别
   - 增长机会分析

6. **专业建议**
   - 基于数据的改进建议
   - 未来发展策略建议

### 输出要求
- 使用 Markdown 格式
- 保持流式输出的结构化
- 确保每个部分内容完整`;

      const completion = await openai.chat.completions.create({
        model: API_MODEL,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });

      let analysis = "";
      for await (const chunk of completion) {
        const content = chunk.choices?.[0]?.delta?.content || "";
        if (content) {
          analysis += content;
          const eventData = JSON.stringify({
            type: "content",
            content: content,
            accumulated: analysis
          });
          res.write(`data: ${eventData}\n\n`);
        }
      }

      // 发送完成事件
      res.write(`data: {"type": "done", "analysis": ${JSON.stringify(analysis)}}\n\n`);
      res.write("event: end\ndata: [DONE]\n\n");

      // 飞书推送
      await sendFeishuMessage(`【智能分析】\n${analysis}`);

    } catch (error) {
      const errorData = JSON.stringify({
        type: "error",
        message: error.message
      });
      res.write(`data: ${errorData}\n\n`);
    } finally {
      res.end();
    }
  });

  // 兼容原有 webhook 入口
  app.post("/feishu-webhook", async (req, res) => {
    try {
      const text = req.body.event.message.text;
      console.log("🔔 飞书问题：", text);

      const data = loadData();

      // 使用 BMAD 风格的结构化提示词（Webhook 版本）
      const systemPrompt = `# GitHub 仓库数据分析专家（Webhook 响应）

## 角色定义
你是一位资深的 GitHub 仓库数据分析专家，专门处理来自 Feishu 的实时查询请求，具备以下专业能力：
- 深度理解开源项目生态和发展规律
- 精通数据可视化和趋势分析技术
- 擅长从复杂数据中快速提取关键洞察
- 具备丰富的项目管理和技术决策经验
- 能够提供简洁、准确的即时响应

## 核心职责
1. **即时数据解读**：快速准确解析 GitHub 仓库的各项指标数据
2. **快速趋势分析**：实时识别项目发展趋势和关键变化点
3. **精准洞察提取**：从数据中快速发现有价值的业务洞察
4. **简洁建议输出**：基于分析结果提供可行的改进建议

## 分析框架
采用高效多维度分析方法：
- **定量分析**：基于数据指标的统计分析
- **定性分析**：结合行业经验的深度解读
- **对比分析**：横向和纵向的数据对比
- **预测分析**：基于历史数据的趋势预测

## 输出标准
- 使用专业的数据分析术语
- 提供清晰的数据可视化表格
- 突出关键发现和异常点
- 给出具体可执行的建议
- 保持响应的简洁性和准确性`;

      const userPrompt = text
        ? `## Webhook 分析任务

### 背景信息
我需要对以下 GitHub 仓库数据进行专业分析，并回答来自 Feishu 的特定问题。

### 数据集
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

### 用户问题
${text}

### 分析要求
请按照以下结构进行快速精准分析：

1. **数据概览**
   - 数据时间范围和覆盖仓库
   - 关键指标汇总

2. **针对性分析**
   - 围绕用户问题的深度分析
   - 相关数据的详细解读

3. **趋势洞察**
   - 数据变化趋势识别
   - 关键变化点分析

4. **可视化展示**
   - 制作数据对比表格
   - 突出显示重要指标

5. **结论与建议**
   - 回答用户问题的核心结论
   - 基于分析的可行建议

### 输出要求
- 使用 Markdown 格式
- 保持响应简洁明了
- 确保关键信息突出`
        : `## Webhook 分析任务

### 背景信息
我需要对以下 GitHub 仓库数据进行全面的专业分析。

### 数据集
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

### 分析要求
请按照以下结构进行全面快速分析：

1. **数据概览**
   - 数据时间范围和覆盖仓库
   - 关键指标汇总统计

2. **趋势分析**
   - Stars 增长趋势分析
   - Commits 活跃度变化
   - Issues 处理情况评估

3. **对比分析**
   - 不同仓库间的横向对比
   - 时间维度的纵向对比
   - 关键指标的相关性分析

4. **可视化展示**
   - 制作详细的数据对比表格
   - 突出显示异常值和关键变化

5. **深度洞察**
   - 项目健康度评估
   - 发展瓶颈识别
   - 增长机会分析

6. **专业建议**
   - 基于数据的改进建议
   - 未来发展策略建议

### 输出要求
- 使用 Markdown 格式
- 保持响应简洁明了
- 确保关键信息突出`;

      const completion = await openai.chat.completions.create({
        model: API_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });

      const analysis = completion.choices[0].message.content;

      // 飞书推送
      await sendFeishuMessage(`【智能分析】\n${analysis}`);

      res.json({ success: true, message: "分析完成并已推送到飞书" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // 健康检查
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "starReport MCP Server",
      timestamp: new Date().toISOString()
    });
  });

  return app;
};

// ========== 主程序 ==========

const taskType = process.argv[2] || "daily";

const run = async () => {
  // 启动时检查文件系统访问权限
  const hasFileAccess = checkFileSystemAccess();
  if (!hasFileAccess) {
    console.warn("⚠️  文件系统只读，将使用内存存储模式");
    console.log(`📁 尝试的数据文件路径: ${DATA_FILE}`);
    console.log("💡 可通过环境变量 DATA_FILE 指定可写路径");
  } else {
    console.log(`📁 数据文件路径: ${DATA_FILE}`);
  }

  if (taskType === "daily") {
    await dailyJob();
  } else if (taskType === "weekly") {
    await weeklyJob();
  } else if (taskType === "analysis") {
    await weeklyJob();
    const data = loadData();
    // 只获取最近一周的数据
    const dates = Object.keys(data).sort().reverse().slice(0, 7);
    const weeklyData = {};
    dates.forEach(date => {
      if (data[date]) {
        weeklyData[date] = data[date];
      }
    });

    const analysis = await generateAnalysis(weeklyData);
    await sendFeishuMessage(`【智能分析】\n${analysis}`);
    console.log("【智能分析】\n" + analysis);
  } else if (taskType === "mcp-server") {
    // MCP Server 通过 stdio 运行
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("🚀 MCP Server 已启动 (stdio)");
  } else if (taskType === "sse-server") {
    // SSE Server 通过 HTTP 运行
    const app = createSseServer();
    const port = process.env.PORT || 3001;
    app.listen(port, () => {
      console.log(`🚀 SSE Server 已启动：http://localhost:${port}`);
      console.log(`📊 实时分析：http://localhost:${port}/mcp-sse`);
      console.log(`🔔 Webhook：http://localhost:${port}/feishu-webhook`);
    });
  } else {
    console.log("可用的任务类型：daily, weekly, analysis, mcp-server, sse-server");
  }
};

// ========== 定时任务启动 ==========

if (taskType === "daily" || taskType === "weekly") {
  // // 每天早上 9 点执行日报（东八区）
  // schedule.scheduleJob("0 9 * * *", async () => {
  //   console.log("执行每日任务...");
  //   await dailyJob();
  // });

  // // 每周三 20:00 执行周报（东八区）
  // schedule.scheduleJob("0 20 * * 3", async () => {
  //   console.log("执行周报任务...");
  //   await weeklyJob();
  // });

  // console.log("GitHub 监控服务已启动...");
  run();
} else {
  run();
}
