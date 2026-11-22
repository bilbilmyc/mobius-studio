pub(crate) mod commands;
mod exchange;
#[cfg(test)]
mod tests;

use crate::{
    domain::{id, Result},
    storage::{
        files::{read, save},
        store::Store,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Medium {
    Any,
    Image,
    Video,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Template {
    name: String,
    medium: Medium,
    body: String,
    #[serde(default)]
    description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    author: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    source: String,
}

impl Template {
    fn clean(mut self) -> Result<Self> {
        self.name = self.name.trim().to_owned();
        self.body = self.body.trim().to_owned();
        self.description = self.description.trim().to_owned();
        self.author = self.author.trim().into();
        self.source = self.source.trim().into();
        if self.name.is_empty()
            || self.name.chars().any(char::is_control)
            || self.name.chars().count() > 256
            || self.body.is_empty()
            || self.body.chars().count() > 262144
            || self.description.chars().count() > 800
            || self.author.chars().count() > 256
            || self.source.chars().count() > 2000
        {
            return Err(
                "模板需要名称和正文。名称与作者最多 256 字，正文最多 262144 字，说明最多 800 字，来源最多 2000 字。".into(),
            );
        }
        Ok(self)
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Entry {
    id: String,
    #[serde(flatten)]
    spec: Template,
}

#[derive(Default, Deserialize, Serialize)]
struct Library {
    revision: u64,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
pub(crate) struct View {
    revision: u64,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub(crate) enum Change {
    Import { templates: Vec<Template> },
    Edit { id: String, template: Template },
    Remove { id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Updated {
    library: View,
    selected: Option<String>,
    added: usize,
    skipped: usize,
    renamed: usize,
}

const MAX_LIBRARY: usize = 5000;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

fn builtins() -> Vec<Entry> {
    serde_json::from_str(include_str!("../../../../src/PromptTemplates.json"))
        .expect("built-in prompt templates")
}

impl Library {
    fn view(self) -> View {
        let mut entries = builtins();
        entries.extend(self.entries);
        View {
            revision: self.revision,
            entries,
        }
    }
}

impl Store {
    fn read_template_library(&self) -> Result<Library> {
        let path = self.home.join("提示词模板.json");
        if path.try_exists().map_err(|e| e.to_string())? {
            read(&path)
        } else {
            Ok(Library::default())
        }
    }

    fn template_library(&self) -> Result<View> {
        let _guard = self.gate.lock().unwrap();
        Ok(self.read_template_library()?.view())
    }

    fn change_templates(&self, revision: u64, change: Change) -> Result<Updated> {
        let _guard = self.gate.lock().unwrap();
        let mut lib = self.read_template_library()?;
        if revision != lib.revision {
            return Err("模板库已在其他窗口更新，请重新打开模板库。".into());
        }
        let fixed = builtins();
        let (mut added, mut skipped, mut renamed) = (0, 0, 0);
        let mut selected = None;
        let changed =
            match change {
                Change::Import { templates } => {
                    if templates.is_empty() || templates.len() > MAX_LIBRARY + fixed.len() {
                        return Err("请选择 1 到 5000 个模板。".into());
                    }
                    let mut by_name = std::collections::HashMap::new();
                    for e in fixed.iter().chain(&lib.entries) {
                        by_name.insert(e.spec.name.to_lowercase(), (e.id.clone(), e.spec.clone()));
                    }
                    for template in templates {
                        let mut spec = template.clean()?;
                        let name = spec.name.clone();
                        for suffix in 1usize.. {
                            if suffix > 1 {
                                let tail = format!(" ({suffix})");
                                let base: String =
                                    name.chars().take(256 - tail.chars().count()).collect();
                                spec.name = format!("{base}{tail}");
                            }
                            let key = spec.name.to_lowercase();
                            if let Some((existing_id, existing)) = by_name.get(&key) {
                                if existing.medium == spec.medium
                                    && existing.body == spec.body
                                    && existing.description == spec.description
                                    && existing.author == spec.author
                                    && existing.source == spec.source
                                {
                                    selected.get_or_insert(existing_id.clone());
                                    skipped += 1;
                                    break;
                                }
                                continue;
                            }
                            if lib.entries.len() >= MAX_LIBRARY {
                                return Err("模板库最多保存 5000 个自定义模板。".into());
                            }
                            let key_id = id();
                            by_name.insert(key, (key_id.clone(), spec.clone()));
                            selected.get_or_insert(key_id.clone());
                            lib.entries.push(Entry { id: key_id, spec });
                            added += 1;
                            if suffix > 1 {
                                renamed += 1
                            }
                            break;
                        }
                    }
                    added > 0
                }
                Change::Edit { id, template } => {
                    let spec = template.clean()?;
                    if fixed.iter().chain(&lib.entries).any(|e| {
                        e.id != id && e.spec.name.to_lowercase() == spec.name.to_lowercase()
                    }) {
                        return Err("这个名称已被使用，请换一个名称。".into());
                    }
                    let entry = lib
                        .entries
                        .iter_mut()
                        .find(|e| e.id == id)
                        .ok_or("请选择一个自定义模板。")?;
                    let changed = entry.spec != spec;
                    entry.spec = spec;
                    selected = Some(id);
                    changed
                }
                Change::Remove { id } => {
                    let i = lib
                        .entries
                        .iter()
                        .position(|e| e.id == id)
                        .ok_or("请选择一个自定义模板。")?;
                    lib.entries.remove(i);
                    true
                }
            };
        if changed {
            lib.revision += 1;
            save(&self.home.join("提示词模板.json"), &lib)?;
        }
        Ok(Updated {
            library: lib.view(),
            selected,
            added,
            skipped,
            renamed,
        })
    }
}

#[derive(Serialize)]
pub(crate) struct Match {
    name: String,
    description: String,
    body: String,
    characters: usize,
}

impl Store {
    fn find_templates(&self, kind: Medium, query: String) -> Result<Vec<Match>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() || query.chars().count() > 120 {
            return Err("查找模板需要 1 到 120 字的关键词。".into());
        }
        let words: Vec<_> = query
            .split(|c: char| c.is_whitespace() || matches!(c, ',' | '，' | '、'))
            .filter(|s| !s.is_empty())
            .collect();
        let mut found = Vec::new();
        for entry in self.template_library()?.entries {
            let t = entry.spec;
            if t.medium != Medium::Any && t.medium != kind {
                continue;
            }
            let score = [(&t.name, 3), (&t.description, 2), (&t.body, 1)]
                .into_iter()
                .map(|(field, weight)| {
                    let field = field.to_lowercase();
                    words.iter().filter(|w| field.contains(**w)).count() * weight
                })
                .sum::<usize>();
            if score > 0 {
                found.push((score, t));
            }
        }
        found.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        Ok(found
            .into_iter()
            .take(3)
            .map(|(_, t)| Match {
                name: t.name,
                description: t.description,
                characters: t.body.chars().count(),
                body: t.body.chars().take(2500).collect(),
            })
            .collect())
    }
}
