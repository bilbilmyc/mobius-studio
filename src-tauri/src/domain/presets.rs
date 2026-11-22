use super::{string, Result, SiteOptions};
use serde_json::Value;
use std::sync::OnceLock;
pub const SITE: &str = "https://queueapi.vylai.com/openapi";
pub const WEBSITE: &str = "https://rh.vylai.com/workbench";
pub fn site(proto: &str) -> bool {
    matches!(proto, "rh-image" | "rh-video")
}
pub fn custom(proto: &str) -> bool {
    matches!(proto, "relay-image" | "relay-video")
}
pub fn kind(proto: &str) -> &str {
    if proto.ends_with("-video") {
        "video"
    } else {
        "image"
    }
}
pub fn templates() -> &'static Vec<Value> {
    static LIST: OnceLock<Vec<Value>> = OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/RhTemplates.json"))
            .expect("embedded RH templates")
    })
}
pub fn template(key: &str) -> Option<&'static Value> {
    templates().iter().find(|v| v["Key"] == key)
}
pub fn default_model(media: &str) -> String {
    templates()
        .iter()
        .find(|v| v["Video"] == (media == "video"))
        .unwrap()["Key"]
        .as_str()
        .unwrap()
        .to_string()
}
pub fn validate_template(t: &Value, o: &SiteOptions, prompt: &str) -> Result<()> {
    if t["Text"]["Required"] == true && prompt.trim().is_empty() {
        return Err("请填写提示词。".into());
    }
    if o.priority > 1 || o.priority == 1 && t["Rate"] == t["FastRate"] {
        return Err("所选队列不可用。".into());
    }
    let fields = t["Fields"].as_array().unwrap();
    if fields.len() != o.config.len() {
        return Err("模板参数数目不匹配。".into());
    }
    for f in fields {
        let k = string(&f["Key"]);
        let v = o.config.get(k).ok_or_else(|| format!("缺少参数 {k}"))?;
        let ok = match string(&f["Type"]) {
            "number" => v.as_i64().is_some_and(|i| {
                i >= f["Min"].as_i64().unwrap()
                    && i <= f["Max"].as_i64().unwrap()
                    && (i - f["Min"].as_i64().unwrap()) % f["Step"].as_i64().unwrap() == 0
            }),
            "boolean" => v.is_boolean(),
            "select" => f["Options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|x| x["Value"] == *v),
            _ => false,
        };
        if !ok {
            return Err(format!("请检查「{}」。", string(&f["Label"])));
        }
    }
    let mode = o.config.get("mode").and_then(Value::as_str).unwrap_or("");
    for k in ["image", "video", "audio"] {
        let n = o.assets.iter().filter(|a| a.kind == k).count() as u64;
        let (min, max) = match mode {
            "t2v" => (0, 0),
            "first_frame" if k == "image" => (1, 1),
            "first_last" if k == "image" => (2, 2),
            "first_frame" | "first_last" => (0, 0),
            _ => t["Slots"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["Kind"] == k)
                .map(|s| (s["Min"].as_u64().unwrap(), s["Max"].as_u64().unwrap()))
                .unwrap_or((0, 0)),
        };
        if n < min || n > max {
            return Err(format!(
                "{}素材需要 {min}–{max} 个。",
                match k {
                    "image" => "图片",
                    "video" => "视频",
                    _ => "音频",
                }
            ));
        }
    }
    if t["AnyReference"] == true && o.assets.is_empty() {
        return Err("请至少添加一个参考素材。".into());
    }
    Ok(())
}
