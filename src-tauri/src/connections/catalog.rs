use crate::{
    domain::{canonical_base, route, Result},
    generation::jobs::Studio,
    providers::provider::{auth, response_json, Fault, Reply},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Deserialize)]
pub struct Lookup {
    pub base: String,
    #[serde(default)]
    pub key: String,
    #[serde(flatten)]
    pub source: Source,
}

#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum Source {
    Writer,
    Comfy {
        id: Option<String>,
    },
    Connection {
        id: Option<String>,
        auth: Option<String>,
    },
}

#[derive(Serialize)]
pub struct Catalog {
    pub base: String,
    pub models: Vec<String>,
}

impl Studio {
    pub async fn discover_models(&self, input: Lookup) -> Result<Catalog> {
        let entered = canonical_base(&input.base)?;
        let url = url::Url::parse(&entered).map_err(|e| e.to_string())?;
        let base =
            if !matches!(input.source, Source::Comfy { .. }) && url.path().ends_with("/models") {
                entered.strip_suffix("/models").unwrap_or(&entered)
            } else {
                &entered
            };
        let mut key = input.key.trim().to_owned();
        let scheme = match &input.source {
            Source::Writer | Source::Comfy { .. } => "bearer",
            Source::Connection { auth, .. } => auth.as_deref().unwrap_or("bearer"),
        };
        if key.is_empty() && scheme != "none" {
            let saved = match &input.source {
                Source::Writer => Some(self.store.preferences()?.writer),
                Source::Connection { id: Some(id), .. } | Source::Comfy { id: Some(id) } => {
                    self.store.profiles()?.into_iter().find(|p| &p.id == id)
                }
                Source::Connection { id: None, .. } | Source::Comfy { id: None } => None,
            };
            if let Some(profile) = saved.filter(|p| p.base_url == entered || p.base_url == base) {
                key = self.store.vault.get(&profile, &profile.base_url)?;
            }
        }
        let catalog = if matches!(input.source, Source::Comfy { .. }) {
            crate::providers::comfy::models(&self.http, &entered, &key).await
        } else {
            request_catalog(&self.http, base, url.path() == "/", scheme, &key).await
        }
        .map_err(|e| e.message)?;
        if !matches!(input.source, Source::Writer) {
            self.store.remember_catalog(&catalog)?;
        }
        Ok(catalog)
    }
}

async fn request_catalog(
    h: &Client,
    base: &str,
    origin_only: bool,
    scheme: &str,
    key: &str,
) -> Reply<Catalog> {
    if origin_only {
        let versioned = format!("{base}/v1");
        if let Some(models) = fetch_models(h, &versioned, scheme, key, true).await? {
            return Ok(Catalog {
                base: versioned,
                models,
            });
        }
    }
    let models = fetch_models(h, base, scheme, key, false)
        .await?
        .ok_or_else(|| Fault::known("此服务没有返回兼容的模型列表，可手动填写模型 ID。"))?;
    Ok(Catalog {
        base: base.to_owned(),
        models,
    })
}

async fn fetch_models(
    h: &Client,
    base: &str,
    scheme: &str,
    key: &str,
    probing: bool,
) -> Reply<Option<Vec<String>>> {
    let reply = auth(h.get(route(base, "models")?), scheme, key)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(Fault::transport)?;
    if probing
        && matches!(
            reply.status(),
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
        )
    {
        return Ok(None);
    }
    Ok(response_json(reply, key)
        .await?
        .as_ref()
        .and_then(model_ids))
}

fn model_ids(v: &Value) -> Option<Vec<String>> {
    let list = v["data"]
        .as_array()
        .or_else(|| v["models"].as_array())
        .or_else(|| v.as_array())?;
    let mut ids: Vec<_> = list
        .iter()
        .filter_map(|v| v["id"].as_str().or_else(|| v.as_str()))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    (list.is_empty() || !ids.is_empty()).then_some(ids)
}
