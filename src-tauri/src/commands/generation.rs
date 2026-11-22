#[cfg(target_os = "linux")]
use crate::media::preview;
use crate::{
    app::Core,
    domain::*,
    generation::{batches, comparisons, creation, jobs::Studio},
    providers,
    storage::vault,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

type ShotLabels = std::collections::HashMap<String, std::collections::BTreeMap<String, String>>;

fn view(app: &AppHandle, s: &Studio, j: &Job, labels: &mut ShotLabels) -> Value {
    let file = s.store.original(j).ok();
    if let Some(p) = &file {
        let _ = app.asset_protocol_scope().allow_file(p);
    }
    let mut view = j.view(file.as_ref().and_then(|p| p.to_str()));
    view["estimatedCny"] = json!(batches::estimate(j));
    if s.group_file(&j.id).is_file() {
        view["hasResultUrl"] = json!(true);
    }
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
pub(crate) async fn studio_state(app: AppHandle, s: Core<'_>) -> Result<Value> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = core.store.profiles()?;
        let official = core.store.resolve("@site", "image")?;
        let mut labels = ShotLabels::new();
        let jobs = core.store.jobs()?.iter().map(|j|view(&app,&core,j,&mut labels)).collect::<Vec<_>>();
        let state = json!({
            "scriptRuns": core.script_runs.list(),
            "modelFeatures":core.store.feature_map()?,
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
pub(crate) async fn changed_jobs(
    app: AppHandle,
    s: Core<'_>,
    ids: Vec<String>,
) -> Result<Vec<Value>> {
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
pub(crate) async fn start_job(s: Core<'_>, input: Start) -> Result<String> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(n) = input.repeat.filter(|n| *n > 1) {
            return core.start_repeats(input, n);
        }
        let j = core.prepare(input)?;
        let id = j.id.clone();
        core.submit_new(j)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn resume_job(s: Core, id: String) -> Result<()> {
    let j = s.store.job(&id)?;
    if j.status != "paused"
        || j.remote_id.is_none() && j.result_url.is_none() && !s.group_file(&j.id).is_file()
    {
        return Err("没有可恢复的任务编号或下载地址。".into());
    }
    s.inner().launch(j, false)
}

#[tauri::command]
pub(crate) fn reuse_job(app: AppHandle, s: Core, id: String) -> Result<Value> {
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
    let mask = j
        .mask
        .as_ref()
        .map(|a| {
            s.store
                .register("image", s.store.input(&a.path)?, Some(a.name.clone()))
        })
        .transpose()?;
    Ok(json!({"job":view(&app,&s,&j,&mut ShotLabels::new()),"assets":picks,"mask":mask}))
}

pub(crate) fn task_info(j: &Job) -> String {
    let time = j.time();
    let created = chrono::DateTime::from_timestamp_millis(time)
        .filter(|_| time > 0)
        .map(|t| t.to_rfc3339())
        .unwrap_or_else(|| "未记录".into());
    let mut lines = vec![
        format!("本地记录号 {}", j.id),
        format!(
            "服务商任务号 {}",
            providers::protect_text(j.remote_id.as_deref().unwrap_or("未取得"), "")
        ),
        format!("模型 {}", providers::protect_text(&j.model, "")),
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
pub(crate) fn copy_task_info(app: AppHandle, s: Core, id: String) -> Result<()> {
    let info = task_info(&s.store.job(&id)?);
    app.clipboard().write_text(info).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn start_comparison(
    s: Core<'_>,
    inputs: [Start; 2],
) -> Result<comparisons::Comparison> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.start_comparison(inputs))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn select_comparison(s: Core, id: String, job_id: String) -> Result<()> {
    s.store.select_comparison(&id, &job_id)?;
    s.changed();
    Ok(())
}
