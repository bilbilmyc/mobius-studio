use crate::{
    export::read_image,
    model::{kind, Result},
    store::Store,
};
use image::ImageFormat;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager, State};

struct CacheFile {
    original: PathBuf,
    path: PathBuf,
    stamp: String,
}

impl Store {
    fn thumb_file(&self, id: &str, media: &str, ext: &str) -> Result<CacheFile> {
        let job = self.job(id)?;
        if kind(&job.protocol_id) != media {
            return Err("作品类型不符。".into());
        }
        let original = self.original(&job)?;
        let info = original.metadata().map_err(|e| e.to_string())?;
        let stamp = info
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = self.home.join("缓存").join("缩略图-v1");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        if !dir.starts_with(self.home.join("缓存")) {
            return Err("缩略图目录无效。".into());
        }
        let stamp = format!("{}-{stamp}", info.len());
        Ok(CacheFile {
            original,
            path: dir.join(format!("{id}-{stamp}.{ext}")),
            stamp,
        })
    }
    pub fn thumbnail(&self, id: &str) -> Result<PathBuf> {
        let CacheFile {
            original,
            path: file,
            ..
        } = self.thumb_file(id, "image", "webp")?;
        if !file.is_file() {
            let image = read_image(&original)?;
            let image = if image.width().max(image.height()) > 384 {
                image.thumbnail(384, 384)
            } else {
                image
            };
            let mut staged = tempfile::NamedTempFile::new_in(file.parent().unwrap())
                .map_err(|e| e.to_string())?;
            image
                .write_to(staged.as_file_mut(), ImageFormat::WebP)
                .map_err(|e| e.to_string())?;
            cache_once(staged, &file)?;
        }
        self.cached_path(&file)
    }
    fn cached_path(&self, file: &Path) -> Result<PathBuf> {
        let path = file.canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(self.home.join("缓存")) {
            return Err("缩略图路径无效。".into());
        }
        Ok(path)
    }
}

fn cache_once(staged: tempfile::NamedTempFile, path: &Path) -> Result<()> {
    match staged.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.error.to_string()),
    }
}
fn allow(app: &AppHandle, path: &Path) -> Result<String> {
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn video_poster(
    app: AppHandle,
    s: State<'_, std::sync::Arc<crate::jobs::Studio>>,
    id: String,
) -> Result<serde_json::Value> {
    let file = s.store.thumb_file(&id, "video", "png")?;
    let path = if file.path.is_file() {
        Some(allow(&app, &s.store.cached_path(&file.path)?)?)
    } else {
        None
    };
    Ok(serde_json::json!({"path":path,"stamp":file.stamp}))
}
#[tauri::command]
pub async fn save_video_poster(
    app: AppHandle,
    s: State<'_, std::sync::Arc<crate::jobs::Studio>>,
    request: tauri::ipc::Request<'_>,
) -> Result<String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .ok_or("视频缩略图缺少参数")
    };
    let file = s.store.thumb_file(header("x-job-id")?, "video", "png")?;
    if file.stamp != header("x-source-stamp")? {
        return Err("视频原件已更新。".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("缺少缩略图。".into());
    };
    if bytes.len() > 1024 * 1024 {
        return Err("视频缩略图过大。".into());
    }
    let bytes = bytes.clone();
    let core = s.inner().clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let (w, h) =
            image::ImageReader::with_format(std::io::Cursor::new(&bytes), ImageFormat::Png)
                .into_dimensions()
                .map_err(|e| e.to_string())?;
        if w.min(h) == 0 || w.max(h) > 384 {
            return Err("视频缩略图尺寸无效。".into());
        }
        image::load_from_memory_with_format(&bytes, ImageFormat::Png).map_err(|e| e.to_string())?;
        let mut staged = tempfile::NamedTempFile::new_in(file.path.parent().unwrap())
            .map_err(|e| e.to_string())?;
        staged.write_all(&bytes).map_err(|e| e.to_string())?;
        cache_once(staged, &file.path)?;
        core.store.cached_path(&file.path)
    })
    .await
    .map_err(|e| e.to_string())??;
    allow(&app, &path)
}
#[tauri::command]
pub async fn job_thumbnail(
    app: AppHandle,
    s: State<'_, std::sync::Arc<crate::jobs::Studio>>,
    id: String,
) -> Result<String> {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _slot = SLOTS.acquire().await.map_err(|e| e.to_string())?;
    let core = s.inner().clone();
    let path = tauri::async_runtime::spawn_blocking(move || core.store.thumbnail(&id))
        .await
        .map_err(|e| e.to_string())??;
    allow(&app, &path)
}
