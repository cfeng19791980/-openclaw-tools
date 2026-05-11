// Brain Hook V9.4 - Sidecar 模式，自动启动 brain_entry 进程
// 这个文件由 sidecar 进程加载，拥有自己的 HTTP server
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BRAIN_PORT = 5002;
const BRAIN_SCRIPT = path.join(process.env.USERPROFILE || 'C:\\Users\\10341', '.openclaw', 'workspace', 'BrainSystem-AutoEvolution', 'core', 'brain_entry.py');
const LOG_FILE = path.join(process.env.USERPROFILE || 'C:\\Users\\10341', '.openclaw', 'logs', 'brain-hook.log');

let brainProcess = null;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(`[brain-hook] ${msg}`);
  try { fs.appendFileSync(LOG_FILE, line, 'utf-8'); } catch(e) {}
}

function ensureBrainRunning() {
  return new Promise((resolve) => {
    // 先检查端口是否已监听
    const check = http.request({ hostname: '127.0.0.1', port: BRAIN_PORT, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      resolve(true);
    });
    check.on('error', () => {
      // 端口未监听，需要启动
      log('Brain Entry not running, starting...');
      try {
        brainProcess = spawn('python', [BRAIN_SCRIPT], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        brainProcess.unref();
        
        let started = false;
        const retry = () => {
          const c = http.request({ hostname: '127.0.0.1', port: BRAIN_PORT, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
            started = true;
            log('Brain Entry started successfully');
            resolve(true);
          });
          c.on('error', () => {
            if (!started) setTimeout(retry, 500);
            else resolve(false);
          });
          c.end();
        };
        setTimeout(retry, 1000);
        
        // 45秒超时（需等待 llama-server 启动）
        setTimeout(() => {
          if (!started) {
            log('Brain Entry start timeout after 45s');
            resolve(false);
          }
        }, 45000);
      } catch (e) {
        log(`Brain Entry start failed: ${e.message}`);
        resolve(false);
      }
    });
    check.end();
  });
}

log('V9.4 Loading');

module.exports = {
  id: "brain-hook",
  register(api) {
    log('register() called');

    api.on('before_prompt_build', async (event) => {
      log(`before_prompt_build triggered, messages: ${event.messages?.length || 0}`);

      if (!event.messages?.length) {
        log('No messages, skip');
        return;
      }

      const lastUserMsg = event.messages.filter(m => m.role === 'user').pop();
      if (!lastUserMsg) {
        log('No user message, skip');
        return;
      }

      let userContent = '';
      if (typeof lastUserMsg.content === 'string') {
        userContent = lastUserMsg.content;
      } else if (lastUserMsg.content?.[0]?.text) {
        userContent = lastUserMsg.content[0].text;
      } else if (lastUserMsg.content?.text) {
        userContent = lastUserMsg.content.text;
      }

      if (!userContent || userContent.length < 10) {
        log('Content too short, skip');
        return;
      }

      try {
        // 先确保 Brain Entry 在运行
        await ensureBrainRunning();
        
        log('Calling Brain /entry...');
        const result = await callBrainEntry(userContent.slice(0, 80000));

        if (result && result.success && result.processed_content) {
          log(`Brain OK: intent=${result.brain_context?.intent?.type}, conf=${result.brain_context?.intent?.confidence}, len=${result.processed_content.length}`);

          // Inject via multiple fields to ensure at least one works
          // Add a local identity notice and tool description so the model knows it's running locally
          // and can access files through the Brain Tool API
          const toolDescription = `

## 身份说明 (LOCAL IDENTITY NOTICE)

📌重要：你是我的专属深度协作伙伴，具备独立逻辑思辨、方案审视、查漏补缺、优化迭代能力。
`;
          // 编码规范
          const codingRules = `

## 编码规范 (请严格遵守)
🔤所有代码必须设置UTF8编码，任务完成必须将经验、教训、项目readme导入brain 向量库（e:\data\.brain_vectors.db）
🤔先思考再编写代码，明确用户需求，避免自作假设。
⚡简单优先，只实现当前任务所需的最少代码，避免过度工程化。
🎯 精准修改，只动必须动的部分，不重构未损坏的功能。
📋目标驱动执行，将任务拆解为明确可验证的目标。
💾先备份后修改可回滚，写完代码必测试，做好版本管理。重要修改升级使用gh推送代码库
🧹编码测试完成后，清理临时文件（如测试脚本/修复脚本等），保持文件架构整洁。
🛠️必用工具：读取文件-code_reader，代码执行-exec_thyton，内容比较code_diff，批量替换file_patch
`;
          const enhancedContent = result.processed_content + toolDescription + codingRules;
          return {
            prependSystemContext: enhancedContent,
            appendSystemContext: enhancedContent,
            prependContext: result.processed_content
          };
        } else {
          log(`Brain response: success=${result?.success}, has content=${!!result?.processed_content}`);
        }
      } catch (err) {
        log(`API error: ${err.message}`);
      }

      log('Hook completed without injection');
    });

    log('V9.4 Ready');
  }
};

function callBrainEntry(content) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ content });
    const options = {
      hostname: '127.0.0.1',
      port: BRAIN_PORT,
      path: '/entry',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { log(`JSON parse error: ${e.message}`); reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', (e) => { log(`Request error: ${e.message}`); reject(e); });
    req.on('timeout', () => { log('Request timeout'); req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}
