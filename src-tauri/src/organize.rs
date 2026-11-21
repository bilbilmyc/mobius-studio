use crate::{
    jobs::freeze_asset,
    model::{id, valid_id, Asset, Picked, Result},
    store::{read, save},
    Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize)]
pub struct Card {
    id: String,
    name: String,
    category: String,
    description: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
pub struct CardEdit {
    id: Option<String>,
    name: String,
    category: String,
    description: String,
    items: Vec<Picked>,
}
#[tauri::command]
pub async fn save_card(s: Core<'_>, input: CardEdit) -> Result<()> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if input.name.trim().is_empty()
            || !matches!(input.category.as_str(), "角色" | "场景")
            || input.name.chars().count() > 120
            || input.description.chars().count() > 4000
        {
            return Err("请填写卡片名称与有效分类。".into());
        }
        if input.items.is_empty() || input.items.len() > 24 {
            return Err("每张卡片可保存 1–24 张参考图。".into());
        }
        let mut assets = s.store.assets(&input.items)?;
        for a in &mut assets {
            if a.kind != "image" || crate::creation::remote(&a.path) {
                return Err("请使用本地图片或作品库原图创建素材卡。".into());
            }
            a.path = freeze_asset(&s.store.home, &s.store.input(&a.path)?)?;
        }
        let id = input.id.unwrap_or_else(id);
        if !valid_id(&id) {
            return Err("卡片编号无效。".into());
        }
        let card = Card {
            id: id.clone(),
            name: input.name.trim().into(),
            category: input.category,
            description: input.description,
            assets,
        };
        let _lock = s.store.gate.lock().unwrap();
        let path = s.store.home.join("素材卡.json");
        let mut all: BTreeMap<String, Card> = if path.exists() {
            read(&path)?
        } else {
            Default::default()
        };
        all.insert(id, card);
        save(&path, &all)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn list_cards(s: Core) -> Result<Vec<Value>> {
    let p = s.store.home.join("素材卡.json");
    if !p.exists() {
        return Ok(vec![]);
    }
    let all: BTreeMap<String, Card> = read(&p)?;
    Ok(all
        .into_values()
        .map(|c| {
            json!({"id":c.id,"name":c.name,"category":c.category,"description":c.description,
        "items":c.assets.into_iter().map(|a|s.store.pick(a)).collect::<Vec<_>>()})
        })
        .collect())
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Mark {
    favorite: bool,
    archived: bool,
    tags: Vec<String>,
}
#[tauri::command]
pub fn library_marks(s: Core) -> Result<BTreeMap<String, Mark>> {
    let p = s.store.home.join("作品整理.json");
    if p.exists() {
        read(&p)
    } else {
        Ok(Default::default())
    }
}
#[tauri::command]
pub fn mark_work(s: Core, id: String, mut mark: Mark) -> Result<()> {
    s.store.job(&id)?;
    let mut seen = std::collections::HashSet::new();
    mark.tags = mark
        .tags
        .into_iter()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty() && seen.insert(t.clone()))
        .collect();
    if mark.tags.len() > 32 || mark.tags.iter().any(|t| t.chars().count() > 80) {
        return Err("标签过多或过长。".into());
    }
    let _guard = s.store.gate.lock().unwrap();
    let p = s.store.home.join("作品整理.json");
    let mut all: BTreeMap<String, Mark> = if p.exists() {
        read(&p)?
    } else {
        Default::default()
    };
    all.insert(id, mark);
    save(&p, &all)
}

#[tauri::command]
pub fn candidate_choice(s: Core, id: String) -> Result<Option<String>> {
    let job = s.store.job(&id)?;
    if let Some(link) = job.shot {
        return Ok(s
            .store
            .script(&link.script_id)?
            .finals
            .get(&link.scene_id)
            .and_then(|f| f.get("image"))
            .cloned());
    }
    let p = s.store.home.join("候选定稿").join(format!("{id}.json"));
    if p.is_file() {
        read(&p).map(Some)
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub fn choose_candidate(s: Core, id: String) -> Result<()> {
    let j = s.store.job(&id)?;
    let first = j
        .candidate_ids
        .first()
        .filter(|r| valid_id(r))
        .ok_or("该记录没有候选组。")?;
    if j.status != "done" || !j.candidate_ids.contains(&id) {
        return Err("请选择已完成的候选。".into());
    }
    s.store.original(&j)?;
    if let Some(link) = &j.shot {
        s.store
            .set_final(&link.script_id, &link.scene_id, "image", Some(&j.id))?;
    } else {
        let dir = s.store.home.join("候选定稿");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        save(&dir.join(format!("{first}.json")), &id)?;
    }
    s.changed();
    Ok(())
}
