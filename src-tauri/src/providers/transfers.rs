use super::{
    http::{auth, envelope, json_response, text, Fault, Reply},
    media_jobs::content_url,
};
use crate::{domain::*, media::formats::mime};
use reqwest::Client;
use serde_json::json;
use std::path::Path;
use tokio_util::io::ReaderStream;
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
    let request = put.body(reqwest::Body::wrap_stream(ReaderStream::new(f)));
    let response = crate::developer::send(request, key, crate::developer::Destination::Media)
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
        let reply = crate::developer::send(req, key, crate::developer::Destination::Media)
            .await
            .map_err(Fault::transport)?;
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
