use crate::{
    jobs::Studio,
    model::{canonical_base, kind, Job, Result},
    preferences::{Preferences, StorageProvider, StorageTarget},
    store::mime,
};
use http::header::{CONTENT_TYPE, HOST};
use reqsign_aliyun_oss::{Credential, RequestSigner, SigningVersion};
use reqsign_core::{Context, SignRequest};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::OnceLock, time::Duration};
use tokio_util::io::ReaderStream;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct CloudCopy {
    pub status: String,
    pub uri: String,
    pub endpoint: String,
    pub detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPreset {
    id: StorageProvider,
    endpoint: String,
    china_endpoint: Option<String>,
}

impl StorageTarget {
    fn regional_endpoint(&self) -> String {
        static PRESETS: OnceLock<Vec<ProviderPreset>> = OnceLock::new();
        let presets = PRESETS.get_or_init(|| {
            serde_json::from_str(include_str!("../../src/StorageProviders.json"))
                .expect("storage presets")
        });
        let preset = presets
            .iter()
            .find(|p| p.id == self.provider)
            .expect("storage provider");
        let domain = if self.region.starts_with("cn-") {
            preset.china_endpoint.as_ref().unwrap_or(&preset.endpoint)
        } else {
            &preset.endpoint
        };
        domain.replace("{region}", &self.region)
    }

    pub fn resolve_endpoint(&mut self) -> Result<()> {
        if self.provider != StorageProvider::Aliyun {
            self.custom_domain.clear();
        }
        if self.provider == StorageProvider::S3 {
            self.endpoint = canonical_base(&self.endpoint)?;
            return Ok(());
        }
        if self.region.is_empty()
            || self.region.len() > 63
            || !self
                .region
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err("请填写存储桶所在的地域 ID。".into());
        }
        self.custom_domain = self.custom_domain.trim().into();
        self.virtual_host = !(self.provider == StorageProvider::Aws && self.bucket.contains('.'));
        self.endpoint = if self.custom_domain.is_empty() {
            self.regional_endpoint()
        } else {
            let base = canonical_base(&self.custom_domain)?;
            let url: url::Url = base.parse().map_err(|_| "自定义域名无效。")?;
            if url.path() != "/" {
                return Err("请填写绑定到此 Bucket 的域名，域名后无需加入路径。".into());
            }
            self.custom_domain = base.clone();
            base
        };
        Ok(())
    }

    fn bucket_at(&self, endpoint: &str) -> Result<Bucket> {
        let url = canonical_base(endpoint)?
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
        if self.provider != StorageProvider::S3
            && (self.bucket.len() < 3
                || self.bucket.bytes().any(|c| {
                    !(c.is_ascii_lowercase()
                        || c.is_ascii_digit()
                        || c == b'-'
                        || self.provider == StorageProvider::Aws && c == b'.')
                })
                || !self.bucket.as_bytes()[0].is_ascii_alphanumeric()
                || !self.bucket.as_bytes()[self.bucket.len() - 1].is_ascii_alphanumeric())
        {
            return Err("请按所选服务商的规则填写完整的存储桶名称。".into());
        }
        if self.provider == StorageProvider::Tencent
            && !self.bucket.rsplit_once('-').is_some_and(|(name, id)| {
                !name.is_empty() && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err("腾讯云 COS 需要带 APPID 的完整桶名，例如 photos-1250000000。".into());
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
        if self.provider == StorageProvider::Aliyun && !self.custom_domain.is_empty() {
            self.bucket_at(&self.regional_endpoint()).map(|_| ())
        } else {
            self.bucket_at(&self.endpoint).map(|_| ())
        }
    }

    async fn signed_put(
        &self,
        http: &reqwest::Client,
        secret: String,
        key: &str,
        mime: &str,
    ) -> Result<reqwest::RequestBuilder> {
        if self.provider == StorageProvider::Aliyun {
            // OSS signs /bucket/key even when a bucket-bound CNAME serves /key.
            let regional = self.bucket_at(&self.regional_endpoint())?.object_url(key);
            let mut wire = regional.clone();
            if !self.custom_domain.is_empty() {
                wire = self.endpoint.parse().map_err(|_| "自定义域名无效。")?;
                wire.set_path(regional.path());
            }
            let (mut parts, _) = http::Request::put(regional.as_str())
                .header(
                    HOST,
                    &wire[url::Position::BeforeHost..url::Position::AfterPort],
                )
                .header(CONTENT_TYPE, mime)
                .body(())
                .map_err(|_| "对象上传地址无效。")?
                .into_parts();
            let credential = Credential {
                access_key_id: self.access_key.clone(),
                access_key_secret: secret,
                ..Default::default()
            };
            RequestSigner::new(&self.bucket)
                .with_region(&self.region)
                .with_signing_version(SigningVersion::V4)
                .sign_request(&Context::new(), &mut parts, Some(&credential), None)
                .await
                .map_err(|_| "阿里云 OSS 请求签名失败，请检查地域和凭据。")?;
            return Ok(http.put(wire).headers(parts.headers));
        }
        let bucket = self.bucket_at(&self.endpoint)?;
        let credential = Credentials::new(self.access_key.clone(), secret);
        let mut action = bucket.put_object(Some(&credential), key);
        action.headers_mut().insert("content-type", mime);
        Ok(http
            .put(action.sign(Duration::from_secs(900)))
            .header(CONTENT_TYPE, mime))
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
            uri: format!(
                "{}://{}/{}",
                match self.provider {
                    StorageProvider::Aliyun => "oss",
                    StorageProvider::Tencent => "cos",
                    StorageProvider::Volcengine => "tos",
                    StorageProvider::Aws | StorageProvider::S3 => "s3",
                },
                self.bucket,
                self.object_key(j)?
            ),
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
        let key = config.object_key(j)?;
        let path = self.store.original(j)?;
        let content_type = mime(&path)
            .filter(|(k, _)| *k == "image")
            .ok_or("请选择图片作品。")?
            .1;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| e.to_string())?;
        let len = file.metadata().await.map_err(|e| e.to_string())?.len();
        let response = config
            .signed_put(&self.http, secret, &key, content_type)
            .await?
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
            self.job_changed(id);
            return Ok(());
        }
        if same_target && j.cloud.as_ref().is_some_and(|c| c.status == "saved") {
            return Ok(());
        }
        copy.status = "uploading".into();
        j.cloud = Some(copy.clone());
        self.store.save_job(&j)?;
        self.job_changed(id);
        let outcome = self.put_image(&p, &j).await;
        copy.status = if outcome.is_ok() { "saved" } else { "failed" }.into();
        copy.detail = outcome.as_ref().err().cloned().unwrap_or_default();
        j.cloud = Some(copy);
        self.store.save_job(&j)?;
        self.job_changed(id);
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StorageProvider::*;

    #[tokio::test]
    async fn branded_puts_use_the_bucket_region_host_and_signing_protocol() {
        let client = reqwest::Client::new();
        for (provider, region, bucket, host, path) in [
            (
                Aliyun,
                "cn-hangzhou",
                "photos",
                "photos.oss-cn-hangzhou.aliyuncs.com",
                "/%E5%A4%9C%20%E6%99%AF.png",
            ),
            (
                Tencent,
                "ap-guangzhou",
                "photos-1250000000",
                "photos-1250000000.cos.ap-guangzhou.myqcloud.com",
                "/%E5%A4%9C%20%E6%99%AF.png",
            ),
            (
                Volcengine,
                "cn-beijing",
                "photos",
                "photos.tos-s3-cn-beijing.volces.com",
                "/%E5%A4%9C%20%E6%99%AF.png",
            ),
            (
                Aws,
                "eu-west-1",
                "photos",
                "photos.s3.eu-west-1.amazonaws.com",
                "/%E5%A4%9C%20%E6%99%AF.png",
            ),
            (
                Aws,
                "cn-north-1",
                "dotted.photos",
                "s3.cn-north-1.amazonaws.com.cn",
                "/dotted.photos/%E5%A4%9C%20%E6%99%AF.png",
            ),
        ] {
            let mut target = StorageTarget {
                provider,
                region: region.into(),
                bucket: bucket.into(),
                access_key: "fixture".into(),
                endpoint: "https://old.invalid".into(),
                ..Default::default()
            };
            target.resolve_endpoint().unwrap();
            target.validate().unwrap();
            let put = target
                .signed_put(&client, "fixture-secret".into(), "夜 景.png", "image/png")
                .await
                .unwrap()
                .build()
                .unwrap();
            assert_eq!(put.url().host_str(), Some(host));
            assert_eq!(put.url().path(), path);
            assert_eq!(put.headers()[CONTENT_TYPE], "image/png");
            if provider == Aliyun {
                assert!(put.headers()["authorization"]
                    .to_str()
                    .unwrap()
                    .starts_with("OSS4-HMAC-SHA256 Credential=fixture/"));
            } else {
                let q = put
                    .url()
                    .query_pairs()
                    .collect::<std::collections::HashMap<_, _>>();
                assert!(q["X-Amz-Credential"].ends_with(&format!("/{region}/s3/aws4_request")));
                assert_eq!(q["X-Amz-SignedHeaders"], "content-type;host");
                assert_eq!(q["X-Amz-Signature"].len(), 64);
            }
        }
    }

    #[test]
    fn legacy_storage_and_vendor_specific_validation() {
        let mut legacy: StorageTarget = serde_json::from_value(serde_json::json!({
            "endpoint":"http://127.0.0.1:9000/store","bucket":"pictures","region":"auto",
            "accessKey":"old-account","virtualHost":false,"automatic":true
        }))
        .unwrap();
        assert!(legacy.provider == S3);
        legacy.resolve_endpoint().unwrap();
        legacy.validate().unwrap();
        assert!(!legacy.virtual_host && legacy.automatic);
        assert_eq!(legacy.endpoint, "http://127.0.0.1:9000/store");
        legacy.provider = Tencent;
        legacy.region = "ap-shanghai".into();
        legacy.resolve_endpoint().unwrap();
        assert!(legacy.validate().unwrap_err().contains("APPID"));
        legacy.provider = Aliyun;
        legacy.custom_domain = "https://assets.example.com/extra".into();
        assert!(legacy.resolve_endpoint().is_err());
    }
}
