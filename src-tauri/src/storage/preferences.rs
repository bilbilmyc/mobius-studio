use crate::{
    domain::{id, Profile, Result},
    storage::files::{read, save},
    storage::{store::Store, writers::WriterConnection},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use super::writers::WriterInput;

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
    pub developer_mode: bool,
    pub performance: PerformanceMode,
    pub writer: WriterConnection,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub other_writers: Vec<WriterConnection>,
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
            "developerMode": p.developer_mode,
            "performance": p.performance,
            "writer": self.writer_view(&p.writer),
            "writers": p.writers().map(|c| self.writer_view(c)).collect::<Vec<_>>(),
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

    pub(crate) fn save_developer_mode(&self, enabled: bool) -> Result<()> {
        let _guard = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        p.developer_mode = enabled;
        save(&self.home.join("settings.json"), &p)?;
        crate::developer::enable(enabled);
        Ok(())
    }

    // Stage new credentials under a separate account until the settings file commits.
    pub(super) fn credential(
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

    pub(super) fn commit_preferences(
        &self,
        p: &Preferences,
        old: &Profile,
        next: &Profile,
    ) -> Result<()> {
        let result = save(&self.home.join("settings.json"), p);
        if old.id != next.id {
            self.vault.forget(if result.is_ok() { old } else { next });
        }
        result
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
