use crate::{
    domain::ShotLink,
    domain::{Asset, Picked, Result},
    generation::creation::remote,
    generation::jobs::keep_asset,
    storage::files::{read, save},
    storage::store::Store,
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
pub struct FreeDraft {
    pub kind: String,
    pub editor: Value,
    pub updated: i64,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct StoredDraft<T = ShotDraft> {
    #[serde(flatten)]
    pub(crate) draft: T,
    pub(crate) inputs: HashMap<String, Asset>,
}

impl Store {
    fn draft_inputs(
        &self,
        kind: &str,
        editor: &Value,
        picks: &[Picked],
    ) -> Result<HashMap<String, Asset>> {
        if !matches!(kind, "image" | "video") || !editor.is_object() {
            return Err("创作草稿格式无效。".into());
        }
        let mut inputs = HashMap::new();
        for (picked, mut asset) in picks.iter().zip(self.assets(picks)?) {
            if !remote(&asset.path) {
                asset.path = keep_asset(&self.home, &self.input(&asset.path)?, "参考素材")?;
            }
            inputs.insert(picked.token.clone(), asset);
        }
        Ok(inputs)
    }

    pub fn save_free_draft(&self, draft: FreeDraft, picks: Vec<Picked>) -> Result<()> {
        let inputs = self.draft_inputs(&draft.kind, &draft.editor, &picks)?;
        let _lock = self.gate.lock().unwrap();
        let dir = self.home.join("自由创作草稿");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{}.json", draft.kind));
        self.remember_picks(&inputs);
        save(&file, &StoredDraft { draft, inputs })
    }

    pub fn free_drafts(&self) -> Result<Vec<FreeDraft>> {
        let mut drafts = Vec::new();
        for kind in ["image", "video"] {
            let path = self.home.join("自由创作草稿").join(format!("{kind}.json"));
            if path.is_file() {
                let StoredDraft { draft, inputs }: StoredDraft<FreeDraft> = read(&path)?;
                self.remember_picks(&inputs);
                drafts.push(draft);
            }
        }
        Ok(drafts)
    }

    pub fn save_shot_draft(&self, mut draft: ShotDraft, picks: Vec<Picked>) -> Result<()> {
        let inputs = self.draft_inputs(&draft.kind, &draft.editor, &picks)?;
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
            let StoredDraft { mut draft, inputs }: StoredDraft = read(&path)?;
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
