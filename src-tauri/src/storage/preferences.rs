use crate::{
    domain::{canonical_base, id, Profile, Result},
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn writer_default() -> Profile {
    Profile {
        id: id(),
        base_url: "https://api.deepseek.com".into(),
        model: "deepseek-v4-pro".into(),
        ..Default::default()
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StorageTarget {
    pub provider: StorageProvider,
    pub custom_domain: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub access_key: String,
    pub virtual_host: bool,
    pub automatic: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageProvider {
    Aliyun,
    Tencent,
    Volcengine,
    Aws,
    #[default]
    S3,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub performance: PerformanceMode,
    #[serde(default = "writer_default")]
    pub writer: Profile,
    pub storage: StorageTarget,
    pub storage_key: Profile,
}

#[derive(Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerformanceMode {
    #[default]
    Auto,
    Eco,
    Performance,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterInput {
    pub base: String,
    pub model: String,
    pub key: String,
}

impl Store {
    pub fn preferences(&self) -> Result<Preferences> {
        let path = self.home.join("settings.json");
        if path.try_exists().map_err(|e| e.to_string())? {
            let mut p: Preferences = read(&path)?;
            if p.storage.provider == StorageProvider::S3
                && p.storage.endpoint.is_empty()
                && p.storage.bucket.is_empty()
                && p.storage.access_key.is_empty()
            {
                p.storage.provider = StorageProvider::Aliyun;
                p.storage.region = "cn-hangzhou".into();
            }
            return Ok(p);
        }
        Ok(Preferences {
            writer: writer_default(),
            storage: StorageTarget {
                provider: StorageProvider::Aliyun,
                region: "cn-hangzhou".into(),
                prefix: "mobius".into(),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    pub fn settings_view(&self) -> Result<Value> {
        let p = self.preferences()?;
        Ok(json!({
            "performance": p.performance,
            "writer": {"base":p.writer.base_url,"model":p.writer.model,"hasKey":self.vault.has(&p.writer,&p.writer.base_url)},
            "storage": p.storage,
            "hasStorageKey": self.vault.has(&p.storage_key,&p.storage.endpoint)
        }))
    }

    pub fn save_performance(&self, mode: PerformanceMode) -> Result<()> {
        let _guard = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        p.performance = mode;
        save(&self.home.join("settings.json"), &p)
    }

    // Stage new credentials under a separate account until the settings file commits.
    fn credential(
        &self,
        old: &Profile,
        base: &str,
        same_scope: bool,
        key: &str,
    ) -> Result<Profile> {
        if same_scope && old.base_url == base && key.trim().is_empty() {
            return Ok(old.clone());
        }
        let mut next = Profile {
            id: id(),
            base_url: base.into(),
            ..Default::default()
        };
        self.vault.put(&mut next, key)?;
        Ok(next)
    }

    fn commit_preferences(&self, p: &Preferences, old: &Profile, next: &Profile) -> Result<()> {
        let result = save(&self.home.join("settings.json"), p);
        if old.id != next.id {
            self.vault.forget(if result.is_ok() { old } else { next });
        }
        result
    }

    pub fn save_writer(&self, input: WriterInput) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        let base = canonical_base(&input.base)?;
        let model = input.model.trim();
        if model.is_empty() || model.len() > 200 {
            return Err("请填写剧本模型 ID。".into());
        }
        let old = p.writer;
        p.writer = self.credential(&old, &base, true, &input.key)?;
        p.writer.model = model.into();
        self.commit_preferences(&p, &old, &p.writer)
    }

    pub fn save_storage(&self, mut target: StorageTarget, secret: &str) -> Result<()> {
        target.bucket = target.bucket.trim().into();
        target.region = target.region.trim().into();
        target.access_key = target.access_key.trim().into();
        target.prefix = target.prefix.trim().trim_matches('/').into();
        target.resolve_endpoint()?;
        target.validate()?;
        let _lock = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        let same_account =
            p.storage.access_key == target.access_key && p.storage.provider == target.provider;
        let old = p.storage_key;
        p.storage_key = self.credential(&old, &target.endpoint, same_account, secret)?;
        if target.automatic && !self.vault.has(&p.storage_key, &target.endpoint) {
            return Err("自动上传需要填写 Secret Access Key。".into());
        }
        p.storage = target;
        self.commit_preferences(&p, &old, &p.storage_key)
    }
}
