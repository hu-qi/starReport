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

const sendFeishuMessage = async (text) => {
  await fetch(FEISHU_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } })
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
  const prompt = question 
    ? `你是一个 GitHub 活跃度智能分析助手。
       以下是最新数据：
       ${JSON.stringify(data, null, 2)}
       用户问题：${question}
       请进行详细总结、趋势分析、表格可视化等。`
    : `你是一个 GitHub 活跃度智能分析助手。
       以下是最新数据：
       ${JSON.stringify(data, null, 2)}
       请进行详细总结、趋势分析、表格可视化等。`;

  const completion = await openai.chat.completions.create({
    model: API_MODEL,
    messages: [
      { role: "system", content: "你是 GitHub 智能分析助手。" },
      { role: "user", content: prompt }
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
      const prompt = `
        你是一个 GitHub 活跃度智能分析助手。
        以下是最新数据：
        ${JSON.stringify(data, null, 2)}
        请进行详细总结、趋势分析、表格可视化等。
        `;

      const completion = await openai.chat.completions.create({
        model: API_MODEL,
        stream: true,
        messages: [
          { role: "system", content: "你是 GitHub 智能分析助手。" },
          { role: "user", content: prompt }
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
      const analysis = await generateAnalysis(data, text);

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
    const analysis = await generateAnalysis(data);
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
