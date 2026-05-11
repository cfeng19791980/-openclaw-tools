// -*- coding: utf-8 -*-
/**
 * code_diff - 代码版本对比工具
 * 用于对比两个文件或两个版本的代码差异，输出带行号的 diff
 */

import * as fs from "fs";
import * as path from "path";
import * as iconv from "iconv-lite";

// 默认配置
const DEFAULT_CONTEXT_LINES = 3;

// 编码检测结果
interface DecodeResult {
  content: string;
  encoding: string;
}

/**
 * 尝试用多种编码解码文件内容
 * 优先尝试 UTF-8，失败后尝试 GBK
 */
function decodeBuffer(buffer: Buffer): DecodeResult {
  // 1. 尝试 UTF-8
  try {
    const content = buffer.toString("utf-8");
    // 检查是否有无效的 UTF-8 字符（替换字符）
    const hasReplacementChar = content.includes("\uFFFD");
    if (!hasReplacementChar) {
      return { content, encoding: "utf-8" };
    }
  } catch {
    // 继续尝试其他编码
  }

  // 2. 尝试 GBK (简体中文)
  const gbkDetector = detectGBK(buffer);
  if (gbkDetector.isLikelyGBK) {
    try {
      const content = decodeGBK(buffer);
      return { content, encoding: "gbk" };
    } catch {
      // 继续回退
    }
  }

  // 3. 尝试 Latin1 作为最后的回退
  try {
    const content = buffer.toString("latin1");
    return { content, encoding: "latin1" };
  } catch {
    return { content: buffer.toString("utf-8"), encoding: "utf-8 (with errors)" };
  }
}

/**
 * 检测是否可能是 GBK 编码
 */
function detectGBK(buffer: Buffer): { isLikelyGBK: boolean } {
  let gbkBytes = 0;
  let totalBytes = 0;

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 0x81 && byte <= 0xFE) {
      if (i + 1 < buffer.length) {
        const nextByte = buffer[i + 1];
        if (
          (nextByte >= 0x40 && nextByte <= 0x7E) ||
          (nextByte >= 0x80 && nextByte <= 0xFE)
        ) {
          gbkBytes += 2;
          i++;
        }
      }
    }
    totalBytes++;
  }

  const ratio = totalBytes > 0 ? gbkBytes / totalBytes : 0;
  return { isLikelyGBK: ratio > 0.05 };
}

/**
 * 使用 iconv-lite 解码 GBK
 */
function decodeGBK(buffer: Buffer): string {
  return iconv.decode(buffer, "gbk");
}

/**
 * 读取文件内容并按行分割
 */
function readFileLines(filePath: string): string[] {
  const normalizedPath = path.normalize(filePath);

  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`文件不存在: ${normalizedPath}`);
  }

  const stat = fs.statSync(normalizedPath);
  if (stat.isDirectory()) {
    throw new Error(`路径是目录，不是文件: ${normalizedPath}`);
  }

  // 检查文件大小（防止读取过大文件）
  const maxSize = 10 * 1024 * 1024; // 10MB 上限
  if (stat.size > maxSize) {
    throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，超过安全限制`);
  }

  const buffer = fs.readFileSync(normalizedPath);
  const decoded = decodeBuffer(buffer);

  // 按行分割，保留空行
  return decoded.content.split("\n");
}

/**
 * Diff 操作类型
 */
type DiffOp = "equal" | "add" | "remove";

/**
 * Diff 行
 */
interface DiffLine {
  op: DiffOp;
  oldLine?: number;  // 旧文件行号（1-based）
  newLine?: number;  // 新文件行号（1-based）
  content: string;
}

/**
 * 简单的 LCS (最长公共子序列) diff 算法
 * 返回差异行列表
 */
function computeLCS(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  // 构建 LCS 表
  // dp[i][j] = oldLines[0..i-1] 和 newLines[0..j-1] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => 
    Array.from({ length: n + 1 }, () => 0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const result: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // 相同行
      result.unshift({
        op: "equal",
        oldLine: i,
        newLine: j,
        content: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // 新增行
      result.unshift({
        op: "add",
        newLine: j,
        content: newLines[j - 1],
      });
      j--;
    } else if (i > 0) {
      // 删除行
      result.unshift({
        op: "remove",
        oldLine: i,
        content: oldLines[i - 1],
      });
      i--;
    }
  }

  return result;
}

/**
 * Diff 块
 */
interface DiffChunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * 将 diff 行分组为块
 */
function groupIntoChunks(diffLines: DiffLine[], contextLines: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let currentChunk: DiffChunk | null = null;
  let lastDiffIndex = -Infinity;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    const isDiff = line.op !== "equal";

    if (isDiff) {
      // 需要开始新块？
      if (!currentChunk || i - lastDiffIndex > contextLines * 2 + 1) {
        // 保存当前块
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        // 开始新块
        const startIndex = Math.max(0, i - contextLines);
        currentChunk = {
          oldStart: 0,
          oldCount: 0,
          newStart: 0,
          newCount: 0,
          lines: [],
        };
        // 添加前导上下文
        for (let j = startIndex; j < i; j++) {
          currentChunk.lines.push(diffLines[j]);
        }
      }
      lastDiffIndex = i;
    }

    if (currentChunk) {
      currentChunk.lines.push(line);
    }
  }

  // 添加最后的上下文
  if (currentChunk) {
    const endIndex = Math.min(diffLines.length, lastDiffIndex + contextLines + 1);
    for (let j = lastDiffIndex + 1; j < endIndex; j++) {
      if (diffLines[j].op === "equal") {
        currentChunk.lines.push(diffLines[j]);
      }
    }
    chunks.push(currentChunk);
  }

  // 计算每个块的起始行号和行数
  for (const chunk of chunks) {
    let oldLine = 0, newLine = 0;
    for (const line of chunk.lines) {
      if (line.op === "equal" || line.op === "remove") {
        if (chunk.oldStart === 0 && line.oldLine) {
          chunk.oldStart = line.oldLine;
        }
        if (line.op === "remove" || line.op === "equal") {
          oldLine++;
        }
      }
      if (line.op === "equal" || line.op === "add") {
        if (chunk.newStart === 0 && line.newLine) {
          chunk.newStart = line.newLine;
        }
        if (line.op === "add" || line.op === "equal") {
          newLine++;
        }
      }
    }
    chunk.oldCount = oldLine;
    chunk.newCount = newLine;
  }

  return chunks;
}

/**
 * 格式化 diff 输出
 */
function formatDiff(
  file1: string,
  file2: string,
  diffLines: DiffLine[],
  contextLines: number,
  showFull: boolean
): string {
  const lines: string[] = [];
  const file1Name = path.basename(file1);
  const file2Name = path.basename(file2);

  lines.push(`--- ${file1Name} (${file1}) ---`);
  lines.push(`+++ ${file2Name} (${file2}) +++\n`);

  if (showFull) {
    // 显示全文件对比
    let oldLineNum = 0, newLineNum = 0;
    for (const line of diffLines) {
      const prefix = line.op === "add" ? "+" : line.op === "remove" ? "-" : " ";
      const oldNum = line.oldLine ? String(line.oldLine).padStart(4) : "    ";
      const newNum = line.newLine ? String(line.newLine).padStart(4) : "    ";
      
      if (line.op === "equal") {
        lines.push(`  ${oldNum} | ${newNum} | ${line.content}`);
        oldLineNum = line.oldLine!;
        newLineNum = line.newLine!;
      } else if (line.op === "remove") {
        lines.push(`- ${oldNum} |      | ${line.content}`);
        oldLineNum = line.oldLine!;
      } else {
        lines.push(`+      | ${newNum} | ${line.content}`);
        newLineNum = line.newLine!;
      }
    }
  } else {
    // 只显示差异块
    const chunks = groupIntoChunks(diffLines, contextLines);

    for (const chunk of chunks) {
      // 块头
      lines.push(`@@ -${chunk.oldStart},${chunk.oldCount} +${chunk.newStart},${chunk.newCount} @@`);

      for (const line of chunk.lines) {
        const prefix = line.op === "add" ? "+" : line.op === "remove" ? "-" : " ";
        const oldNum = line.oldLine ? String(line.oldLine).padStart(4) : "    ";
        const newNum = line.newLine ? String(line.newLine).padStart(4) : "    ";
        
        if (line.op === "equal") {
          lines.push(`  ${oldNum} | ${newNum} | ${line.content}`);
        } else if (line.op === "remove") {
          lines.push(`- ${oldNum} |      | ${line.content}`);
        } else {
          lines.push(`+      | ${newNum} | ${line.content}`);
        }
      }
      lines.push("");
    }
  }

  // 统计
  const added = diffLines.filter(l => l.op === "add").length;
  const removed = diffLines.filter(l => l.op === "remove").length;
  const unchanged = diffLines.filter(l => l.op === "equal").length;
  
  lines.push(`============`);
  lines.push(`统计: ${added} 行新增, ${removed} 行删除, ${unchanged} 行不变`);

  return lines.join("\n");
}

/**
 * 工具执行函数
 */
async function executeCodeDiff(
  _toolCallId: string,
  params: {
    file1: string;
    file2: string;
    context_lines?: number;
    show_full?: boolean;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const file1 = params.file1?.trim();
  const file2 = params.file2?.trim();

  if (!file1) {
    throw new Error("file1 参数是必需的");
  }
  if (!file2) {
    throw new Error("file2 参数是必需的");
  }

  const contextLines = params.context_lines ?? DEFAULT_CONTEXT_LINES;
  const showFull = params.show_full ?? false;

  try {
    // 读取两个文件
    const oldLines = readFileLines(file1);
    const newLines = readFileLines(file2);

    // 计算 diff
    const diffLines = computeLCS(oldLines, newLines);

    // 格式化输出
    const output = formatDiff(file1, file2, diffLines, contextLines, showFull);

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
    return {
      content: [
        {
          type: "text",
          text: `错误: ${errorMsg}`,
        },
      ],
    };
  }
}

// 导出插件
const codeDiffPlugin = {
  id: "code-diff",
  name: "Code Diff",
  description: "代码版本对比工具，对比两个文件或两个版本的代码差异，输出带行号的 diff",

  register(api: any) {
    api.registerTool({
      name: "code_diff",
      label: "代码版本对比",
      description:
        "对比两个文件或两个版本的代码差异，输出带行号的 diff。自动检测 UTF-8/GBK 编码。",
      parameters: {
        type: "object",
        properties: {
          file1: {
            type: "string",
            description: "第一个文件路径（旧版本）",
          },
          file2: {
            type: "string",
            description: "第二个文件路径（新版本）",
          },
          context_lines: {
            type: "number",
            description: "上下文行数（默认 3）",
          },
          show_full: {
            type: "boolean",
            description: "是否显示全文件对比（默认 false，只显示差异部分）",
          },
        },
        required: ["file1", "file2"],
      },
      execute: executeCodeDiff,
    } as any);
  },
};

export default codeDiffPlugin;