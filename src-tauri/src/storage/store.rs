use crate::{
    domain::{Asset, Result},
    storage::vault::Vault,
};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
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
pub struct Store {
    pub home: PathBuf,
    pub vault: Vault,
    pub(crate) gate: Mutex<()>,
    pub(crate) picks: Mutex<HashMap<String, Asset>>,
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
}
