use crate::{
    app::Core,
    domain::{kind, Picked, Result, WEBSITE},
    generation::creation,
    media::export,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub(crate) fn add_link(s: Core, kind: String, url: String) -> Result<Picked> {
    s.store.register_link(&kind, &url)
}

#[tauri::command]
pub(crate) fn asset_preview(app: AppHandle, s: Core, item: Picked) -> Result<Option<String>> {
    let a = s.store.assets(&[item])?.pop().unwrap();
    if a.kind != "image" || creation::remote(&a.path) {
        return Ok(None);
    }
    let path = s
        .store
        .input(&a.path)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into()))
}

#[tauri::command]
pub(crate) fn add_files(s: Core, kind: String, paths: Vec<String>) -> Result<Vec<Picked>> {
    paths
        .into_iter()
        .map(|p| s.store.register(&kind, p.into(), None))
        .collect()
}

#[tauri::command]
pub(crate) async fn pick_files(
    app: AppHandle,
    s: Core<'_>,
    kind: String,
    multiple: bool,
) -> Result<Vec<Picked>> {
    let exts = match kind.as_str() {
        "image" => vec![
            "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tif", "tiff", "heic", "heif",
            "jfif",
        ],
        "video" => vec!["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpeg", "mpg"],
        "audio" => vec![
            "wav", "mp3", "m4a", "aac", "ogg", "flac", "opus", "aiff", "wma",
        ],
        _ => return Err("无效素材类别".into()),
    };
    let picks = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_title("选择参考素材")
            .add_filter("支持的文件", &exts);
        if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    picks
        .into_iter()
        .map(|f| {
            s.store
                .register(&kind, f.into_path().map_err(|e| e.to_string())?, None)
        })
        .collect()
}

#[tauri::command]
pub(crate) fn job_frame(s: Core, id: String) -> Result<Picked> {
    let j = s.store.job(&id)?;
    if kind(&j.protocol_id) != "image" {
        return Err("请选择一张图片。".into());
    }
    s.store.register("image", s.store.original(&j)?, None)
}

#[tauri::command]
pub(crate) async fn upload_image(s: Core<'_>, id: String) -> Result<()> {
    s.upload_image(&id, false).await
}

#[tauri::command]
pub(crate) async fn copy_job_image(
    app: AppHandle,
    s: Core<'_>,
    id: String,
    link: bool,
) -> Result<()> {
    let job = s.store.job(&id)?;
    if kind(&job.protocol_id) != "image" {
        return Err("请选择一张图片。".into());
    }
    let file = s.store.original(&job)?;
    tauri::async_runtime::spawn_blocking(move || {
        if link {
            let url = url::Url::from_file_path(file).map_err(|_| "本地文件地址无效。")?;
            app.clipboard().write_text(url.as_str())
        } else {
            let rgba = export::read_image(&file)?.into_rgba8();
            let (w, h) = rgba.dimensions();
            app.clipboard()
                .write_image(&tauri::image::Image::new_owned(rgba.into_raw(), w, h))
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn open_file(app: AppHandle, s: Core, id: String) -> Result<()> {
    let p = s.store.original(&s.store.job(&id)?)?;
    app.opener()
        .open_path(p.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn open_folder(app: AppHandle, s: Core) -> Result<()> {
    app.opener()
        .open_path(
            s.store.home.join("作品").to_string_lossy().into_owned(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn open_web(app: AppHandle, prompt: String) -> Result<()> {
    if !prompt.is_empty() {
        app.clipboard()
            .write_text(prompt)
            .map_err(|e| e.to_string())?;
    }
    app.opener()
        .open_url(WEBSITE, None::<&str>)
        .map_err(|e| e.to_string())
}
