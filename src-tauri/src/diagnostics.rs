use crate::{domain::Result, storage::store::portable_path};
use chrono::Local;
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const FILE: &str = "mobius.log";
const LIMIT: u64 = 2 * 1024 * 1024;
struct RuntimeLog {
    directory: PathBuf,
    lock: Mutex<()>,
}
static LOG: OnceLock<RuntimeLog> = OnceLock::new();

fn append(directory: &Path, line: &str, limit: u64) -> io::Result<()> {
    let path = directory.join(FILE);
    if fs::metadata(&path).is_ok_and(|m| m.len() + line.len() as u64 > limit) {
        // A log viewer can temporarily prevent renaming on Windows. Keep writing until it releases the file.
        let _ = fs::rename(&path, directory.join("mobius.1.log"));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

pub(crate) fn init(identifier: &str) {
    #[cfg(target_os = "macos")]
    let user_dir = dirs::home_dir().map(|p| p.join("Library/Logs").join(identifier));
    #[cfg(not(target_os = "macos"))]
    let user_dir = dirs::data_local_dir().map(|p| p.join(identifier).join("logs"));
    let override_dir = std::env::var_os("MOBIUS_HOME").map(|p| PathBuf::from(p).join("logs"));
    let portable = (!cfg!(feature = "installed"))
        .then(|| {
            std::env::current_exe()
                .ok()
                .map(|p| portable_path(&p).join("logs"))
        })
        .flatten();
    let candidates = if let Some(dir) = override_dir {
        vec![dir]
    } else {
        portable.into_iter().chain(user_dir).collect()
    };
    let directory = candidates
        .iter()
        .find(|dir| {
            fs::create_dir_all(dir)
                .and_then(|_| append(dir, "", LIMIT))
                .is_ok()
        })
        .or(candidates.first())
        .cloned();
    if let Some(directory) = directory {
        let _ = LOG.set(RuntimeLog {
            directory,
            lock: Mutex::new(()),
        });
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(location) = info.location() {
            let file = location
                .file()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("native");
            let message = info
                .payload()
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| info.payload().downcast_ref::<&str>().copied())
                .unwrap_or("");
            entry(
                "ERROR",
                "panic",
                &format!(
                    "原生线程异常 {file}:{}:{} {}",
                    location.line(),
                    location.column(),
                    reason(message)
                ),
            );
        }
        previous(info);
    }));
}

pub(crate) fn entry(level: &str, area: &str, detail: &str) {
    if let Some(log) = LOG.get() {
        let line = format!(
            "{} {level} [{}] {area} | {detail}\n",
            Local::now().format("%Y-%m-%d %H:%M:%S%.3f %:z"),
            std::process::id()
        );
        let _lock = log.lock.lock().unwrap_or_else(|p| p.into_inner());
        let _ = append(&log.directory, &line, LIMIT);
    }
}

// Raw error text can contain arbitrary upstream replies, prompts and signed file URLs.
// Keep diagnostic codes and categories, without copying that text to a persistent file.
fn reason(error: &str) -> String {
    for prefix in ["HTTP ", "官网返回 ", "os error "] {
        if let Some((_, rest)) = error.split_once(prefix) {
            let digits: String = rest
                .chars()
                .take_while(char::is_ascii_digit)
                .take(8)
                .collect();
            if !digits.is_empty() {
                return format!("{prefix}{digits}");
            }
        }
    }
    let lower = error.to_ascii_lowercase();
    if let Some((_, rest)) = lower.split_once("0x") {
        let code: String = rest
            .chars()
            .take_while(char::is_ascii_hexdigit)
            .take(9)
            .collect();
        if code.len() == 8 {
            return format!("系统错误 0x{code}");
        }
    }
    for (needles, label) in [
        (&["timeout", "timed out", "超时"][..], "等待超时"),
        (
            &[
                "无法连接",
                "连接中断",
                "connection refused",
                "error sending request",
            ],
            "网络连接失败",
        ),
        (
            &["permission denied", "access denied", "权限", "拒绝访问"],
            "权限不足",
        ),
        (&["no space", "磁盘空间", "空间不足"], "磁盘空间不足"),
        (&["数据目录已在", "共享冲突"], "数据目录被占用"),
        (&["webview2", "webview runtime"], "WebView 运行环境异常"),
        (&["api key", "密钥", "鉴权", "凭据"], "凭据或配置错误"),
        (
            &["invalid args", "invalid type", "json", "格式"],
            "参数或数据格式错误",
        ),
        (
            &["不存在", "找不到", "not found", "no such file"],
            "找不到所需资源",
        ),
        (&["无法读取", "读取失败", "failed to read"], "读取失败"),
        (&["无法保存", "无法写入", "保存失败"], "写入失败"),
        (&["已移除", "已更换"], "所选连接或资源已变更"),
        (&["ffmpeg", "ffprobe"], "媒体工具执行失败"),
        (&["不支持", "unsupported"], "当前模型或环境不支持这项操作"),
        (&["请填写", "无效", "不能为空"], "输入未通过校验"),
        (
            &["cannot read properties of", "cannot access property"],
            "读取了空对象的属性",
        ),
        (&["is not a function"], "调用了无效函数"),
        (&["is not defined"], "引用未定义的变量"),
        (&["maximum call stack", "stack overflow"], "调用栈溢出"),
    ] {
        if needles.iter().any(|s| lower.contains(s)) {
            return label.into();
        }
    }
    "操作失败".into()
}

pub(crate) fn failure(area: &str, error: &str) {
    entry("ERROR", area, &reason(error));
}

pub(crate) fn task_failure(id: &str, stage: &str, status: &str, error: &str) {
    if crate::domain::valid_id(id) {
        let phase = match stage {
            "preparing" | "submitting" | "waiting" | "downloading" => stage,
            _ => "unknown",
        };
        entry(
            "ERROR",
            "generation",
            &format!("task={id} phase={phase} status={status} {}", reason(error)),
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum IssueKind {
    Command,
    Script,
    Rejection,
    React,
}

#[tauri::command]
pub(crate) fn report_runtime_issue(
    kind: IssueKind,
    operation: String,
    message: String,
    line: Option<u32>,
    column: Option<u32>,
) {
    let label = match kind {
        IssueKind::Command => "IPC",
        IssueKind::Script => "JavaScript",
        IssueKind::Rejection => "Promise",
        IssueKind::React => "React",
    };
    let operation = if operation.len() <= 80
        && operation
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
    {
        &operation
    } else {
        "frontend"
    };
    let position = line
        .map(|n| format!(":{n}:{}", column.unwrap_or(0)))
        .unwrap_or_default();
    entry(
        "ERROR",
        label,
        &format!("{operation}{position} {}", reason(&message)),
    );
}

pub(crate) fn file_path() -> Result<PathBuf> {
    let log = LOG.get().ok_or("系统未提供可用的日志目录。")?;
    let path = log.directory.join(FILE);
    if !path.is_file() {
        return Err(format!(
            "无法创建运行日志，请检查目录的写入权限：{}",
            log.directory.display()
        ));
    }
    Ok(path)
}

#[tauri::command]
pub(crate) fn open_log_folder(app: AppHandle) -> Result<()> {
    let path = file_path()?;
    let dir = path.parent().ok_or("日志目录无效。")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_log_rotates_and_keeps_only_safe_failure_metadata() {
        let dir = tempfile::tempdir().unwrap();
        for line in ["first\n", "other\n", "final\n"] {
            append(dir.path(), line, 8).unwrap();
        }
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE)).unwrap(),
            "final\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("mobius.1.log")).unwrap(),
            "other\n"
        );
        assert_eq!(
            reason("HTTP 403 private-token https://signed.example/?sig=test"),
            "HTTP 403"
        );
        assert_eq!(reason("private prompt and signed address"), "操作失败");
        let busy = tempfile::tempdir().unwrap();
        fs::create_dir(busy.path().join("mobius.1.log")).unwrap();
        append(busy.path(), "first\n", 8).unwrap();
        append(busy.path(), "other\n", 8).unwrap();
        assert_eq!(
            fs::read_to_string(busy.path().join(FILE)).unwrap(),
            "first\nother\n"
        );
    }
}
