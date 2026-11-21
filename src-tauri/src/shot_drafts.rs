use crate::{
    creation::remote,
    jobs::keep_asset,
    model::{Asset, Picked, Result},
    screenplay::ShotLink,
    store::{read, save, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs};

#[derive(Serialize, Deserialize)]
pub struct ShotDraft {
    pub shot: ShotLink,
    pub kind: String,
    pub editor: Value,
    #[serde(default)]
    pub updated: i64,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct StoredDraft {
    #[serde(flatten)]
    pub(crate) draft: ShotDraft,
    pub(crate) inputs: HashMap<String, Asset>,
}

impl Store {
    pub fn save_shot_draft(&self, mut draft: ShotDraft, picks: Vec<Picked>) -> Result<()> {
        if !matches!(draft.kind.as_str(), "image" | "video") || !draft.editor.is_object() {
            return Err("分镜草稿格式无效。".into());
        }
        let mut inputs = HashMap::new();
        for (picked, mut asset) in picks.iter().zip(self.assets(&picks)?) {
            if !remote(&asset.path) {
                asset.path = keep_asset(&self.home, &self.input(&asset.path)?, "参考素材")?;
            }
            inputs.insert(picked.token.clone(), asset);
        }
        let _lock = self.gate.lock().unwrap();
        draft.shot = self.resolve_shot(draft.shot)?;
        // A background suggestion may arrive after a different shot became the last edited one.
        if draft.updated <= 0 {
            draft.updated = chrono::Utc::now().timestamp_millis();
        }
        let dir = self.home.join("分镜草稿");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let filename = format!(
            "{}-{}-{}.json",
            draft.shot.script_id, draft.shot.scene_id, draft.kind
        );
        self.remember_picks(&inputs);
        save(&dir.join(filename), &StoredDraft { draft, inputs })
    }

    pub fn shot_drafts(&self) -> Result<Vec<ShotDraft>> {
        let dir = self.home.join("分镜草稿");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut drafts = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let StoredDraft { mut draft, inputs } = read(&path)?;
            // Removed scenes no longer have an editable draft; existing jobs remain in the library.
            let Ok(shot) = self.resolve_shot(draft.shot) else {
                continue;
            };
            draft.shot = shot;
            self.remember_picks(&inputs);
            drafts.push(draft);
        }
        drafts.sort_by_key(|d| std::cmp::Reverse(d.updated));
        Ok(drafts)
    }
}
