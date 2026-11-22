mod capture;
mod form;
mod json_body;
#[cfg(test)]
mod tests;

use capture::Example;
pub(crate) use form::{Form, Outgoing};
use reqwest::{Response, StatusCode};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
    time::Instant,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

const LIMIT: usize = 80;
// The desktop process serves one data directory, including background jobs and project downloads.
static LOG: LazyLock<Mutex<Log>> = LazyLock::new(Mutex::default);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    id: u64,
    time: i64,
    method: String,
    target: String,
    outcome: String,
    status: Option<u16>,
    elapsed_ms: Option<u64>,
}
struct Entry {
    summary: Summary,
    example: Example,
}
#[derive(Default)]
struct Log {
    enabled: bool,
    epoch: u64,
    next: u64,
    entries: VecDeque<Entry>,
}
impl Log {
    fn clear(&mut self) {
        self.entries.clear();
        self.epoch += 1;
    }
    fn begin(
        &mut self,
        epoch: u64,
        method: String,
        target: String,
        example: Example,
    ) -> Option<u64> {
        if !self.enabled || self.epoch != epoch {
            return None;
        }
        self.next += 1;
        self.entries.truncate(LIMIT - 1);
        self.entries.push_front(Entry {
            summary: Summary {
                id: self.next,
                time: chrono::Utc::now().timestamp_millis(),
                method,
                target,
                outcome: "pending".into(),
                status: None,
                elapsed_ms: None,
            },
            example,
        });
        Some(self.next)
    }
    fn finish(&mut self, id: u64, status: Option<StatusCode>, outcome: &str, elapsed: u64) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.summary.id == id) {
            entry.summary.status = status.map(|s| s.as_u16());
            entry.summary.outcome = outcome.into();
            entry.summary.elapsed_ms = Some(elapsed);
        }
    }
}

fn epoch() -> Option<u64> {
    let log = LOG.lock().unwrap();
    log.enabled.then_some(log.epoch)
}
pub(crate) fn enable(enabled: bool) {
    let mut log = LOG.lock().unwrap();
    if log.enabled != enabled {
        log.clear();
        log.enabled = enabled;
    }
}
struct Pending {
    id: Option<u64>,
    start: Instant,
}
impl Pending {
    fn finish(&mut self, status: Option<StatusCode>, outcome: &str) {
        if let Some(id) = self.id.take() {
            LOG.lock().unwrap().finish(
                id,
                status,
                outcome,
                self.start.elapsed().as_millis() as u64,
            );
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.finish(None, "interrupted");
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Destination {
    Api,
    Media,
}

pub(crate) async fn send(
    request: impl Into<Outgoing>,
    key: &str,
    destination: Destination,
) -> reqwest::Result<Response> {
    let outgoing = request.into();
    let Some(epoch) = epoch() else {
        let result = outgoing.wire.send().await;
        log_response(&result, destination);
        return result;
    };
    let (client, request) = outgoing.wire.build_split();
    let request = request?;
    let (target, example) = Example::capture(&request, key, outgoing.form, destination);
    let id = LOG
        .lock()
        .unwrap()
        .begin(epoch, request.method().to_string(), target, example);
    let mut pending = Pending {
        id,
        start: Instant::now(),
    };
    let result = client.execute(request).await;
    log_response(&result, destination);
    pending.finish(
        result.as_ref().ok().map(Response::status),
        if result.is_ok() { "received" } else { "failed" },
    );
    result
}

fn log_response(result: &reqwest::Result<Response>, destination: Destination) {
    let area = match destination {
        Destination::Api => "http-api",
        Destination::Media => "http-media",
    };
    match result {
        Ok(reply) if reply.status().is_client_error() || reply.status().is_server_error() => {
            crate::diagnostics::entry("WARN", area, &format!("HTTP {}", reply.status().as_u16()))
        }
        Err(e) => crate::diagnostics::entry(
            "ERROR",
            area,
            if e.is_timeout() {
                "等待超时"
            } else if e.is_connect() {
                "连接失败"
            } else {
                "网络请求中断"
            },
        ),
        _ => {}
    }
}

#[tauri::command]
pub(crate) fn set_developer_mode(s: crate::app::Core, enabled: bool) -> crate::domain::Result<()> {
    s.store.save_developer_mode(enabled)
}
#[tauri::command]
pub(crate) fn request_history() -> Vec<Summary> {
    LOG.lock()
        .unwrap()
        .entries
        .iter()
        .map(|e| e.summary.clone())
        .collect()
}
#[tauri::command]
pub(crate) fn request_example(id: u64) -> Option<Example> {
    LOG.lock()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.summary.id == id)
        .map(|e| e.example.clone())
}
#[tauri::command]
pub(crate) fn clear_request_history() {
    LOG.lock().unwrap().clear()
}
#[tauri::command]
pub(crate) fn copy_request_example(
    app: tauri::AppHandle,
    id: u64,
    code: String,
) -> crate::domain::Result<()> {
    let log = LOG.lock().unwrap();
    if !log.entries.iter().any(|e| e.summary.id == id) {
        return Err("这条请求记录已清除。".into());
    }
    app.clipboard().write_text(code).map_err(|e| e.to_string())
}
