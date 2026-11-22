use super::{
    optimizer::PromptResult,
    provider::{completion_text, Message, WriterTarget},
};
use crate::{
    domain::{valid_id, Result},
    generation::jobs::Studio,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Tool {
    ReadShot,
    ReadReferences,
    FindTemplates,
    RecallDrafts,
}

impl Tool {
    fn definition(self) -> Value {
        let (description, search) = match self {
            Self::ReadShot => ("读取当前分镜的场景、动作、台词以及相邻镜头标题", false),
            Self::ReadReferences => ("读取本镜参考素材的数量、类型及首尾帧角色", false),
            Self::FindTemplates => ("用简短关键词查找适合当前创作的可复用提示词模板", true),
            Self::RecallDrafts => ("用作品细节或关键词找回本段对话较早的历史提示词草稿", true),
        };
        let schema = if search {
            json!({"type":"object","properties":{"query":{"type":"string","description":"要查找的简短关键词"}},"required":["query"],"additionalProperties":false})
        } else {
            json!({"type":"object","properties":{},"additionalProperties":false})
        };
        json!({"type":"function","function":{"name":self,"description":description,"parameters":schema}})
    }
}

#[derive(Deserialize)]
pub(crate) struct Observation {
    id: String,
    content: String,
}
#[derive(Deserialize)]
pub(crate) struct Step {
    pub id: String,
    pub native: bool,
    pub tools: Vec<Tool>,
    #[serde(default)]
    observations: Vec<Observation>,
}
#[derive(Serialize)]
pub(crate) struct Call {
    id: String,
    name: Tool,
    arguments: Value,
}
#[derive(Serialize)]
pub(crate) struct StepResult {
    #[serde(flatten)]
    pub result: PromptResult,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<Call>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unsupported: bool,
}

struct Conversation {
    target: WriterTarget,
    touched: Instant,
    count: u8,
    stop: Option<oneshot::Sender<()>>,
    previous: Vec<Value>,
    ids: Vec<String>,
}
#[derive(Default)]
pub(crate) struct Runs(Mutex<HashMap<String, Conversation>>);

impl Runs {
    pub(crate) fn close(&self, id: &str) {
        if let Some(mut run) = self.0.lock().unwrap().remove(id) {
            if let Some(stop) = run.stop.take() {
                let _ = stop.send(());
            }
        }
    }
    fn begin(
        &self,
        step: &Step,
        target: &WriterTarget,
        messages: &[Message],
    ) -> Result<(Vec<Value>, oneshot::Receiver<()>)> {
        if !valid_id(&step.id)
            || step.tools.len() > 4
            || step.tools.iter().collect::<HashSet<_>>().len() != step.tools.len()
        {
            return Err("改稿工具列表无效。".into());
        }
        let mut runs = self.0.lock().unwrap();
        runs.retain(|_, r| r.touched.elapsed() < Duration::from_secs(240));
        if !runs.contains_key(&step.id) && runs.len() >= 24 {
            return Err("正在进行的改稿太多，请稍后再试。".into());
        }
        let run = runs.entry(step.id.clone()).or_insert_with(|| Conversation {
            target: target.clone(),
            touched: Instant::now(),
            count: 0,
            stop: None,
            previous: vec![],
            ids: vec![],
        });
        if run.target != *target || run.stop.is_some() || run.count >= 4 {
            return Err("本轮改稿已达到上限或连接已变更。".into());
        }
        if run.ids.iter().ne(step.observations.iter().map(|o| &o.id))
            || step.observations.iter().any(|o| o.content.len() > 65000)
        {
            return Err("工具结果与本轮请求不一致。".into());
        }
        let mut wire = if run.ids.is_empty() {
            messages.iter().map(|m| json!(m)).collect()
        } else {
            std::mem::take(&mut run.previous)
        };
        for result in &step.observations {
            wire.push(json!({"role":"tool","tool_call_id":result.id,"content":result.content}));
        }
        run.ids.clear();
        run.count += 1;
        run.touched = Instant::now();
        let (tx, rx) = oneshot::channel();
        run.stop = Some(tx);
        Ok((wire, rx))
    }

    pub(super) async fn exchange(
        &self,
        studio: &Studio,
        target: &WriterTarget,
        messages: &[Message],
        step: Step,
    ) -> Result<StepResult> {
        let (mut wire, stop) = self.begin(&step, target, messages)?;
        let mut body = json!({"messages":wire,"response_format":{"type":"json_object"}});
        if step.native && !step.tools.is_empty() {
            body["tools"] = Value::Array(step.tools.iter().map(|t| t.definition()).collect());
        }
        let response = tokio::select! {result=studio.writer_request(body,Some(target))=>result,_=stop=>return Err("本轮改稿已停止。".into())};
        let mut runs = self.0.lock().unwrap();
        let run = runs.get_mut(&step.id).ok_or("本轮改稿已停止。")?;
        run.stop.take();
        let reply = match response {
            Ok((_, reply)) => reply,
            Err(e)
                if step.native
                    && !step.tools.is_empty()
                    && run.count == 1
                    && unsupported_tools(&e) =>
            {
                return Ok(StepResult {
                    result: PromptResult {
                        model: target.model.clone(),
                        text: String::new(),
                    },
                    calls: vec![],
                    unsupported: true,
                })
            }
            Err(e) => return Err(e),
        };
        let choice = &reply["choices"][0];
        let message = &choice["message"];
        let raw = message["tool_calls"]
            .as_array()
            .filter(|calls| !calls.is_empty());
        if let Some(raw) = raw {
            if !step.native
                || raw.len() > step.tools.len()
                || !matches!(
                    choice["finish_reason"].as_str(),
                    Some("tool_calls" | "stop")
                )
            {
                return Err("模型返回了未完成或不可用的工具调用。".into());
            }
            let mut calls = vec![];
            let mut names = HashSet::new();
            let mut ids = HashSet::new();
            for tool in raw {
                let name: Tool = serde_json::from_value(tool["function"]["name"].clone())
                    .map_err(|_| "模型请求了未知工具。")?;
                let id = tool["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                    .ok_or("工具调用编号无效。")?;
                let args = tool["function"]["arguments"]
                    .as_str()
                    .filter(|a| a.len() <= 2048)
                    .ok_or("工具参数无效。")?;
                if tool["type"] != "function"
                    || !step.tools.contains(&name)
                    || !names.insert(name)
                    || !ids.insert(id)
                {
                    return Err("模型请求了不可用或重复的工具。".into());
                }
                calls.push(Call {
                    id: id.into(),
                    name,
                    arguments: serde_json::from_str(args).map_err(|_| "工具参数不是有效 JSON。")?,
                });
            }
            let mut assistant =
                json!({"role":"assistant","content":message["content"],"tool_calls":raw});
            // Some reasoning providers require their opaque continuation on the next tool response.
            if let Some(value) = message["reasoning_content"].as_str() {
                assistant["reasoning_content"] = json!(value);
            }
            wire.push(assistant);
            run.previous = wire;
            run.ids = calls.iter().map(|c| c.id.clone()).collect();
            Ok(StepResult {
                result: PromptResult {
                    model: target.model.clone(),
                    text: String::new(),
                },
                calls,
                unsupported: false,
            })
        } else {
            Ok(StepResult {
                result: PromptResult {
                    model: target.model.clone(),
                    text: completion_text(&reply)?,
                },
                calls: vec![],
                unsupported: false,
            })
        }
    }
}

fn unsupported_tools(error: &str) -> bool {
    let e = error.to_lowercase();
    (e.contains("http 400") || e.contains("http 422"))
        && e.contains("tool")
        && [
            "unsupported",
            "not support",
            "doesn't support",
            "not allowed",
            "mutually exclusive",
            "cannot be used together",
            "cannot be combined",
            "unknown parameter",
            "unrecognized",
            "不支持",
        ]
        .iter()
        .any(|s| e.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_inflight_step_per_run_and_close_aborts_the_transport() {
        let runs = Runs::default();
        let step = Step {
            id: crate::domain::id(),
            native: true,
            tools: vec![Tool::FindTemplates],
            observations: vec![],
        };
        let target = WriterTarget {
            base: "https://writer.invalid".into(),
            model: "text".into(),
        };
        let (_, stopped) = runs.begin(&step, &target, &[]).unwrap();
        assert!(runs.begin(&step, &target, &[]).is_err());
        runs.close(&step.id);
        stopped.await.unwrap();
        assert!(runs.0.lock().unwrap().is_empty());
    }

    #[test]
    fn only_explicit_protocol_rejections_can_trigger_json_fallback() {
        assert!(unsupported_tools(
            "HTTP 400 This endpoint does not support tools"
        ));
        assert!(unsupported_tools("HTTP 422 unknown parameter: tools"));
        assert!(!unsupported_tools("HTTP 429 insufficient_quota tools"));
        assert!(!unsupported_tools("HTTP 401 unsupported tools"));
        assert!(!unsupported_tools("HTTP 400 invalid function arguments"));
    }
}
