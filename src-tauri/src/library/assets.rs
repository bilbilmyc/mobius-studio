use crate::{domain::*, media::formats::mime, storage::store::Store};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};
impl Store {
    pub fn media(&self, j: &Job) -> Option<PathBuf> {
        let name = j.file_name.as_ref()?;
        if name.contains(['/', '\\'])
            || !matches!(
                Path::new(name).extension()?.to_str()?,
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp4" | "webm"
            )
        {
            return None;
        }
        let p = self.home.join("作品").join(name);
        p.is_file().then_some(p)
    }
    pub fn original(&self, j: &Job) -> Result<PathBuf> {
        let file = self
            .media(j)
            .ok_or("原文件已移动")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !file.starts_with(self.home.join("作品")) {
            return Err("作品路径无效。".into());
        }
        Ok(file)
    }
    pub fn input(&self, s: &str) -> Result<PathBuf> {
        let normal = s.replace('\\', "/");
        let p = Path::new(&normal);
        if p.is_absolute() {
            return Ok(p.to_owned());
        }
        if p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err("素材路径无效。".into());
        }
        Ok(self.home.join(p))
    }
    pub fn register(&self, media: &str, path: PathBuf, name: Option<String>) -> Result<Picked> {
        if !path.is_file() || mime(&path).is_none_or(|(k, _)| k != media) {
            return Err("素材类型不匹配，或文件已被移动。".into());
        }
        let name = name.unwrap_or_else(|| path.file_name().unwrap().to_string_lossy().into());
        Ok(self.pick(Asset {
            kind: media.into(),
            name,
            path: path.to_string_lossy().into(),
        }))
    }
    pub fn register_link(&self, media: &str, source: &str) -> Result<Picked> {
        if !matches!(media, "image" | "video" | "audio") {
            return Err("素材类型无效".into());
        }
        let path = crate::generation::creation::public_source(source)?;
        let url = url::Url::parse(&path).map_err(|e| e.to_string())?;
        let name = url
            .path_segments()
            .and_then(|mut it| it.next_back())
            .filter(|s| !s.is_empty())
            .unwrap_or(url.host_str().unwrap_or("素材"))
            .to_owned();
        Ok(self.pick(Asset {
            kind: media.into(),
            name,
            path,
        }))
    }
    pub fn pick(&self, a: Asset) -> Picked {
        let token = id();
        let p = Picked {
            kind: a.kind.clone(),
            name: a.name.clone(),
            token: token.clone(),
        };
        self.picks.lock().unwrap().insert(token, a);
        p
    }
    pub fn assets(&self, list: &[Picked]) -> Result<Vec<Asset>> {
        let picks = self.picks.lock().unwrap();
        list.iter()
            .map(|v| {
                picks
                    .get(&v.token)
                    .filter(|a| a.kind == v.kind)
                    .cloned()
                    .ok_or("请重新选择参考素材。".into())
            })
            .collect()
    }
    pub(crate) fn remember_picks(&self, assets: &HashMap<String, Asset>) {
        self.picks.lock().unwrap().extend(assets.clone());
    }
}
