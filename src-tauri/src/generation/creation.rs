use crate::domain::*;
use crate::storage::store::Store;
use serde_json::{json, Value};
use std::{fs, sync::OnceLock};

pub fn preset(proto: &str) -> &'static Value {
    static TABLE: OnceLock<Value> = OnceLock::new();
    &TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/GenerationPresets.json"))
            .expect("generation presets")
    })[proto]
}
pub fn remote(path: &str) -> bool {
    path.starts_with("https://")
}
pub fn public_source(link: &str) -> Result<String> {
    let u = url::Url::parse(link.trim()).map_err(|_| "请输入完整的 HTTPS 素材地址。")?;
    if u.scheme() != "https"
        || !u.has_host()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("素材链接须使用 HTTPS，并且地址中不能包含登录信息或片段。".into());
    }
    Ok(u.to_string())
}
pub fn dimensions(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.split_once('x')?;
    let (w, h) = (w.parse().ok()?, h.parse().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}
pub fn ratio(size: &str) -> String {
    if let Some((w, h)) = dimensions(size) {
        let (mut a, mut b) = (w, h);
        while b != 0 {
            (a, b) = (b, a % b)
        }
        return format!("{}:{}", w / a, h / a);
    }
    size.into()
}
pub fn validate_controls(c: &Controls) -> Result<()> {
    if c.sizes
        .iter()
        .chain(&c.resolutions)
        .chain(&c.ratios)
        .any(|x| x.is_empty() || x.len() > 64)
        || c.seconds.contains(&0)
    {
        return Err("参数选项中有空值或无效时长。".into());
    }
    Ok(())
}
fn prepare_openai_image_output(j: &mut Job) -> Result<()> {
    let fields = preset("openai-image")["gifParameters"].as_array().unwrap();
    match j.settings.get("output_format") {
        Some(format) if format == "gif" => {
            if j.mask.is_some() {
                return Err("GIF 动图不支持遮罩，请先移除遮罩。".into());
            }
            for field in fields {
                let value = j
                    .settings
                    .entry(string(&field["key"]))
                    .or_insert_with(|| field["default"].clone());
                let min = field["min"].as_u64().unwrap();
                let max = field["max"].as_u64().unwrap();
                if !value.as_u64().is_some_and(|n| (min..=max).contains(&n)) {
                    return Err(format!(
                        "{}须为 {min}–{max} 之间的整数。",
                        string(&field["label"])
                    ));
                }
            }
        }
        Some(format) if format != "" => return Err("图片输出格式无效。".into()),
        _ => {
            j.settings.remove("output_format");
            for field in fields {
                j.settings.remove(string(&field["key"]));
            }
        }
    }
    Ok(())
}
pub fn prepare_with_limit(
    j: &mut Job,
    c: Option<&Controls>,
    store: &Store,
    limit: Option<usize>,
) -> Result<()> {
    if j.prompt.trim().is_empty() {
        return Err("请填写提示词。".into());
    }
    let table = preset(&j.protocol_id);
    let media = kind(&j.protocol_id);
    let mode = j
        .settings
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if !j.assets.is_empty()
                && matches!(j.protocol_id.as_str(), "openai-video" | "ark-video")
            {
                "first_frame"
            } else {
                string(&table["modes"][0])
            }
        })
        .to_owned();
    let builtin = table["modes"]
        .as_array()
        .is_some_and(|m| m.iter().any(|v| v == &mode));
    if !builtin
        && !j
            .relay
            .as_ref()
            .is_some_and(|r| r.workflows.contains_key(&mode))
    {
        return Err("此连接尚未配置所选创作方式。".into());
    }
    j.settings.insert("mode".into(), json!(mode));
    if let Some(r) = &j.relay {
        let body = r.workflow(&mode).1;
        if (body.contains("{{width}}") || body.contains("{{height}}"))
            && dimensions(&j.size).is_none()
        {
            return Err(
                "此接口需要像素宽高，请在连接中添加宽×高尺寸，或启用自定义像素尺寸。".into(),
            );
        }
        for p in &r.parameters {
            let k = format!("params.{}", p.key);
            if !body.contains(&format!("{{{{{k}}}}}")) {
                continue;
            }
            let v = j.settings.entry(k).or_insert_with(|| p.initial.clone());
            if !p.accepts(v) {
                return Err(format!("请检查「{}」的取值。", p.label));
            }
        }
    }
    let n = j.assets.len();
    let images = j.assets.iter().filter(|a| a.kind == "image").count();
    let max = limit.unwrap_or_else(|| table["maxImages"].as_u64().unwrap_or(1) as usize);
    let valid = match mode.as_str() {
        "t2i" | "t2v" => n == 0,
        "i2i" => n == images && (1..=max).contains(&images),
        "first_frame" => n == 1 && images == 1,
        "first_last" => n == 2 && images == 2,
        "reference" => {
            n > 0
                && images <= max
                && j.assets.iter().filter(|a| a.kind == "video").count() <= 3
                && j.assets.iter().filter(|a| a.kind == "audio").count() <= 3
        }
        _ => false,
    };
    if !valid {
        return Err("素材与所选创作方式不匹配，请检查数量和首尾帧顺序。".into());
    }
    if custom(&j.protocol_id) && n > 0 {
        let body = j.relay.as_ref().unwrap().workflow(&mode).1;
        for (k, field) in [("audio", "{{audios}}"), ("video", "{{videos}}")] {
            if j.assets.iter().any(|a| a.kind == k) && !body.contains(field) {
                return Err(format!("请求体缺少素材字段 {field}"));
            }
        }
        if images > 1
            && !body.contains("{{images}}")
            && !body.contains("{{images_base64}}")
            && !(images == 2 && mode == "first_last")
        {
            return Err("多张图片需要使用图片数组占位符。".into());
        }
        if images > 0
            && mode == "reference"
            && !body.contains("{{images}}")
            && !body.contains("{{images_base64}}")
        {
            return Err("请求体缺少图片数组字段。".into());
        }
    }
    if j.protocol_id == "ark-video"
        && mode == "reference"
        && j.assets.iter().all(|a| a.kind == "audio")
    {
        return Err("方舟音频参考需要同时添加图片或视频。".into());
    }
    let mut total = 0;
    for a in &j.assets {
        if remote(&a.path) {
            public_source(&a.path)?;
            if j.protocol_id == "openai-video" {
                return Err("此视频协议的首帧需要选择本地图片。".into());
            }
            continue;
        }
        let bytes = fs::metadata(store.input(&a.path)?)
            .map_err(|e| e.to_string())?
            .len();
        let max_mb = if j.protocol_id.starts_with("wan-") {
            10
        } else if j.protocol_id == "openai-video" {
            30
        } else {
            50
        };
        if bytes == 0 || bytes > max_mb * 1024 * 1024 {
            return Err(format!("素材为空或超过每个 {max_mb} MiB 的限制。"));
        }
        total += bytes;
    }
    if total > 150 * 1024 * 1024 {
        return Err("单次请求的本地素材合计超过 150 MiB。可改用受支持的 HTTPS 素材链接。".into());
    }
    if j.protocol_id == "comfy-image" {
        if let Some(g) = crate::providers::custom_graph::selected(j)? {
            return crate::providers::custom_graph::actual_parameters(j, &g);
        }
    }
    let fallback = Controls::default();
    let c = c.unwrap_or(&fallback);
    let sizes = j
        .relay
        .as_ref()
        .map(|r| r.sizes.as_slice())
        .unwrap_or(&c.sizes);
    let accept = |values: &[String], key: &str, value: &str| {
        if values.is_empty() {
            table[key]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == value))
        } else {
            values.iter().any(|s| s == value)
        }
    };
    if !accept(sizes, "sizes", &j.size) && !(c.custom_size && dimensions(&j.size).is_some()) {
        return Err("所选尺寸或画幅不在此连接的可用范围内。".into());
    }
    if j.protocol_id == "ark-video" && matches!(mode.as_str(), "first_frame" | "first_last") {
        j.size = "adaptive".into();
    }
    let durations = j
        .relay
        .as_ref()
        .map(|r| r.seconds.as_slice())
        .unwrap_or(&c.seconds);
    if media == "image" {
        j.seconds = 0
    } else if !(if durations.is_empty() {
        table["seconds"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(j.seconds)))
    } else {
        durations.contains(&j.seconds)
    }) {
        return Err("所选时长不在此连接的可用范围内。".into());
    }
    let res = j
        .settings
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            c.resolutions
                .first()
                .map(String::as_str)
                .unwrap_or_else(|| string(&table["resolutions"][0]))
        })
        .to_owned();
    if !res.is_empty() && !accept(&c.resolutions, "resolutions", &res) {
        return Err("分辨率不在此连接的可用范围内。".into());
    }
    if res.is_empty()
        && j.relay
            .as_ref()
            .is_some_and(|r| r.workflow(&mode).1.contains("{{resolution}}"))
    {
        return Err("此接口需要分辨率，请在连接中填写可用分辨率。".into());
    }
    j.settings.insert("resolution".into(), json!(res));
    let r = j
        .settings
        .get("ratio")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !r.is_empty() && !c.ratios.is_empty() && !c.ratios.contains(&r) {
        return Err("画幅不在此连接的可用范围内。".into());
    }
    let r = if c.ratios.is_empty() {
        ratio(&j.size)
    } else if r.is_empty() {
        c.ratios[0].clone()
    } else {
        r
    };
    j.settings.insert("ratio".into(), json!(r));
    if j.protocol_id == "comfy-image" {
        crate::providers::comfy::prepare(j)?;
    }
    if j.protocol_id == "openai-image" {
        prepare_openai_image_output(j)?;
    }
    if let Some(q) = j.settings.get("quality") {
        if j.protocol_id != "openai-image"
            || !matches!(q.as_str(), Some("" | "auto" | "low" | "medium" | "high"))
        {
            return Err("图片质量选项无效。".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gif_defaults_and_mask_validation_follow_the_selected_format() {
        let mut job = Job::default();
        job.settings.insert("output_format".into(), json!("gif"));
        prepare_openai_image_output(&mut job).unwrap();
        assert_eq!(job.settings["frame_count"], 9);
        assert_eq!(job.settings["frame_duration_ms"], 200);

        job.mask = Some(Asset::default());
        assert!(prepare_openai_image_output(&mut job)
            .unwrap_err()
            .contains("遮罩"));
        job.settings.insert("output_format".into(), json!(""));
        prepare_openai_image_output(&mut job).unwrap();
        assert!(job.settings.is_empty());
        assert!(job.mask.is_some());
    }
}
