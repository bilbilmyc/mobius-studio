use crate::{
    domain::{canonical_base, site, Controls, Profile, Result},
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Connection {
    id: String,
    name: String,
    protocol: String,
    base: String,
    model: String,
    models: Vec<String>,
    controls: Option<Controls>,
    #[serde(default)]
    features: BTreeMap<String, crate::connections::model_features::Features>,
}
pub(crate) fn describe(s: &Store, used: &HashSet<String>) -> Result<Vec<Connection>> {
    let index = s.feature_map()?;
    Ok(s.profiles()?
        .into_iter()
        .filter(|p| used.contains(&p.id))
        .map(|p| {
            let prefix = format!("{}|{}|", p.id, p.base_url);
            let features = index
                .iter()
                .filter_map(|(k, f)| {
                    k.strip_prefix(&prefix)
                        .map(|name| (name.to_owned(), f.clone()))
                })
                .collect();
            Connection {
                id: p.id,
                name: p.name,
                protocol: p.protocol_id,
                base: p.base_url,
                model: p.model,
                models: p.models,
                controls: p.controls,
                features,
            }
        })
        .collect())
}
pub(crate) fn plan(
    s: &Store,
    profiles: &[Connection],
    stage: &Path,
) -> Result<HashMap<String, String>> {
    let current = s.profiles()?;
    let mut remap = HashMap::new();
    let mut additions = vec![];
    for entry in profiles {
        let base = canonical_base(&entry.base)?;
        if site(&entry.protocol) && base == crate::domain::SITE {
            remap.insert(entry.id.clone(), "@site".into());
            continue;
        }
        if !site(&entry.protocol) && crate::generation::creation::preset(&entry.protocol).is_null()
        {
            return Err("归档连接协议无效。".into());
        }
        if let Some(c) = &entry.controls {
            crate::generation::creation::validate_controls(c)?;
        }
        let existing = current.iter().find(|p| {
            p.id == entry.id
                && p.base_url == base
                && p.protocol_id == entry.protocol
                && p.model == entry.model
                && entry
                    .models
                    .iter()
                    .all(|m| p.model == *m || p.models.contains(m))
        });
        let id = existing
            .map(|p| p.id.clone())
            .unwrap_or_else(crate::domain::id);
        remap.insert(entry.id.clone(), id.clone());
        if existing.is_none() {
            additions.push(Connection {
                id,
                ..entry.clone()
            })
        }
    }
    if !additions.is_empty() {
        save(&stage.join("project-connections.json"), &additions)?
    }
    Ok(remap)
}
pub(crate) fn install(s: &Store, stage: &Path) -> Result<()> {
    let file = stage.join("project-connections.json");
    if !file.exists() {
        return Ok(());
    }
    let additions: Vec<Connection> = read(&file)?;
    let mut all = s.profiles()?;
    let mut changed = false;
    let mut features = s.feature_map()?;
    let mut feature_change = false;
    for c in additions {
        for (model, f) in &c.features {
            let key = format!("{}|{}|{model}", c.id, c.base);
            if !features.contains_key(&key) {
                features.insert(key, f.clone());
                feature_change = true;
            }
        }
        if all.iter().any(|p| p.id == c.id) {
            continue;
        }
        all.push(Profile {
            id: c.id,
            name: c.name,
            protocol_id: c.protocol,
            base_url: c.base,
            model: c.model,
            models: c.models,
            controls: c.controls,
            ..Default::default()
        });
        changed = true
    }
    if changed {
        save(&s.home.join("connections.json"), &all)?
    }
    if feature_change {
        save(&s.home.join("模型能力.json"), &features)?
    }
    Ok(())
}
pub(crate) fn draft(
    editor: &mut Value,
    profiles: &HashMap<String, String>,
    jobs: &HashMap<String, String>,
) {
    let map_id = |s: &str| profiles.get(s).cloned().unwrap_or_else(|| s.to_owned());
    if let Some(old) = editor["service"].as_str() {
        editor["service"] = Value::String(map_id(old))
    }
    for k in ["models", "templates"] {
        if let Some(m) = editor[k].as_object_mut() {
            let entries = std::mem::take(m);
            for (k, v) in entries {
                m.insert(map_id(&k), v);
            }
        }
    }
    let variant_key = |k: &str| {
        if let Ok(mut a) = serde_json::from_str::<Vec<Value>>(k) {
            if let Some(id) = a.first().and_then(Value::as_str) {
                let new = map_id(id);
                if new == "@site" && a.len() == 4 {
                    a[2] = Value::Null;
                }
                a[0] = Value::String(new);
                return serde_json::to_string(&a).unwrap_or_else(|_| k.to_owned());
            }
        }
        k.to_owned()
    };
    if let Some(old) = editor["compare"].as_str() {
        editor["compare"] = Value::String(variant_key(old))
    }
    if let Some(m) = editor["variants"].as_object_mut() {
        let entries = std::mem::take(m);
        for (k, mut v) in entries {
            if let Some(o) = v.as_object_mut() {
                if let Some(orig) = o.remove("sourceJob") {
                    if let Some(id) = orig.as_str().and_then(|s| jobs.get(s)) {
                        o.insert("sourceJob".into(), Value::String(id.clone()));
                    }
                }
            }
            m.insert(variant_key(&k), v);
        }
    }
}
pub(crate) fn used(editor: &Value, ids: &mut HashSet<String>) {
    if let Some(s) = editor["service"].as_str() {
        ids.insert(s.to_owned());
    }
    for k in ["models", "templates"] {
        if let Some(obj) = editor[k].as_object() {
            ids.extend(obj.keys().cloned())
        }
    }
    if let Ok(variants) =
        serde_json::from_value::<BTreeMap<String, Value>>(editor["variants"].clone())
    {
        for key in variants.keys() {
            if let Ok(a) = serde_json::from_str::<Vec<Value>>(key) {
                if let Some(id) = a.first().and_then(Value::as_str) {
                    ids.insert(id.to_owned());
                }
            }
        }
    }
}
