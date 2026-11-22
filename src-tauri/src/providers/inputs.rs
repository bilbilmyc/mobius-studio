use crate::{
    domain::{Asset, Job},
    generation::creation,
    media::formats::mime,
    providers::provider::{Fault, Reply},
    storage::store::Store,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use tokio_util::io::ReaderStream;

pub struct Input {
    pub kind: String,
    name: String,
    source: Source,
}
enum Source {
    Local(PathBuf),
    Link(String),
}
impl Input {
    pub fn local(kind: &str, name: String, path: PathBuf) -> Self {
        Self {
            kind: kind.into(),
            name,
            source: Source::Local(path),
        }
    }
    pub fn from_asset(store: &Store, a: &Asset) -> Result<Self, String> {
        if creation::remote(&a.path) {
            return Ok(Self {
                kind: a.kind.clone(),
                name: a.name.clone(),
                source: Source::Link(creation::public_source(&a.path)?),
            });
        }
        Ok(Self::local(&a.kind, a.name.clone(), store.input(&a.path)?))
    }
    pub fn is_link(&self) -> bool {
        matches!(self.source, Source::Link(_))
    }
    pub async fn url(&self) -> Reply<String> {
        match &self.source {
            Source::Link(s) => Ok(s.clone()),
            Source::Local(p) => {
                let bytes = tokio::fs::read(p).await.map_err(Fault::known)?;
                Ok(format!(
                    "data:{};base64,{}",
                    mime(p).ok_or_else(|| Fault::known("未识别素材类型"))?.1,
                    STANDARD.encode(bytes)
                ))
            }
        }
    }
    pub async fn part(&self) -> Reply<Part> {
        match &self.source {
            Source::Link(s) => Ok(Part::text(s.clone())),
            Source::Local(p) => {
                let file = tokio::fs::File::open(p).await.map_err(Fault::known)?;
                let len = file.metadata().await.map_err(Fault::known)?.len();
                Part::stream_with_length(reqwest::Body::wrap_stream(ReaderStream::new(file)), len)
                    .file_name(self.name.clone())
                    .mime_str(mime(p).ok_or_else(|| Fault::known("未识别素材类型"))?.1)
                    .map_err(Fault::known)
            }
        }
    }
}
fn render(v: &Value, vars: &Map<String, Value>) -> Value {
    match v {
        Value::String(s) => {
            let mut rest = s.as_str();
            let mut out = String::new();
            while let Some(start) = rest.find("{{") {
                let Some(end) = rest[start + 2..].find("}}").map(|i| start + 2 + i) else {
                    break;
                };
                let token = &rest[start + 2..end];
                let value = vars.get(token);
                if start == 0 && end + 2 == s.len() && rest.len() == s.len() {
                    if let Some(v) = value {
                        return v.clone();
                    }
                }
                out.push_str(&rest[..start]);
                match value {
                    Some(Value::String(s)) => out.push_str(s),
                    Some(v) => out.push_str(&v.to_string()),
                    None => out.push_str(&rest[start..end + 2]),
                };
                rest = &rest[end + 2..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(|v| render(v, vars)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), render(v, vars)))
                .collect(),
        ),
        v => v.clone(),
    }
}
fn file_token(s: &str) -> bool {
    matches!(
        s,
        "{{image}}"
            | "{{images}}"
            | "{{first_frame}}"
            | "{{last_frame}}"
            | "{{videos}}"
            | "{{audios}}"
    )
}
fn parts<'a>(token: &str, inputs: &'a [Input]) -> Vec<&'a Input> {
    let mut images = inputs.iter().filter(|a| a.kind == "image");
    match token {
        "{{first_frame}}" | "{{image}}" => images.next().into_iter().collect(),
        "{{last_frame}}" => images.nth(1).into_iter().collect(),
        "{{images}}" => images.collect(),
        _ => inputs
            .iter()
            .filter(|a| {
                a.kind
                    == if token == "{{videos}}" {
                        "video"
                    } else {
                        "audio"
                    }
            })
            .collect(),
    }
}
pub async fn mapped(
    request: reqwest::RequestBuilder,
    j: &Job,
    inputs: &[Input],
) -> Reply<reqwest::RequestBuilder> {
    let relay = j
        .relay
        .as_ref()
        .ok_or_else(|| Fault::known("缺少接口映射"))?;
    let (_, body, encoding) = creation::workflow(
        relay,
        j.settings.get("mode").and_then(Value::as_str).unwrap_or(""),
    );
    let body: Value = serde_json::from_str(body).map_err(Fault::known)?;
    let object = body
        .as_object()
        .ok_or_else(|| Fault::known("请求体必须是对象"))?;
    let (w, h) = creation::dimensions(&j.size)
        .map(|(w, h)| (Some(w), Some(h)))
        .unwrap_or((None, None));
    let mut vars=json!({"model":j.model,"prompt":j.prompt,"size":j.size,"seconds":j.seconds,"width":w,"height":h,"mode":j.settings.get("mode"),"ratio":j.settings.get("ratio"),"resolution":j.settings.get("resolution")}).as_object().unwrap().clone();
    for (k, v) in &j.settings {
        if k.starts_with("params.") {
            vars.insert(k.clone(), v.clone());
        }
    }
    let inline: Vec<_> = object
        .values()
        .filter(|v| encoding != "multipart" || !v.as_str().is_some_and(file_token))
        .collect();
    let needed = serde_json::to_string(&inline).map_err(Fault::known)?;
    for (kind, plural) in [
        ("image", "images"),
        ("video", "videos"),
        ("audio", "audios"),
    ] {
        let mut urls = vec![];
        if needed.contains(&format!("{{{{{plural}"))
            || (kind == "image"
                && ["{{image}}", "{{first_frame", "{{last_frame"]
                    .iter()
                    .any(|v| needed.contains(v)))
        {
            for a in inputs.iter().filter(|a| a.kind == kind) {
                urls.push(a.url().await?)
            }
        }
        if kind == "image" {
            vars.insert("image".into(), json!(urls.first()));
            for (i, name) in ["first_frame", "last_frame"].iter().enumerate() {
                vars.insert(name.to_string(), json!(urls.get(i)));
            }
            let raw = |s: &String| {
                s.strip_prefix("data:")
                    .and_then(|s| s.split_once(','))
                    .map(|(_, b)| b.to_owned())
                    .ok_or_else(|| Fault::known("原始 Base64 字段只能使用本地素材。"))
            };
            for (i, name) in ["first_frame_base64", "last_frame_base64"]
                .iter()
                .enumerate()
            {
                if needed.contains(&format!("{{{{{name}}}}}")) {
                    vars.insert(name.to_string(), json!(urls.get(i).map(raw).transpose()?));
                }
            }
            if needed.contains("{{images_base64}}") {
                vars.insert(
                    "images_base64".into(),
                    json!(urls.iter().map(raw).collect::<Reply<Vec<_>>>()?),
                );
            }
        }
        vars.insert(plural.into(), json!(urls));
    }
    if encoding != "multipart" {
        return Ok(request.json(&render(&body, &vars)));
    }
    let mut form = Form::new();
    for (key, v) in object {
        if let Some(token) = v.as_str().filter(|s| file_token(s)) {
            for a in parts(token, inputs) {
                form = form.part(key.clone(), a.part().await?);
            }
        } else {
            let v = render(v, &vars);
            if !v.is_null() {
                form = form.text(
                    key.clone(),
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string()),
                );
            }
        }
    }
    Ok(request.multipart(form))
}
