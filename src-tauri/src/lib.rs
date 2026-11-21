mod catalog;
mod comfy;
mod comparisons;
mod creation;
mod export;
mod inputs;
mod jobs;
mod model;
mod object_storage;
#[cfg(test)]
mod poll_tests;
mod preferences;
#[cfg(target_os = "linux")]
mod preview;
mod provider;
mod screenplay;
mod shot_drafts;
mod store;
#[cfg(test)]
mod tests;
mod thumbnails;
mod vault;
#[cfg(test)]
mod workspace_tests;
mod writer;
use jobs::Studio;
use model::*;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
type Core<'a> = State<'a, Arc<Studio>>;

type ShotLabels = std::collections::HashMap<String, std::collections::BTreeMap<String, String>>;
fn view(app: &AppHandle, s: &Studio, j: &Job, labels: &mut ShotLabels) -> Value {
    let file = s.store.original(j).ok();
    if let Some(p) = &file {
        let _ = app.asset_protocol_scope().allow_file(p);
    }
    let mut view = j.view(file.as_ref().and_then(|p| p.to_str()));
    if let Some(link) = &j.shot {
        let scenes = labels
            .entry(link.script_id.clone())
            .or_insert_with(|| s.store.shot_labels(&link.script_id).unwrap_or_default());
        if let Some(label) = scenes.get(&link.scene_id) {
            view["shot"]["label"] = json!(label);
        } else {
            view["shot"] = Value::Null;
        }
    }
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
async fn studio_state(app: AppHandle, s: Core<'_>) -> Result<Value> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = core.store.profiles()?;
        let official = core.store.resolve("@site", "image")?;
        let mut labels = ShotLabels::new();
        let jobs = core.store.jobs()?.iter().map(|j|view(&app,&core,j,&mut labels)).collect::<Vec<_>>();
        let state = json!({
            "profiles": profiles.iter().map(|p|core.store.profile_view(p)).collect::<Vec<_>>(),
            "official": core.store.profile_view(&official), "jobs": jobs, "comparisons":core.store.comparisons()?, "keyStorage": vault::Vault::note(),
        });
        if std::env::var_os("MOBIUS_SMOKE_TEST").is_some() {
            eprintln!("MOBIUS_WEBVIEW_READY");
        }
        Ok(state)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn changed_jobs(app: AppHandle, s: Core<'_>, ids: Vec<String>) -> Result<Vec<Value>> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut labels = ShotLabels::new();
        ids.iter()
            .map(|id| {
                let job = core.store.job(id)?;
                Ok(view(&app, &core, &job, &mut labels))
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
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
fn set_final(
    s: Core,
    script_id: String,
    scene_id: String,
    kind: String,
    job_id: Option<String>,
) -> Result<screenplay::Script> {
    s.store
        .set_final(&script_id, &scene_id, &kind, job_id.as_deref())
}
#[tauri::command]
fn save_performance(s: Core, mode: preferences::PerformanceMode) -> Result<()> {
    s.store.save_performance(mode)
}
#[tauri::command]
fn performance_mode(s: Core) -> Result<preferences::PerformanceMode> {
    Ok(s.store.preferences()?.performance)
}
#[tauri::command]
async fn generate_script(s: Core<'_>, brief: String, count: usize) -> Result<screenplay::Script> {
    s.generate_script(brief, count).await
}
#[tauri::command]
async fn optimize_prompt(s: Core<'_>, input: writer::PromptInput) -> Result<writer::PromptResult> {
    s.optimize_prompt(input).await
}
#[tauri::command]
fn edit_script(s: Core, id: String, story: screenplay::Screenplay) -> Result<screenplay::Script> {
    let script = s.store.edit_script(&id, story)?;
    s.changed();
    Ok(script)
}
#[tauri::command]
fn create_script(s: Core, story: screenplay::Screenplay) -> Result<screenplay::Script> {
    s.store.create_script(story)
}
#[tauri::command]
async fn list_shot_drafts(s: Core<'_>) -> Result<Vec<shot_drafts::ShotDraft>> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.shot_drafts())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_shot_draft(
    s: Core<'_>,
    draft: shot_drafts::ShotDraft,
    picks: Vec<Picked>,
) -> Result<()> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.save_shot_draft(draft, picks))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn start_comparison(s: Core<'_>, inputs: [Start; 2]) -> Result<comparisons::Comparison> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.start_comparison(inputs))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn select_comparison(s: Core, id: String, job_id: String) -> Result<()> {
    s.store.select_comparison(&id, &job_id)?;
    s.changed();
    Ok(())
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
            source: if input.protocol == "comfy-image" {
                catalog::Source::Comfy { id: input.id }
            } else {
                catalog::Source::Connection {
                    id: input.id,
                    auth: input.relay.map(|r| r.auth),
                }
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
    Ok(json!({"job":view(&app,&s,&j,&mut ShotLabels::new()),"assets":picks}))
}
#[tauri::command]
fn job_frame(s: Core, id: String) -> Result<Picked> {
    let j = s.store.job(&id)?;
    if kind(&j.protocol_id) != "image" {
        return Err("请选择一张图片。".into());
    }
    s.store.register("image", s.store.original(&j)?, None)
}
fn task_info(j: &Job) -> String {
    let time = j.time();
    let created = chrono::DateTime::from_timestamp_millis(time)
        .filter(|_| time > 0)
        .map(|t| t.to_rfc3339())
        .unwrap_or_else(|| "未记录".into());
    let mut lines = vec![
        format!("本地记录号 {}", j.id),
        format!(
            "服务商任务号 {}",
            provider::protect_text(j.remote_id.as_deref().unwrap_or("未取得"), "")
        ),
        format!("模型 {}", provider::protect_text(&j.model, "")),
        format!("接口协议 {}", j.protocol_id),
        format!("提交时间 {created}"),
        format!("任务状态 {}", j.status),
    ];
    if let Some(stage) = &j.stopped_during {
        lines.push(format!("中断阶段 {stage}"));
    }
    for prefix in ["HTTP ", "官网返回 "] {
        if let Some((_, rest)) = j.detail.split_once(prefix) {
            let code: String = rest
                .chars()
                .take_while(char::is_ascii_digit)
                .take(8)
                .collect();
            if !code.is_empty() {
                lines.push(format!("{prefix}{code}"));
            }
        }
    }
    lines.join("\n")
}
#[tauri::command]
fn copy_task_info(app: AppHandle, s: Core, id: String) -> Result<()> {
    let info = task_info(&s.store.job(&id)?);
    app.clipboard().write_text(info).map_err(|e| e.to_string())
}
#[tauri::command]
async fn copy_job_image(app: AppHandle, s: Core<'_>, id: String, link: bool) -> Result<()> {
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
async fn export_job(
    app: AppHandle,
    s: Core<'_>,
    id: String,
    resize: Option<export::Resize>,
    choose_location: bool,
) -> Result<Option<String>> {
    export_selected(app, s, id, resize, choose_location, None).await
}

#[tauri::command]
async fn export_input(s: Core<'_>, id: String) -> Result<tauri::ipc::Response> {
    let job = s.store.job(&id)?;
    if kind(&job.protocol_id) != "image" {
        return Err("请选择图片作品。".into());
    }
    let file = s.store.original(&job)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || export::gpu_input(&file))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn export_rendered(
    app: AppHandle,
    s: Core<'_>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or("缺少导出参数")
    };
    let id = header("x-job-id")?.to_owned();
    let spec = export::Resize {
        width: header("x-width")?.parse().map_err(|_| "宽度无效")?,
        height: header("x-height")?.parse().map_err(|_| "高度无效")?,
        fit: header("x-fit")?.into(),
    };
    let choose = header("x-choose")? == "1";
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("缺少 PNG 数据。".into());
    };
    export::validate_rendered(data, &spec)?;
    export_selected(app, s, id, Some(spec), choose, Some(data.clone())).await
}

async fn export_selected(
    app: AppHandle,
    s: Core<'_>,
    id: String,
    resize: Option<export::Resize>,
    choose_location: bool,
    rendered: Option<Vec<u8>>,
) -> Result<Option<String>> {
    let j = s.store.job(&id)?;
    if resize.is_some() && kind(&j.protocol_id) != "image" {
        return Err("尺寸导出仅适用于图片。".into());
    }
    let file = s.store.original(&j)?;
    let dir = s.store.home.join("作品");
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
        if let Some(png) = rendered {
            export::write_output(&file, &dest, resize.as_ref(), Some(&png))?;
        } else {
            export::write_copy(&file, &dest, resize.as_ref())?;
        }
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
    let p = s.store.original(&s.store.job(&id)?)?;
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
    #[cfg(feature = "render-benchmark")]
    if std::env::var_os("MOBIUS_RENDER_BENCHMARK").is_some()
        && std::env::var_os("MOBIUS_HOME").is_some()
    {
        builder = builder.on_page_load(|webview, page| {
            if page.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(include_str!("../../tests/render-probe.js"));
            }
        });
    }
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
            #[cfg(feature = "render-benchmark")]
            if std::env::var_os("MOBIUS_RENDER_BENCHMARK").is_some()
                && store.home.join(".render-fixture").is_file()
            {
                use tauri::Listener;
                let output = store.home.join("render-result.json");
                app.listen("mobius-render-benchmark", move |event| {
                    if let Ok(result) = serde_json::from_str::<Value>(event.payload()) {
                        let _ = store::save(&output, &result);
                    }
                });
            }
            let handle = app.handle().clone();
            let core = Arc::new(
                Studio::new(store, move |id| {
                    let _ = handle.emit("jobs-changed", id);
                })
                .map_err(std::io::Error::other)?,
            );
            app.manage(core.clone());
            core.recover().map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            studio_state,
            changed_jobs,
            integration_settings,
            save_performance,
            performance_mode,
            set_final,
            thumbnails::job_thumbnail,
            thumbnails::video_poster,
            thumbnails::save_video_poster,
            save_writer,
            save_storage,
            upload_image,
            list_scripts,
            generate_script,
            optimize_prompt,
            create_script,
            list_shot_drafts,
            save_shot_draft,
            start_comparison,
            select_comparison,
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
            copy_job_image,
            copy_task_info,
            export_job,
            export_input,
            export_rendered,
            open_file,
            open_folder,
            open_web
        ])
        .run(tauri::generate_context!())
        .expect("莫比环启动失败");
}
