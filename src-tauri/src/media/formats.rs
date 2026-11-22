use crate::domain::Result;
use std::path::Path;
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
