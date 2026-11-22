use crate::{
    app::Core,
    domain::{self, kind, Result},
    media::export,
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn export_job(
    app: AppHandle,
    s: Core<'_>,
    id: String,
    resize: Option<export::Resize>,
    choose_location: bool,
) -> Result<Option<String>> {
    export_selected(app, s, id, resize, choose_location, None).await
}

#[tauri::command]
pub(crate) async fn export_input(s: Core<'_>, id: String) -> Result<tauri::ipc::Response> {
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
pub(crate) async fn export_rendered(
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
            dir.join(format!("{}-{name}", &domain::id()[..8]))
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
