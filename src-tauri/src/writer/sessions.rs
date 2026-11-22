use super::optimizer::Medium;
use crate::{
    domain::{valid_id, Result},
    projects::screenplay::ShotLink,
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
pub(crate) struct Scope {
    pub kind: Medium,
    pub shot: Option<ShotLink>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source {
    ReadShot,
    ReadReferences,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Turn {
    pub user: String,
    pub original: String,
    pub reply: String,
    pub prompt: Option<String>,
    pub model: String,
    pub sources: Vec<Source>,
}

#[derive(Default, Deserialize, Serialize)]
struct Conversation {
    revision: u64,
    turns: Vec<Turn>,
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    pub revision: u64,
    pub memory: String,
    pub turns: Vec<Turn>,
}

impl Store {
    fn prompt_paths(&self, scope: &Scope) -> Result<(PathBuf, PathBuf)> {
        let (project, scene) = match &scope.shot {
            Some(shot) if valid_id(&shot.script_id) && valid_id(&shot.scene_id) => {
                self.resolve_shot(shot.clone())?;
                (shot.script_id.as_str(), shot.scene_id.as_str())
            }
            Some(_) => return Err("分镜编号无效。".into()),
            None => ("studio", "free"),
        };
        let kind = match scope.kind {
            Medium::Image => "image",
            Medium::Video => "video",
        };
        let dir = self.home.join("提示词对话").join(project);
        Ok((
            dir.join(format!("{scene}-{kind}.json")),
            dir.join("memory.json"),
        ))
    }

    pub(super) fn prompt_session(&self, scope: &Scope) -> Result<Snapshot> {
        let _lock = self.gate.lock().unwrap();
        let (session, memory) = self.prompt_paths(scope)?;
        let chat: Conversation = read_or_default(&session)?;
        Ok(Snapshot {
            revision: chat.revision,
            turns: chat.turns,
            memory: read_or_default(&memory)?,
        })
    }

    pub(super) fn update_prompt_session(
        &self,
        scope: &Scope,
        revision: u64,
        turn: Option<Turn>,
    ) -> Result<Snapshot> {
        if let Some(t) = &turn {
            if !valid_text(&t.user, 4000)
                || t.original.chars().count() > 12000
                || !valid_text(&t.reply, 4000)
                || !valid_text(&t.model, 256)
                || t.prompt.as_ref().is_some_and(|p| !valid_text(p, 12000))
                || t.sources.len() > 2
            {
                return Err("改稿内容超出会话可保存的范围。".into());
            }
        }
        let _lock = self.gate.lock().unwrap();
        let (session, memory_path) = self.prompt_paths(scope)?;
        let mut chat: Conversation = read_or_default(&session)?;
        if chat.revision != revision {
            return Err("这段对话已在其他窗口更新，请重新打开查看。".into());
        }
        let memory = read_or_default(&memory_path)?;
        match turn {
            Some(turn) => chat.turns.push(turn),
            None => chat.turns.clear(),
        }
        chat.revision += 1;
        write_local(&session, &chat)?;
        Ok(Snapshot {
            revision: chat.revision,
            turns: chat.turns,
            memory,
        })
    }

    pub(super) fn save_prompt_memory(
        &self,
        scope: &Scope,
        previous: &str,
        memory: &str,
    ) -> Result<String> {
        if memory.chars().count() > 2000 {
            return Err("创作记忆最多 2000 字。".into());
        }
        let _lock = self.gate.lock().unwrap();
        let (_, path) = self.prompt_paths(scope)?;
        let current: String = read_or_default(&path)?;
        if current != previous {
            return Err("创作记忆已经更新，请重新打开查看。".into());
        }
        let memory = memory.trim().to_owned();
        write_local(&path, &memory)?;
        Ok(memory)
    }

    pub(super) fn prompt_shot_context(&self, shot: ShotLink) -> Result<Value> {
        let story = self.script(&shot.script_id)?.story;
        let i = story
            .scenes
            .iter()
            .position(|s| s.id == shot.scene_id)
            .ok_or("所选分镜已移除。")?;
        let current = &story.scenes[i];
        let adjacent = |index: usize| story.scenes.get(index).map(|s| &s.heading);
        Ok(
            json!({ "title":story.title, "number":i + 1, "current": current,
            "previousHeading": i.checked_sub(1).and_then(adjacent), "nextHeading": adjacent(i+1) }),
        )
    }
}

fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}

fn read_or_default<T: Default + DeserializeOwned>(path: &Path) -> Result<T> {
    if path.try_exists().map_err(|e| e.to_string())? {
        read(path)
    } else {
        Ok(T::default())
    }
}

fn write_local<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    save(path, value)
}
