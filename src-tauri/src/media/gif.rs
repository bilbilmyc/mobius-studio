use crate::domain::Result;
use serde::{Deserialize, Serialize};
use std::{fs::File, io::BufReader, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifInfo {
    pub width: u16,
    pub height: u16,
    pub frames: u32,
    pub duration_ms: u64,
    pub frame_ms: Option<u32>,
    /// None plays once, zero loops indefinitely, positive values repeat that many times.
    pub repeats: Option<u16>,
}

pub fn is_gif(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gif"))
}

impl GifInfo {
    pub fn read(path: &Path) -> Result<Self> {
        let mut options = gif::DecodeOptions::new();
        options.skip_frame_decoding(true);
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mut reader = options
            .read_info(BufReader::new(file))
            .map_err(|e| e.to_string())?;
        let mut info = Self {
            width: reader.width(),
            height: reader.height(),
            frames: 0,
            duration_ms: 0,
            frame_ms: None,
            repeats: None,
        };
        while let Some(frame) = reader.next_frame_info().map_err(|e| e.to_string())? {
            let ms = u32::from(frame.delay) * 10;
            if info.frames == 0 {
                info.frame_ms = Some(ms);
            } else if info.frame_ms != Some(ms) {
                info.frame_ms = None;
            }
            info.frames += 1;
            info.duration_ms += u64::from(ms);
        }
        if info.frames == 0 {
            return Err("GIF 中没有画面。".into());
        }
        info.repeats = match reader.repeat() {
            gif::Repeat::Infinite => Some(0),
            gif::Repeat::Finite(0) => None,
            gif::Repeat::Finite(n) => Some(n),
        };
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::export::{write_copy, Resize, ResizeFormat};
    use image::AnimationDecoder;
    use std::borrow::Cow;

    #[test]
    fn resizing_preserves_composited_frames_delays_and_loop_mode() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.gif");
        let dest = dir.path().join("resized.gif");
        let first = dir.path().join("first.png");
        for repeats in [None, Some(0), Some(3)] {
            let mut enc = gif::Encoder::new(
                File::create(&source).unwrap(),
                3,
                2,
                &[255, 0, 0, 0, 0, 255],
            )
            .unwrap();
            if let Some(n) = repeats {
                enc.set_repeat(if n == 0 {
                    gif::Repeat::Infinite
                } else {
                    gif::Repeat::Finite(n)
                })
                .unwrap();
            }
            enc.write_frame(&gif::Frame {
                width: 3,
                height: 2,
                delay: 4,
                dispose: gif::DisposalMethod::Keep,
                buffer: Cow::Owned(vec![0; 6]),
                ..Default::default()
            })
            .unwrap();
            enc.write_frame(&gif::Frame {
                left: 2,
                width: 1,
                height: 2,
                delay: 12,
                buffer: Cow::Owned(vec![1; 2]),
                ..Default::default()
            })
            .unwrap();
            enc.into_inner().unwrap();
            let mut resize = Resize {
                width: 6,
                height: 4,
                fit: "crop".into(),
                format: ResizeFormat::Auto,
            };
            write_copy(&source, &dest, Some(&resize)).unwrap();
            assert_eq!(
                GifInfo::read(&dest).unwrap(),
                GifInfo {
                    width: 6,
                    height: 4,
                    frames: 2,
                    duration_ms: 160,
                    frame_ms: None,
                    repeats
                }
            );
            let decoder =
                image::codecs::gif::GifDecoder::new(BufReader::new(File::open(&dest).unwrap()))
                    .unwrap();
            let frames = decoder.into_frames().collect_frames().unwrap();
            assert_eq!(frames[0].delay().numer_denom_ms(), (40, 1));
            assert_eq!(frames[1].delay().numer_denom_ms(), (120, 1));
            assert_eq!(frames[0].buffer().get_pixel(5, 0).0, [255, 0, 0, 255]);
            assert_eq!(frames[1].buffer().get_pixel(5, 0).0, [0, 0, 255, 255]);
            let composited = image::RgbaImage::from_fn(3, 2, |x, _| {
                if x == 2 {
                    image::Rgba([0, 0, 255, 255])
                } else {
                    image::Rgba([255, 0, 0, 255])
                }
            });
            let expected =
                image::imageops::resize(&composited, 6, 4, image::imageops::FilterType::Lanczos3);
            assert_eq!(frames[1].buffer(), &expected);
            resize.format = ResizeFormat::Png;
            write_copy(&source, &first, Some(&resize)).unwrap();
            assert_eq!(image::open(&first).unwrap().to_rgba8(), *frames[0].buffer());
        }
    }
}
