//! WebKitGTK's media pipeline needs HTTP byte ranges for local video playback.
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::{
    collections::HashMap,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

#[derive(Clone)]
pub struct Preview {
    port: u16,
    capability: String,
    files: Arc<RwLock<HashMap<String, PathBuf>>>,
}
impl Preview {
    pub fn start() -> std::io::Result<Self> {
        let socket = TcpListener::bind(("127.0.0.1", 0))?;
        socket.set_nonblocking(true)?;
        let this = Self {
            port: socket.local_addr()?.port(),
            capability: crate::model::id(),
            files: Default::default(),
        };
        let router = Router::new()
            .route("/{cap}/{job}", get(serve))
            .with_state(this.clone());
        tauri::async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(socket) {
                let _ = axum::serve(listener, router).await;
            }
        });
        Ok(this)
    }
    pub fn register(&self, job: &str, file: &std::path::Path) -> String {
        self.files
            .write()
            .unwrap()
            .insert(job.into(), file.to_owned());
        format!("http://127.0.0.1:{}/{}/{}", self.port, self.capability, job)
    }
}
async fn serve(
    State(state): State<Preview>,
    Path((token, job)): Path<(String, String)>,
    request: Request,
) -> Response {
    if token != state.capability {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = state.files.read().unwrap().get(&job).cloned();
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match ServeFile::new(path).oneshot(request).await {
        Ok(response) => {
            let mut r = response.map(Body::new);
            r.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("private, no-store"),
            );
            r
        }
        Err(never) => match never {},
    }
}
