use crate::{
    app::Core,
    connections::catalog,
    domain::{Edit, Result},
    storage::preferences,
};
use serde_json::Value;

#[tauri::command]
pub(crate) fn integration_settings(s: Core) -> Result<Value> {
    s.store.settings_view()
}

#[tauri::command]
pub(crate) async fn save_storage(
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
pub(crate) fn save_performance(s: Core, mode: preferences::PerformanceMode) -> Result<()> {
    s.store.save_performance(mode)
}

#[tauri::command]
pub(crate) fn performance_mode(s: Core) -> Result<preferences::PerformanceMode> {
    Ok(s.store.preferences()?.performance)
}

#[tauri::command]
pub(crate) async fn edit_profile(s: Core<'_>, input: Edit) -> Result<String> {
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
pub(crate) fn remove_profile(s: Core, id: String) -> Result<()> {
    s.store.remove(&id)?;
    s.changed();
    Ok(())
}

#[tauri::command]
pub(crate) async fn discover_models(
    s: Core<'_>,
    input: catalog::Lookup,
) -> Result<catalog::Catalog> {
    s.discover_models(input).await
}

#[tauri::command]
pub(crate) async fn list_models(s: Core<'_>, input: Edit) -> Result<Vec<String>> {
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
