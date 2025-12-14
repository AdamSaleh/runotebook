import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import os from 'os';

// Monkey-patch os.networkInterfaces to handle Android permission issues
const originalNetworkInterfaces = os.networkInterfaces;
os.networkInterfaces = function() {
  try {
    return originalNetworkInterfaces.call(os);
  } catch {
    // Return empty object on Android where this fails with EACCES
    return {};
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const SERVER_URL = 'http://127.0.0.1:8080';
const WS_URL = 'ws://127.0.0.1:8080/ws';

// Test result tracking
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function logError(message: string): void {
  console.error(`[e2e] ERROR: ${message}`);
}

function logSuccess(message: string): void {
  console.log(`[e2e] ✓ ${message}`);
}

function logFailure(message: string): void {
  console.log(`[e2e] ✗ ${message}`);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    logSuccess(`${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: errorMessage, duration });
    logFailure(`${name}: ${errorMessage}`);
  }
}

function execCommand(command: string, cwd: string): void {
  log(`Running: ${command} (in ${cwd})`);
  execSync(command, { cwd, stdio: 'inherit' });
}

// Step 1: Build Frontend (typecheck + build)
async function buildFrontend(): Promise<void> {
  await runTest('Frontend typecheck', async () => {
    execCommand('npm run typecheck', FRONTEND_DIR);
  });

  await runTest('Frontend build', async () => {
    execCommand('npm run build', FRONTEND_DIR);
  });
}

// Step 2: Build Backend
async function buildBackend(): Promise<void> {
  await runTest('Backend build', async () => {
    execCommand('cargo build', ROOT_DIR);
  });
}

// Step 3: Start Server
let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

async function startServer(): Promise<void> {
  await runTest('Server start', async () => {
    log('Starting server...');
    serverProcess = spawn('cargo', ['run'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      log(`[server stdout] ${data.toString().trim()}`);
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      // Filter out cargo compilation messages
      if (!output.includes('Compiling') && !output.includes('Finished') && !output.includes('Running')) {
        log(`[server stderr] ${output}`);
      }
    });

    serverProcess.on('error', (err) => {
      logError(`Server process error: ${err.message}`);
    });

    // Wait for server to respond to HTTP requests
    await waitForServer(SERVER_URL, 30000);
    log('Server is responding to requests');
  });
}

function stopServer(): void {
  if (serverProcess) {
    log('Stopping server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// Step 4: HTTP/WebSocket Tests
async function runHttpTests(): Promise<void> {
  // Test: Index page loads
  await runTest('Index page loads', async () => {
    const response = await fetch(SERVER_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    if (!html.includes('Runotepad')) {
      throw new Error('Page does not contain "Runotepad"');
    }
  });

  // Test: HTML contains editor element
  await runTest('HTML contains editor element', async () => {
    const response = await fetch(SERVER_URL);
    const html = await response.text();
    if (!html.includes('id="editor"')) {
      throw new Error('Page does not contain editor element');
    }
  });

  // Test: HTML contains preview element
  await runTest('HTML contains preview element', async () => {
    const response = await fetch(SERVER_URL);
    const html = await response.text();
    if (!html.includes('id="preview"')) {
      throw new Error('Page does not contain preview element');
    }
  });

  // Test: HTML contains status indicator
  await runTest('HTML contains status indicator', async () => {
    const response = await fetch(SERVER_URL);
    const html = await response.text();
    if (!html.includes('id="statusText"')) {
      throw new Error('Page does not contain status indicator');
    }
  });

  // Test: HTML contains view tabs
  await runTest('HTML contains view tabs', async () => {
    const response = await fetch(SERVER_URL);
    const html = await response.text();
    if (!html.includes('data-view="split"') || !html.includes('data-view="editor-only"')) {
      throw new Error('Page does not contain view tabs');
    }
  });

  // Test: JavaScript bundle is served
  await runTest('JavaScript bundle is served', async () => {
    const response = await fetch(`${SERVER_URL}/bundle.js`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const js = await response.text();
    if (js.length < 1000) {
      throw new Error('JavaScript bundle appears too small');
    }
  });

  // Test: CSS bundle is served
  await runTest('CSS bundle is served', async () => {
    const response = await fetch(`${SERVER_URL}/bundle.css`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const css = await response.text();
    if (css.length < 100) {
      throw new Error('CSS bundle appears too small');
    }
  });
}

async function runWebSocketTests(): Promise<void> {
  // Test: WebSocket connection works
  await runTest('WebSocket connection establishes', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    });
  });

  // Test: WebSocket can create PTY session
  await runTest('WebSocket can create PTY session', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('PTY session creation timeout'));
      }, 10000);

      ws.on('open', () => {
        // Send create session message
        ws.send(JSON.stringify({
          type: 'create',
          cols: 80,
          rows: 24,
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'created' && msg.session_id) {
            clearTimeout(timeout);
            log(`PTY session created: ${msg.session_id}`);

            // Close the session
            ws.send(JSON.stringify({
              type: 'close',
              session_id: msg.session_id,
            }));

            ws.close();
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`PTY error: ${msg.message}`));
          }
        } catch {
          // Ignore parse errors for non-JSON messages
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    });
  });

  // Test: PTY session can execute commands
  await runTest('PTY session can execute commands', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let sessionId: string | null = null;
      let outputReceived = false;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Command execution timeout'));
      }, 15000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'create',
          cols: 80,
          rows: 24,
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'created' && msg.session_id) {
            sessionId = msg.session_id;
            log(`PTY session created: ${sessionId}`);

            // Send a simple echo command
            ws.send(JSON.stringify({
              type: 'input',
              session_id: sessionId,
              data: 'echo "E2E_TEST_OUTPUT"\n',
            }));
          } else if (msg.type === 'output' && msg.session_id === sessionId) {
            const output = msg.data || '';
            if (output.includes('E2E_TEST_OUTPUT')) {
              outputReceived = true;
              clearTimeout(timeout);
              log('Received expected output from PTY');

              // Close the session
              ws.send(JSON.stringify({
                type: 'close',
                session_id: sessionId,
              }));

              ws.close();
              resolve();
            }
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`PTY error: ${msg.message}`));
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    });
  });
}

// Main test runner
async function main(): Promise<void> {
  console.log('');
  console.log('========================================');
  console.log('  Runotepad E2E Test Suite');
  console.log('========================================');
  console.log('');

  const startTime = Date.now();

  try {
    // Build steps
    log('Building frontend...');
    await buildFrontend();

    log('Building backend...');
    await buildBackend();

    // Start server
    log('Starting server...');
    await startServer();

    // Run HTTP tests
    log('Running HTTP tests...');
    await runHttpTests();

    // Run WebSocket tests
    log('Running WebSocket tests...');
    await runWebSocketTests();

  } finally {
    // Cleanup
    stopServer();
  }

  // Print summary
  const totalDuration = Date.now() - startTime;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('');
  console.log('========================================');
  console.log('  Test Summary');
  console.log('========================================');
  console.log(`  Total:  ${results.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log('========================================');

  if (failed > 0) {
    console.log('');
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }

  console.log('');
  logSuccess('All tests passed!');
  process.exit(0);
}

// Handle process signals
process.on('SIGINT', () => {
  log('Received SIGINT, cleaning up...');
  stopServer();
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, cleaning up...');
  stopServer();
  process.exit(1);
});

main().catch((error) => {
  logError(`Unhandled error: ${error}`);
  stopServer();
  process.exit(1);
});
