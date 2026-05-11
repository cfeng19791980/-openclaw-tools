// -*- coding: utf-8 -*-
/**
 * code_read - 代码全量读取工具
 * 用于一次性读取整个代码文件，支持行号、编码检测、多文件和通配符
 */

import * as fs from "fs";
import * as path from "path";
import * as iconv from "iconv-lite";

// 默认配置
const DEFAULT_MAX_CHARS = 100000;
const DEFAULT_SHOW_LINE_NUMBERS = true;

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
  // GBK 编码的常见字节范围检测
  const gbkDetector = detectGBK(buffer);
  if (gbkDetector.isLikelyGBK) {
    try {
      const content = decodeGBK(buffer);
      return { content, encoding: "gbk" };
    } catch {
      // 继续回退
    }
  }

  // 3. 尝试 Latin1 (ISO-8859-1) 作为最后的回退
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
      // GBK 第一字节范围
      if (i + 1 < buffer.length) {
        const nextByte = buffer[i + 1];
        // GBK 第二字节范围
        if (
          (nextByte >= 0x40 && nextByte <= 0x7E) ||
          (nextByte >= 0x80 && nextByte <= 0xFE)
        ) {
          gbkBytes += 2;
          i++; // 跳过下一个字节
        }
      }
    }
    totalBytes++;
  }

  // 如果有超过 5% 的字节匹配 GBK 模式，可能是 GBK
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
 * 检查路径是否包含通配符
 */
function hasWildcard(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/**
 * 简单的 glob 匹配实现
 * 支持 * 和 ? 通配符
 */
function simpleGlob(pattern: string): string[] {
  const results: string[] = [];

  // 分离目录和文件名模式
  const lastSep = Math.max(pattern.lastIndexOf("/"), pattern.lastIndexOf("\\"));
  const dirPath = lastSep >= 0 ? pattern.substring(0, lastSep) : ".";
  const filePattern = lastSep >= 0 ? pattern.substring(lastSep + 1) : pattern;

  // 检查目录是否存在
  if (!fs.existsSync(dirPath)) {
    return results;
  }

  try {
    const dirStat = fs.statSync(dirPath);
    if (!dirStat.isDirectory()) {
      return results;
    }
  } catch {
    return results;
  }

  // 读取目录内容
  try {
    const files = fs.readdirSync(dirPath);

    // 转换 glob 模式为正则表达式
    const regexPattern = filePattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${regexPattern}$`, "i"); // Windows 不区分大小写

    for (const file of files) {
      if (regex.test(file)) {
        results.push(path.join(dirPath, file));
      }
    }
  } catch {
    // 权限错误等
  }

  return results.sort();
}

/**
 * 格式化单个文件的内容
 */
function formatFileContent(
  filePath: string,
  content: string,
  showLineNumbers: boolean,
  offset?: number,
  limit?: number,
  maxChars?: number
): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // 计算起始和结束行
  const startLine = offset ? Math.max(1, offset) : 1;
  const endLine = limit ? Math.min(totalLines, startLine + limit - 1) : totalLines;

  // 提取目标行
  const selectedLines = lines.slice(startLine - 1, endLine);

  // 计算行号宽度
  const lineWidth = String(endLine).length;

  // 构建输出
  const outputLines: string[] = [];
  let currentChars = 0;
  const maxOutputChars = maxChars || DEFAULT_MAX_CHARS;

  for (let i = 0; i < selectedLines.length; i++) {
    const lineNum = startLine + i;
    const line = selectedLines[i];

    let formattedLine: string;
    if (showLineNumbers) {
      formattedLine = `${String(lineNum).padStart(lineWidth)} | ${line}`;
    } else {
      formattedLine = line;
    }

    // 检查字符限制
    if (currentChars + formattedLine.length > maxOutputChars) {
      const remaining = maxOutputChars - currentChars;
      if (remaining > 0) {
        outputLines.push(formattedLine.substring(0, remaining) + "...");
      }
      outputLines.push(`\n[截断] 已达到最大字符限制 (${maxOutputChars} 字符)`);
      outputLines.push(`总行数: ${totalLines}, 已显示: ${i + 1}/${selectedLines.length} 行`);
      break;
    }

    outputLines.push(formattedLine);
    currentChars += formattedLine.length + 1; // +1 for newline
  }

  // 如果是因为 limit 截断，添加提示
  if (limit && endLine < totalLines && currentChars < maxOutputChars) {
    outputLines.push(`\n[部分显示] 总行数: ${totalLines}, 已显示: ${selectedLines.length} 行`);
  }

  return `=== ${filePath} ===\n${outputLines.join("\n")}`;
}

/**
 * 处理单个文件路径
 */
function processFile(
  filePath: string,
  params: {
    offset?: number;
    limit?: number;
    max_chars?: number;
    show_line_numbers?: boolean;
  }
): string {
  const normalizedPath = path.normalize(filePath);

  // 检查路径是否存在
  if (!fs.existsSync(normalizedPath)) {
    return `错误: 文件不存在 - ${normalizedPath}`;
  }

  // 获取文件状态
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (err) {
    return `错误: 无法访问路径 - ${normalizedPath} (${(err as Error).message})`;
  }

  // 如果是目录，列出目录内容
  if (stat.isDirectory()) {
    try {
      const files = fs.readdirSync(normalizedPath);
      const fileList = files.map((f) => {
        const fullPath = path.join(normalizedPath, f);
        try {
          const s = fs.statSync(fullPath);
          return s.isDirectory() ? `${f}/` : f;
        } catch {
          return f;
        }
      });
      return `=== ${normalizedPath} (目录) ===\n${fileList.join("\n")}`;
    } catch (err) {
      return `错误: 无法读取目录 - ${normalizedPath} (${(err as Error).message})`;
    }
  }

  // 检查文件大小（防止读取过大文件）
  const maxSize = (params.max_chars || DEFAULT_MAX_CHARS) * 2; // 估计字节上限
  if (stat.size > maxSize) {
    return `错误: 文件过大 (${(stat.size / 1024).toFixed(1)} KB)，超过安全限制`;
  }

  // 读取文件
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(normalizedPath);
  } catch (err) {
    const errorMsg = (err as Error).message;
    if (errorMsg.includes("EACCES") || errorMsg.includes("permission")) {
      return `错误: 权限不足，无法读取文件 - ${normalizedPath}`;
    }
    return `错误: 读取文件失败 - ${normalizedPath} (${errorMsg})`;
  }

  // 解码文件内容
  const decoded = decodeBuffer(buffer);

  // 格式化输出
  return formatFileContent(
    normalizedPath,
    decoded.content,
    params.show_line_numbers !== false,
    params.offset,
    params.limit,
    params.max_chars
  );
}

/**
 * 工具执行函数
 */
async function executeCodeRead(
  _toolCallId: string,
  params: {
    path: string;
    offset?: number;
    limit?: number;
    max_chars?: number;
    show_line_numbers?: boolean;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const inputPath = params.path?.trim();

  if (!inputPath) {
    throw new Error("path 参数是必需的");
  }

  const results: string[] = [];
  const fileInfo: string[] = [];

  // 检查是否是通配符模式
  if (hasWildcard(inputPath)) {
    const matchedFiles = simpleGlob(inputPath);

    if (matchedFiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `未找到匹配的文件: ${inputPath}`,
          },
        ],
      };
    }

    fileInfo.push(`通配符匹配: ${inputPath} -> ${matchedFiles.length} 个文件\n`);

    // 处理每个匹配的文件
    for (const filePath of matchedFiles) {
      const result = processFile(filePath, params);
      results.push(result);
    }
  } else {
    // 单个文件
    const result = processFile(inputPath, params);
    results.push(result);
  }

  // 合并结果
  const header = fileInfo.length > 0 ? fileInfo.join("\n") + "\n" : "";
  const output = header + results.join("\n\n");

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
const codeReaderPlugin = {
  id: "code-reader",
  name: "Code Reader",
  description: "代码文件全量读取工具，支持行号、编码检测、多文件和通配符匹配",

  register(api: any) {
    api.registerTool({
      name: "code_read",
      label: "代码全量读取",
      description:
        "一次性读取代码文件的完整内容，支持行号显示、按行范围读取、多文件读取和通配符匹配。自动检测 UTF-8/GBK 编码。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径或 glob 模式（支持 * 和 ? 通配符）",
          },
          offset: {
            type: "number",
            description: "起始行号（从 1 开始，可选）",
          },
          limit: {
            type: "number",
            description: "最大读取行数（可选）",
          },
          max_chars: {
            type: "number",
            description: "最大字符数限制（默认 100000）",
          },
          show_line_numbers: {
            type: "boolean",
            description: "是否显示行号（默认 true）",
          },
        },
        required: ["path"],
      },
      execute: executeCodeRead,
    } as any);
  },
};

export default codeReaderPlugin;
