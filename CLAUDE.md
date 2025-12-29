# Runotepad

Interactive runbook editor with embedded terminal sessions. Rust backend (Actix-web) + TypeScript frontend (CodeMirror 6 + xterm.js).

## Quick Commands

```bash
# Build
make build              # Frontend + backend (debug)
make build-release      # Optimized build

# Test
make test               # All tests (Rust + E2E)
cargo test              # Rust unit tests only
cd e2e && npm test      # E2E tests only

# Run
cargo run               # Start server at http://0.0.0.0:8080

# Frontend development
cd frontend && npm run watch      # Watch mode with auto-rebuild
cd frontend && npm run typecheck  # Type check only
cd frontend && npm run build      # Single build

# Code quality
make lint               # Run clippy + typecheck
make format             # Run cargo fmt + typecheck
./coverage.sh html      # Generate coverage report
```

## Project Structure

```
src/                    # Rust backend
├── main.rs            # Actix server, WebSocket handler, PTY management
├── auth.rs            # Token authentication
├── config.rs          # Config management (~/.runotepad/config.json)
├── workspace.rs       # API handlers for workspaces/branches/files
├── git_ops.rs         # Git operations (shell-based, not git2)
└── file_ops.rs        # File system operations

frontend/src/          # TypeScript frontend
├── main.ts            # Entry point, route setup
├── router.ts          # Custom SPA router with pattern matching
├── api.ts             # REST API client
├── websocket.ts       # WebSocket with auto-reconnect
├── terminal.ts        # Terminal manager, session handling
├── editor.ts          # CodeMirror setup, run buttons
├── fileSync.ts        # File sync with backend
├── auth.ts            # Token management (localStorage + URL)
└── pages/             # Page components

e2e/test/              # End-to-end tests
├── e2e.test.ts        # Custom runner (builds, starts server, tests API)
└── ui.spec.ts         # Playwright UI tests

static/                # Built frontend assets (bundle.js, bundle.css)
```

## Architecture

**Backend patterns:**
- All API endpoints require token auth (except `/api/console`)
- Token: query param `?token=xxx` OR header `Authorization: Bearer xxx`
- Error handling: `Result<T, String>` converted to JSON `{"error": "..."}` in handlers
- Config location: `~/.runotepad/config.json`
- PTY sessions tracked in `HashMap<String, PtySession>` with UUID keys
- Git operations use shell commands (no git2 library)

**Frontend patterns:**
- Singleton pattern: `apiClient`, `authManager`, `wsConnection`, `terminalManager`, `router`
- No framework - direct DOM manipulation
- WebSocket message types: `Create`, `Input`, `Resize`, `Close`, `Output`
- esbuild bundles to `static/bundle.js`

**Static asset paths:**
- All assets served from `/static/` prefix
- `index.html` uses absolute paths: `/static/bundle.js`, `/static/styles.css`
- SPA fallback: non-API routes serve `index.html`

## Code Conventions

**Rust:**
- Use `log::info!`, `log::debug!` for logging
- Tests use `#[serial]` attribute when modifying shared state (config)
- Snake_case for JSON serialization (serde defaults)

**TypeScript:**
- Strict mode enabled
- Async/await for all API calls
- Callbacks for WebSocket message handling
- No emojis in code unless explicitly requested

**Testing:**
- Rust: 30 unit tests in `config.rs` and `file_ops.rs`
- E2E: 16 tests covering HTTP API and WebSocket
- Use `tempfile` crate for isolated test directories
- Tests require `serial_test` for config mutations

## API Endpoints

```
GET  /api/auth/check                           # Verify token
GET  /api/workspaces                           # List workspaces
POST /api/workspaces                           # Create (clone repo)
GET  /api/workspaces/:name/branches            # List branches
POST /api/workspaces/:name/branches            # Create branch
GET  /api/workspaces/:name/branches/:branch/files
GET  /api/workspaces/:name/branches/:branch/file?path=...
PUT  /api/workspaces/:name/branches/:branch/file?path=...
POST /api/workspaces/:name/branches/:branch/commit
POST /api/workspaces/:name/branches/:branch/push
WS   /ws?token=...                             # Terminal WebSocket
```

## Environment Variables

- `RUNOTEPAD_TOKEN` - Override auth token
- `RUNOTEPAD_WORKSPACE_DIR` - Override workspace directory (default: `/tmp/runbookws`)
- `RUNOTEPAD_CONFIG_FILE` - Override config file path
- `RUST_LOG` - Logging level (e.g., `debug`, `info`)

## Common Tasks

**Adding a new API endpoint:**
1. Add handler function in `src/workspace.rs`
2. Wire route in `src/main.rs` under `App::new()`
3. Add auth check: `auth::check_auth(&config_manager, &req)?`

**Adding a new frontend page:**
1. Create `frontend/src/pages/newpage.ts`
2. Add route pattern in `frontend/src/main.ts`
3. Export render function that returns HTMLElement

**Modifying terminal behavior:**
1. Edit `frontend/src/terminal.ts`
2. WebSocket messages defined in `frontend/src/types.ts`
3. Backend handling in `src/main.rs` `handle_ws_message()`

**Updating editor features:**
1. Edit `frontend/src/editor.ts`
2. CodeMirror extensions in `createEditor()` function
3. Run button logic in `RunButtonMarker` class

## Dependencies

**Rust (Cargo.toml):**
- actix-web 4.3, actix-ws, actix-files
- portable-pty 0.8 for PTY
- tokio 1.32 (full features)
- serde, serde_json
- uuid (v4)

**Frontend (package.json):**
- @codemirror/* 6.x for editor
- xterm 5.3, xterm-addon-fit
- marked 9.1 for markdown
- esbuild for bundling

**Dev dependencies:**
- tempfile, serial_test (Rust tests)
- @playwright/test, tsx (E2E tests)
- cargo-llvm-cov (coverage)

## Known Patterns

- Workspace = bare git repository + worktrees for branches
- Session names derived from runbook path: `path/to/file.md` -> `path_to_file_md`
- Code blocks with `session=name` share terminal sessions
- Code blocks with `out=blockname` capture output to named blocks
- Code blocks with `file=./path` enable bidirectional file sync
