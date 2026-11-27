use crate::{domain::Result, storage::files::persist};
use image::{
    imageops, AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgba,
    RgbaImage,
};
use serde::Deserialize;
use std::{
    fs,
    io::{BufReader, BufWriter, Cursor, Read, Write},
    path::Path,
};

#[derive(Clone, Deserialize)]
pub struct Resize {
    pub width: u32,
    pub height: u32,
    pub fit: String,
    #[serde(default)]
    pub format: ResizeFormat,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResizeFormat {
    #[default]
    Auto,
    Gif,
    Png,
}

impl Resize {
    pub fn extension(&self, source: &Path) -> Result<&'static str> {
        let gif = super::gif::is_gif(source);
        if self.format == ResizeFormat::Gif && !gif {
            return Err("请选择 GIF 原文件。".into());
        }
        Ok(if gif && self.format != ResizeFormat::Png {
            "gif"
        } else {
            "png"
        })
    }
    pub fn validate(&self) -> Result<()> {
        let pixels = u64::from(self.width) * u64::from(self.height);
        if pixels == 0 || pixels > 50_000_000 || !matches!(self.fit.as_str(), "crop" | "contain") {
            return Err("请使用有效的导出尺寸，单张上限为 5000 万像素。".into());
        }
        Ok(())
    }
}
pub fn gpu_input(source: &Path) -> Result<Vec<u8>> {
    if super::gif::is_gif(source) {
        return Err("GIF 使用原生逐帧导出。".into());
    }
    const MAX_BYTES: u64 = 96 * 1024 * 1024;
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("大文件使用原生导出。".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("大文件使用原生导出。".into());
    }
    let mut decoder = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    let color = decoder.color_type();
    if u64::from(w) * u64::from(h) > 50_000_000
        || color.bits_per_pixel() > u16::from(color.channel_count()) * 8
    {
        return Err("超大尺寸或高位深原图使用原生导出。".into());
    }
    if decoder.icc_profile().map_err(|e| e.to_string())?.is_some() {
        return Err("带独立色彩配置的图片使用原生导出。".into());
    }
    drop(decoder);
    Ok(bytes)
}

pub fn read_image(source: &Path) -> Result<DynamicImage> {
    let mut decoder = ImageReader::open(source)
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut original = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    original.apply_orientation(orientation);
    Ok(original)
}

pub fn write_copy(source: &Path, dest: &Path, spec: Option<&Resize>) -> Result<()> {
    write_output(source, dest, spec, None)
}

fn resize_image(original: DynamicImage, spec: &Resize) -> DynamicImage {
    let (w, h) = (spec.width, spec.height);
    if spec.fit == "crop" {
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
        let left = (w - inner.width()) / 2;
        let top = (h - inner.height()) / 2;
        for (x, y, &pixel) in inner.enumerate_pixels() {
            let mut opaque = pixel;
            let alpha = u16::from(pixel[3]);
            if alpha < 255 {
                for channel in &mut opaque.0[..3] {
                    *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
                }
                opaque[3] = 255;
            }
            canvas.put_pixel(left + x, top + y, opaque);
        }
        DynamicImage::ImageRgba8(canvas)
    }
}

fn write_gif(source: &Path, target: &mut fs::File, spec: &Resize) -> Result<()> {
    let w = u16::try_from(spec.width).map_err(|_| "GIF 宽度不能超过 65535 像素。")?;
    let h = u16::try_from(spec.height).map_err(|_| "GIF 高度不能超过 65535 像素。")?;
    let info = super::gif::GifInfo::read(source)?;
    let raw = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut decoder =
        image::codecs::gif::GifDecoder::new(BufReader::new(raw)).map_err(|e| e.to_string())?;
    decoder.set_limits(image::Limits::default()).map_err(|e| e.to_string())?;
    let mut encoder =
        gif::Encoder::new(BufWriter::new(target), w, h, &[]).map_err(|e| e.to_string())?;
    if let Some(n) = info.repeats {
        let repeat = if n == 0 {
            gif::Repeat::Infinite
        } else {
            gif::Repeat::Finite(n)
        };
        encoder.set_repeat(repeat).map_err(|e| e.to_string())?;
    }
    for frame in decoder.into_frames() {
        let frame = frame.map_err(|e| e.to_string())?;
        let (ms, denominator) = frame.delay().numer_denom_ms();
        let original = DynamicImage::ImageRgba8(frame.into_buffer());
        let mut pixels = resize_image(original, spec).into_rgba8().into_raw();
        let mut output = gif::Frame::from_rgba_speed(w, h, &mut pixels, 10);
        output.delay = (ms / denominator / 10) as u16;
        output.dispose = gif::DisposalMethod::Background;
        encoder.write_frame(&output).map_err(|e| e.to_string())?;
    }
    let mut stream = encoder.into_inner().map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

pub fn validate_rendered(data: &[u8], spec: &Resize) -> Result<()> {
    spec.validate()?;
    if data.len() < 45
        || data.len() > 256 * 1024 * 1024
        || !data.starts_with(b"\x89PNG\r\n\x1a\n")
        || &data[12..16] != b"IHDR"
        || data[16..20] != spec.width.to_be_bytes()
        || data[20..24] != spec.height.to_be_bytes()
        || !data.ends_with(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")
    {
        return Err("渲染结果不是预期尺寸的完整 PNG。".into());
    }
    Ok(())
}

pub fn write_output(
    source: &Path,
    dest: &Path,
    spec: Option<&Resize>,
    rendered: Option<&[u8]>,
) -> Result<()> {
    if dest
        .canonicalize()
        .is_ok_and(|p| source.canonicalize().is_ok_and(|original| p == original))
    {
        return Err("请选择与原件不同的文件名。".into());
    }
    let expected = if let Some(spec) = spec {
        spec.extension(source)?
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
    if let Some(bytes) = rendered {
        if expected != "png" {
            return Err("静帧数据不能用于导出动图。".into());
        }
        target.write_all(bytes).map_err(|e| e.to_string())?;
    } else if let Some(spec) = spec {
        spec.validate()?;
        if expected == "gif" {
            write_gif(source, target.as_file_mut(), spec)?;
        } else {
            resize_image(read_image(source)?, spec)
                .write_to(target.as_file_mut(), ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
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
