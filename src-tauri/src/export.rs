use crate::{model::Result, store::persist};
use image::{imageops, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgba, RgbaImage};
use serde::Deserialize;
use std::{fs, io::Write, path::Path};

#[derive(Clone, Deserialize)]
pub struct Resize {
    pub width: u32,
    pub height: u32,
    pub fit: String,
}
impl Resize {
    pub fn validate(&self) -> Result<()> {
        let pixels = u64::from(self.width) * u64::from(self.height);
        if pixels == 0 || pixels > 50_000_000 || !matches!(self.fit.as_str(), "crop" | "contain") {
            return Err("请使用有效的导出尺寸，单张上限为 5000 万像素。".into());
        }
        Ok(())
    }
}
pub fn write_copy(source: &Path, dest: &Path, spec: Option<&Resize>) -> Result<()> {
    if dest
        .canonicalize()
        .is_ok_and(|p| source.canonicalize().is_ok_and(|original| p == original))
    {
        return Err("请选择与原件不同的文件名。".into());
    }
    let expected = if spec.is_some() {
        "png"
    } else {
        source.extension().and_then(|e| e.to_str()).unwrap_or("")
    };
    if !dest
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected))
    {
        return Err(format!("请使用 .{expected} 扩展名。"));
    }
    let mut target = tempfile::NamedTempFile::new_in(dest.parent().ok_or("导出目录不存在")?)
        .map_err(|e| e.to_string())?;
    if let Some(spec) = spec {
        spec.validate()?;
        let mut decoder = ImageReader::open(source)
            .map_err(|e| e.to_string())?
            .into_decoder()
            .map_err(|e| e.to_string())?;
        let orientation = decoder.orientation().map_err(|e| e.to_string())?;
        let mut original = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
        original.apply_orientation(orientation);
        let (w, h) = (spec.width, spec.height);
        let out = if spec.fit == "crop" {
            // Crop the source before scaling so a panoramic input never creates a huge intermediate canvas.
            let (ow, oh) = (u64::from(original.width()), u64::from(original.height()));
            let (cw, ch) = if ow * u64::from(h) > oh * u64::from(w) {
                ((oh * u64::from(w) / u64::from(h)).max(1), oh)
            } else {
                (ow, (ow * u64::from(h) / u64::from(w)).max(1))
            };
            original
                .crop_imm(
                    ((ow - cw) / 2) as u32,
                    ((oh - ch) / 2) as u32,
                    cw as u32,
                    ch as u32,
                )
                .resize_exact(w, h, imageops::FilterType::Lanczos3)
        } else {
            let inner = original
                .resize(w, h, imageops::FilterType::Lanczos3)
                .to_rgba8();
            let mut canvas = RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 255]));
            imageops::overlay(
                &mut canvas,
                &inner,
                i64::from((w - inner.width()) / 2),
                i64::from((h - inner.height()) / 2),
            );
            DynamicImage::ImageRgba8(canvas)
        };
        out.write_to(target.as_file_mut(), ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    } else {
        std::io::copy(
            &mut fs::File::open(source).map_err(|e| e.to_string())?,
            target.as_file_mut(),
        )
        .map_err(|e| e.to_string())?;
    }
    target
        .flush()
        .and_then(|_| target.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    persist(target, dest)
}
