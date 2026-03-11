// Teams Agent Bridge - Tauri Application
// Modular desktop application for joining meetings with AI agents

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config_file;
mod mcp;

use tauri::Manager;

fn main() {
    // Enable backtraces in debug builds for crash diagnostics
    #[cfg(debug_assertions)]
    if std::env::var("RUST_BACKTRACE").is_err() {
        std::env::set_var("RUST_BACKTRACE", "1");
    }

    // Install panic hook to log crashes before the process exits
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();

        let crash_msg = format!(
            "PANIC in thread '{}' at {}: {}\n\nBacktrace:\n{}",
            thread_name, location, payload, backtrace
        );

        // Log to stderr (visible in tauri dev console)
        eprintln!("\n╔══════════════════════════════════════╗");
        eprintln!("║       COMMUNITY AGENT BRIDGE CRASH      ║");
        eprintln!("╚══════════════════════════════════════╝");
        eprintln!("{}", crash_msg);

        // Also write to a crash log file next to the executable
        if let Ok(exe) = std::env::current_exe() {
            let crash_log = exe.with_file_name("crash.log");
            let entry = format!(
                "[{}] {}\n\n",
                chrono_lite_now(),
                crash_msg
            );
            // Append so we keep history of crashes
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log)
                .and_then(|mut f| std::io::Write::write_all(&mut f, entry.as_bytes()));
            eprintln!("Crash log written to: {}", crash_log.display());
        }
    }));

    // Initialize tracing for MCP server logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,teams_agent_bridge::mcp=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .manage(mcp::state::McpState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::open_external_url,
            // Config file commands
            commands::load_config_file,
            commands::load_raw_config_file,
            commands::save_config_file,
            commands::get_config_file_path,
            commands::import_config_file,
            // MCP server commands
            commands::start_mcp_server,
            commands::stop_mcp_server,
            commands::get_mcp_server_status,
            commands::mcp_respond,
        ])
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event.event() {
                // Gracefully shut down the MCP server before the window closes
                let app = event.window().app_handle();
                if let Some(state) = app.try_state::<mcp::state::McpState>() {
                    tauri::async_runtime::block_on(async {
                        let inner = state.inner.lock().await;
                        if let Some(ct) = &inner.cancellation_token {
                            ct.cancel();
                            tracing::info!("MCP server shutdown initiated (window close)");
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Lightweight timestamp for crash logs (no extra dependency)
fn chrono_lite_now() -> String {
    use std::time::SystemTime;
    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => format!("epoch+{}s", d.as_secs()),
        Err(_) => "unknown-time".to_string(),
    }
}
