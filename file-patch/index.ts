// -*- coding: utf-8 -*-
/**
 * file_patch - 按行号修补文件工具
 * 解决 edit 工具在大文件中精确上下文匹配困难的问题
 */

import * as fs from "fs";
import * as path from "path";

// 编码检测结果
interface DecodeResult {
  content: string;
  encoding: string;
  buffer: Buffer;
}

/**
 * 检测并解码文件内容
 * UTF-8 优先，失败后使用 latin1（保留原始字节）
 */
function decodeBuffer(buffer: Buffer): DecodeResult {
  // 1. 尝试 UTF-8
  try {
    const content = buffer.toString("utf-8");
    // 检查是否有无效的 UTF-8 字符（替换字符 U+FFFD）
    const hasReplacementChar = content.includes("\uFFFD");
    if (!hasReplacementChar) {
      return { content, encoding: "utf-8", buffer };
    }
  } catch {
    // 继续尝试其他编码
  }

  // 2. 使用 latin1 (ISO-8859-1) 作为回退
  // Latin1 是单字节编码，可以保留原始字节值
  const content = buffer.toString("latin1");
  return { content, encoding: "latin1", buffer };
}

/**
 * 将字符串按指定编码写入文件
 */
function encodeContent(content: string, encoding: string): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(content, "utf-8");
  }
  // latin1 编码（保留原始字节）
  return Buffer.from(content, "latin1");
}

/**
 * 将内容分割为行数组（保留换行符信息）
 */
function splitLines(content: string): string[] {
  // 检测换行符类型
  const hasCRLF = content.includes("\r\n");
  const lines = content.split(hasCRLF ? "\r\n" : "\n");
  
  // 返回行数组和换行符类型
  return lines;
}

/**
 * 获取换行符类型
 */
function detectLineEnding(content: string): string {
  if (content.includes("\r\n")) return "\r\n";
  if (content.includes("\n")) return "\n";
  return "\n"; // 默认 LF
}

/**
 * Patch 定义
 */
interface Patch {
  start_line: number;
  end_line: number;
  new_content: string;
}

/**
 * 验证 patch 参数
 */
function validatePatches(patches: Patch[], totalLines: number): string | null {
  if (!patches || patches.length === 0) {
    return "patches 列表不能为空";
  }

  // 按起始行号排序
  const sorted = [...patches].sort((a, b) => a.start_line - b.start_line);

  for (let i = 0; i < sorted.length; i++) {
    const patch = sorted[i];

    // 验证行号范围
    if (patch.start_line < 1) {
      return `patch ${i + 1}: start_line (${patch.start_line}) 不能小于 1`;
    }
    if (patch.end_line > totalLines) {
      return `patch ${i + 1}: end_line (${patch.end_line}) 超过文件总行数 (${totalLines})`;
    }
    if (patch.start_line > patch.end_line) {
      return `patch ${i + 1}: start_line (${patch.start_line}) 不能大于 end_line (${patch.end_line})`;
    }

    // 检查重叠
    if (i > 0) {
      const prev = sorted[i - 1];
      if (patch.start_line <= prev.end_line) {
        return `patch ${i + 1} (行 ${patch.start_line}-${patch.end_line}) 与前一个 patch (行 ${prev.start_line}-${prev.end_line}) 重叠`;
      }
    }
  }

  return null; // 验证通过
}

/**
 * 生成 diff 预览
 */
function generateDiff(
  oldLines: string[],
  patch: Patch,
  patchIndex: number,
  totalPatches: number
): string {
  const lines: string[] = [];
  
  // 提取旧行内容
  const extractedOld = oldLines.slice(patch.start_line - 1, patch.end_line);
  
  // 分割新内容
  const newLines = patch.new_content.split("\n");
  
  // 计算行数变化
  const oldCount = patch.end_line - patch.start_line + 1;
  const newCount = newLines.length;
  
  lines.push(`修补 ${patchIndex + 1}/${totalPatches}: 行 ${patch.start_line}-${patch.end_line} → 新内容 (${newCount}行, 原 ${oldCount}行)`);
  
  // 显示 diff
  lines.push("--- 旧内容 ---");
  for (const line of extractedOld) {
    lines.push(`- ${line}`);
  }
  
  lines.push("+++ 新内容 +++");
  for (const line of newLines) {
    lines.push(`+ ${line}`);
  }
  
  return lines.join("\n");
}

/**
 * 应用 patches 到文件内容
 */
function applyPatches(
  lines: string[],
  patches: Patch[],
  lineEnding: string
): string[] {
  // 从后往前应用，避免行号偏移
  const sorted = [...patches].sort((a, b) => b.start_line - a.start_line);
  
  for (const patch of sorted) {
    // 分割新内容为行数组
    const newLines = patch.new_content.split("\n");
    
    // 替换指定行范围
    lines.splice(patch.start_line - 1, patch.end_line - patch.start_line + 1, ...newLines);
  }
  
  return lines;
}

/**
 * 工具执行函数
 */
async function executeFilePatch(
  _toolCallId: string,
  params: {
    path: string;
    patches: Patch[];
    backup?: boolean;
    dry_run?: boolean;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // 验证必需参数
  if (!params.path || typeof params.path !== "string") {
    throw new Error("path 参数是必需的");
  }
  
  if (!params.patches || !Array.isArray(params.patches)) {
    throw new Error("patches 参数是必需的，且必须为数组");
  }
  
  const filePath = path.normalize(params.path);
  const backup = params.backup !== false; // 默认 true
  const dryRun = params.dry_run === true; // 默认 false
  
  const output: string[] = [];
  
  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `[错误] 文件不存在: ${filePath}` }],
    };
  }
  
  // 读取文件
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return {
      content: [{ type: "text", text: `[错误] 无法读取文件: ${(err as Error).message}` }],
    };
  }
  
  // 解码文件
  const decoded = decodeBuffer(buffer);
  const lineEnding = detectLineEnding(decoded.content);
  const lines = splitLines(decoded.content);
  const totalLines = lines.length;
  
  // 输出文件信息
  output.push(`[file_patch] 文件: ${filePath} (${decoded.encoding.toUpperCase()}, ${totalLines}行)`);
  
  // 验证 patches
  const validationError = validatePatches(params.patches, totalLines);
  if (validationError) {
    return {
      content: [{ type: "text", text: `[错误] ${validationError}` }],
    };
  }
  
  // 按 start_line 排序（用于显示和应用）
  const sortedPatches = [...params.patches].sort((a, b) => a.start_line - b.start_line);
  
  // 生成预览
  const previews: string[] = [];
  for (let i = 0; i < sortedPatches.length; i++) {
    previews.push(generateDiff(lines, sortedPatches[i], i, sortedPatches.length));
  }
  
  // 如果是 dry_run，只输出预览
  if (dryRun) {
    output.push("\n== 修补预览 (dry_run 模式，未实际修改) ==");
    output.push(previews.join("\n\n"));
    output.push(`\n预览完成，共 ${sortedPatches.length} 个修补`);
    return {
      content: [{ type: "text", text: output.join("\n") }],
    };
  }
  
  // 备份
  if (backup) {
    const backupPath = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, backupPath);
      output.push(`备份: ${backupPath}`);
    } catch (err) {
      return {
        content: [{ type: "text", text: `[错误] 备份失败: ${(err as Error).message}` }],
      };
    }
  }
  
  // 应用 patches
  const patchedLines = applyPatches([...lines], sortedPatches, lineEnding);
  
  // 重新组合内容
  const newContent = patchedLines.join(lineEnding);
  
  // 写入文件
  try {
    const newBuffer = encodeContent(newContent, decoded.encoding);
    fs.writeFileSync(filePath, newBuffer);
  } catch (err) {
    return {
      content: [{ type: "text", text: `[错误] 写入文件失败: ${(err as Error).message}` }],
    };
  }
  
  // 输出结果
  output.push(`已应用 ${sortedPatches.length}/${sortedPatches.length} 个修补`);
  output.push("\n== 修补预览 ==");
  output.push(previews.join("\n\n"));
  
  // 统计变化
  const addedLines = sortedPatches.reduce((sum, p) => sum + p.new_content.split("\n").length, 0);
  const removedLines = sortedPatches.reduce((sum, p) => sum + (p.end_line - p.start_line + 1), 0);
  const newTotalLines = patchedLines.length;
  
  output.push(`\n统计: 原文件 ${totalLines} 行 → 新文件 ${newTotalLines} 行 (+${addedLines - removedLines} 行)`);
  
  return {
    content: [{ type: "text", text: output.join("\n") }],
  };
}

// 导出插件
const filePatchPlugin = {
  id: "file-patch",
  name: "File Patch",
  description: "按行号修补文件工具，解决大文件精确上下文匹配困难的问题",

  register(api: any) {
    api.registerTool({
      name: "file_patch",
      label: "按行号修补文件",
      description:
        "按行号直接替换文件内容，支持多个不重叠的修补、自动备份和预览模式。解决 edit 工具在大文件中精确上下文匹配困难的问题。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径",
          },
          patches: {
            type: "array",
            description: "修补列表（支持多个不重叠的修补）",
            items: {
              type: "object",
              properties: {
                start_line: {
                  type: "number",
                  description: "起始行号（1-indexed）",
                },
                end_line: {
                  type: "number",
                  description: "结束行号（包含）",
                },
                new_content: {
                  type: "string",
                  description: "替换的新内容（多行字符串）",
                },
              },
              required: ["start_line", "end_line", "new_content"],
            },
          },
          backup: {
            type: "boolean",
            description: "是否自动备份（默认 true）",
          },
          dry_run: {
            type: "boolean",
            description: "仅预览不实际修改（默认 false）",
          },
        },
        required: ["path", "patches"],
      },
      execute: executeFilePatch,
    } as any);
  },
};

export default filePatchPlugin;