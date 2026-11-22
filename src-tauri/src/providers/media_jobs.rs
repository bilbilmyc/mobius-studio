use super::http::{auth, envelope, json_response, protect_text, text, Fault, Reply, POLL_TIMEOUT};
use crate::domain::*;
use reqwest::Client;
use serde_json::{json, Value};
#[derive(serde::Serialize, serde::Deserialize)]
pub enum Output {
    Many(Vec<Output>),
    Ticket(String),
    Pending(String),
    Url(String),
    Inline(String),
    Failed(String),
}
fn ticket(v: &Value, path: &str) -> Reply<Output> {
    text(v, path)
        .map(Output::Ticket)
        .ok_or_else(|| Fault::uncertain("未收到任务编号，请先核对服务商记录。"))
}
fn encoded(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
fn media(v: &Value, url: &str, b64: &str) -> Option<Output> {
    text(v, b64)
        .map(Output::Inline)
        .or_else(|| text(v, url).map(Output::Url))
}
pub async fn submit(
    h: &Client,
    j: &Job,
    key: &str,
    uploads: Value,
    inputs: &[crate::providers::inputs::Input],
) -> Reply<Output> {
    let post = |path: &str| route(&j.base_url, path).map(|u| h.post(u));
    let proto = j.protocol_id.as_str();
    if proto == "comfy-image" {
        return crate::providers::comfy::submit(h, j, key, inputs).await;
    }
    if site(proto) {
        if key.is_empty() {
            return Err(Fault::known("请连接官网 Key。"));
        }
        let s = j
            .site_options
            .as_ref()
            .ok_or_else(|| Fault::known("缺少模板参数"))?;
        let mut body =
            json!({"template_key":j.model,"config_values":s.config,"priority":s.priority});
        if !j.prompt.is_empty() {
            body["extra_data"] = json!({"text":j.prompt})
        }
        if let Some(o) = uploads.as_object() {
            for (k, v) in o {
                body[format!("{k}_path")] = v.clone();
            }
        }
        let v = envelope(
            json_response(
                auth(post("tasks/create")?, "x-auth-token", key).json(&body),
                key,
            )
            .await?,
            key,
        )?;
        return ticket(&v, "task_id");
    }
    if custom(proto) {
        let r = j
            .relay
            .as_ref()
            .ok_or_else(|| Fault::known("缺少自定义映射"))?;
        let mode = j.settings.get("mode").and_then(Value::as_str).unwrap_or("");
        let (submit, _, _) = r.workflow(mode);
        let request = crate::providers::inputs::mapped(
            auth(
                post(&submit.replace("{model}", &encoded(&j.model)))?,
                &r.auth,
                key,
            ),
            j,
            inputs,
            key,
        )
        .await?;
        let v = json_response(request, key).await?;
        if let Some(out) = media(&v, &r.url, &r.base64) {
            return Ok(out);
        }
        if !r.poll.is_empty() {
            return ticket(&v, &r.id);
        }
        return Err(Fault::uncertain(format!(
            "响应缺少已配置的结果字段。{}",
            protect_text(&text(&v, &r.error).unwrap_or_default(), key)
        )));
    }
    if proto == "openai-video" {
        let mut form = crate::developer::Form::new(key)
            .text("model", j.model.clone())
            .text("prompt", j.prompt.clone())
            .text("size", j.size.clone())
            .text("seconds", j.seconds.to_string());
        if let Some(image) = inputs.first() {
            form = image.add_to_form(form, "input_reference").await?;
        }
        let v = json_response(form.attach(auth(post("videos")?, "bearer", key)), key).await?;
        return ticket(&v, "id");
    }
    let mode = j
        .settings
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or(if inputs.is_empty() {
            "t2v"
        } else {
            "first_frame"
        });
    let res = j
        .settings
        .get("resolution")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("720p");
    if proto == "openai-image" {
        let mut payload = json!({"model":j.model,"prompt":j.prompt,"size":j.size});
        if let Some(n) = j.native_count {
            payload["n"] = json!(n)
        }
        let quality = j
            .settings
            .get("quality")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(q) = quality {
            payload["quality"] = json!(q);
        }
        let (path, req) = if inputs.is_empty() {
            ("images/generations", None)
        } else if inputs.iter().any(|a| a.is_link()) {
            let mut images = vec![];
            for a in inputs {
                images.push(json!({"image_url":a.url().await?}));
            }
            payload["images"] = json!(images);
            ("images/edits", None)
        } else {
            let mut form = crate::developer::Form::new(key);
            for (k, v) in payload.as_object().unwrap() {
                form = form.text(
                    k.clone(),
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string()),
                )
            }
            let field = if inputs.iter().filter(|i| i.kind != "mask").count() == 1 {
                "image"
            } else {
                "image[]"
            };
            for a in inputs {
                form = a
                    .add_to_form(form, if a.kind == "mask" { "mask" } else { field })
                    .await?;
            }
            ("images/edits", Some(form))
        };
        let request = auth(post(path)?, "bearer", key);
        let request = match req {
            Some(form) => form.attach(request),
            None => request.json(&payload).into(),
        };
        let v = json_response(request, key).await?;
        if j.native_count.is_some() {
            let rows = v["data"]
                .as_array()
                .ok_or_else(|| Fault::uncertain("服务商未返回候选清单。"))?;
            return rows
                .iter()
                .map(|row| {
                    media(row, "url", "b64_json").ok_or_else(|| Fault::uncertain("候选缺少图片。"))
                })
                .collect::<Reply<Vec<_>>>()
                .map(Output::Many);
        }
        return media(&v, "data.0.url", "data.0.b64_json")
            .ok_or_else(|| Fault::uncertain("响应中没有图片，请核对中转站记录。"));
    }
    let (path, body) = match proto {
        "wan-image" => {
            let mut content = vec![];
            for a in inputs {
                content.push(json!({"image":a.url().await?}));
            }
            content.push(json!({"text":j.prompt}));
            (
                "services/aigc/image-generation/generation",
                json!({"model":j.model,"input":{"messages":[{"role":"user","content":content}]},"parameters":{"size":j.size.replace('x',"*"),"n":j.native_count.unwrap_or(1)}}),
            )
        }
        "wan-video" => (
            "services/aigc/video-generation/video-synthesis",
            json!({"model":j.model,"input":{"prompt":j.prompt},"parameters":{"size":j.size.replace('x',"*"),"duration":j.seconds}}),
        ),
        "wan-i2v-video" | "wan-frames-video" => {
            let mut input = json!({"prompt":j.prompt});
            let first = inputs
                .first()
                .ok_or_else(|| Fault::known("缺少首帧图片"))?
                .url()
                .await?;
            if proto == "wan-frames-video" {
                input["first_frame_url"] = json!(first);
                input["last_frame_url"] = json!(
                    inputs
                        .get(1)
                        .ok_or_else(|| Fault::known("缺少尾帧图片"))?
                        .url()
                        .await?
                );
            } else {
                input["img_url"] = json!(first);
            }
            (
                if proto == "wan-frames-video" {
                    "services/aigc/image2video/video-synthesis"
                } else {
                    "services/aigc/video-generation/video-synthesis"
                },
                json!({"model":j.model,"input":input,"parameters":{"resolution":res,"duration":j.seconds}}),
            )
        }
        "ark-video" => {
            let mut content = vec![json!({"type":"text","text":j.prompt})];
            for (i, a) in inputs.iter().enumerate() {
                let typ = format!("{}_url", a.kind);
                let role = if mode == "reference" {
                    format!("reference_{}", a.kind)
                } else if i == 0 {
                    "first_frame".into()
                } else {
                    "last_frame".into()
                };
                content.push(json!({"type":typ,typ.as_str():{"url":a.url().await?},"role":role}));
            }
            let ratio = if matches!(mode, "first_frame" | "first_last") {
                "adaptive"
            } else {
                &j.size
            };
            (
                "contents/generations/tasks",
                json!({"model":j.model,"content":content,"ratio":ratio,"duration":j.seconds,"resolution":res}),
            )
        }
        _ => return Err(Fault::known("未知生成协议")),
    };
    let mut r = auth(post(path)?, "bearer", key).json(&body);
    if proto.starts_with("wan-") {
        r = r.header("X-DashScope-Async", "enable")
    }
    let v = json_response(r, key).await?;
    ticket(
        &v,
        if proto == "ark-video" {
            "id"
        } else {
            "output.task_id"
        },
    )
}
pub fn content_url(j: &Job) -> Result<url::Url> {
    route(
        &j.base_url,
        &format!(
            "videos/{}/content",
            encoded(j.remote_id.as_deref().ok_or("缺少编号")?)
        ),
    )
}
pub async fn query(h: &Client, j: &Job, key: &str) -> Reply<Output> {
    let id = encoded(
        j.remote_id
            .as_deref()
            .ok_or_else(|| Fault::known("缺少任务编号"))?,
    );
    let proto = j.protocol_id.as_str();
    let r = j.relay.as_ref();
    if proto == "comfy-image" {
        return crate::providers::comfy::query(h, j, key, &id).await;
    }
    let path = if custom(proto) {
        r.ok_or_else(|| Fault::known("缺少接口映射"))?
            .poll
            .replace("{id}", &id)
            .replace("{model}", &encoded(&j.model))
    } else {
        format!(
            "{}/{}",
            match proto {
                "ark-video" => "contents/generations/tasks",
                "openai-video" => "videos",
                _ => "tasks",
            },
            id
        )
    };
    let raw = json_response(
        auth(
            h.get(route(&j.base_url, &path)?).timeout(POLL_TIMEOUT),
            if site(proto) {
                "none"
            } else {
                r.map(|v| v.auth.as_str()).unwrap_or("bearer")
            },
            key,
        ),
        key,
    )
    .await?;
    let v = if site(proto) {
        envelope(raw, key)?
    } else {
        raw
    };
    let state = text(
        &v,
        if let Some(r) = r {
            &r.state
        } else if proto.starts_with("wan-") {
            "output.task_status"
        } else {
            "status"
        },
    )
    .unwrap_or_default()
    .to_lowercase();
    let member = |s: &str| {
        s.split(',')
            .any(|x| !state.is_empty() && x.trim().eq_ignore_ascii_case(&state))
    };
    if member(
        r.map(|d| d.waiting.as_str())
            .unwrap_or("pending,preparing,queued,running,in_progress,processing"),
    ) {
        let detail = match state.as_str() {
            "queued" => "服务商已接收，正在排队",
            "running" | "in_progress" | "processing" => "服务商正在生成",
            "preparing" => "服务商正在准备任务",
            _ => "服务商已接收，等待处理",
        };
        let progress = v["progress"]
            .as_u64()
            .filter(|&p| proto == "openai-video" && p <= 100);
        return Ok(Output::Pending(match progress {
            Some(p) => format!("{detail}，服务进度 {p}%。"),
            None => format!("{detail}。"),
        }));
    }
    if member(
        r.map(|d| d.failure.as_str())
            .unwrap_or("failed,cancelled,canceled,expired"),
    ) {
        let msg = text(&v, r.map(|d| d.error.as_str()).unwrap_or("error.message"))
            .or_else(|| text(&v, "display_error_message"))
            .or_else(|| text(&v, "error_message"))
            .or_else(|| text(&v, "output.message"))
            .unwrap_or(state);
        let code = text(&v, "error.code")
            .or_else(|| text(&v, "output.code"))
            .unwrap_or_default();
        return Ok(Output::Failed(protect_text(&format!("{code} {msg}"), key)));
    }
    if !member(
        r.map(|d| d.success.as_str())
            .unwrap_or("completed,succeeded"),
    ) {
        return Err(Fault::known(format!(
            "无法识别服务商状态 {}",
            protect_text(&state, key)
        )));
    }
    if let Some(r) = r {
        return media(&v, &r.url, &r.base64).ok_or_else(|| Fault::known("完成响应缺少媒体字段"));
    }
    if proto == "openai-video" {
        return Ok(Output::Url(
            text(&v, "video_url")
                .or_else(|| text(&v, "url"))
                .unwrap_or(content_url(j)?.to_string()),
        ));
    }
    if proto == "wan-image" && j.native_count.is_some() {
        let rows = if let Some(items) = v.pointer("/output/results").and_then(Value::as_array) {
            items
                .iter()
                .filter_map(|r| text(r, "url"))
                .map(Output::Url)
                .collect()
        } else {
            v.pointer("/output/choices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| c.pointer("/message/content").and_then(Value::as_array))
                .flatten()
                .filter_map(|r| text(r, "image"))
                .map(Output::Url)
                .collect::<Vec<_>>()
        };
        return Ok(Output::Many(rows));
    }
    let path = if site(proto) {
        "result_oss_url"
    } else if proto == "ark-video" {
        "content.video_url"
    } else if proto.starts_with("wan-") && kind(proto) == "video" {
        "output.video_url"
    } else {
        "output.results.0.url"
    };
    text(&v, path)
        .or_else(|| {
            v.pointer("/output/choices/0/message/content")?
                .as_array()?
                .iter()
                .find_map(|part| text(part, "image"))
        })
        .map(Output::Url)
        .ok_or_else(|| Fault::known("服务商已完成，结果中缺少媒体地址。"))
}
