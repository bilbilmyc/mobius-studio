use crate::domain::Result;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
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
