use crate::{
    app::Core,
    domain::{id, kind, Picked, Result},
    storage::store::Store,
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn program(home: &Path, name: &str) -> Command {
    let resolved = crate::media::media_tools::locate(home, name);
    let sibling = std::env::current_exe().ok().and_then(|p| {
        p.parent().map(|d| {
            d.join("tools")
                .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
        })
    });
    let mut cmd = Command::new(
        resolved
            .or_else(|| sibling.filter(|p| p.is_file()))
            .unwrap_or_else(|| PathBuf::from(name)),
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
fn run(cmd: &mut Command) -> Result<Output> {
    let output = cmd
        .output()
        .map_err(|e| format!("请安装 FFmpeg（含 ffprobe）并加入 PATH。{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "媒体处理失败：{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .rev()
                .take(500)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(output)
}
fn metadata(home: &Path, path: &Path) -> Result<Value> {
    let output = run(program(home, "ffprobe")
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(path))?;
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}
fn stitch(home: &Path, files: &[PathBuf], dest: &Path) -> Result<()> {
    if files.is_empty() {
        return Err("缺少视频定稿。".into());
    }
    let temp =
        tempfile::tempdir_in(dest.parent().ok_or("成片目录无效。")?).map_err(|e| e.to_string())?;
    let mut canvas = None;
    let mut list = String::new();
    for (i, path) in files.iter().enumerate() {
        let info = metadata(home, path)?;
        let streams = info["streams"].as_array().ok_or("视频没有轨道。")?;
        let video = streams
            .iter()
            .find(|v| v["codec_type"] == "video")
            .ok_or("文件没有画面轨道。")?;
        let w = video["width"].as_u64().ok_or("无法读取视频宽度。")?;
        let h = video["height"].as_u64().ok_or("无法读取视频高度。")?;
        let rotated = video["side_data_list"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|v| v["rotation"].as_i64().unwrap_or(0) % 180 != 0)
        });
        let (w, h) = if rotated { (h, w) } else { (w, h) };
        let (w, h) = *canvas.get_or_insert((w.max(2) / 2 * 2, h.max(2) / 2 * 2));
        let has_audio = streams.iter().any(|v| v["codec_type"] == "audio");
        let name = format!("clip-{i}.mp4");
        let picture = temp.path().join("picture.mp4");
        let filter = format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30");
        run(program(home, "ffmpeg")
            .args(["-nostdin", "-v", "error", "-y", "-i"])
            .arg(path)
            .args([
                "-map", "0:v:0", "-an", "-vf", &filter, "-c:v", "libx264", "-preset", "veryfast",
                "-pix_fmt", "yuv420p",
            ])
            .arg(&picture))?;
        // Anchor both tracks to the actual encoded picture, including sources with no declared duration.
        // An unbounded silent/padded track with -shortest can otherwise extend short clips on older FFmpeg.
        let encoded = metadata(home, &picture)?;
        let duration = encoded["streams"][0]["duration"]
            .as_str()
            .filter(|s| s.parse::<f64>().is_ok_and(|n| n.is_finite() && n > 0.0))
            .ok_or("无法确定归一化画面的时长。")?;
        let mut cmd = program(home, "ffmpeg");
        cmd.current_dir(temp.path())
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(&picture);
        if has_audio {
            cmd.arg("-i").arg(path);
        } else {
            cmd.args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
        }
        run(cmd.args([
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", "apad", "-t", duration,
            "-c:a", "aac", "-ar", "48000", "-ac", "2", &name,
        ]))?;
        list.push_str(&format!("file '{name}'\n"));
    }
    fs::write(temp.path().join("clips.txt"), list).map_err(|e| e.to_string())?;
    run(program(home, "ffmpeg")
        .current_dir(temp.path())
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "1",
            "-i",
            "clips.txt",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(dest))?;
    Ok(())
}
pub(crate) fn deliver(s: &Store, script_id: &str, combine: bool) -> Result<String> {
    let script = s.script(script_id)?;
    let parent = s.home.join("作品").join("导出");
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let stage = tempfile::tempdir_in(&parent).map_err(|e| e.to_string())?;
    let mut videos = vec![];
    let mut text = String::from("镜号\t场景\t台词\t视频\t图片\n");
    for (i, scene) in script.story.scenes.iter().enumerate() {
        let finals = script.finals.get(&scene.id);
        let mut names = vec![];
        for media in ["video", "image"] {
            let Some(job_id) = finals.and_then(|f| f.get(media)) else {
                if media == "video" {
                    return Err(format!("第 {} 镜缺少视频定稿。", i + 1));
                }
                names.push(String::new());
                continue;
            };
            let job = s.job(job_id)?;
            if kind(&job.protocol_id) != media
                || !job
                    .shot
                    .as_ref()
                    .is_some_and(|l| l.script_id == script_id && l.scene_id == scene.id)
            {
                return Err("定稿关联无效。".into());
            }
            let source = s
                .original(&job)
                .map_err(|_| format!("第 {} 镜的定稿原件缺失。", i + 1))?;
            let name = format!(
                "{:03}-{}.{}",
                i + 1,
                if media == "video" { "视频" } else { "图片" },
                source
                    .extension()
                    .and_then(|v| v.to_str())
                    .ok_or("定稿类型无效。")?
            );
            let target = stage.path().join(&name);
            fs::copy(&source, &target).map_err(|e| e.to_string())?;
            if media == "video" {
                videos.push(target)
            }
            names.push(name);
        }
        let line = |s: &str| s.replace(['\r', '\n', '\t'], " ");
        text.push_str(&format!(
            "{:03}\t{}\t{}\t{}\t{}\n",
            i + 1,
            line(&scene.heading),
            line(&scene.dialogue),
            names[0],
            names[1]
        ));
    }
    fs::write(stage.path().join("镜头与台词.tsv"), text).map_err(|e| e.to_string())?;
    if combine {
        stitch(&s.home, &videos, &stage.path().join("整片.mp4"))?;
    }
    let dir = parent.join(format!("整片-{}", id()));
    fs::rename(stage.path(), &dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}
#[tauri::command]
pub async fn deliver_film(s: Core<'_>, script_id: String, combine: bool) -> Result<String> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || deliver(&s.store, &script_id, combine))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn extract_frame(s: Core<'_>, id: String, seconds: f64) -> Result<Picked> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !seconds.is_finite() || seconds < 0. {
            return Err("播放位置无效。".into());
        }
        let job = s.store.job(&id)?;
        if kind(&job.protocol_id) != "video" {
            return Err("请选择视频作品。".into());
        }
        let path = s.store.original(&job)?;
        let tmp = tempfile::tempdir_in(&s.store.home).map_err(|e| e.to_string())?;
        let frame = tmp.path().join("frame.png");
        run(program(&s.store.home, "ffmpeg")
            .args([
                "-nostdin",
                "-v",
                "error",
                "-ss",
                &format!("{seconds:.6}"),
                "-i",
            ])
            .arg(path)
            .args(["-frames:v", "1"])
            .arg(&frame))?;
        if !frame.is_file() {
            return Err("此位置没有可读取的视频帧，请向前移动一帧。".into());
        }
        let kept = crate::generation::jobs::freeze_asset(&s.store.home, &frame)?;
        s.store.register(
            "image",
            s.store.input(&kept)?,
            Some(format!("视频帧-{seconds:.2}s.png")),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
