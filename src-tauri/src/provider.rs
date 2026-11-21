use crate::{model::*, store::mime};

use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tokio_util::io::ReaderStream;

#[derive(Debug)]
pub struct Fault {
    pub message: String,
    pub definite: bool,
    // Only read-only status queries use this. Zero allows the client's normal backoff.
    pub poll_retry_after: Option<Duration>,
}
impl Fault {
    pub fn uncertain(s: impl ToString) -> Self {
        Self {
            message: s.to_string(),
            definite: false,
            poll_retry_after: None,
        }
    }
    pub fn known(s: impl ToString) -> Self {
        Self {
            message: s.to_string(),
            definite: true,
            poll_retry_after: None,
        }
    }
    pub(crate) fn transport(error: reqwest::Error) -> Self {
        let transient =
            error.is_timeout() || error.is_connect() || error.is_body() || error.is_request();
        let reason = if error.is_timeout() {
            "等待服务响应超时"
        } else if error.is_connect() {
            "无法连接服务"
        } else {
            "服务连接中断"
        };
        Self {
            poll_retry_after: transient.then_some(Duration::ZERO),
            ..Self::uncertain(format!("{reason}。{}", error.without_url()))
        }
    }
}
impl From<String> for Fault {
    fn from(v: String) -> Self {
        Self::known(v)
    }
}
pub type Reply<T> = std::result::Result<T, Fault>;
pub(crate) const POLL_TIMEOUT: Duration = Duration::from_secs(30);

fn poll_retry_after(status: i64, hint: Option<&str>) -> Option<Duration> {
    if !matches!(status, 408 | 429 | 500 | 502 | 503 | 504) {
        return None;
    }
    let delay = hint.and_then(|value| {
        let value = value.trim();
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(Duration::from_secs(seconds));
        }
        let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        Some(
            (at.to_utc() - chrono::Utc::now())
                .to_std()
                .unwrap_or_default(),
        )
    });
    Some(delay.unwrap_or_default())
}
pub fn client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| e.to_string())
}
#[derive(serde::Serialize, serde::Deserialize)]
pub enum Output {
    Many(Vec<Output>),
    Ticket(String),
    Pending(String),
    Url(String),
    Inline(String),
    Failed(String),
}
pub fn protect_text(s: &str, key: &str) -> String {
    let text = if key.is_empty() {
        s.to_owned()
    } else {
        s.replace(key, "[Key 已隐藏]")
    };
    text.split_whitespace()
        .map(|w| if w.contains("://") { "[地址]" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}
fn field<'a>(data: &'a Value, path: &str) -> Option<&'a Value> {
    if path.trim().is_empty() {
        return None;
    }
    path.trim()
        .trim_start_matches("$.")
        .split('.')
        .try_fold(data, |v, k| {
            if v.is_array() {
                v.get(k.parse::<usize>().ok()?)
            } else {
                v.get(k)
            }
        })
}
fn text(data: &Value, path: &str) -> Option<String> {
    match field(data, path)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
pub(crate) fn auth(r: RequestBuilder, scheme: &str, key: &str) -> RequestBuilder {
    if key.is_empty() {
        return r;
    }
    match scheme {
        "x-auth-token" => r.header("X-Auth-Token", key),
        "x-api-key" => r.header("X-API-Key", key),
        "x-goog-api-key" => r.header("x-goog-api-key", key),
        "api-key" => r.header("api-key", key),
        "token" => r.header("Authorization", format!("Token {key}")),
        "none" => r,
        _ => r.bearer_auth(key),
    }
}
pub(crate) async fn json_response(request: RequestBuilder, key: &str) -> Reply<Value> {
    let reply = request.send().await.map_err(Fault::transport)?;
    response_json(reply, key)
        .await?
        .ok_or_else(|| Fault::uncertain("服务返回的内容不是 JSON，请核对地址和协议。"))
}
pub(crate) async fn response_json(reply: reqwest::Response, key: &str) -> Reply<Option<Value>> {
    let status = reply.status();
    let retry = poll_retry_after(
        i64::from(status.as_u16()),
        reply
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
    );
    let body = reply.bytes().await;
    if !status.is_success() {
        let v = body
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let msg = text(&v, "error.message")
            .or_else(|| text(&v, "message"))
            .or_else(|| text(&v, "msg"))
            .unwrap_or_default();
        let code = text(&v, "error.code")
            .or_else(|| text(&v, "code"))
            .or_else(|| text(&v, "error.type"))
            .unwrap_or_default();
        let detail = protect_text(&format!("{code} {msg}"), key);
        let billing = matches!(
            code.to_ascii_lowercase().as_str(),
            "insufficient_quota" | "insufficient_balance" | "billing_hard_limit_reached"
        );
        return Err(Fault {
            message: format!("HTTP {} {detail}", status.as_u16()),
            definite: status.is_client_error() && !matches!(status.as_u16(), 408 | 409 | 499),
            poll_retry_after: if billing { None } else { retry },
        });
    }
    Ok(serde_json::from_slice(&body.map_err(Fault::transport)?).ok())
}
pub(crate) fn envelope(v: Value, key: &str) -> Reply<Value> {
    let code = text(&v, "code")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(-1);
    if code == 200 || code == 0 {
        Ok(v["data"].clone())
    } else {
        Err(Fault {
            message: format!("官网返回 {code} {}", protect_text(string(&v["msg"]), key)),
            definite: (400..500).contains(&code) && !matches!(code, 408 | 409 | 499),
            poll_retry_after: poll_retry_after(code, None),
        })
    }
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
pub async fn upload(h: &Client, j: &Job, key: &str, a: &Asset, path: &Path) -> Reply<String> {
    let (_, mime) = mime(path).ok_or_else(|| Fault::known("素材类型无效"))?;
    let presign = auth(
        h.post(route(&j.base_url, "upload/presign")?),
        "x-auth-token",
        key,
    )
    .json(&json!({"filename":a.name,"content_type":mime}));
    let v = envelope(json_response(presign, key).await?, key)?;
    let dest =
        url::Url::parse(string(&v["upload_url"])).map_err(|_| Fault::known("官网上传地址无效"))?;
    if dest.scheme() != "https"
        && !(dest.scheme() == "http"
            && dest.host_str() == Some("127.0.0.1")
            && url::Url::parse(&j.base_url)
                .ok()
                .and_then(|s| s.host_str().map(str::to_owned))
                .as_deref()
                == Some("127.0.0.1"))
    {
        return Err(Fault::known("上传地址须使用 HTTPS"));
    }
    let f = tokio::fs::File::open(path).await.map_err(Fault::known)?;
    let size = f.metadata().await.map_err(Fault::known)?.len();
    let mut put = h
        .put(dest)
        .header(
            "Content-Type",
            v["required_headers"]["Content-Type"]
                .as_str()
                .unwrap_or(mime),
        )
        .header("Content-Length", size);
    if let Some(headers) = v["required_headers"].as_object() {
        for (k, x) in headers {
            let n = k.to_lowercase();
            if n != "content-type" && n != "content-length" {
                if !n.starts_with("x-cos-") && !n.starts_with("content-") {
                    return Err(Fault::known("不支持的上传签名头"));
                }
                put = put.header(k, string(x));
            }
        }
    }
    let response = put
        .body(reqwest::Body::wrap_stream(ReaderStream::new(f)))
        .send()
        .await
        .map_err(|e| Fault::known(e.without_url()))?;
    if !response.status().is_success() {
        return Err(Fault::known(format!(
            "素材上传返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    text(&v, "path").ok_or_else(|| Fault::known("未收到素材路径"))
}
pub async fn submit(
    h: &Client,
    j: &Job,
    key: &str,
    uploads: Value,
    inputs: &[crate::inputs::Input],
) -> Reply<Output> {
    let post = |path: &str| route(&j.base_url, path).map(|u| h.post(u));
    let proto = j.protocol_id.as_str();
    if proto == "comfy-image" {
        return crate::comfy::submit(h, j, key, inputs).await;
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
        let (submit, _, _) = crate::creation::workflow(r, mode);
        let request = crate::inputs::mapped(
            auth(
                post(&submit.replace("{model}", &encoded(&j.model)))?,
                &r.auth,
                key,
            ),
            j,
            inputs,
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
        let mut form = reqwest::multipart::Form::new()
            .text("model", j.model.clone())
            .text("prompt", j.prompt.clone())
            .text("size", j.size.clone())
            .text("seconds", j.seconds.to_string());
        if let Some(image) = inputs.first() {
            form = form.part("input_reference", image.part().await?);
        }
        let v = json_response(auth(post("videos")?, "bearer", key).multipart(form), key).await?;
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
        let req = if inputs.is_empty() {
            post("images/generations")?.json(&payload)
        } else if inputs.iter().any(|a| a.is_link()) {
            let mut images = vec![];
            for a in inputs {
                images.push(json!({"image_url":a.url().await?}));
            }
            payload["images"] = json!(images);
            post("images/edits")?.json(&payload)
        } else {
            let mut form = reqwest::multipart::Form::new();
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
                form = form.part(
                    if a.kind == "mask" { "mask" } else { field },
                    a.part().await?,
                );
            }
            post("images/edits")?.multipart(form)
        };
        let v = json_response(auth(req, "bearer", key), key).await?;
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
        return crate::comfy::query(h, j, key, &id).await;
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
pub async fn download(h: &Client, j: &Job, raw: &str, key: &str) -> Reply<reqwest::Response> {
    let mut dest = url::Url::parse(raw)
        .or_else(|_| url::Url::parse(&(j.base_url.clone() + "/"))?.join(raw))
        .map_err(Fault::known)?;
    for hop in 0..=5 {
        if !matches!(dest.scheme(), "https" | "http")
            || !dest.username().is_empty()
            || dest.password().is_some()
        {
            return Err(Fault::known("结果地址无效"));
        }
        let mut req = h.get(dest.clone());
        if hop == 0
            && j.protocol_id == "comfy-image"
            && route(&j.base_url, "view")
                .is_ok_and(|u| u.origin() == dest.origin() && u.path() == dest.path())
        {
            req = auth(req, "bearer", key);
        }
        if hop == 0
            && j.protocol_id == "openai-video"
            && content_url(j).is_ok_and(|url| url == dest)
        {
            req = auth(req, "bearer", key);
        }
        let reply = req.send().await.map_err(Fault::transport)?;
        if reply.status().is_redirection() {
            let loc = reply
                .headers()
                .get("location")
                .and_then(|s| s.to_str().ok())
                .ok_or_else(|| Fault::known("重定向缺少地址"))?;
            dest = dest.join(loc).map_err(Fault::known)?;
            continue;
        }
        if !reply.status().is_success() {
            return Err(Fault::known(format!(
                "下载返回 HTTP {}",
                reply.status().as_u16()
            )));
        }
        return Ok(reply);
    }
    Err(Fault::known("结果重定向过多"))
}
