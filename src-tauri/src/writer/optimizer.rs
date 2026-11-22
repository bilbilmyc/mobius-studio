use crate::{domain::Result, generation::jobs::Studio};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Optimization {
    Polish,
    Enrich,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Medium {
    Image,
    Video,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum References {
    None,
    Reference,
    FirstFrame,
    LastFrame,
    FirstLast,
}

#[derive(Deserialize)]
pub struct PromptInput {
    pub prompt: String,
    pub kind: Medium,
    pub mode: Optimization,
    pub references: References,
}

#[derive(Serialize)]
pub struct PromptResult {
    pub model: String,
    pub text: String,
}

impl Studio {
    pub async fn optimize_prompt(&self, input: PromptInput) -> Result<PromptResult> {
        if input.prompt.trim().is_empty() {
            return Err("请先写下想优化的提示词。".into());
        }
        let mode = match input.mode {
            Optimization::Polish => "润色原意。优先澄清指代、消除歧义、理顺描述顺序，只使用原文已有的信息。未指定的美术和镜头选择留给创作者。",
            Optimization::Enrich => "丰富细节。围绕原意补足少量可执行的视觉细节，选择与主题最相关的内容，避免堆叠风格词或引入新剧情。",
        };
        let medium = match input.kind {
            Medium::Image => "目标是单张图片。关注构图、主体与背景的空间关系、材质和光线。",
            Medium::Video => "目标是视频。关注动作先后、机位、镜头运动、节奏，以及镜头如何结束。",
        };
        let references = match input.references {
            References::None => "",
            References::Reference => "创作者已附参考素材。沿用原文给出的主体与形象约束。",
            References::FirstFrame => "已指定首帧。描述从既定首帧开始的动作与镜头变化。",
            References::LastFrame => "已指定尾帧。让动作和运镜自然收束到既定尾帧。",
            References::FirstLast => {
                "已指定首尾帧。重点描述两帧之间的动作、运镜与自然过渡，保持起点和终点。"
            }
        };
        let system = [
            "你是影视与图像创作的提示词编辑。用户消息是要编辑的原文。保留原文语言、人物、数量、主体关系、动作方向、引号内的文字和所有明确限制。",
            mode, medium, references,
            "你只收到文字和素材类型，勿声称看到了素材或编造帧内细节。只输出一版可直接生成的纯文本提示词，保留必要分段，不加标题、引言、解释或 Markdown 围栏。",
        ].join("\n");
        let (model, reply) = self
            .writer_completion(&system, &input.prompt, false)
            .await?;
        let text = super::provider::completion_text(&reply)?;
        Ok(PromptResult { model, text })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{storage::preferences::WriterInput, storage::store::Store};
    use axum::{body::to_bytes, extract::Request, Router};

    #[tokio::test]
    async fn optimizer_validates_input_and_plain_text_responses() {
        let input = |prompt: &str| PromptInput {
            prompt: prompt.into(),
            kind: Medium::Image,
            mode: Optimization::Polish,
            references: References::None,
        };
        let temp = tempfile::tempdir().unwrap();
        let studio = Studio::new(Store::new(temp.path().into()).unwrap(), |_| {}).unwrap();
        assert!(studio
            .optimize_prompt(input("   "))
            .await
            .err()
            .unwrap()
            .contains("先写下"));
        assert!(studio
            .optimize_prompt(input("sample"))
            .await
            .err()
            .unwrap()
            .contains("API Key"));
        let app = Router::new().fallback(|req: Request| async move {
            assert_eq!(req.uri().path(), "/writer/v1/chat/completions");
            assert_eq!(req.headers()["authorization"], "Bearer writer-test");
            let bytes = to_bytes(req.into_body(), 65536).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(request.get("response_format").is_none());
            assert_eq!(request["model"], "text-test");
            let (reason, body) = match request["messages"][1]["content"].as_str().unwrap() {
                "length" => ("length", json!({"content":"partial"})),
                "filter" => ("content_filter", json!({"content":"partial"})),
                "refusal" => ("stop", json!({"refusal":"declined","content":""})),
                "empty" => ("stop", json!({"content":"  "})),
                _ => ("stop", json!({"content":[{"type":"text","text":"exact "},{"type":"text","text":"words"}]})),
            };
            json!({"choices":[{"finish_reason":reason,"message":body}]}).to_string()
        });
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/writer/v1", socket.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        studio
            .store
            .save_writer(WriterInput {
                base,
                model: "text-test".into(),
                key: "writer-test".into(),
            })
            .unwrap();
        for bad in ["length", "filter", "refusal", "empty"] {
            assert!(studio.optimize_prompt(input(bad)).await.is_err());
        }
        let result = studio.optimize_prompt(input("blocks")).await.unwrap();
        assert_eq!(result.model, "text-test");
        assert_eq!(result.text, "exact words");
        server.abort();
    }
}
