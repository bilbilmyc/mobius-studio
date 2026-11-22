use crate::{
    domain::{route, Result},
    generation::jobs::Studio,
    providers::provider::json_response,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
    System,
    User,
    Assistant,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Message {
    pub role: Role,
    pub content: String,
}

#[derive(Deserialize)]
pub(crate) struct WriterTarget {
    pub base: String,
    pub model: String,
}

impl Studio {
    pub(crate) async fn writer_completion(
        &self,
        system: &str,
        user: &str,
        json_object: bool,
    ) -> Result<(String, Value)> {
        self.writer_messages(
            &[
                Message {
                    role: Role::System,
                    content: system.into(),
                },
                Message {
                    role: Role::User,
                    content: user.into(),
                },
            ],
            json_object,
            None,
        )
        .await
    }

    pub(crate) async fn writer_messages(
        &self,
        messages: &[Message],
        json_object: bool,
        target: Option<&WriterTarget>,
    ) -> Result<(String, Value)> {
        let writer = self.store.preferences()?.writer;
        if target.is_some_and(|t| t.base != writer.base_url || t.model != writer.model) {
            return Err("文本模型连接已更换，请用当前连接重新发送。".into());
        }
        let key = self.store.vault.get(&writer, &writer.base_url)?;
        if key.is_empty() {
            return Err("请在设置的「剧本模型」中填写 API Key。".into());
        }
        let mut body = json!({ "model": writer.model, "stream": false, "messages": messages });
        if json_object {
            body["response_format"] = json!({"type":"json_object"});
        }
        let request = self
            .http
            .post(route(&writer.base_url, "chat/completions")?)
            .bearer_auth(&key)
            .json(&body);
        let request = if target.is_some() {
            request.timeout(std::time::Duration::from_secs(90))
        } else {
            request
        };
        let reply = json_response(request, &key).await.map_err(|e| e.message)?;
        Ok((writer.model, reply))
    }
}

pub(super) fn completion_text(reply: &Value) -> Result<String> {
    let choice = &reply["choices"][0];
    if choice["finish_reason"] == "length" {
        return Err("文本模型回复被截断，请缩短输入后重试。".into());
    }
    if choice["finish_reason"] == "content_filter"
        || choice["message"]["refusal"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err("文本模型未提供这段提示词的回复。".into());
    }
    let text = match &choice["message"]["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let text = text.trim();
    if text.is_empty() {
        return Err("文本模型没有返回正文，请重试。".into());
    }
    Ok(text.to_owned())
}
