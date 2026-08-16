const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

async function executeCode(code, language = 'python', timeoutMs = 5000) {
  if (!code || typeof code !== 'string') return { error: 'Code is required' };
  if (code.length > 50000) return { error: 'Code size exceeds 50KB limit' };
  if (!['python', 'javascript'].includes(language)) return { error: 'Unsupported language' };
  if (config.runtimeMode !== 'docker') {
    return { status: 'unavailable', error: 'Secure runtime is not configured. Set RUNTIME_MODE=docker.' };
  }

  const jobId = uuidv4();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-runtime-${jobId}-`));
  const filename = language === 'python' ? 'main.py' : 'main.js';
  fs.writeFileSync(path.join(tempDir, filename), code, { mode: 0o600 });
  const image = language === 'python' ? config.pythonRuntimeImage : config.nodeRuntimeImage;
  const command = language === 'python' ? ['python3', `/workspace/${filename}`] : ['node', `/workspace/${filename}`];
  const args = [
    'run', '--rm', '--network=none', '--read-only', '--pids-limit=64',
    '--memory=256m', '--cpus=0.5', '--security-opt=no-new-privileges',
    '--cap-drop=ALL', '-v', `${tempDir}:/workspace:ro`, image, ...command
  ];

  return new Promise(resolve => {
    execFile('docker', args, { timeout: Math.min(Math.max(timeoutMs, 100), 10000), maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      if (error && error.code === 'ENOENT') return resolve({ status: 'unavailable', error: 'Docker is not installed on the runtime host' });
      resolve({ jobId, exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || (error ? error.message : ''), status: error ? 'failed' : 'finished' });
    });
  });
}

module.exports = { executeCode };
