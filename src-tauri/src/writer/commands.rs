use super::{
    optimizer::{PromptInput, PromptResult},
    provider::{completion_text, Message, Role, WriterTarget},
    sessions::{Scope, Snapshot, Turn},
};
use crate::storage::store::Store;
use crate::{
    app::Core,
    domain::Result,
    projects::screenplay::{self, ShotLink},
    storage::preferences::WriterInput,
};
use serde_json::Value;

async fn local_data<T: Send + 'static>(
    s: Core<'_>,
    action: impl FnOnce(&Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let core = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || action(&core.store))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_writer(s: Core<'_>, input: WriterInput) -> Result<()> {
    local_data(s, move |store| store.save_writer(input)).await
}

#[tauri::command]
pub(crate) async fn generate_script(
    s: Core<'_>,
    brief: String,
    count: usize,
) -> Result<screenplay::Script> {
    s.generate_script(brief, count).await
}
#[tauri::command]
pub(crate) async fn optimize_prompt(s: Core<'_>, input: PromptInput) -> Result<PromptResult> {
    s.optimize_prompt(input).await
}

#[tauri::command]
pub(crate) async fn prompt_session(s: Core<'_>, scope: Scope) -> Result<Snapshot> {
    local_data(s, move |store| store.prompt_session(&scope)).await
}
#[tauri::command]
pub(crate) async fn update_prompt_session(
    s: Core<'_>,
    scope: Scope,
    revision: u64,
    turn: Option<Turn>,
) -> Result<Snapshot> {
    local_data(s, move |store| {
        store.update_prompt_session(&scope, revision, turn)
    })
    .await
}
#[tauri::command]
pub(crate) async fn save_prompt_memory(
    s: Core<'_>,
    scope: Scope,
    previous: String,
    memory: String,
) -> Result<String> {
    local_data(s, move |store| {
        store.save_prompt_memory(&scope, &previous, &memory)
    })
    .await
}
#[tauri::command]
pub(crate) async fn prompt_shot_context(s: Core<'_>, shot: ShotLink) -> Result<Value> {
    local_data(s, move |store| store.prompt_shot_context(shot)).await
}

#[tauri::command]
pub(crate) async fn prompt_agent_step(
    s: Core<'_>,
    target: WriterTarget,
    messages: Vec<Message>,
) -> Result<PromptResult> {
    if messages.len() < 2
        || messages.len() > 24
        || !matches!(messages[0].role, Role::System)
        || messages[1..].iter().any(|m| matches!(m.role, Role::System))
        || messages.iter().map(|m| m.content.len()).sum::<usize>() > 420_000
    {
        return Err("改稿上下文过长或格式有误，请缩短本次输入。".into());
    }
    let (model, reply) = s.writer_messages(&messages, true, Some(&target)).await?;
    Ok(PromptResult {
        model,
        text: completion_text(&reply)?,
    })
}
