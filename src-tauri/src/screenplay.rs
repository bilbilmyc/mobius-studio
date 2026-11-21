use crate::{
    jobs::Studio,
    model::{id, route, valid_id, Result},
    provider::json_response,
    store::{read, save, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    heading: String,
    action: String,
    #[serde(default)]
    dialogue: String,
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
    pub id: String,
    pub created: i64,
    pub model: String,
    pub brief: String,
    #[serde(flatten)]
    pub story: Screenplay,
}

impl Screenplay {
    fn validate(&self) -> Result<()> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 200
            || !(1..=12).contains(&self.scenes.len())
        {
            return Err("剧本需要标题和 1 到 12 个分镜。".into());
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
                list.push(read::<Script>(&file)?);
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

    pub fn edit_script(&self, id: &str, story: Screenplay) -> Result<Script> {
        if !valid_id(id) {
            return Err("剧本编号无效。".into());
        }
        let _lock = self.gate.lock().unwrap();
        let mut script: Script = read(&self.home.join("剧本").join(format!("{id}.json")))?;
        script.story = story;
        self.save_script(&script)?;
        Ok(script)
    }
}

impl Studio {
    pub async fn generate_script(&self, brief: String, count: usize) -> Result<Script> {
        let brief = brief.trim();
        if brief.is_empty() || brief.chars().count() > 12000 || !(1..=12).contains(&count) {
            return Err("请填写 1 至 12000 字的故事构想，并选择 1 至 12 个分镜。".into());
        }
        let writer = self.store.preferences()?.writer;
        let key = self.store.vault.get(&writer, &writer.base_url)?;
        if key.is_empty() {
            return Err("请在设置的「剧本模型」中填写 API Key。".into());
        }
        let system = concat!(
            "你是影视编剧。根据用户构想写中文分镜剧本。返回单个 JSON 对象，结构为 ",
            r#"{"title":"片名","scenes":[{"heading":"内景或外景、地点、时间","action":"画面与动作","dialogue":"台词或旁白，无则空字符串","imagePrompt":"独立可用的画面提示词","videoPrompt":"独立可用的运镜和动作提示词"}]}。"#,
            "各镜头的人物、服装和美术设定应保持连贯。"
        );
        let request = self
            .http
            .post(route(&writer.base_url, "chat/completions")?)
            .bearer_auth(&key)
            .json(
                &json!({"model":writer.model, "response_format":{"type":"json_object"},
                "messages":[{"role":"system","content":system},
                {"role":"user","content":format!("请写 {count} 个分镜。\n\n{brief}")}],
                "stream":false}),
            );
        let reply = json_response(request, &key).await.map_err(|e| e.message)?;
        let choice = &reply["choices"][0];
        if choice["finish_reason"] == "length" {
            return Err("生成内容被截断，请减少分镜数后重试。".into());
        }
        let content = choice["message"]["content"]
            .as_str()
            .ok_or("剧本模型没有返回正文。")?;
        let story: Screenplay = serde_json::from_str(content.trim())
            .map_err(|_| "剧本模型返回的分镜格式不完整，请重试。")?;
        if story.scenes.len() != count {
            return Err(format!(
                "模型返回了 {} 个分镜，预期 {count} 个，请重试。",
                story.scenes.len()
            ));
        }
        let script = Script {
            id: id(),
            created: chrono::Utc::now().timestamp_millis(),
            model: writer.model,
            brief: brief.into(),
            story,
        };
        self.store.save_script(&script)?;
        Ok(script)
    }
}
