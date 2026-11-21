use crate::{
    creation::public_source,
    model::{id, Result},
    provider::client,
    store::mime,
};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
pub(crate) async fn fetch(raw: &str, kind: &str, dir: &Path) -> Result<PathBuf> {
    let url = url::Url::parse(&public_source(raw)?).map_err(|_| "素材链接无效。")?;
    let http = client()?;
    let mut target = url.clone();
    let mut response = None;
    for _ in 0..5 {
        let r = http
            .get(target.clone())
            .timeout(std::time::Duration::from_secs(90))
            .send()
            .await
            .map_err(|_| "素材链接无法访问。")?;
        if r.status().is_redirection() {
            let next = r
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| target.join(v).ok())
                .ok_or("素材重定向无效。")?;
            public_source(next.as_str())?;
            target = next;
        } else {
            response = Some(r.error_for_status().map_err(|_| "素材不可下载。")?);
            break;
        }
    }
    let response = response.ok_or("素材重定向过多。")?;
    let media = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let ext = Path::new(target.path())
        .extension()
        .and_then(|s| s.to_str())
        .filter(|e| mime(Path::new(&format!("a.{e}"))).is_some_and(|m| m.0 == kind))
        .map(str::to_owned)
        .or_else(|| {
            [
                "png", "jpg", "webp", "gif", "mp4", "webm", "wav", "mp3", "ogg",
            ]
            .into_iter()
            .find(|e| mime(Path::new(&format!("a.{e}"))) == Some((kind, media)))
            .map(str::to_owned)
        })
        .ok_or("远程素材格式无法识别。")?;
    let path = dir.join(format!("{}.{}", id(), ext));
    let mut output = tokio::fs::File::create(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut chunks = response.bytes_stream();
    let mut size = 0u64;
    while let Some(chunk) = chunks.next().await {
        let data = chunk.map_err(|_| "远程素材下载中断。")?;
        size += data.len() as u64;
        if size > 1024 * 1024 * 1024 {
            return Err("远程素材超过 1 GiB。".into());
        }
        output.write_all(&data).await.map_err(|e| e.to_string())?;
    }
    output.flush().await.map_err(|e| e.to_string())?;
    if size == 0 {
        return Err("远程素材为空。".into());
    }
    Ok(path)
}
