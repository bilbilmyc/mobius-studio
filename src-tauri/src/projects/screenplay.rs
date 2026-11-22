use crate::{
    domain::{id, valid_id, Result, ShotLink},
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    #[serde(default)]
    pub(crate) id: String,
    pub(crate) heading: String,
    action: String,
    #[serde(default)]
    pub(crate) dialogue: String,
    image_prompt: String,
    video_prompt: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Screenplay {
    pub title: String,
    pub scenes: Vec<Scene>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    #[serde(default)]
    pub(crate) finals: BTreeMap<String, BTreeMap<String, String>>,
    pub id: String,
    pub created: i64,
    pub model: String,
    pub brief: String,
    #[serde(flatten)]
    pub story: Screenplay,
}

impl Screenplay {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 200
            || self.scenes.is_empty()
        {
            return Err("剧本需要标题和至少一个分镜。".into());
        }
        for scene in &self.scenes {
            for text in [
                &scene.heading,
                &scene.action,
                &scene.image_prompt,
                &scene.video_prompt,
            ] {
                if text.trim().is_empty() || text.chars().count() > 12000 {
                    return Err(
                        "每个分镜都需要场景、动作、图片提示词和视频提示词，每项最多 12000 字。"
                            .into(),
                    );
                }
            }
            if scene.dialogue.chars().count() > 12000 {
                return Err("每个分镜的台词最多 12000 字。".into());
            }
        }
        Ok(())
    }
}

impl Store {
    pub fn create_script(&self, mut story: Screenplay) -> Result<Script> {
        for scene in &mut story.scenes {
            scene.id = id();
        }
        let script = Script {
            id: id(),
            created: chrono::Utc::now().timestamp_millis(),
            model: "手工分镜".into(),
            brief: String::new(),
            finals: Default::default(),
            story,
        };
        self.save_script(&script)?;
        Ok(script)
    }
    pub(crate) fn script(&self, script_id: &str) -> Result<Script> {
        if !valid_id(script_id) {
            return Err("剧本编号无效。".into());
        }
        let mut script: Script = read(&self.home.join("剧本").join(format!("{script_id}.json")))?;
        if script.id != script_id {
            return Err("剧本文件与编号不符。".into());
        }
        for (index, scene) in script.story.scenes.iter_mut().enumerate() {
            if scene.id.is_empty() {
                scene.id = format!("{index:032x}");
            }
        }
        Ok(script)
    }

    pub fn resolve_shot(&self, mut link: ShotLink) -> Result<ShotLink> {
        link.label = self
            .shot_labels(&link.script_id)?
            .remove(&link.scene_id)
            .ok_or("所选分镜已移除。")?;
        Ok(link)
    }
    pub fn shot_labels(&self, id: &str) -> Result<BTreeMap<String, String>> {
        let story = self.script(id)?.story;
        Ok(story
            .scenes
            .into_iter()
            .enumerate()
            .map(|(i, s)| (s.id, format!("{} · 第 {} 镜", story.title, i + 1)))
            .collect())
    }

    pub fn set_final(
        &self,
        script_id: &str,
        scene_id: &str,
        media: &str,
        job_id: Option<&str>,
    ) -> Result<Script> {
        let _guard = self.gate.lock().unwrap();
        let mut script = self.script(script_id)?;
        if !matches!(media, "image" | "video")
            || !script.story.scenes.iter().any(|s| s.id == scene_id)
        {
            return Err("所选分镜或媒体类型无效。".into());
        }
        let finals = script.finals.entry(scene_id.into()).or_default();
        if let Some(id) = job_id {
            let job = self.job(id)?;
            if job.status != "done"
                || crate::domain::kind(&job.protocol_id) != media
                || !job
                    .shot
                    .as_ref()
                    .is_some_and(|r| r.script_id == script_id && r.scene_id == scene_id)
            {
                return Err("请从这个分镜中选择已完成的作品。".into());
            }
            self.original(&job)?;
            finals.insert(media.into(), id.into());
        } else {
            finals.remove(media);
        }
        self.save_script(&script)?;
        Ok(script)
    }

    pub fn scripts(&self) -> Result<Vec<Script>> {
        let dir = self.home.join("剧本");
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.to_string()),
        };
        let mut list = Vec::new();
        for entry in entries {
            let file = entry.map_err(|e| e.to_string())?.path();
            if file.extension().is_some_and(|s| s == "json") {
                list.push(
                    self.script(
                        file.file_stem()
                            .and_then(|s| s.to_str())
                            .ok_or("剧本文件名无效。")?,
                    )?,
                );
            }
        }
        list.sort_by_key(|s| std::cmp::Reverse(s.created));
        Ok(list)
    }

    pub fn save_script(&self, script: &Script) -> Result<()> {
        script.story.validate()?;
        if !valid_id(&script.id) {
            return Err("剧本编号无效。".into());
        }
        let dir = self.home.join("剧本");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        save(&dir.join(format!("{}.json", script.id)), script)
    }

    pub fn edit_script(&self, id: &str, mut story: Screenplay) -> Result<Script> {
        if !valid_id(id) {
            return Err("剧本编号无效。".into());
        }
        let _lock = self.gate.lock().unwrap();
        let mut script = self.script(id)?;
        let mut ids = HashSet::new();
        for (index, scene) in story.scenes.iter_mut().enumerate() {
            if scene.id.is_empty() {
                scene.id = script
                    .story
                    .scenes
                    .get(index)
                    .map(|s| s.id.clone())
                    .unwrap_or_else(crate::domain::id);
            }
            if !valid_id(&scene.id) || !ids.insert(scene.id.clone()) {
                return Err("分镜编号无效或重复。".into());
            }
        }
        script.finals.retain(|key, _| ids.contains(key));
        script.story = story;
        self.save_script(&script)?;
        Ok(script)
    }
}
