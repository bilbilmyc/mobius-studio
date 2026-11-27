use crate::{
    domain::*,
    storage::{
        files::{read, save},
        store::Store,
    },
};
use serde_json::{json, Value};
impl Store {
    pub fn profiles(&self) -> Result<Vec<Profile>> {
        let f = self.home.join("connections.json");
        if f.is_file() {
            read(&f)
        } else {
            Ok(vec![])
        }
    }
    pub fn resolve(&self, id: &str, media: &str) -> Result<Profile> {
        let profiles = self.profiles()?;
        if id != "@site" {
            return profiles
                .into_iter()
                .find(|p| p.id == id)
                .ok_or("连接已移除。".into());
        }
        let proto = format!("rh-{media}");
        let mut options: Vec<_> = profiles
            .into_iter()
            .filter(|p| site(&p.protocol_id) && p.base_url == SITE)
            .collect();
        options.sort_by_key(|p| {
            (
                !self.vault.has(p, SITE),
                p.extra.get("DefaultOfficial") != Some(&Value::Bool(true)),
                p.protocol_id != proto,
            )
        });
        let mut p = options.into_iter().next().unwrap_or_default();
        p.base_url = SITE.into();
        p.protocol_id = proto;
        p.name = "AIGC 创作空间 · 官网".into();
        p.model = default_model(media);
        Ok(p)
    }
    pub fn profile_view(&self, p: &Profile) -> Value {
        let model_sizes: std::collections::BTreeMap<_, _> = std::iter::once(&p.model)
            .chain(&p.models)
            .filter_map(|model| p.image_size_presets(model).map(|sizes| (model, sizes)))
            .collect();
        json!({"Id":p.id,"ServiceId":p.service_id(),"Name":p.name,"ServiceGroup":p.service_group,"ProtocolId":p.protocol_id,"BaseUrl":p.base_url,"Model":p.model,"Models":p.models,"ModelSizePresets":model_sizes,"Relay":p.relay,"Controls":p.controls,"hasKey":self.vault.has(p,&p.base_url)})
    }
    pub fn edit(&self, mut e: Edit) -> Result<String> {
        let _lock = self.gate.lock().unwrap();
        let mut profiles = self.profiles()?;
        let official = e.id.as_deref() == Some("@site");
        let base = canonical_base(if official { SITE } else { &e.base })?;
        let proto = if official {
            "rh-image"
        } else {
            e.protocol.as_str()
        };
        if !site(proto) && crate::generation::creation::preset(proto).is_null() {
            return Err("未知接口协议。".into());
        }
        let mut new_route = None;
        if let Some(source_id) = &e.add_to {
            let source = profiles
                .iter()
                .find(|p| &p.id == source_id)
                .ok_or("原服务已移除。")?;
            if e.id.is_some()
                || source.base_url != base
                || e.model.trim().is_empty()
                || site(&source.protocol_id)
                || site(proto)
                || proto == "comfy-image"
                || source.protocol_id == "comfy-image"
            {
                return Err("请在原服务地址下添加图片或视频模型。".into());
            }
            let service_id = source.service_id().to_owned();
            e.name.clone_from(&source.name);
            e.service_group = Some(source.service_group);
            new_route = Some(Profile {
                id: id(),
                service_id: Some(service_id.clone()),
                keys: source.keys.clone(),
                ..Default::default()
            });
            if let Some(route) = profiles
                .iter_mut()
                .find(|p| p.service_id() == service_id && p.protocol_id == proto)
            {
                let model = e.model.trim();
                let saved = route.id.clone();
                if model != route.model && !route.models.iter().any(|m| m == model) {
                    route.models.push(model.to_owned());
                    save(&self.home.join("connections.json"), &profiles)?;
                }
                return Ok(saved);
            }
        }
        if let Some(c) = &e.controls {
            crate::generation::creation::validate_controls(c)?;
        }
        if !official && (e.model.trim().is_empty() || e.name.trim().is_empty()) {
            return Err("请填写连接名称和模型 ID。".into());
        }
        if custom(proto) {
            e.relay
                .as_ref()
                .ok_or("缺少接口映射。")?
                .validate(&base, kind(proto) == "video")?;
        }
        let pos = if official {
            let active = self.resolve("@site", "image")?;
            profiles.iter().position(|p| p.id == active.id)
        } else {
            profiles.iter().position(|p| Some(&p.id) == e.id.as_ref())
        };
        if !official && e.id.is_some() && pos.is_none() {
            return Err("连接不存在。".into());
        }
        let adding = new_route.is_some();
        let mut p = new_route
            .or_else(|| pos.map(|i| profiles[i].clone()))
            .unwrap_or_else(|| Profile {
                id: id(),
                ..Default::default()
            });
        if official {
            p.extra.insert("DefaultOfficial".into(), Value::Bool(true));
        } else if let Some(group) = e.service_group {
            p.service_group = group;
        }
        p.name = if official {
            "AIGC 创作空间 · 官网".into()
        } else {
            e.name.trim().into()
        };
        if official || base != p.base_url || proto != p.protocol_id {
            p.models.clear();
        }
        p.protocol_id = proto.into();
        p.base_url = base;
        p.model = if official {
            default_model("image")
        } else {
            e.model.trim().into()
        };
        p.relay = if custom(proto) { e.relay } else { None };
        if !official {
            let mut seen = std::collections::HashSet::from([p.model.clone()]);
            p.models = e
                .models
                .unwrap_or(p.models)
                .into_iter()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty() && seen.insert(name.clone()))
                .collect();
        }
        p.controls = if official { None } else { e.controls };
        let siblings = profiles
            .iter_mut()
            .filter(|other| other.id != p.id && other.service_id() == p.service_id())
            .collect::<Vec<_>>();
        if !siblings.is_empty()
            && (site(proto)
                || proto == "comfy-image"
                || siblings.iter().any(|other| other.protocol_id == proto))
        {
            return Err("此服务已有相同协议，或所选协议需要独立连接。".into());
        }
        if !adding && e.session_only {
            self.vault.temporary(&p, &e.key);
        } else if !adding {
            self.vault.put(&mut p, &e.key)?;
        }
        for sibling in siblings {
            sibling.name.clone_from(&p.name);
            sibling.base_url.clone_from(&p.base_url);
            sibling.service_group = p.service_group;
            sibling.keys.clone_from(&p.keys);
        }
        let saved = p.id.clone();
        if let Some(i) = pos {
            profiles[i] = p
        } else {
            profiles.push(p)
        }
        save(&self.home.join("connections.json"), &profiles)?;
        Ok(saved)
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        if self.jobs()?.iter().any(|j| {
            j.profile_id == id
                && matches!(
                    j.status.as_str(),
                    "preparing" | "submitting" | "waiting" | "downloading" | "paused"
                )
        }) {
            return Err("连接仍有进行中或待恢复的任务。".into());
        }
        let mut all = self.profiles()?;
        let i = all.iter().position(|p| p.id == id).ok_or("找不到连接")?;
        let removed = all.remove(i);
        save(&self.home.join("connections.json"), &all)?;
        if !all.iter().any(|p| p.service_id() == removed.service_id()) {
            self.vault.forget(&removed);
        }
        Ok(())
    }
    pub fn key(&self, j: &Job) -> Result<String> {
        let profiles = self.profiles()?;
        match profiles.iter().find(|p| p.id == j.profile_id) {
            Some(p) => self.vault.get(p, &j.base_url),
            None => Ok(String::new()),
        }
    }
}
