// -*- coding: utf-8 -*-
/**
 * exec_python - Python 代码执行工具
 * 在 Node.js 中通过 child_process 调用 python3 执行 Python 代码
 */

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// 不再依赖 iconv-lite，通过 PYTHONIOENCODING=utf-8 强制 Python 输出 UTF-8

// 默认超时时间（秒）
const DEFAULT_TIMEOUT = 30;

/**
 * 获取系统临时目录
 */
function getTempDir(): string {
  return os.tmpdir();
}

/**
 * 解码 Buffer 为字符串（UTF-8）
 * 注意：通过 PYTHONIOENCODING=utf-8 强制 Python 输出 UTF-8
 */
function decodeBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) return "";
  // Python 已被强制输出 UTF-8，直接解码
  return buf.toString("utf-8");
}

/**
 * 生成唯一的临时文件名
 */
function generateTempFileName(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `exec_python_${timestamp}_${random}.py`;
}

/**
 * 查找可用的 Python 解释器
 */
async function findPythonInterpreter(): Promise<string> {
  const candidates = ["python3", "python"];

  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        child_process.exec(`${candidate} --version`, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      return candidate;
    } catch {
      // 继续尝试下一个
    }
  }

  // 默认返回 python3
  return "python3";
}

/**
 * 执行 Python 代码
 */
async function executePythonCode(
  code: string,
  timeout: number,
  workdir?: string
): Promise<{ stdout: string; stderr: string; executionTime: number }> {
  return new Promise(async (resolve, reject) => {
    // 创建临时文件
    const tempDir = getTempDir();
    const tempFileName = generateTempFileName();
    const tempFilePath = path.join(tempDir, tempFileName);

    // 写入 Python 代码（UTF-8 编码）
    try {
      fs.writeFileSync(tempFilePath, code, { encoding: "utf-8" });
    } catch (err) {
      reject(new Error(`无法写入临时文件: ${(err as Error).message}`));
      return;
    }

    // 查找可用的 Python 解释器
    const pythonCmd = await findPythonInterpreter();

    // 记录开始时间
    const startTime = Date.now();

    // 设置超时
    const timeoutMs = timeout * 1000;

    // 执行 Python 代码
    const execOptions: child_process.ExecOptions = {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB 输出缓冲
      encoding: "buffer",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8", // 强制 Python 输出 UTF-8
      },
    };

    if (workdir) {
      execOptions.cwd = workdir;
    }

    child_process.exec(
      `${pythonCmd} "${tempFilePath}"`,
      execOptions,
      (error, stdout, stderr) => {
        // 计算执行时间
        const executionTime = (Date.now() - startTime) / 1000;

        // 清理临时文件
        try {
          fs.unlinkSync(tempFilePath);
        } catch {
          // 忽略清理错误
        }

        if (error) {
          // 检查是否是超时错误
          if ((error as any).killed) {
            reject(new Error(`执行超时（超过 ${timeout} 秒）`));
            return;
          }

          // 其他错误，仍然返回输出
          resolve({
            stdout: decodeBuffer(stdout as Buffer),
            stderr: decodeBuffer(stderr as Buffer) || error.message,
            executionTime,
          });
          return;
        }

        resolve({
          stdout: decodeBuffer(stdout as Buffer),
          stderr: decodeBuffer(stderr as Buffer),
          executionTime,
        });
      }
    );
  });
}

/**
 * 格式化输出结果
 */
function formatOutput(
  stdout: string,
  stderr: string,
  executionTime: number
): string {
  const lines: string[] = [];

  lines.push(`[执行完成] 耗时: ${executionTime.toFixed(2)}秒`);

  // 添加 stdout
  if (stdout.trim()) {
    lines.push("--- stdout ---");
    lines.push(stdout.trimEnd());
  }

  // 添加 stderr（如果有）
  if (stderr.trim()) {
    lines.push("--- stderr ---");
    lines.push(stderr.trimEnd());
  }

  return lines.join("\n");
}

/**
 * 工具执行函数
 */
async function executePython(
  _toolCallId: string,
  params: {
    code: string;
    timeout?: number;
    workdir?: string;
  },
  _signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // 验证必需参数
  if (!params.code || typeof params.code !== "string") {
    throw new Error("code 参数是必需的，且必须为字符串");
  }

  const code = params.code;
  const timeout = params.timeout && params.timeout > 0 ? params.timeout : DEFAULT_TIMEOUT;
  const workdir = params.workdir;

  // 检查工作目录是否存在
  if (workdir) {
    try {
      const stat = fs.statSync(workdir);
      if (!stat.isDirectory()) {
        throw new Error(`工作目录不存在或不是目录: ${workdir}`);
      }
    } catch (err) {
      if ((err as Error).message.includes("工作目录")) {
        throw err;
      }
      throw new Error(`无法访问工作目录: ${workdir}`);
    }
  }

  try {
    // 执行 Python 代码
    const result = await executePythonCode(code, timeout, workdir);

    // 格式化并返回结果
    const output = formatOutput(result.stdout, result.stderr, result.executionTime);

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  } catch (err) {
    // 返回错误信息
    return {
      content: [
        {
          type: "text",
          text: `[执行失败] ${(err as Error).message}`,
        },
      ],
    };
  }
}

// 导出插件
const execPythonPlugin = {
  id: "exec-python",
  name: "Exec Python",
  description: "Python 代码执行工具，直接执行 Python 代码字符串并返回结果",

  register(api: any) {
    api.registerTool({
      name: "exec_python",
      label: "执行Python代码",
      description:
        "直接传入 Python 代码字符串，在 Node.js 中通过 child_process 调用 python3 执行，返回结果。支持超时控制和工作目录设置。",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Python 代码字符串（必需）",
          },
          timeout: {
            type: "number",
            description: "超时秒数（默认 30 秒）",
          },
          workdir: {
            type: "string",
            description: "工作目录（可选）",
          },
        },
        required: ["code"],
      },
      execute: executePython,
    } as any);
  },
};

export default execPythonPlugin;
