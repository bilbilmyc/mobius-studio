use super::{
    exchange::{self, Preview},
    Change, Updated, View,
};
use crate::{app::Core, domain::Result};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn prompt_templates(s: Core<'_>) -> Result<View> {
    super::super::commands::local_data(s, |store| store.template_library()).await
}
#[tauri::command]
pub(crate) async fn parse_prompt_templates(filename: String, content: String) -> Result<Preview> {
    tauri::async_runtime::spawn_blocking(move || exchange::parse(&filename, &content))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn change_prompt_templates(
    s: Core<'_>,
    revision: u64,
    change: Change,
) -> Result<Updated> {
    super::super::commands::local_data(s, move |store| store.change_templates(revision, change))
        .await
}
#[tauri::command]
pub(crate) async fn export_prompt_templates(
    s: Core<'_>,
    app: AppHandle,
    ids: Vec<String>,
    choose_location: bool,
) -> Result<Option<String>> {
    super::super::commands::local_data(s, move |store| {
        let target = if choose_location {
            let Some(file) = app
                .dialog()
                .file()
                .set_title("导出提示词模板")
                .add_filter("模板包", &["json"])
                .set_file_name("提示词模板.json")
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let mut path = file.into_path().map_err(|e| e.to_string())?;
            if path.extension().is_none() {
                path.set_extension("json");
            }
            Some(path)
        } else {
            None
        };
        store.export_templates(ids, target).map(Some)
    })
    .await
}

#[tauri::command]
pub(crate) async fn find_prompt_templates(
    s: Core<'_>,
    kind: super::Medium,
    query: String,
) -> Result<Vec<super::Match>> {
    super::super::commands::local_data(s, move |store| store.find_templates(kind, query)).await
}
