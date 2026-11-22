use super::provider::{WriterRequest, WriterTarget};
use crate::{
    diagnostics,
    domain::{id, valid_id, Result},
    generation::jobs::Studio,
    projects::screenplay::{Screenplay, Script},
    storage::{
        files::{read, save},
        store::Store,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RunStatus {
    Writing,
    Done,
    Failed,
    Interrupted,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct ScriptRun {
    pub id: String,
    pub created: i64,
    pub brief: String,
    pub count: usize,
    pub model: String,
    pub service: String,
    pub status: RunStatus,
    pub title: String,
    pub error: String,
}

impl ScriptRun {
    fn save(&self, store: &Store) -> Result<()> {
        let dir = store.home.join("剧本任务");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        save(&dir.join(format!("{}.json", self.id)), self)
    }

    fn save_reply(&self, store: &Store, reply: Value) -> Result<Script> {
        let choice = &reply["choices"][0];
        if choice["finish_reason"] == "length" {
            return Err("生成内容被截断，请减少分镜数后重试。".into());
        }
        let content = choice["message"]["content"]
            .as_str()
            .ok_or("剧本模型没有返回正文。")?;
        let mut story: Screenplay = serde_json::from_str(content.trim())
            .map_err(|_| "剧本模型返回的分镜格式不完整，请重试。")?;
        if story.scenes.len() != self.count {
            return Err(format!(
                "模型返回了 {} 个分镜，预期 {} 个，请重试。",
                story.scenes.len(),
                self.count
            ));
        }
        for scene in &mut story.scenes {
            scene.id = id();
        }
        let script = Script {
            id: self.id.clone(),
            created: self.created,
            model: self.model.clone(),
            brief: self.brief.clone(),
            finals: Default::default(),
            story,
        };
        store.save_script(&script)?;
        Ok(script)
    }
}

#[derive(Default)]
pub(crate) struct ScriptRuns(Mutex<HashMap<String, ScriptRun>>);

impl ScriptRuns {
    pub(crate) fn load(store: &Store) -> Result<Self> {
        let runs = Self::default();
        let entries = match fs::read_dir(store.home.join("剧本任务")) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(runs),
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let mut run: ScriptRun = match read::<ScriptRun>(&path) {
                Ok(record)
                    if valid_id(&record.id)
                        && path.file_stem().and_then(|s| s.to_str()) == Some(&record.id) =>
                {
                    record
                }
                _ => {
                    diagnostics::failure("script-run-read", "剧本任务文件无效");
                    continue;
                }
            };
            if run.status == RunStatus::Writing {
                // The result may already have reached disk before the process exited.
                if let Ok(script) = store.script(&run.id) {
                    run.status = RunStatus::Done;
                    run.title = script.story.title;
                } else {
                    run.status = RunStatus::Interrupted;
                    run.error =
                        "应用退出时尚未保存这份剧本。可向服务商核对请求记录，或取回构想继续编辑。"
                            .into();
                }
                if let Err(e) = run.save(store) {
                    diagnostics::failure("script-run-recover", &e);
                }
            }
            runs.remember(run);
        }
        Ok(runs)
    }

    fn remember(&self, run: ScriptRun) {
        self.0.lock().unwrap().insert(run.id.clone(), run);
    }

    pub(crate) fn list(&self) -> Vec<ScriptRun> {
        let mut runs: Vec<_> = self.0.lock().unwrap().values().cloned().collect();
        runs.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
        runs
    }
}

impl Studio {
    fn prepare_script(
        &self,
        brief: &str,
        count: usize,
        target: Option<&WriterTarget>,
    ) -> Result<(ScriptRun, WriterRequest)> {
        let brief = brief.trim();
        if brief.is_empty() || brief.chars().count() > 12000 || !(1..=12).contains(&count) {
            return Err("请填写 1 至 12000 字的故事构想，并选择 1 至 12 个分镜。".into());
        }
        let system = concat!(
            "你是影视编剧。根据用户构想写中文分镜剧本。返回单个 JSON 对象，结构为 ",
            r#"{"title":"片名","scenes":[{"heading":"内景或外景、地点、时间","action":"画面与动作","dialogue":"台词或旁白，无则空字符串","imagePrompt":"独立可用的画面提示词","videoPrompt":"独立可用的运镜和动作提示词"}]}。"#,
            "各镜头的人物、服装和美术设定应保持连贯。"
        );
        let request = self.prepare_writer_request(json!({
            "messages": [{"role":"system","content":system}, {"role":"user","content":format!("请写 {count} 个分镜。\n\n{brief}")}],
            "response_format": {"type":"json_object"},
        }), target)?;
        let run = ScriptRun {
            id: id(),
            created: chrono::Utc::now().timestamp_millis(),
            brief: brief.into(),
            count,
            model: request.model.clone(),
            service: request.service.clone(),
            status: RunStatus::Writing,
            title: String::new(),
            error: String::new(),
        };
        run.save(&self.store)?;
        self.script_runs.remember(run.clone());
        self.changed();
        Ok((run, request))
    }

    async fn write_script(&self, mut run: ScriptRun, request: WriterRequest) -> Result<Script> {
        let result = request
            .send()
            .await
            .and_then(|(_, reply)| run.save_reply(&self.store, reply));
        match &result {
            Ok(script) => {
                run.status = RunStatus::Done;
                run.title.clone_from(&script.story.title);
            }
            Err(e) => {
                run.status = RunStatus::Failed;
                run.error.clone_from(e);
                diagnostics::failure("script-generation", e);
            }
        }
        if let Err(e) = run.save(&self.store) {
            diagnostics::failure("script-run-save", &e);
        }
        self.script_runs.remember(run);
        self.changed();
        result
    }

    pub async fn generate_script(&self, brief: String, count: usize) -> Result<Script> {
        let (run, request) = self.prepare_script(&brief, count, None)?;
        self.write_script(run, request).await
    }

    pub(crate) fn start_script_run(
        self: &Arc<Self>,
        brief: String,
        count: usize,
        target: &WriterTarget,
    ) -> Result<ScriptRun> {
        let (run, request) = self.prepare_script(&brief, count, Some(target))?;
        let studio = self.clone();
        let task = run.clone();
        tauri::async_runtime::spawn(async move {
            let _ = studio.write_script(task, request).await;
        });
        Ok(run)
    }
}
