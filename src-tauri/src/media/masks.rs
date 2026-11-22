use crate::{
    app::Core,
    domain::{Asset, Picked, Result},
    storage::store::Store,
};
use image::ImageFormat;
use std::io::Write;
pub(crate) fn validate(s: &Store, images: &[Asset], mask: &Asset) -> Result<()> {
    let first = images.first().ok_or("遮罩重绘需要一张底图。")?;
    if images
        .iter()
        .any(|a| crate::generation::creation::remote(&a.path))
        || mask.kind != "image"
    {
        return Err("遮罩重绘请使用本地底图。".into());
    }
    let path = s.input(&mask.path)?;
    let shape = image::image_dimensions(s.input(&first.path)?).map_err(|e| e.to_string())?;
    if image::image_dimensions(&path).map_err(|e| e.to_string())? != shape
        || u64::from(shape.0) * u64::from(shape.1) > 32_000_000
    {
        return Err("遮罩与底图必须同尺寸且不超过 3200 万像素。".into());
    }
    let image = image::open(path).map_err(|e| e.to_string())?;
    if !image.color().has_alpha() || !image.to_rgba8().pixels().any(|p| p[3] < 255) {
        return Err("请在底图上画出要重绘的区域。".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn save_mask(s: Core<'_>, request: tauri::ipc::Request<'_>) -> Result<Picked> {
    save_png(s, request, "局部重绘遮罩.png").await
}
#[tauri::command]
pub async fn save_captured_frame(s: Core<'_>, request: tauri::ipc::Request<'_>) -> Result<Picked> {
    save_png(s, request, "视频当前帧.png").await
}
async fn save_png(
    s: Core<'_>,
    request: tauri::ipc::Request<'_>,
    name: &'static str,
) -> Result<Picked> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要 PNG 图片。".into());
    };
    if bytes.len() > 20 * 1024 * 1024 || image::guess_format(bytes).ok() != Some(ImageFormat::Png) {
        return Err("PNG 格式或大小无效。".into());
    }
    let bytes = bytes.clone();
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = tempfile::tempdir_in(&s.store.home).map_err(|e| e.to_string())?;
        let p = tmp.path().join(name);
        std::fs::File::create(&p)
            .and_then(|mut f| f.write_all(&bytes))
            .map_err(|e| e.to_string())?;
        let kept = crate::generation::jobs::freeze_asset(&s.store.home, &p)?;
        s.store
            .register("image", s.store.input(&kept)?, Some(name.into()))
    })
    .await
    .map_err(|e| e.to_string())?
}
