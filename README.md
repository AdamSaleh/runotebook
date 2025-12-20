# Runotepad

An interactive runbook editor with embedded terminal sessions. Write markdown documentation with executable shell code blocks that run in persistent terminal sessions.

## Features

- Markdown editor with syntax highlighting (CodeMirror 6)
- Executable shell code blocks with run buttons in the gutter
- Persistent terminal sessions (xterm.js) - code blocks share sessions per runbook
- Named sessions with `session=name` attribute for explicit session management
- Git-based workspace management with branch support
- Token-based authentication
- Browser console log forwarding to server (for mobile debugging)

## Prerequisites

- Rust (tested with rustc 1.70+)
- Node.js (v18+)
- npm
- Git

## Project Structure

```
runotepad/
├── src/              # Rust backend (Actix-web server)
├── frontend/         # TypeScript frontend (CodeMirror + xterm.js)
├── static/           # Built frontend assets
├── e2e/              # End-to-end tests
├── Cargo.toml        # Rust dependencies
└── README.md
```

## Building

### Frontend

```bash
cd frontend
npm install
npm run build
```

This compiles TypeScript and bundles everything into `static/bundle.js`.

For development with auto-rebuild:
```bash
npm run watch
```

Type checking only:
```bash
npm run typecheck
```

### Backend

```bash
cargo build
```

For release build:
```bash
cargo build --release
```

## Running

Start the server:
```bash
cargo run
```

The server starts on `http://0.0.0.0:8080`. On first run, it generates a config file at `~/.config/runotepad/config.json` with an access token.

The startup logs show the access URL with token:
```
Access with token: http://127.0.0.1:8080/?token=<your-token>
```

### Configuration

Config file location: `~/.config/runotepad/config.json`

```json
{
  "token": "your-auth-token",
  "workspace_dir": "/path/to/workspaces"
}
```

- `token`: Authentication token (auto-generated if not set)
- `workspace_dir`: Directory for git workspaces (defaults to `/tmp/runbookws`)

## Testing

### E2E Tests

The e2e tests build both frontend and backend, start the server, and run integration tests.

```bash
cd e2e
npm install
npm test
```

### Playwright UI Tests

For browser-based UI testing:
```bash
cd e2e
npx playwright install  # First time only
npm run test:ui
```

Headed mode (visible browser):
```bash
npm run test:ui:headed
```

## Usage

### Code Blocks

Shell code blocks in markdown are executable. Click the play button in the gutter to run:

````markdown
```bash
echo "Hello, World!"
```
````

### Named Sessions

Use `session=name` to run commands in a specific named session:

````markdown
```bash session=dev
cd /my/project
npm install
```

```bash session=dev
npm run build
```
````

Both blocks run in the same terminal session named "dev".

### Default Session

Code blocks without an explicit session share a default session per runbook. This allows sequential execution in the same terminal:

````markdown
```bash
export MY_VAR="hello"
```

```bash
echo $MY_VAR  # Outputs: hello
```
````

## API Endpoints

All API endpoints (except `/api/console`) require authentication via query parameter `?token=<token>` or header `Authorization: Bearer <token>`.

- `GET /api/auth/check` - Verify token
- `GET /api/workspaces` - List workspaces
- `POST /api/workspaces` - Create workspace (clone repo)
- `GET /api/workspaces/:name/branches` - List branches
- `POST /api/workspaces/:name/branches` - Create branch
- `GET /api/workspaces/:name/branches/:branch/files` - List files
- `GET /api/workspaces/:name/branches/:branch/file?path=<path>` - Read file
- `PUT /api/workspaces/:name/branches/:branch/file` - Save file
- `POST /api/workspaces/:name/branches/:branch/commit` - Commit changes
- `POST /api/workspaces/:name/branches/:branch/push` - Push to remote
- `POST /api/workspaces/:name/branches/:branch/pull` - Pull from remote
- `WS /ws?token=<token>` - WebSocket for terminal sessions

## License

ISC
