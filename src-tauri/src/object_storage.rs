use crate::{
    jobs::Studio,
    model::{canonical_base, kind, Job, Result},
    preferences::{Preferences, StorageTarget},
    store::mime,
};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tokio_util::io::ReaderStream;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct CloudCopy {
    pub status: String,
    pub uri: String,
    pub endpoint: String,
    pub detail: String,
}

impl StorageTarget {
    fn bucket(&self) -> Result<Bucket> {
        let url = canonical_base(&self.endpoint)?
            .parse()
            .map_err(|_| "Endpoint 无效")?;
        let style = if self.virtual_host {
            UrlStyle::VirtualHost
        } else {
            UrlStyle::Path
        };
        Bucket::new(url, style, self.bucket.clone(), self.region.clone())
            .map_err(|_| "Endpoint 与 Bucket 寻址方式不匹配。".into())
    }
    pub fn validate(&self) -> Result<()> {
        if self.bucket.is_empty()
            || self.bucket.len() > 63
            || self.bucket == "."
            || self.bucket.contains("..")
            || !self
                .bucket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            return Err("请填写有效的 Bucket 名称。".into());
        }
        if self.region.is_empty()
            || !self
                .region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("请填写签名区域，例如 us-east-1 或 auto。".into());
        }
        if self.access_key.is_empty() {
            return Err("请填写 Access Key ID。".into());
        }
        if self.prefix.len() > 900
            || self.prefix.contains('\\')
            || self.prefix.chars().any(char::is_control)
            || !self.prefix.is_empty()
                && self.prefix.split('/').any(|s| matches!(s, "" | "." | ".."))
        {
            return Err("对象前缀应由有效的目录名称组成。".into());
        }
        self.bucket().map(|_| ())
    }
    fn object_key(&self, j: &Job) -> Result<String> {
        let ext = j
            .file_name
            .as_deref()
            .and_then(|s| Path::new(s).extension())
            .and_then(|s| s.to_str())
            .ok_or("找不到图片扩展名。")?;
        let name = format!("{}.{ext}", j.id);
        Ok(if self.prefix.is_empty() {
            name
        } else {
            format!("{}/{name}", self.prefix)
        })
    }
    fn planned_copy(&self, j: &Job) -> Result<CloudCopy> {
        Ok(CloudCopy {
            status: "pending".into(),
            endpoint: self.endpoint.clone(),
            uri: format!("s3://{}/{}", self.bucket, self.object_key(j)?),
            detail: String::new(),
        })
    }
}

impl Studio {
    pub(crate) fn plan_image_copy(&self, j: &mut Job) {
        if kind(&j.protocol_id) != "image" {
            return;
        }
        let plan = self.store.preferences().and_then(|p| {
            if p.storage.automatic {
                p.storage.planned_copy(j).map(Some)
            } else {
                Ok(None)
            }
        });
        j.cloud = plan.unwrap_or_else(|detail| {
            Some(CloudCopy {
                status: "failed".into(),
                detail,
                ..Default::default()
            })
        });
    }

    async fn put_image(&self, p: &Preferences, j: &Job) -> Result<()> {
        let config = &p.storage;
        let secret = self.store.vault.get(&p.storage_key, &config.endpoint)?;
        if secret.is_empty() {
            return Err("请先在设置中填写对象存储密钥。".into());
        }
        let bucket = config.bucket()?;
        let credential = Credentials::new(config.access_key.clone(), secret);
        let key = config.object_key(j)?;
        let path = self
            .store
            .media(j)
            .ok_or("本地图片已移动。")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(self.store.home.join("作品")) {
            return Err("作品路径无效。".into());
        }
        let content_type = mime(&path)
            .filter(|(k, _)| *k == "image")
            .ok_or("请选择图片作品。")?
            .1;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| e.to_string())?;
        let len = file.metadata().await.map_err(|e| e.to_string())?.len();
        let mut action = bucket.put_object(Some(&credential), &key);
        action.headers_mut().insert("content-type", content_type);
        let response = self
            .http
            .put(action.sign(Duration::from_secs(900)))
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await
            .map_err(|e| format!("对象存储连接失败：{}", e.without_url()))?;
        if !response.status().is_success() {
            return Err(format!(
                "对象存储返回 HTTP {}，请检查区域、凭据和对象写入权限。",
                response.status().as_u16()
            ));
        }
        Ok(())
    }

    pub async fn upload_image(&self, id: &str, automatic: bool) -> Result<()> {
        let _transfer = self.cloud_transfer.lock().await;
        let mut j = self.store.job(id)?;
        if j.status != "done" || kind(&j.protocol_id) != "image" {
            return Err("请选择已完成的图片作品。".into());
        }
        let p = self.store.preferences()?;
        if automatic && j.cloud.as_ref().is_none_or(|c| c.status != "pending") {
            return Ok(());
        }
        if p.storage.endpoint.is_empty() {
            return Err("请先配置对象存储。".into());
        }
        let mut copy = p.storage.planned_copy(&j)?;
        let same_target = j
            .cloud
            .as_ref()
            .is_some_and(|c| c.uri == copy.uri && c.endpoint == copy.endpoint);
        if automatic && (!p.storage.automatic || !same_target) {
            if let Some(previous) = &mut j.cloud {
                previous.status = "failed".into();
                previous.detail = "上传设置已改变，可手动保存到当前存储。".into();
            }
            self.store.save_job(&j)?;
            self.changed();
            return Ok(());
        }
        if same_target && j.cloud.as_ref().is_some_and(|c| c.status == "saved") {
            return Ok(());
        }
        copy.status = "uploading".into();
        j.cloud = Some(copy.clone());
        self.store.save_job(&j)?;
        self.changed();
        let outcome = self.put_image(&p, &j).await;
        copy.status = if outcome.is_ok() { "saved" } else { "failed" }.into();
        copy.detail = outcome.as_ref().err().cloned().unwrap_or_default();
        j.cloud = Some(copy);
        self.store.save_job(&j)?;
        self.changed();
        outcome
    }
}
