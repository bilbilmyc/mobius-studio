use crate::{
    app::Core,
    domain::{Picked, Result},
    projects::{screenplay, shot_drafts},
};

#[tauri::command]
pub(crate) fn list_scripts(s: Core) -> Result<Vec<screenplay::Script>> {
    s.store.scripts()
}

#[tauri::command]
pub(crate) fn set_final(
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
pub(crate) fn edit_script(
    s: Core,
    id: String,
    story: screenplay::Screenplay,
) -> Result<screenplay::Script> {
    let script = s.store.edit_script(&id, story)?;
    s.changed();
    Ok(script)
}

#[tauri::command]
pub(crate) fn create_script(s: Core, story: screenplay::Screenplay) -> Result<screenplay::Script> {
    s.store.create_script(story)
}

#[tauri::command]
pub(crate) async fn list_free_drafts(s: Core<'_>) -> Result<Vec<shot_drafts::FreeDraft>> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.free_drafts())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_free_draft(
    s: Core<'_>,
    draft: shot_drafts::FreeDraft,
    picks: Vec<Picked>,
) -> Result<()> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.save_free_draft(draft, picks))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn list_shot_drafts(s: Core<'_>) -> Result<Vec<shot_drafts::ShotDraft>> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.shot_drafts())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_shot_draft(
    s: Core<'_>,
    draft: shot_drafts::ShotDraft,
    picks: Vec<Picked>,
) -> Result<()> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.store.save_shot_draft(draft, picks))
        .await
        .map_err(|e| e.to_string())?
}
