// -*- coding: utf-8 -*-
/**
 * session_summary - 会话摘要工具
 * 快速提取会话的关键信息，生成结构化摘要
 * 
 * 修复：通过本地文件系统读取会话数据
 */

import * as fs from "fs";
import * as path from "path";

// ============ 辅助函数：获取默认配置（每次调用返回新对象）============
function getOpenclawDir(): string {
  return path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".openclaw");
}

function getSessionsDir(): string {
  return path.join(getOpenclawDir(), "sessions");
}

function getAgentsDir(): string {
  return path.join(getOpenclawDir(), "agents");
}

function getDefaultMaxMessages(): number {
  return 50;
}

/**
 * 从本地文件系统获取会话消息
 */
async function fetchSessionMessages(
  sessionKey: string,
  limit: number
): Promise<any[]> {
  // 先从 sessions 目录的索引文件中查找 sessionFile
  const sessionsDir = getSessionsDir();
  const agentsDir = getAgentsDir();
  let sessionFilePath: string | null = null;
  let foundSessionKey = sessionKey;

  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json") || file.includes(".bak.")) continue;
      const filePath = path.join(sessionsDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const sessions = JSON.parse(content);

        if (sessionKey && sessions[sessionKey]) {
          foundSessionKey = sessionKey;
          if (sessions[sessionKey].sessionFile) {
            sessionFilePath = sessions[sessionKey].sessionFile;
          }
          break;
        }

        // 如果没指定 sessionKey，找根会话（spawnDepth 为空或为 0）
        if (!sessionKey) {
          for (const [key, value] of Object.entries(sessions)) {
            const s = value as any;
            const depth = s.spawnDepth;
            if (depth === undefined || depth === null || depth === 0) {
              foundSessionKey = key;
              if (s.sessionFile) {
                sessionFilePath = s.sessionFile;
              }
              break;
            }
          }
          if (sessionFilePath) break;
        }
      } catch {
        // 跳过无效文件
      }
    }
  }

  // 如果索引文件中没找到，直接搜索 agents/{role}/sessions/ 下的 .jsonl 文件
  if (!sessionFilePath && fs.existsSync(agentsDir)) {
    const agentRoles = fs.readdirSync(agentsDir);
    for (const role of agentRoles) {
      const roleSessionsDir = path.join(agentsDir, role, "sessions");
      if (!fs.existsSync(roleSessionsDir)) continue;

      const sessionFiles = fs.readdirSync(roleSessionsDir)
        .filter(f => f.endsWith(".jsonl") && !f.includes(".deleted.") && !f.includes(".reset.") && !f.includes(".checkpoint."));

      // 按修改时间排序，取最新的
      const sortedFiles = sessionFiles.map(f => ({
        name: f,
        mtime: fs.statSync(path.join(roleSessionsDir, f)).mtime.getTime()
      })).sort((a, b) => b.mtime - a.mtime);

      if (sortedFiles.length > 0 && !sessionKey) {
        sessionFilePath = path.join(roleSessionsDir, sortedFiles[0].name);
        break;
      } else if (sessionKey) {
        for (const sf of sortedFiles) {
          if (sf.name.includes(sessionKey.replace(/:/g, "-").substring(0, 8))) {
            sessionFilePath = path.join(roleSessionsDir, sf.name);
            break;
          }
        }
      }

      if (sessionFilePath) break;
    }
  }

  if (!sessionFilePath) {
    throw new Error("未找到会话数据: " + (sessionKey || "无指定会话"));
  }

  // 读取 .jsonl 文件并解析消息
  if (!fs.existsSync(sessionFilePath)) {
    throw new Error("会话文件不存在: " + sessionFilePath);
  }

  const messages: any[] = [];
  const lines = fs.readFileSync(sessionFilePath, "utf-8").split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // 只处理消息类型的记录
      if (obj.type === "message") {
        const msg: any = {
          role: obj.message?.role || "unknown",
          content: obj.message?.content || "",
          timestamp: obj.timestamp,
          model: obj.model,
        };

        // 处理内容格式
        if (typeof msg.content === "object" && msg.content !== null) {
          msg.content = JSON.stringify(msg.content);
        } else if (Array.isArray(msg.content)) {
          const textParts: string[] = [];
          for (const part of msg.content) {
            if (part.type === "text" && part.text) {
              textParts.push(part.text);
            }
          }
          msg.content = textParts.join("\n");
        }

        messages.push(msg);

        if (limit > 0 && messages.length >= limit) {
          break;
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }

  return messages;
}

/**
 * 获取会话列表（从本地文件系统）
 */
async function fetchSessionList(): Promise<any[]> {
  const sessionsDir = getSessionsDir();
  const sessions: any[] = [];

  if (!fs.existsSync(sessionsDir)) {
    return sessions;
  }

  const files = fs.readdirSync(sessionsDir);

  for (const file of files) {
    if (!file.endsWith(".json") || file.includes(".bak.")) {
      continue;
    }

    const filePath = path.join(sessionsDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const sessionData = JSON.parse(content);

      for (const [key, value] of Object.entries(sessionData)) {
        const s = value as any;
        sessions.push({
          key,
          sessionId: s.sessionId,
          label: s.label,
          status: s.status,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          model: s.model,
        });
      }
    } catch {
      // 跳过无效文件
    }
  }

  // 按更新时间排序
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return sessions;
}

/**
 * 从消息文本中提取文件路径
 */
function extractFilePaths(text: string): string[] {
  const files: Set<string> = new Set();

  if (!text) return [];

  // 匹配常见文件路径模式
  const patterns = [
    // Windows 绝对路径
    /[A-Z]:[\\/][\w\-./\\]+\.\w{1,10}/gi,
    // 相对路径（包含扩展名）
    /(?:^|\s|["'`])([\w\-./]+\.\w{1,10})(?:\s|["'`]|$)/gi,
    // 文件路径提及（中文）
    /(?:文件|修改|创建|读取|写入)[:：]\s*([^\s\n]+\.\w{1,10})/gi,
    // Markdown 代码块引用
    /`([^`]+\.\w{1,10})`/gi,
  ];

  for (const pattern of patterns) {
    let match;
    // 重置正则表达式 lastIndex
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(text)) !== null) {
      const filePath = match[1] || match[0];
      // 过滤掉明显不是文件路径的内容
      if (filePath && 
          !filePath.startsWith("http") &&
          !filePath.includes("node_modules") &&
          filePath.length > 3 &&
          filePath.length < 200) {
        files.add(filePath);
      }
    }
  }

  return Array.from(files);
}

/**
 * 从消息文本中提取解决的问题
 */
function extractSolvedProblems(text: string): string[] {
  const problems: string[] = [];

  if (!text) return problems;

  // 匹配成功标记
  const successPatterns = [
    /✅\s*(.+)/g,
    /√\s*(.+)/g,
    /已解决[：:]\s*(.+)/g,
    /成功[：:]\s*(.+)/g,
    /修复[：:]\s*(.+)/g,
    /完成[：:]\s*(.+)/g,
    /问题[：:]\s*(.+?)(?:已|成功)/g,
  ];

  for (const pattern of successPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const problem = match[1].trim();
      if (problem && problem.length > 2 && problem.length < 100) {
        problems.push(problem);
      }
    }
  }

  return problems;
}

/**
 * 从消息文本中提取遗留待办
 */
function extractTodos(text: string): string[] {
  const todos: string[] = [];

  if (!text) return todos;

  // 匹配待办标记
  const todoPatterns = [
    /[-•]\s*\[?\s*\]\s*(.+)/g,
    /TODO[:：]\s*(.+)/gi,
    /待办[:：]\s*(.+)/g,
    /待处理[:：]\s*(.+)/g,
    /遗留问题[:：]\s*(.+)/g,
    /后续[:：]\s*(.+)/g,
    /需要.+[:：]\s*(.+)/g,
  ];

  for (const pattern of todoPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const todo = match[1].trim();
      if (todo && todo.length > 2 && todo.length < 100) {
        todos.push(todo);
      }
    }
  }

  return todos;
}

/**
 * 从消息文本中提取关键决策
 */
function extractDecisions(text: string): string[] {
  const decisions: string[] = [];

  if (!text) return decisions;

  // 匹配决策标记
  const decisionPatterns = [
    /决策[:：]\s*(.+)/g,
    /决定[:：]\s*(.+)/g,
    /选择[:：]\s*(.+)/g,
    /方案[:：]\s*(.+)/g,
    /→(.+)/g,
    /使用\s*(.+?)\s*(?:方案|方式|实现)/g,
    /改用\s*(.+)/g,
    /采用\s*(.+)/g,
  ];

  for (const pattern of decisionPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const decision = match[1].trim();
      if (decision && decision.length > 2 && decision.length < 150) {
        decisions.push(decision);
      }
    }
  }

  return decisions;
}

/**
 * 提取消息文本内容（去除工具调用）
 */
function extractTextContent(message: any): string {
  const parts: string[] = [];

  if (!message) return "";

  if (message.content) {
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && part.text) {
          parts.push(part.text);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * 解析会话消息
 */
function parseMessages(
  messages: any[],
  includeTools: boolean
): {
  userMessages: number;
  aiMessages: number;
  model: string;
  startTime: Date | null;
  endTime: Date | null;
  files: string[];
  solvedProblems: string[];
  decisions: string[];
  todos: string[];
  fullText: string;
} {
  let userMessages = 0;
  let aiMessages = 0;
  let model = "";
  let startTime: Date | null = null;
  let endTime: Date | null = null;
  const files = new Set<string>();
  const solvedProblems = new Set<string>();
  const decisions = new Set<string>();
  const todos = new Set<string>();
  const textParts: string[] = [];

  for (const msg of messages) {
    // 过滤工具调用信息（除非 includeTools 为 true）
    if (!includeTools && msg.role === "tool") {
      continue;
    }

    // 统计消息类型
    if (msg.role === "user" || msg.role === "human") {
      userMessages++;
    } else if (msg.role === "assistant" || msg.role === "ai") {
      aiMessages++;
      // 提取模型信息
      if (msg.model && !model) {
        model = msg.model;
      }
    }

    // 提取时间
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!isNaN(ts.getTime())) {
        if (!startTime || ts < startTime) {
          startTime = ts;
        }
        if (!endTime || ts > endTime) {
          endTime = ts;
        }
      }
    }

    // 提取文本内容
    const text = extractTextContent(msg);
    if (text) {
      textParts.push(text);

      // 提取文件
      for (const file of extractFilePaths(text)) {
        files.add(file);
      }

      // 提取解决的问题
      for (const problem of extractSolvedProblems(text)) {
        solvedProblems.add(problem);
      }

      // 提取决策
      for (const decision of extractDecisions(text)) {
        decisions.add(decision);
      }

      // 提取待办
      for (const todo of extractTodos(text)) {
        todos.add(todo);
      }
    }
  }

  return {
    userMessages,
    aiMessages,
    model: model || "未知",
    startTime,
    endTime,
    files: Array.from(files).slice(0, 20),
    solvedProblems: Array.from(solvedProblems).slice(0, 10),
    decisions: Array.from(decisions).slice(0, 10),
    todos: Array.from(todos).slice(0, 10),
    fullText: textParts.join("\n\n"),
  };
}

/**
 * 格式化时间范围
 */
function formatTimeRange(start: Date | null, end: Date | null): string {
  if (!start || !end) {
    return "未知";
  }

  const formatDate = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const minute = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  };

  const duration = Math.round((end.getTime() - start.getTime()) / 60000);
  const durationStr = duration < 60 ? `${duration} 分钟` : `${Math.round(duration / 60)} 小时`;

  return `${formatDate(start)} - ${formatDate(end)} (${durationStr})`;
}

/**
 * 生成摘要格式输出
 */
function formatSummary(
  sessionKey: string,
  parsed: ReturnType<typeof parseMessages>,
  totalMessages: number
): string {
  const lines: string[] = [];

  lines.push("================== 会话摘要 ==================");
  lines.push("会话: " + sessionKey);
  lines.push("时间: " + formatTimeRange(parsed.startTime, parsed.endTime));
  lines.push("消息数: " + totalMessages + "（用户 " + parsed.userMessages + ", AI " + parsed.aiMessages + "）");
  lines.push("模型: " + parsed.model);
  lines.push("");

  // 解决的问题
  if (parsed.solvedProblems.length > 0) {
    lines.push("=== 解决的问题 ===");
    for (const problem of parsed.solvedProblems) {
      lines.push("✅ " + problem);
    }
    lines.push("");
  } else {
    lines.push("=== 解决的问题 ===");
    lines.push("（未识别到明确标记的已解决问题）");
    lines.push("");
  }

  // 修改的文件
  if (parsed.files.length > 0) {
    lines.push("=== 修改的文件 ===");
    for (const file of parsed.files) {
      lines.push("- " + file);
    }
    lines.push("");
  } else {
    lines.push("=== 修改的文件 ===");
    lines.push("（未识别到明确的文件路径）");
    lines.push("");
  }

  // 关键决策
  if (parsed.decisions.length > 0) {
    lines.push("=== 关键决策 ===");
    for (const decision of parsed.decisions) {
      lines.push("- " + decision);
    }
    lines.push("");
  }

  // 遗留待办
  if (parsed.todos.length > 0) {
    lines.push("=== 遗留待办 ===");
    for (const todo of parsed.todos) {
      lines.push("- " + todo);
    }
    lines.push("");
  }

  lines.push("==========================================");

  return lines.join("\n");
}

/**
 * 生成紧凑格式输出
 */
function formatCompact(
  sessionKey: string,
  parsed: ReturnType<typeof parseMessages>,
  totalMessages: number
): string {
  const lines: string[] = [];

  lines.push("【" + sessionKey + "】 " + parsed.userMessages + "+" + parsed.aiMessages + "条消息 | " + parsed.model);
  lines.push("时间: " + formatTimeRange(parsed.startTime, parsed.endTime));

  if (parsed.solvedProblems.length > 0) {
    lines.push("✅: " + parsed.solvedProblems.slice(0, 3).join("; "));
  }
  if (parsed.files.length > 0) {
    lines.push("📁: " + parsed.files.slice(0, 5).join(", "));
  }
  if (parsed.todos.length > 0) {
    lines.push("📌: " + parsed.todos.slice(0, 3).join("; "));
  }

  return lines.join("\n");
}

/**
 * 生成完整格式输出
 */
function formatFull(
  sessionKey: string,
  parsed: ReturnType<typeof parseMessages>,
  totalMessages: number
): string {
  const lines: string[] = [];

  lines.push("================== 会话完整记录 ==================");
  lines.push("会话: " + sessionKey);
  lines.push("时间: " + formatTimeRange(parsed.startTime, parsed.endTime));
  lines.push("消息数: " + totalMessages + "（用户 " + parsed.userMessages + ", AI " + parsed.aiMessages + "）");
  lines.push("模型: " + parsed.model);
  lines.push("");
  lines.push("=== 完整文本 ===");
  lines.push(parsed.fullText);
  lines.push("");
  lines.push("==========================================");

  return lines.join("\n");
}

/**
 * 工具执行函数
 */
async function executeSessionSummary(
  _toolCallId: string,
  params: {
    session_key?: string;
    include_tools?: boolean;
    max_messages?: number;
    output_format?: string;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const sessionKey = params.session_key;
  const includeTools = params.include_tools ?? false;
  const maxMessages = params.max_messages ?? getDefaultMaxMessages();
  const outputFormat = params.output_format ?? "summary";

  try {
    // 如果没有指定 session_key，尝试获取最近的会话
    let targetSession = sessionKey;

    if (!targetSession) {
      try {
        const sessions = await fetchSessionList();
        if (sessions.length > 0) {
          // 取最近的会话
          targetSession = sessions[0].key || sessions[0].label || "未知会话";
        } else {
          throw new Error("没有找到可用的会话");
        }
      } catch {
        // 如果无法获取会话列表，让 fetchSessionMessages 自动找最新会话
        targetSession = "";
      }
    }

    // 获取会话消息
    const messages = await fetchSessionMessages(targetSession, maxMessages);

    if (!messages || messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "会话 \"" + (targetSession || "最近会话") + "\" 没有消息记录",
          },
        ],
      };
    }

    // 解析消息
    const parsed = parseMessages(messages, includeTools);

    // 格式化输出
    let output: string;
    const sessionLabel = targetSession || "最近会话";
    switch (outputFormat) {
      case "compact":
        output = formatCompact(sessionLabel, parsed, messages.length);
        break;
      case "full":
        output = formatFull(sessionLabel, parsed, messages.length);
        break;
      case "summary":
      default:
        output = formatSummary(sessionLabel, parsed, messages.length);
        break;
    }

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  } catch (err) {
    const errorMsg = (err as Error).message;

    // 提供有用的错误提示
    let helpText = "";
    if (errorMsg.includes("ENOENT") || errorMsg.includes("不存在")) {
      helpText = "\n\n提示: 请确认 OpenClaw 会话数据目录存在";
    }

    return {
      content: [
        {
          type: "text",
          text: "错误: " + errorMsg + helpText,
        },
      ],
    };
  }
}

// 导出插件
const sessionSummaryPlugin = {
  id: "session-summary",
  name: "Session Summary",
  description: "会话摘要工具，快速提取会话的关键信息和决策点",

  register(api: any) {
    api.registerTool({
      name: "session_summary",
      label: "会话摘要",
      description:
        "提取本次会话的内容要点。包括解决的问题、修改的文件、关键决策和遗留待办。支持 summary、compact、full 三种输出格式。",
      parameters: {
        type: "object",
        properties: {
          session_key: {
            type: "string",
            description: "可选：指定会话key（默认当前会话）",
          },
          include_tools: {
            type: "boolean",
            description: "可选：是否包含工具调用（默认 false，只保留消息文本）",
          },
          max_messages: {
            type: "number",
            description: "可选：最大消息数（默认 50）",
          },
          output_format: {
            type: "string",
            description: "可选：输出格式 \"summary\" | \"full\" | \"compact\"（默认 \"summary\"）",
            enum: ["summary", "full", "compact"],
          },
        },
        required: [],
      },
      execute: executeSessionSummary,
    } as any);
  },
};

export default sessionSummaryPlugin;
