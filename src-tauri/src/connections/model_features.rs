use crate::{
    app::Core,
    connections::catalog::Catalog,
    domain::{Job, Profile, Result},
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Features {
    pub sizes: Vec<String>,
    pub max_images: Option<usize>,
    pub first_last: Option<bool>,
    pub mask: Option<bool>,
    pub multi: Option<usize>,
}
impl Store {
    pub(crate) fn feature_map(&self) -> Result<BTreeMap<String, Features>> {
        let p = self.home.join("模型能力.json");
        if p.exists() {
            read(&p)
        } else {
            Ok(Default::default())
        }
    }
    pub(crate) fn features(&self, p: &Profile, model: &str) -> Result<Option<Features>> {
        Ok(self
            .feature_map()?
            .remove(&format!("{}|{}|{}", p.id, p.base_url, model)))
    }
    pub(crate) fn remember_catalog(&self, c: &Catalog) -> Result<()> {
        let _guard = self.gate.lock().unwrap();
        let f = self.home.join("模型目录记录.json");
        let mut all: BTreeMap<String, Vec<String>> = if f.exists() {
            read(&f)?
        } else {
            Default::default()
        };
        all.insert(c.base.clone(), c.models.clone());
        save(&f, &all)
    }
}
#[tauri::command]
pub fn get_model_features(s: Core, profile_id: String, model: String) -> Result<Value> {
    let p = s.store.resolve(&profile_id, "image")?;
    let file = s.store.home.join("模型目录记录.json");
    let dir: BTreeMap<String, Vec<String>> = if file.exists() {
        read(&file)?
    } else {
        Default::default()
    };
    let tested=s.store.jobs()?.into_iter().filter(|j|j.profile_id==p.id&&j.base_url==p.base_url&&j.model==model&&j.status=="done"&&(j.native_count.is_none()||j.candidate_ids.first()==Some(&j.id))&&j.detail!="项目备份中的历史记录。")
        .take(12).map(|j|json!({"size":j.size,"references":j.assets.len(),"mode":j.settings.get("mode"),"mask":j.mask.is_some(),"results":j.received_count.unwrap_or(1),"at":j.time()})).collect::<Vec<_>>();
    Ok(
        json!({"declared":s.store.features(&p,&model)?,"listed":dir.get(&p.base_url).is_some_and(|v|v.contains(&model)),"tested":tested}),
    )
}
#[tauri::command]
pub fn set_model_features(
    s: Core,
    profile_id: String,
    model: String,
    features: Features,
) -> Result<()> {
    let p = s.store.resolve(&profile_id, "image")?;
    if p.model != model && !p.models.contains(&model) {
        return Err("请先将该模型加入连接。".into());
    }
    if features.max_images.is_some_and(|n| n > 64)
        || features.multi.is_some_and(|n| ![1, 2, 4].contains(&n))
        || features.sizes.len() > 64
        || features
            .sizes
            .iter()
            .any(|s| s.trim().is_empty() || s.len() > 50)
    {
        return Err("模型能力取值无效。".into());
    }
    let _guard = s.store.gate.lock().unwrap();
    let mut all = s.store.feature_map()?;
    all.insert(format!("{}|{}|{}", p.id, p.base_url, model), features);
    save(&s.store.home.join("模型能力.json"), &all)
}
pub(crate) fn check(f: Option<&Features>, j: &Job) -> Result<()> {
    if let Some(f) = f {
        if !f.sizes.is_empty() && !f.sizes.contains(&j.size) {
            return Err(format!("模型不支持当前尺寸 {}，请调整。", j.size));
        }
        if f.max_images
            .is_some_and(|n| j.assets.iter().filter(|a| a.kind == "image").count() > n)
        {
            return Err("参考图超过此模型的上限。".into());
        }
        if f.first_last == Some(false) && j.settings.get("mode") == Some(&json!("first_last")) {
            return Err("此模型不支持首尾帧。".into());
        }
    }
    if j.mask.is_some()
        && (f.and_then(|v| v.mask) != Some(true)
            || j.protocol_id != "openai-image"
            || j.settings.get("mode") != Some(&json!("i2i")))
    {
        return Err("此模型或创作方式不支持遮罩。".into());
    }
    if j.candidate_ids.len() > 1
        && (!matches!(j.protocol_id.as_str(), "openai-image" | "wan-image")
            || f.and_then(|v| v.multi).unwrap_or(1) < j.candidate_ids.len())
    {
        return Err("此模型未声明支持请求的候选数。".into());
    }
    Ok(())
}
