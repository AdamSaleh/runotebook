mod auth;
mod config;
mod file_ops;
mod git_ops;
mod workspace;

use actix_files::Files;
use actix_web::{middleware, web, App, HttpRequest, HttpResponse, HttpServer};
use futures::StreamExt;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use config::ConfigManager;

#[derive(Debug, Deserialize)]
struct ConsoleLogRequest {
    level: String,
    message: String,
    timestamp: Option<String>,
}

async fn console_log_handler(
    body: web::Json<ConsoleLogRequest>,
) -> HttpResponse {
    let level = body.level.as_str();
    let msg = &body.message;
    let ts = body.timestamp.as_deref().unwrap_or("");

    match level {
        "error" => log::error!("[BROWSER {}] {}", ts, msg),
        "warn" => log::warn!("[BROWSER {}] {}", ts, msg),
        "info" => log::info!("[BROWSER {}] {}", ts, msg),
        "debug" => log::debug!("[BROWSER {}] {}", ts, msg),
        _ => log::trace!("[BROWSER {}] {}", ts, msg),
    }

    HttpResponse::Ok().finish()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum WsMessage {
    #[serde(rename = "create")]
    Create { id: Option<String> },
    #[serde(rename = "input")]
    Input { session_id: String, data: String },
    #[serde(rename = "resize")]
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "close")]
    Close { session_id: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WsResponse {
    #[serde(rename = "created")]
    Created { session_id: String },
    #[serde(rename = "output")]
    Output { session_id: String, data: String },
    #[serde(rename = "closed")]
    Closed { session_id: String },
    #[serde(rename = "error")]
    Error { message: String },
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct AppState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

async fn ws_handler(
    req: HttpRequest,
    body: web::Payload,
    state: web::Data<Arc<AppState>>,
    config: web::Data<Arc<ConfigManager>>,
) -> actix_web::Result<HttpResponse> {
    // Check authentication for WebSocket
    if let Some(token) = req.query_string().split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        let value = parts.next()?;
        if key == "token" { Some(value.to_string()) } else { None }
    }) {
        if !config.verify_token(&token) {
            return Ok(HttpResponse::Unauthorized().json(serde_json::json!({
                "error": "Invalid token"
            })));
        }
    } else {
        return Ok(HttpResponse::Unauthorized().json(serde_json::json!({
            "error": "Token required for WebSocket connection"
        })));
    }

    log::info!("WebSocket connection request from {:?}", req.peer_addr());
    log::debug!("Request headers: {:?}", req.headers());

    let (response, mut session, mut msg_stream) = match actix_ws::handle(&req, body) {
        Ok(result) => {
            log::info!("WebSocket handshake successful");
            result
        }
        Err(e) => {
            log::error!("WebSocket handshake failed: {:?}", e);
            return Err(e);
        }
    };

    let state = state.get_ref().clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Spawn task to send messages from rx to websocket
    let mut session_clone = session.clone();
    actix_rt::spawn(async move {
        log::debug!("Started WebSocket sender task");
        while let Some(msg) = rx.recv().await {
            log::trace!("Sending WS message: {} bytes", msg.len());
            if session_clone.text(msg).await.is_err() {
                log::warn!("Failed to send WebSocket message, closing sender");
                break;
            }
        }
        log::debug!("WebSocket sender task ended");
    });

    // Handle incoming websocket messages
    actix_rt::spawn(async move {
        log::info!("Started WebSocket receiver task");
        while let Some(result) = msg_stream.next().await {
            match result {
                Ok(msg) => {
                    match msg {
                        actix_ws::Message::Text(text) => {
                            let text_str = text.to_string();
                            log::info!("Received WS message: {}", text_str);

                            match serde_json::from_str::<WsMessage>(&text_str) {
                                Ok(ws_msg) => {
                                    log::debug!("Parsed message: {:?}", ws_msg);
                                    match ws_msg {
                                        WsMessage::Create { id } => {
                                            let session_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
                                            log::info!("Creating PTY session: {}", session_id);

                                            match create_pty_session(&session_id, &state, tx.clone()).await {
                                                Ok(_) => {
                                                    log::info!("PTY session created successfully: {}", session_id);
                                                    let resp = WsResponse::Created {
                                                        session_id: session_id.clone(),
                                                    };
                                                    let resp_json = serde_json::to_string(&resp).unwrap();
                                                    log::debug!("Sending response: {}", resp_json);
                                                    if let Err(e) = session.text(resp_json).await {
                                                        log::error!("Failed to send created response: {:?}", e);
                                                    }
                                                }
                                                Err(e) => {
                                                    log::error!("Failed to create PTY session: {:?}", e);
                                                    let resp = WsResponse::Error {
                                                        message: e.to_string(),
                                                    };
                                                    let _ = session
                                                        .text(serde_json::to_string(&resp).unwrap())
                                                        .await;
                                                }
                                            }
                                        }
                                        WsMessage::Input { session_id, data } => {
                                            log::debug!("Input for session {}: {:?}", session_id, data);
                                            let mut sessions = state.sessions.lock().await;
                                            if let Some(pty_session) = sessions.get_mut(&session_id) {
                                                if let Err(e) = pty_session.writer.write_all(data.as_bytes()) {
                                                    log::error!("Failed to write to PTY: {:?}", e);
                                                }
                                                if let Err(e) = pty_session.writer.flush() {
                                                    log::error!("Failed to flush PTY: {:?}", e);
                                                }
                                            } else {
                                                log::warn!("Session not found: {}", session_id);
                                            }
                                        }
                                        WsMessage::Resize { session_id, cols, rows } => {
                                            log::debug!("Resize session {} to {}x{}", session_id, cols, rows);
                                            let sessions = state.sessions.lock().await;
                                            if let Some(pty_session) = sessions.get(&session_id) {
                                                if let Err(e) = pty_session.master.resize(PtySize {
                                                    rows,
                                                    cols,
                                                    pixel_width: 0,
                                                    pixel_height: 0,
                                                }) {
                                                    log::error!("Failed to resize PTY: {:?}", e);
                                                }
                                            }
                                        }
                                        WsMessage::Close { session_id } => {
                                            log::info!("Closing session: {}", session_id);
                                            let mut sessions = state.sessions.lock().await;
                                            sessions.remove(&session_id);
                                            let resp = WsResponse::Closed { session_id };
                                            let _ = session.text(serde_json::to_string(&resp).unwrap()).await;
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("Failed to parse WS message: {:?}", e);
                                }
                            }
                        }
                        actix_ws::Message::Binary(data) => {
                            log::debug!("Received binary message: {} bytes", data.len());
                        }
                        actix_ws::Message::Ping(data) => {
                            log::trace!("Received ping");
                            let _ = session.pong(&data).await;
                        }
                        actix_ws::Message::Pong(_) => {
                            log::trace!("Received pong");
                        }
                        actix_ws::Message::Close(reason) => {
                            log::info!("WebSocket close received: {:?}", reason);
                            break;
                        }
                        _ => {
                            log::debug!("Received other message type");
                        }
                    }
                }
                Err(e) => {
                    log::error!("WebSocket receive error: {:?}", e);
                    break;
                }
            }
        }
        log::info!("WebSocket receiver task ended");
    });

    Ok(response)
}

async fn create_pty_session(
    session_id: &str,
    state: &Arc<AppState>,
    tx: mpsc::UnboundedSender<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    log::debug!("Initializing PTY system");
    let pty_system = NativePtySystem::default();

    log::debug!("Opening PTY pair");
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    log::debug!("Building command");
    let cmd = CommandBuilder::new_default_prog();
    log::info!("Spawning shell process");
    let _child = pair.slave.spawn_command(cmd)?;

    log::debug!("Getting PTY writer and reader");
    let writer = pair.master.take_writer()?;
    let mut reader = pair.master.try_clone_reader()?;

    let session_id_clone = session_id.to_string();

    // Spawn blocking task to read from PTY
    log::debug!("Starting PTY reader thread for session {}", session_id);
    std::thread::spawn(move || {
        log::debug!("PTY reader thread started for {}", session_id_clone);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    log::info!("PTY EOF for session {}", session_id_clone);
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    log::trace!("PTY output for {}: {} bytes", session_id_clone, n);
                    let resp = WsResponse::Output {
                        session_id: session_id_clone.clone(),
                        data,
                    };
                    if tx.send(serde_json::to_string(&resp).unwrap()).is_err() {
                        log::warn!("Failed to send PTY output, channel closed");
                        break;
                    }
                }
                Err(e) => {
                    log::error!("PTY read error for {}: {:?}", session_id_clone, e);
                    break;
                }
            }
        }
        log::debug!("PTY reader thread ended for {}", session_id_clone);
    });

    let pty_session = PtySession {
        writer,
        master: pair.master,
    };

    state
        .sessions
        .lock()
        .await
        .insert(session_id.to_string(), pty_session);

    log::info!("PTY session {} registered", session_id);
    Ok(())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger with debug level by default
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug")).init();

    log::info!("===========================================");
    log::info!("  Runotepad - Interactive Runbook Server");
    log::info!("===========================================");

    // Initialize config
    let config = match ConfigManager::new() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            log::error!("Failed to initialize config: {}", e);
            return Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()));
        }
    };

    log::info!("Workspace directory: {:?}", config.get_workspace_dir());
    log::info!("Access token: {}", config.get_token());
    log::info!("");
    log::info!("Starting server at http://0.0.0.0:8080");
    log::info!("Access with token: http://127.0.0.1:8080/?token={}", config.get_token());
    log::info!("");

    let state = Arc::new(AppState {
        sessions: Mutex::new(HashMap::new()),
    });

    HttpServer::new(move || {
        App::new()
            .wrap(middleware::Logger::default())
            .app_data(web::Data::new(state.clone()))
            .app_data(web::Data::new(config.clone()))
            // WebSocket endpoint
            .route("/ws", web::get().to(ws_handler))
            // Console log forwarding (no auth required)
            .route("/api/console", web::post().to(console_log_handler))
            // Auth endpoints
            .route("/api/auth/check", web::get().to(auth::auth_check_handler))
            // Workspace endpoints
            .route("/api/workspaces", web::get().to(workspace::list_workspaces))
            .route("/api/workspaces", web::post().to(workspace::create_workspace))
            .route("/api/workspaces/{name}", web::delete().to(workspace::delete_workspace))
            // Branch endpoints
            .route("/api/workspaces/{name}/branches", web::get().to(workspace::list_branches))
            .route("/api/workspaces/{name}/branches", web::post().to(workspace::create_branch))
            .route("/api/workspaces/{name}/branches/{branch}", web::delete().to(workspace::delete_branch))
            // File endpoints
            .route("/api/workspaces/{name}/branches/{branch}/files", web::get().to(workspace::list_files))
            .route("/api/workspaces/{name}/branches/{branch}/file", web::get().to(workspace::read_file))
            .route("/api/workspaces/{name}/branches/{branch}/file", web::put().to(workspace::save_file))
            // Git operation endpoints
            .route("/api/workspaces/{name}/branches/{branch}/commit", web::post().to(workspace::commit_files))
            .route("/api/workspaces/{name}/branches/{branch}/push", web::post().to(workspace::push_branch))
            .route("/api/workspaces/{name}/branches/{branch}/pull", web::post().to(workspace::pull_branch))
            .route("/api/workspaces/{name}/branches/{branch}/rebase", web::post().to(workspace::rebase_branch))
            .route("/api/workspaces/{name}/branches/{branch}/checkout", web::post().to(workspace::change_base_branch))
            .route("/api/workspaces/{name}/branches/{branch}/rename", web::post().to(workspace::rename_branch))
            // Static files (must be last)
            .service(Files::new("/", "./static").index_file("index.html"))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
