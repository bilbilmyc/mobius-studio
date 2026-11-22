use crate::{
    app::Core,
    domain::Result,
    storage::files::{read, save},
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;
fn executable(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}
pub(crate) fn locate(home: &Path, name: &str) -> Option<PathBuf> {
    let stored: Option<PathBuf> = read(&home.join("媒体工具.json")).ok();
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|v| v.join("tools")));
    let mut dirs = stored.into_iter().chain(sibling).collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path))
    }
    dirs.into_iter()
        .map(|p| executable(&p, name))
        .find(|p| p.is_absolute() && p.is_file())
}
fn status(home: &Path) -> Value {
    json!({"ffmpeg":locate(home,"ffmpeg"),"ffprobe":locate(home,"ffprobe")})
}
#[tauri::command]
pub fn media_tools(s: Core) -> Value {
    status(&s.store.home)
}
#[tauri::command]
pub async fn choose_media_tools(s: Core<'_>, app: tauri::AppHandle) -> Result<Value> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(folder) = app
            .dialog()
            .file()
            .set_title("选择包含 ffmpeg 和 ffprobe 的目录")
            .blocking_pick_folder()
        {
            let dir = folder.into_path().map_err(|e| e.to_string())?;
            if !["ffmpeg", "ffprobe"]
                .iter()
                .all(|v| executable(&dir, v).is_file())
            {
                return Err("此目录需要同时包含 ffmpeg 和 ffprobe。".into());
            }
            save(&s.store.home.join("媒体工具.json"), &dir)?;
        }
        Ok(status(&s.store.home))
    })
    .await
    .map_err(|e| e.to_string())?
}
