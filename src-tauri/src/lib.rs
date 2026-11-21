mod catalog;
mod creation;
mod export;
mod inputs;
mod jobs;
mod model;
mod object_storage;
mod preferences;
#[cfg(target_os = "linux")]
mod preview;
mod provider;
mod screenplay;
mod store;
#[cfg(test)]
mod tests;
mod vault;
#[cfg(test)]
mod workspace_tests;
use jobs::Studio;
use model::*;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
type Core<'a> = State<'a, Arc<Studio>>;

fn view(app: &AppHandle, s: &Studio, j: &Job) -> Value {
    let file = s
        .store
        .media(j)
        .and_then(|p| p.canonicalize().ok())
        .filter(|p| p.starts_with(s.store.home.join("作品")));
    if let Some(p) = &file {
        let _ = app.asset_protocol_scope().allow_file(p);
    }
    let view = j.view(file.as_ref().and_then(|p| p.to_str()));
    #[cfg(target_os = "linux")]
    if kind(&j.protocol_id) == "video" {
        if let (Some(path), Some(server)) = (&file, app.try_state::<preview::Preview>()) {
            let mut view = view;
            view["mediaUrl"] = json!(server.register(&j.id, path));
            return view;
        }
    }
    view
}
#[tauri::command]
fn studio_state(app: AppHandle, s: Core) -> Result<Value> {
    let profiles = s.store.profiles()?;
    let official = s.store.resolve("@site", "image")?;
    let state = json!({"profiles":profiles.iter().map(|p|s.store.profile_view(p)).collect::<Vec<_>>(),"official":s.store.profile_view(&official),
        "jobs":s.store.jobs()?.iter().map(|j|view(&app,&s,j)).collect::<Vec<_>>(),"keyStorage":vault::Vault::note()});
    if std::env::var_os("MOBIUS_SMOKE_TEST").is_some() {
        eprintln!("MOBIUS_WEBVIEW_READY");
    }
    Ok(state)
}
#[tauri::command]
fn integration_settings(s: Core) -> Result<Value> {
    s.store.settings_view()
}
#[tauri::command]
async fn save_writer(s: Core<'_>, input: preferences::WriterInput) -> Result<()> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.save_writer(input))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_storage(
    s: Core<'_>,
    target: preferences::StorageTarget,
    secret: String,
) -> Result<()> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.save_storage(target, &secret))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn upload_image(s: Core<'_>, id: String) -> Result<()> {
    s.upload_image(&id, false).await
}
#[tauri::command]
fn list_scripts(s: Core) -> Result<Vec<screenplay::Script>> {
    s.store.scripts()
}
#[tauri::command]
async fn generate_script(s: Core<'_>, brief: String, count: usize) -> Result<screenplay::Script> {
    s.generate_script(brief, count).await
}
#[tauri::command]
fn edit_script(s: Core, id: String, story: screenplay::Screenplay) -> Result<screenplay::Script> {
    s.store.edit_script(&id, story)
}
#[tauri::command]
async fn edit_profile(s: Core<'_>, input: Edit) -> Result<String> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = s.store.edit(input)?;
        s.changed();
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn remove_profile(s: Core, id: String) -> Result<()> {
    s.store.remove(&id)?;
    s.changed();
    Ok(())
}
#[tauri::command]
async fn discover_models(s: Core<'_>, input: catalog::Lookup) -> Result<catalog::Catalog> {
    s.discover_models(input).await
}
#[tauri::command]
async fn list_models(s: Core<'_>, input: Edit) -> Result<Vec<String>> {
    let catalog = s
        .discover_models(catalog::Lookup {
            base: input.base,
            key: input.key,
            source: catalog::Source::Connection {
                id: input.id,
                auth: input.relay.map(|r| r.auth),
            },
        })
        .await?;
    Ok(catalog.models)
}
#[tauri::command]
fn add_link(s: Core, kind: String, url: String) -> Result<Picked> {
    s.store.register_link(&kind, &url)
}
#[tauri::command]
fn asset_preview(app: AppHandle, s: Core, item: Picked) -> Result<Option<String>> {
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
fn add_files(s: Core, kind: String, paths: Vec<String>) -> Result<Vec<Picked>> {
    paths
        .into_iter()
        .map(|p| s.store.register(&kind, p.into(), None))
        .collect()
}
#[tauri::command]
async fn pick_files(
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
async fn start_job(s: Core<'_>, input: Start) -> Result<String> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let j = core.prepare(input)?;
        let id = j.id.clone();
        core.launch(j, true)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn resume_job(s: Core, id: String) -> Result<()> {
    let j = s.store.job(&id)?;
    if j.status != "paused" || j.remote_id.is_none() && j.result_url.is_none() {
        return Err("没有可恢复的任务编号或下载地址。".into());
    }
    s.inner().launch(j, false)
}
#[tauri::command]
fn reuse_job(app: AppHandle, s: Core, id: String) -> Result<Value> {
    let j = s.store.job(&id)?;
    let mut picks = vec![];
    for a in j
        .site_options
        .iter()
        .flat_map(|o| o.assets.iter())
        .chain(j.assets.iter())
    {
        picks.push(if creation::remote(&a.path) {
            s.store.register_link(&a.kind, &a.path)?
        } else {
            s.store
                .register(&a.kind, s.store.input(&a.path)?, Some(a.name.clone()))?
        });
    }
    if let Some(p) = &j.reference {
        picks.push(s.store.register("image", s.store.input(p)?, None)?);
    }
    Ok(json!({"job":view(&app,&s,&j),"assets":picks}))
}
#[tauri::command]
fn job_frame(s: Core, id: String) -> Result<Picked> {
    let j = s.store.job(&id)?;
    if kind(&j.protocol_id) != "image" {
        return Err("请选择一张图片。".into());
    }
    s.store
        .register("image", s.store.media(&j).ok_or("原图已移动")?, None)
}
#[tauri::command]
async fn export_job(
    app: AppHandle,
    s: Core<'_>,
    id: String,
    resize: Option<export::Resize>,
    choose_location: bool,
) -> Result<Option<String>> {
    let j = s.store.job(&id)?;
    if resize.is_some() && kind(&j.protocol_id) != "image" {
        return Err("尺寸导出仅适用于图片。".into());
    }
    let file = s
        .store
        .media(&j)
        .ok_or("原文件已移动")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let dir = s.store.home.join("作品");
    if !file.starts_with(&dir) {
        return Err("原文件路径无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = if let Some(spec) = &resize {
            spec.validate()?;
            format!(
                "{}-{}x{}.png",
                file.file_stem().unwrap_or_default().to_string_lossy(),
                spec.width,
                spec.height
            )
        } else {
            file.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        let dest = if choose_location {
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("png");
            let Some(chosen) = app
                .dialog()
                .file()
                .set_title("另存作品")
                .set_file_name(&name)
                .add_filter("作品文件", &[ext])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let mut p = chosen.into_path().map_err(|e| e.to_string())?;
            if p.extension().is_none() {
                p.set_extension(ext);
            }
            p
        } else {
            let dir = dir.join("导出");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir.join(format!("{}-{name}", &model::id()[..8]))
        };
        export::write_copy(&file, &dest, resize.as_ref())?;
        Ok(Some(
            dest.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_owned(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn open_file(app: AppHandle, s: Core, id: String) -> Result<()> {
    let p = s
        .store
        .media(&s.store.job(&id)?)
        .ok_or("原文件已移动")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !p.starts_with(s.store.home.join("作品")) {
        return Err("作品路径无效。".into());
    }
    app.opener()
        .open_path(p.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_folder(app: AppHandle, s: Core) -> Result<()> {
    app.opener()
        .open_path(
            s.store.home.join("作品").to_string_lossy().into_owned(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_web(app: AppHandle, prompt: String) -> Result<()> {
    if !prompt.is_empty() {
        app.clipboard()
            .write_text(prompt)
            .map_err(|e| e.to_string())?;
    }
    app.opener()
        .open_url(WEBSITE, None::<&str>)
        .map_err(|e| e.to_string())
}
pub fn run() {
    let mut builder = tauri::Builder::default();
    if std::env::var_os("MOBIUS_HOME").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Ok(server) = preview::Preview::start() {
                app.manage(server);
            }
            let env = std::env::var_os("MOBIUS_HOME");
            let home = if cfg!(feature = "installed") && env.is_none() {
                app.path().app_data_dir()?.join("Data")
            } else {
                store::portable_path(&std::env::current_exe()?)
            };
            let store = match store::Store::new(home.clone()) {
                Ok(s) => s,
                Err(_) if env.is_none() && !home.exists() => {
                    store::Store::new(app.path().app_data_dir()?.join("Data"))
                        .map_err(std::io::Error::other)?
                }
                Err(e) => return Err(std::io::Error::other(e).into()),
            };
            let guard = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(store.home.join(".studio.lock"))?;
            guard
                .try_lock()
                .map_err(|_| std::io::Error::other("此数据目录已在另一个莫比环窗口中打开。"))?;
            app.manage(guard);
            let handle = app.handle().clone();
            let core = Arc::new(
                Studio::new(store, move || {
                    let _ = handle.emit("jobs-changed", ());
                })
                .map_err(std::io::Error::other)?,
            );
            app.manage(core.clone());
            core.recover().map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            studio_state,
            integration_settings,
            save_writer,
            save_storage,
            upload_image,
            list_scripts,
            generate_script,
            edit_script,
            edit_profile,
            remove_profile,
            discover_models,
            list_models,
            pick_files,
            add_files,
            add_link,
            asset_preview,
            start_job,
            resume_job,
            reuse_job,
            job_frame,
            export_job,
            open_file,
            open_folder,
            open_web
        ])
        .run(tauri::generate_context!())
        .expect("莫比环启动失败");
}
