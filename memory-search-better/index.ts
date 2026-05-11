// -*- coding: utf-8 -*-
/**
 * memory_search_better - 增强记忆搜索工具
 * 直接读取 memory/*.md 和 wiki/*.md 做全文搜索
 */

import * as fs from "fs";
import * as path from "path";

// 默认配置
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.3;
const MEMORY_DIR = path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".openclaw", "memory");
const WIKI_DIR = path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".openclaw", "wiki");

// 匹配结果接口
interface MatchResult {
  filePath: string;
  relativePath: string;
  matchCount: number;
  matches: Array<{
    lineNum: number;
    line: string;
  }>;
}

/**
 * 搜索单个文件
 */
function searchFile(
  filePath: string,
  query: string,
  minScore: number
): MatchResult | null {
  let content: string;

  try {
    const buffer = fs.readFileSync(filePath);
    // 尝试 UTF-8 解码
    content = buffer.toString("utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const matches: MatchResult["matches"] = [];

  // 构建正则表达式（不区分大小写）
  const searchRegex = new RegExp(escapeRegex(query), "gi");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (searchRegex.test(line)) {
      matches.push({
        lineNum: i + 1,
        line: line.trim(),
      });
      // 重置正则的 lastIndex
      searchRegex.lastIndex = 0;
    }
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    filePath,
    relativePath: path.basename(path.dirname(filePath)) + "/" + path.basename(filePath),
    matchCount: matches.length,
    matches,
  };
}

/**
 * 转义正则特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 获取目录下所有 .md 文件
 */
function getMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归搜索子目录
        files.push(...getMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch {
    // 忽略权限错误
  }

  return files;
}

/**
 * 格式化搜索结果
 */
function formatResults(
  query: string,
  corpus: string,
  results: MatchResult[]
): string {
  const lines: string[] = [];

  lines.push(`搜索: ${query} (范围: ${corpus})`);
  lines.push(`找到 ${results.length} 个匹配文件：`);
  lines.push("");

  for (const result of results) {
    lines.push(`=== ${result.relativePath} (匹配 ${result.matchCount} 行) ===`);
    for (const match of result.matches) {
      // 行号右对齐，方便阅读
      const lineNum = String(match.lineNum).padStart(4);
      lines.push(`  ${lineNum} | ${match.line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 工具执行函数
 */
async function executeMemorySearchBetter(
  _toolCallId: string,
  params: {
    query: string;
    max_results?: number;
    corpus?: string;
    min_score?: number;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = params.query?.trim();

  if (!query) {
    throw new Error("query 参数是必需的");
  }

  const maxResults = params.max_results || DEFAULT_MAX_RESULTS;
  const corpus = params.corpus || "all";
  const minScore = params.min_score || DEFAULT_MIN_SCORE;

  const allResults: MatchResult[] = [];

  // 搜索 memory 目录
  if (corpus === "memory" || corpus === "all") {
    const memoryFiles = getMarkdownFiles(MEMORY_DIR);
    for (const file of memoryFiles) {
      const result = searchFile(file, query, minScore);
      if (result) {
        allResults.push(result);
      }
    }
  }

  // 搜索 wiki 目录
  if (corpus === "wiki" || corpus === "all") {
    const wikiFiles = getMarkdownFiles(WIKI_DIR);
    for (const file of wikiFiles) {
      const result = searchFile(file, query, minScore);
      if (result) {
        allResults.push(result);
      }
    }
  }

  // 按匹配行数降序排序
  allResults.sort((a, b) => b.matchCount - a.matchCount);

  // 限制结果数量
  const limitedResults = allResults.slice(0, maxResults);

  if (limitedResults.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `搜索: ${query} (范围: ${corpus})\n未找到匹配结果。`,
        },
      ],
    };
  }

  const output = formatResults(query, corpus, limitedResults);

  return {
    content: [
      {
        type: "text",
        text: output,
      },
    ],
  };
}

// 导出插件
const memorySearchBetterPlugin = {
  id: "memory-search-better",
  name: "Memory Search Better",
  description: "增强记忆搜索工具，直接全文搜索 memory/ 和 wiki/ 目录下的 .md 文件",

  register(api: any) {
    api.registerTool({
      name: "memory_search_better",
      label: "增强记忆搜索",
      description:
        "直接读取 memory/*.md 和 wiki/*.md 文件做全文搜索，返回匹配的文件名、行号和匹配片段。按匹配行数排序。比原生 memory_search 更完整。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词",
          },
          max_results: {
            type: "number",
            description: "最大结果数（默认 10）",
          },
          corpus: {
            type: "string",
            description: "搜索范围：memory | wiki | all（默认 all）",
            enum: ["memory", "wiki", "all"],
          },
          min_score: {
            type: "number",
            description: "最低匹配分数（默认 0.3）",
          },
        },
        required: ["query"],
      },
      execute: executeMemorySearchBetter,
    } as any);
  },
};

export default memorySearchBetterPlugin;
