use crate::{model::*, vault::Vault};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

pub fn portable_path(exe: &Path) -> PathBuf {
    if let Some(base) = std::env::var_os("MOBIUS_HOME") {
        return base.into();
    }
    let dir = exe.parent().unwrap_or(Path::new("."));
    #[cfg(target_os = "macos")]
    {
        if dir.ends_with("Contents/MacOS") {
            if let Some(parent) = dir.ancestors().nth(3) {
                return parent.join("Data");
            }
        }
    }
    dir.join("Data")
}
pub(crate) fn read<T: DeserializeOwned>(p: &Path) -> Result<T> {
    let mut s = String::new();
    fs::File::open(p)
        .and_then(|mut file| file.read_to_string(&mut s))
        .map_err(|e| e.to_string())?;
    serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| {
        format!(
            "无法读取 {}：{e}",
            p.file_name().unwrap_or_default().to_string_lossy()
        )
    })
}
pub(crate) fn save<T: Serialize>(p: &Path, v: &T) -> Result<()> {
    let mut f = tempfile::NamedTempFile::new_in(p.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer(f.as_file_mut(), v).map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    f.as_file().sync_all().map_err(|e| e.to_string())?;
    persist(f, p)
}

pub fn persist(mut staged: tempfile::NamedTempFile, target: &Path) -> Result<()> {
    // Windows can temporarily deny a replacement while a preview or file indexer has a handle.
    for attempt in 0..=6 {
        match staged.persist(target) {
            Ok(_) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && attempt < 6
                    && matches!(error.error.raw_os_error(), Some(5 | 32 | 33)) =>
            {
                staged = error.file;
                std::thread::sleep(std::time::Duration::from_millis(10 << attempt));
            }
            Err(error) => {
                return Err(format!(
                    "无法保存 {}：{}",
                    target.file_name().unwrap_or_default().to_string_lossy(),
                    error.error
                ))
            }
        }
    }
    unreachable!()
}
pub fn mime(path: &Path) -> Option<(&'static str, &'static str)> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => ("image", "image/png"),
            "jpeg" | "jpg" | "jfif" => ("image", "image/jpeg"),
            "webp" => ("image", "image/webp"),
            "gif" => ("image", "image/gif"),
            "bmp" => ("image", "image/bmp"),
            "avif" => ("image", "image/avif"),
            "heic" | "heif" => ("image", "image/heif"),
            "tif" | "tiff" => ("image", "image/tiff"),
            "mp4" | "m4v" => ("video", "video/mp4"),
            "mov" => ("video", "video/quicktime"),
            "webm" => ("video", "video/webm"),
            "mkv" => ("video", "video/x-matroska"),
            "avi" => ("video", "video/x-msvideo"),
            "mpeg" | "mpg" => ("video", "video/mpeg"),
            "mp3" => ("audio", "audio/mpeg"),
            "wav" => ("audio", "audio/wav"),
            "m4a" => ("audio", "audio/mp4"),
            "aac" => ("audio", "audio/aac"),
            "ogg" | "opus" => ("audio", "audio/ogg"),
            "flac" => ("audio", "audio/flac"),
            "aiff" => ("audio", "audio/aiff"),
            "wma" => ("audio", "audio/x-ms-wma"),
            _ => return None,
        },
    )
}
pub fn media_format(b: &[u8], video: bool) -> Result<&'static str> {
    let ext = if video && b.get(4..8) == Some(b"ftyp") {
        "mp4"
    } else if video && b.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        "webm"
    } else if !video && b.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if !video && b.starts_with(&[255, 216, 255]) {
        "jpg"
    } else if !video && b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if !video && b.starts_with(b"GIF") {
        "gif"
    } else {
        return Err("结果文件不是所选类型的有效媒体。".into());
    };
    Ok(ext)
}
pub struct Store {
    pub home: PathBuf,
    pub vault: Vault,
    pub(crate) gate: Mutex<()>,
    picks: Mutex<HashMap<String, Asset>>,
}
impl Store {
    pub fn new(home: PathBuf) -> Result<Self> {
        fs::create_dir_all(home.join("tasks"))
            .and_then(|_| fs::create_dir_all(home.join("作品")))
            .map_err(|e| format!("作品数据目录无法写入：{e}"))?;
        Ok(Self {
            home: home.canonicalize().map_err(|e| e.to_string())?,
            vault: Vault::new(),
            gate: Mutex::new(()),
            picks: Mutex::new(HashMap::new()),
        })
    }
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
        json!({"Id":p.id,"Name":p.name,"ProtocolId":p.protocol_id,"BaseUrl":p.base_url,"Model":p.model,"Models":p.models,"Relay":p.relay,"Controls":p.controls,"hasKey":self.vault.has(p,&p.base_url)})
    }
    pub fn edit(&self, e: Edit) -> Result<String> {
        let _lock = self.gate.lock().unwrap();
        let mut profiles = self.profiles()?;
        let official = e.id.as_deref() == Some("@site");
        let base = canonical_base(if official { SITE } else { &e.base })?;
        let proto = if official {
            "rh-image"
        } else {
            e.protocol.as_str()
        };
        if !site(proto) && crate::creation::preset(proto).is_null() {
            return Err("未知接口协议。".into());
        }
        if let Some(c) = &e.controls {
            crate::creation::validate_controls(c)?;
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
        let mut p = pos.map(|i| profiles[i].clone()).unwrap_or_else(|| Profile {
            id: id(),
            ..Default::default()
        });
        if official {
            p.extra.insert("DefaultOfficial".into(), Value::Bool(true));
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
        if e.session_only {
            self.vault.temporary(&p, &e.key);
        } else {
            self.vault.put(&mut p, &e.key)?;
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
        self.vault.forget(&removed);
        Ok(())
    }
    pub fn key(&self, j: &Job) -> Result<String> {
        let profiles = self.profiles()?;
        match profiles.iter().find(|p| p.id == j.profile_id) {
            Some(p) => self.vault.get(p, &j.base_url),
            None => Ok(String::new()),
        }
    }
    pub(crate) fn job_path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err("任务编号无效。".into());
        }
        Ok(self.home.join("tasks").join(format!("{id}.json")))
    }
    pub fn job(&self, id: &str) -> Result<Job> {
        read(&self.job_path(id)?)
    }
    pub fn save_job(&self, j: &Job) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        save(&self.job_path(&j.id)?, j)
    }
    pub fn jobs(&self) -> Result<Vec<Job>> {
        let mut list = vec![];
        for entry in fs::read_dir(self.home.join("tasks")).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|s| s == "json") {
                list.push(read::<Job>(&path)?);
            }
        }
        list.sort_by_key(|j| std::cmp::Reverse(j.time()));
        Ok(list)
    }
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
        let path = crate::creation::public_source(source)?;
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
