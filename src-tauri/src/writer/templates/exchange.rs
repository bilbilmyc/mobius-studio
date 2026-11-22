use super::{builtins, Medium, Store, Template, MAX_FILE_BYTES, MAX_LIBRARY};
use crate::{
    domain::{id, Result},
    storage::files::save,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pack {
    format: String,
    version: u32,
    templates: Vec<Template>,
}

#[derive(Serialize)]
pub(crate) struct Preview {
    pub(super) templates: Vec<Template>,
    pub(super) skipped: usize,
}

pub(super) fn parse(filename: &str, text: &str) -> Result<Preview> {
    if text.len() > MAX_FILE_BYTES {
        return Err("请选择小于 16 MB 的模板文件。".into());
    }
    let text = text.trim_start_matches('\u{feff}');
    let path = Path::new(filename);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut skipped = 0;
    let parsed = match ext.as_str() {
        "json" => {
            let pack: Pack = serde_json::from_str(text).map_err(|_| {
                "JSON 需要是莫比环导出的模板包。也可以导入 TXT、Markdown 或 act,prompt CSV。"
            })?;
            if pack.format != "mobius-prompt-templates" || pack.version != 1 {
                return Err("不支持这个模板包的格式或版本。".into());
            }
            pack.templates
        }
        "csv" => {
            let mut reader = csv::ReaderBuilder::new()
                .flexible(true)
                .from_reader(text.as_bytes());
            let headers = reader.headers().map_err(|_| "无法读取 CSV 表头。")?.clone();
            let col = |choices: &[&str]| {
                headers
                    .iter()
                    .position(|h| choices.iter().any(|s| h.trim().eq_ignore_ascii_case(s)))
            };
            let name = col(&["act", "name", "title", "名称", "角色"])
                .ok_or("CSV 缺少 act 或 name 列。")?;
            let body = col(&["prompt", "body", "提示词", "正文"]).ok_or("CSV 缺少 prompt 列。")?;
            let kind = col(&["medium", "type"]);
            let author = col(&["author", "contributor", "作者"]);
            let source = col(&["source", "url", "来源"]);
            let description = col(&["description", "说明"]);
            let mut rows = Vec::new();
            for record in reader.records() {
                let row = record.map_err(|_| "CSV 引号或列格式有误。")?;
                let medium = match kind
                    .and_then(|i| row.get(i))
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "image" | "图片" => Medium::Image,
                    "video" | "视频" => Medium::Video,
                    _ => Medium::Any,
                };
                let spec = Template {
                    name: row.get(name).unwrap_or("").into(),
                    body: row.get(body).unwrap_or("").into(),
                    medium,
                    author: author.and_then(|i| row.get(i)).unwrap_or("").into(),
                    source: source.and_then(|i| row.get(i)).unwrap_or("").into(),
                    description: description.and_then(|i| row.get(i)).unwrap_or("").into(),
                };
                match spec.clean() {
                    Ok(template) => rows.push(template),
                    Err(_) => skipped += 1,
                }
                if rows.len() > MAX_LIBRARY {
                    return Err("单次导入最多 5000 个模板，请拆分 CSV。".into());
                }
            }
            rows
        }
        "md" | "markdown" | "txt" => vec![Template {
            name: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("导入模板")
                .into(),
            medium: Medium::Any,
            author: String::new(),
            source: String::new(),
            description: String::new(),
            body: text.into(),
        }],
        _ => return Err("支持莫比环 JSON、TXT、Markdown 和 CSV 模板。".into()),
    };
    if parsed.is_empty() || parsed.len() > MAX_LIBRARY + builtins().len() {
        return Err("文件需要包含 1 到 5000 个有效模板。".into());
    }
    let templates = parsed
        .into_iter()
        .map(Template::clean)
        .collect::<Result<Vec<_>>>()?;
    Ok(Preview { templates, skipped })
}

impl Store {
    pub(super) fn export_templates(
        &self,
        ids: Vec<String>,
        destination: Option<PathBuf>,
    ) -> Result<String> {
        if ids.is_empty() || ids.len() > MAX_LIBRARY + builtins().len() {
            return Err("请选择要导出的模板。".into());
        }
        let library = self.template_library()?;
        let wanted: HashSet<_> = ids.into_iter().collect();
        let templates: Vec<_> = library
            .entries
            .into_iter()
            .filter(|e| wanted.contains(&e.id))
            .map(|e| e.spec)
            .collect();
        if wanted.len() != templates.len() {
            return Err("选中的模板已变更，请重新打开模板库。".into());
        }
        let path = match destination {
            Some(p) => p,
            None => {
                let dir = self.home.join("作品").join("导出");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                dir.join(format!("提示词模板-{}.json", &id()[..12]))
            }
        };
        let pack = Pack {
            format: "mobius-prompt-templates".into(),
            version: 1,
            templates,
        };
        if serde_json::to_vec(&pack).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
            return Err("整库超过单个分享文件的 16 MB 上限，请选择模板分别导出。".into());
        }
        save(&path, &pack)?;
        Ok(path.to_string_lossy().trim_start_matches(r"\\?\").into())
    }
}
