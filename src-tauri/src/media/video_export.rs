use crate::domain::{id, kind, Result};
use crate::{app::Core, storage::files::persist};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use tauri::{ipc, State};
use tempfile::NamedTempFile;

const CHUNK: usize = 1024 * 1024;

struct Session {
    original: File,
    size: u64,
    export: Option<(NamedTempFile, PathBuf)>,
}

#[derive(Default)]
pub struct VideoFiles(Mutex<HashMap<String, Session>>);

impl VideoFiles {
    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, Session>>> {
        self.0.lock().map_err(|_| "视频文件暂时不可用。".into())
    }
}

#[derive(Serialize)]
pub struct OpenedVideo {
    token: String,
    size: u64,
}

#[tauri::command]
pub async fn open_video_io(
    s: Core<'_>,
    files: State<'_, VideoFiles>,
    job_id: String,
    writing: bool,
) -> Result<OpenedVideo> {
    let job = s.store.job(&job_id)?;
    if kind(&job.protocol_id) != "video" {
        return Err("请选择已下载的视频作品。".into());
    }
    let path = s.store.original(&job)?;
    let original = File::open(&path).map_err(|e| e.to_string())?;
    let size = original.metadata().map_err(|e| e.to_string())?.len();
    let token = id();
    let export = if writing {
        let dir = s.store.home.join("作品").join("导出");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = path
            .file_stem()
            .ok_or("原视频文件名无效。")?
            .to_string_lossy();
        Some((
            NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?,
            dir.join(format!("{}-{stem}-无音轨", &token[..8])),
        ))
    } else {
        None
    };
    files.sessions()?.insert(
        token.clone(),
        Session {
            original,
            size,
            export,
        },
    );
    Ok(OpenedVideo { token, size })
}

#[tauri::command]
pub async fn read_video_part(
    files: State<'_, VideoFiles>,
    token: String,
    offset: u64,
    length: usize,
) -> Result<ipc::Response> {
    let mut sessions = files.sessions()?;
    let session = sessions.get_mut(&token).ok_or("视频读取已结束。")?;
    if length > CHUNK
        || offset
            .checked_add(length as u64)
            .is_none_or(|end| end > session.size)
    {
        return Err("视频读取范围无效。".into());
    }
    let mut data = vec![0; length];
    session
        .original
        .seek(SeekFrom::Start(offset))
        .and_then(|_| session.original.read_exact(&mut data))
        .map_err(|e| e.to_string())?;
    Ok(ipc::Response::new(data))
}

#[tauri::command]
pub async fn write_video_part(
    files: State<'_, VideoFiles>,
    request: ipc::Request<'_>,
) -> Result<()> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or("缺少视频导出参数。")
    };
    let token = header("x-video-session")?;
    let offset = header("x-offset")?
        .parse::<u64>()
        .map_err(|_| "视频写入位置无效。")?;
    let ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("缺少视频数据。".into());
    };
    let mut sessions = files.sessions()?;
    let session = sessions.get_mut(token).ok_or("视频导出已结束。")?;
    let limit = session
        .size
        .saturating_mul(2)
        .saturating_add(16 * CHUNK as u64);
    if bytes.len() > CHUNK
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > limit)
    {
        return Err("视频写入范围无效。".into());
    }
    let (stage, _) = session.export.as_mut().ok_or("此视频仅供读取。")?;
    stage
        .seek(SeekFrom::Start(offset))
        .and_then(|_| stage.write_all(bytes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_video_io(
    files: State<'_, VideoFiles>,
    token: String,
    format: Option<String>,
) -> Result<Option<String>> {
    let session = files.sessions()?.remove(&token).ok_or("视频操作已结束。")?;
    let Some(format) = format else {
        return Ok(None);
    };
    if !matches!(format.as_str(), "mp4" | "webm") {
        return Err("不支持此视频导出格式。".into());
    }
    let (stage, base) = session.export.ok_or("此视频仅供读取。")?;
    let mut filename = base.into_os_string();
    filename.push(format!(".{format}"));
    let target = PathBuf::from(filename);
    if stage.as_file().metadata().map_err(|e| e.to_string())?.len() == 0 {
        return Err("导出的视频为空。".into());
    }
    stage.as_file().sync_all().map_err(|e| e.to_string())?;
    persist(stage, &target)?;
    Ok(Some(
        target
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned(),
    ))
}
