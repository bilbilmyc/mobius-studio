use super::{files::save, preferences::Preferences, store::Store};
use crate::domain::{canonical_base, id, Profile, Result, ServiceGroup};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

fn initial_id() -> String {
    "@writer".into()
}

// The connection keeps its identity when the vault rotates the credential account.
// Flattening the profile also preserves the original settings.json writer record.
#[derive(Clone, Serialize, Deserialize)]
pub struct WriterConnection {
    #[serde(default = "initial_id", rename = "ConnectionId")]
    pub id: String,
    #[serde(flatten)]
    pub profile: Profile,
}

impl Default for WriterConnection {
    fn default() -> Self {
        Self {
            id: initial_id(),
            profile: Profile {
                id: id(),
                base_url: "https://api.deepseek.com".into(),
                model: "deepseek-v4-pro".into(),
                ..Default::default()
            },
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub service_group: Option<ServiceGroup>,
    pub base: String,
    pub model: String,
    pub models: Option<Vec<String>>,
    pub key: String,
    #[serde(default)]
    pub activate: bool,
}

impl Preferences {
    pub fn writers(&self) -> impl Iterator<Item = &WriterConnection> {
        std::iter::once(&self.writer).chain(&self.other_writers)
    }

    pub fn find_writer(&self, id: &str) -> Result<&WriterConnection> {
        self.writers()
            .find(|c| c.id == id)
            .ok_or_else(|| "剧本服务已移除。".into())
    }

    fn activate_writer(&mut self, id: &str) -> Result<()> {
        if self.writer.id != id {
            let next = self
                .other_writers
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or("剧本服务已移除。")?;
            std::mem::swap(&mut self.writer, next);
        }
        Ok(())
    }
}

impl Store {
    pub(super) fn writer_view(&self, connection: &WriterConnection) -> Value {
        let p = &connection.profile;
        let mut models = p.models.clone();
        if !models.contains(&p.model) {
            models.insert(0, p.model.clone());
        }
        json!({"id":connection.id,"name":p.name,"base":p.base_url,"model":p.model,"models":models,
            "serviceGroup":p.service_group,"hasKey":self.vault.has(p,&p.base_url)})
    }

    pub fn save_writer(&self, input: WriterInput) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        let base = canonical_base(&input.base)?;
        let model = input.model.trim();
        if model.is_empty() || model.len() > 200 {
            return Err("请填写有效的剧本模型 ID（最多 200 字节）。".into());
        }
        let adding = input.id.as_deref() == Some("@new");
        let (connection_id, old) = if adding {
            (id(), Profile::default())
        } else {
            let existing = p.find_writer(input.id.as_deref().unwrap_or(&p.writer.id))?;
            (existing.id.clone(), existing.profile.clone())
        };
        let candidates = input.models.unwrap_or_else(|| {
            if old.base_url == base {
                old.models.clone()
            } else {
                Vec::new()
            }
        });
        let mut models = vec![model.to_owned()];
        let mut seen = HashSet::from([model.to_owned()]);
        for value in candidates {
            let value = value.trim();
            if value.len() > 200 {
                return Err("剧本模型 ID 最多 200 字节。".into());
            }
            if !value.is_empty() && seen.insert(value.to_owned()) {
                models.push(value.into());
            }
        }
        let mut next = self.credential(&old, &base, true, &input.key)?;
        next.name = input.name.as_deref().unwrap_or(&old.name).trim().into();
        next.service_group = input.service_group.unwrap_or(old.service_group);
        next.model = model.into();
        next.models = models;
        let connection = WriterConnection {
            id: connection_id.clone(),
            profile: next,
        };
        if adding {
            p.other_writers.push(connection);
        } else if p.writer.id == connection_id {
            p.writer = connection;
        } else if let Some(saved) = p.other_writers.iter_mut().find(|c| c.id == connection_id) {
            *saved = connection;
        }
        if input.activate {
            p.activate_writer(&connection_id)?;
        }
        self.commit_preferences(&p, &old, &p.find_writer(&connection_id)?.profile)
    }

    pub fn select_writer(&self, id: &str, model: &str) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        p.activate_writer(id)?;
        let writer = &mut p.writer.profile;
        if model != writer.model && !writer.models.iter().any(|m| m == model) {
            return Err("这个模型已从剧本服务中移除。".into());
        }
        writer.model = model.into();
        save(&self.home.join("settings.json"), &p)
    }

    pub fn remove_writer(&self, id: &str) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        let mut p = self.preferences()?;
        let removed = if p.writer.id == id {
            let replacement = if p.other_writers.is_empty() {
                WriterConnection {
                    id: crate::domain::id(),
                    ..Default::default()
                }
            } else {
                let next = p
                    .other_writers
                    .iter()
                    .position(|c| self.vault.has(&c.profile, &c.profile.base_url))
                    .unwrap_or(0);
                p.other_writers.remove(next)
            };
            std::mem::replace(&mut p.writer, replacement)
        } else {
            let index = p
                .other_writers
                .iter()
                .position(|c| c.id == id)
                .ok_or("剧本服务已移除。")?;
            p.other_writers.remove(index)
        };
        save(&self.home.join("settings.json"), &p)?;
        self.vault.forget(&removed.profile);
        Ok(())
    }
}
