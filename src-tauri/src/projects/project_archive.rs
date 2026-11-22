use crate::{
    app::Core,
    domain::{id, valid_id, Asset, Job, Result},
    generation::comparisons::Comparison,
    projects::screenplay::Script,
    projects::shot_drafts::StoredDraft,
    storage::files::{read, save},
    storage::store::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Deserialize)]
struct Project {
    version: u32,
    script: Script,
    jobs: Vec<Job>,
    drafts: Vec<StoredDraft>,
    comparisons: Vec<Comparison>,
    #[serde(default)]
    connections: Vec<crate::projects::portable_profiles::Connection>,
    missing: Vec<String>,
}
fn err(e: impl ToString) -> String {
    e.to_string()
}
fn hash(mut file: impl Read) -> Result<String> {
    let mut sha = Sha256::new();
    std::io::copy(&mut file, &mut sha).map_err(err)?;
    Ok(format!("{:x}", sha.finalize()))
}
fn clean(value: &mut Value) {
    match value {
        Value::Object(m) => {
            m.retain(|k, _| {
                let k = k.to_lowercase();
                ![
                    "apikey",
                    "api_key",
                    "authorization",
                    "password",
                    "secrets",
                    "resulturl",
                    "access_token",
                    "comfyworkflow",
                    "api-key",
                    "x-auth-token",
                ]
                .iter()
                .any(|s| k.contains(s))
            });
            for v in m.values_mut() {
                clean(v)
            }
        }
        Value::Array(a) => {
            for v in a {
                clean(v)
            }
        }
        Value::String(s)
            if url::Url::parse(s).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && (u.query().is_some() || !u.username().is_empty() || u.password().is_some())
            }) =>
        {
            s.clear()
        }
        _ => (),
    }
}
fn blob_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
        && crate::media::formats::mime(Path::new(&format!("a.{ext}"))).is_some()
        && ext.bytes().all(|c| c.is_ascii_alphanumeric())
}
struct Files {
    scratch: tempfile::TempDir,
    remote_names: HashMap<String, String>,
    paths: BTreeMap<String, PathBuf>,
    missing: Vec<String>,
}
impl Files {
    fn add(&mut self, p: &Path) -> Result<String> {
        let mut input = fs::File::open(p).map_err(err)?;
        let mut frozen = tempfile::NamedTempFile::new_in(self.scratch.path()).map_err(err)?;
        std::io::copy(&mut input, frozen.as_file_mut()).map_err(err)?;
        frozen.flush().map_err(err)?;
        let f = frozen.reopen().map_err(err)?;
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .ok_or("文件没有扩展名。")?
            .to_lowercase();
        let name = format!("{}.{ext}", hash(f)?);
        if !blob_name(&name) {
            return Err("不支持的媒体文件。".into());
        }
        if !self.paths.contains_key(&name) {
            let path = self.scratch.path().join(&name);
            frozen.persist_noclobber(&path).map_err(err)?;
            self.paths.insert(name.clone(), path);
        }
        Ok(name)
    }
    fn asset(&mut self, s: &Store, a: &mut Asset) -> Result<()> {
        if crate::generation::creation::remote(&a.path) {
            let original = a.path.clone();
            if let Some(name) = self.remote_names.get(&original) {
                a.path = format!("参考素材/{name}");
                return Ok(());
            }
            let tmp = self.scratch.path().to_owned();
            let kind = a.kind.clone();
            if let Ok(file) = tauri::async_runtime::block_on(
                crate::projects::remote_archive::fetch(&original, &kind, &tmp),
            ) {
                let name = self.add(&file)?;
                self.remote_names.insert(original, name.clone());
                a.path = format!("参考素材/{name}");
                return Ok(());
            }
        }
        if crate::generation::creation::remote(&a.path)
            || !s.input(&a.path).is_ok_and(|p| p.is_file())
        {
            if a.name.starts_with("http") {
                a.name = "远程参考素材".into()
            }
            self.missing.push(a.name.clone());
            a.path.clear();
            return Ok(());
        }
        let name = self.add(&s.input(&a.path)?)?;
        a.path = format!("参考素材/{name}");
        Ok(())
    }
}
pub(crate) fn export(s: &Store, script_id: &str, dest: &Path) -> Result<()> {
    let script = s.script(script_id)?;
    let scenes: BTreeSet<_> = script.story.scenes.iter().map(|a| a.id.clone()).collect();
    let mut files = Files {
        scratch: tempfile::tempdir_in(&s.home).map_err(err)?,
        remote_names: HashMap::new(),
        paths: Default::default(),
        missing: vec![],
    };
    let mut jobs: Vec<_> = s
        .jobs()?
        .into_iter()
        .filter(|j| {
            j.shot
                .as_ref()
                .is_some_and(|l| l.script_id == script_id && scenes.contains(&l.scene_id))
        })
        .collect();
    for j in &mut jobs {
        if j.file_name.is_some() {
            match s.original(j) {
                Ok(p) => j.file_name = Some(files.add(&p)?),
                Err(_) => {
                    files.missing.push(format!("作品 {}", j.id));
                    j.file_name = None;
                }
            }
        }
        if let Some(p) = j.reference.take() {
            let mut a = Asset {
                path: p,
                kind: "image".into(),
                name: "首帧".into(),
            };
            files.asset(s, &mut a)?;
            j.reference = (!a.path.is_empty()).then_some(a.path);
        }
        if let Some(a) = &mut j.mask {
            files.asset(s, a)?
        }
        for a in &mut j.assets {
            files.asset(s, a)?
        }
        if let Some(o) = &mut j.site_options {
            for a in &mut o.assets {
                files.asset(s, a)?
            }
        }
        j.cloud = None;
        j.relay = None;
        j.result_url = None;
        j.retry_at = None;
        j.stopped_during = None;
        j.detail.clear();
    }
    let ids: BTreeSet<_> = jobs.iter().map(|j| j.id.as_str()).collect();
    let comparisons = s
        .comparisons()?
        .into_iter()
        .filter(|c| c.job_ids.iter().all(|id| ids.contains(id.as_str())))
        .collect();
    let mut drafts = vec![];
    for scene in &script.story.scenes {
        for kind in ["image", "video"] {
            let p = s
                .home
                .join("分镜草稿")
                .join(format!("{script_id}-{}-{kind}.json", scene.id));
            if p.exists() {
                let mut d: StoredDraft = read(&p)?;
                for a in d.inputs.values_mut() {
                    files.asset(s, a)?
                }
                drafts.push(d)
            }
        }
    }
    let mut used = jobs.iter().map(|j| j.profile_id.clone()).collect();
    for d in &drafts {
        crate::projects::portable_profiles::used(&d.draft.editor, &mut used)
    }
    let project = Project {
        connections: crate::projects::portable_profiles::describe(s, &used)?,
        version: 1,
        script,
        jobs,
        drafts,
        comparisons,
        missing: files.missing,
    };
    let mut v = serde_json::to_value(project).map_err(err)?;
    clean(&mut v);
    let manifest = serde_json::to_vec(&v).map_err(err)?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(dest.parent().ok_or("备份目录无效。")?).map_err(err)?;
    {
        let mut tar = tar::Builder::new(tmp.as_file_mut());
        let mut h = tar::Header::new_gnu();
        h.set_mode(0o600);
        h.set_size(manifest.len() as u64);
        h.set_cksum();
        tar.append_data(&mut h, "project.json", manifest.as_slice())
            .map_err(err)?;
        for (name, path) in files.paths {
            tar.append_file(
                format!("files/{name}"),
                &mut fs::File::open(path).map_err(err)?,
            )
            .map_err(err)?
        }
        tar.finish().map_err(err)?;
    }
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist_noclobber(dest).map_err(err)?;
    Ok(())
}

fn unpack(src: &Path, dir: &Path) -> Result<Project> {
    let disk = fs::File::open(src).map_err(err)?;
    let size = disk.metadata().map_err(err)?.len();
    let mut archive = tar::Archive::new(disk);
    let mut project = None;
    let mut count = 0;
    for entry in archive.entries().map_err(err)? {
        let mut entry = entry.map_err(err)?;
        count += 1;
        if count > 20000 || !entry.header().entry_type().is_file() || entry.size() > size {
            return Err("归档包含无效条目。".into());
        }
        let path = entry.path().map_err(err)?.to_string_lossy().to_string();
        if path == "project.json" {
            if project.is_some() || entry.size() > 32 * 1024 * 1024 {
                return Err("项目清单无效。".into());
            }
            let mut raw: Value = serde_json::from_reader(entry).map_err(err)?;
            clean(&mut raw);
            project = Some(serde_json::from_value::<Project>(raw).map_err(err)?);
        } else {
            let name = path
                .strip_prefix("files/")
                .filter(|n| blob_name(n))
                .ok_or("归档媒体路径无效。")?;
            let mut out = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(dir.join(name))
                .map_err(err)?;
            std::io::copy(&mut entry, &mut out).map_err(err)?;
            out.flush().map_err(err)?;
            if hash(fs::File::open(dir.join(name)).map_err(err)?)?
                != name.split('.').next().unwrap()
            {
                return Err(format!("文件校验失败：{name}"));
            }
        }
    }
    let p = project.ok_or("归档缺少项目清单。")?;
    if p.version != 1 {
        return Err("不支持此项目归档版本。".into());
    }
    p.script.story.validate()?;
    let scenes: BTreeSet<_> = p
        .script
        .story
        .scenes
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    if scenes.len() != p.script.story.scenes.len() || scenes.iter().any(|id| !valid_id(id)) {
        return Err("归档镜号无效。".into());
    }
    Ok(p)
}
fn replace_tokens(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::Object(o) => {
            if let Some(Value::String(t)) = o.get_mut("token") {
                if let Some(n) = map.get(t) {
                    *t = n.clone()
                }
            }
            for v in o.values_mut() {
                replace_tokens(v, map)
            }
        }
        Value::Array(a) => {
            for v in a {
                replace_tokens(v, map)
            }
        }
        _ => (),
    }
}
fn copy_blob(name: &str, blobs: &Path, staged: &Path, folder: &str) -> Result<()> {
    if !blob_name(name) {
        return Err("项目引用了无效的媒体路径。".into());
    }
    let src = blobs.join(name);
    if !src.is_file() {
        return Err(format!("归档缺件：{name}"));
    }
    let dir = staged.join(folder);
    fs::create_dir_all(&dir).map_err(err)?;
    let dest = dir.join(name);
    if !dest.exists() {
        fs::hard_link(&src, &dest)
            .or_else(|_| fs::copy(&src, &dest).map(|_| ()))
            .map_err(err)?;
    }
    Ok(())
}
fn stage_asset(a: &Asset, blobs: &Path, stage: &Path) -> Result<()> {
    if a.path.is_empty() {
        return Ok(());
    }
    copy_blob(
        a.path.strip_prefix("参考素材/").ok_or("素材路径无效。")?,
        blobs,
        stage,
        "参考素材",
    )
}
fn json_file(stage: &Path, folder: &str, name: &str, v: &impl Serialize) -> Result<()> {
    let dir = stage.join(folder);
    fs::create_dir_all(&dir).map_err(err)?;
    save(&dir.join(format!("{name}.json")), v)
}
fn preflight(s: &Store, stage: &Path) -> Result<()> {
    for folder in ["参考素材", "作品", "tasks", "分镜草稿", "模型对比", "剧本"] {
        let from = stage.join(folder);
        if !from.exists() {
            continue;
        }
        for entry in fs::read_dir(from).map_err(err)? {
            let entry = entry.map_err(err)?;
            let dest = s.home.join(folder).join(entry.file_name());
            if dest.exists()
                && hash(fs::File::open(dest).map_err(err)?)?
                    != hash(fs::File::open(entry.path()).map_err(err)?)?
            {
                return Err("目标中存在不同内容的同名文件，原项目已保留。".into());
            }
        }
    }
    Ok(())
}
fn install(s: &Store, stage: &Path) -> Result<()> {
    preflight(s, stage)?;
    crate::projects::portable_profiles::install(s, stage)?;
    for folder in ["参考素材", "作品", "tasks", "分镜草稿", "模型对比", "剧本"] {
        let from = stage.join(folder);
        if !from.is_dir() {
            continue;
        }
        let dest = s.home.join(folder);
        fs::create_dir_all(&dest).map_err(err)?;
        for e in fs::read_dir(from).map_err(err)? {
            let e = e.map_err(err)?;
            let target = dest.join(e.file_name());
            if target.exists() {
                if hash(fs::File::open(&target).map_err(err)?)?
                    != hash(fs::File::open(e.path()).map_err(err)?)?
                {
                    return Err("目标中存在不同内容的同名文件。".into());
                }
            } else {
                fs::hard_link(e.path(), &target)
                    .or_else(|_| {
                        let mut temp = tempfile::NamedTempFile::new_in(&dest)?;
                        std::io::copy(&mut fs::File::open(e.path())?, temp.as_file_mut())?;
                        temp.as_file().sync_all()?;
                        temp.persist_noclobber(&target)
                            .map(|_| ())
                            .map_err(|e| e.error)
                    })
                    .map_err(err)?;
            }
        }
    }
    Ok(())
}
pub(crate) fn recover(s: &Store) -> Result<()> {
    let dir = s.home.join("项目导入");
    if !dir.exists() {
        return Ok(());
    }
    for e in fs::read_dir(dir).map_err(err)? {
        let e = e.map_err(err)?;
        let path = e.path();
        if valid_id(&e.file_name().to_string_lossy()) && path.join("ready").is_file() {
            if let Err(reason) = install(s, &path) {
                fs::rename(path.join("ready"), path.join("needs-review")).map_err(err)?;
                eprintln!("项目恢复需要核对：{reason}");
                continue;
            }
            fs::remove_dir_all(path).map_err(err)?;
        }
    }
    Ok(())
}
pub(crate) fn import(s: &Store, src: &Path, commit: bool) -> Result<Value> {
    let tmp = tempfile::tempdir_in(&s.home).map_err(err)?;
    let mut p = unpack(src, tmp.path())?;
    let titles = s.scripts()?;
    let same = titles
        .iter()
        .filter(|x| x.story.title == p.script.story.title)
        .count();
    let scenes: BTreeSet<_> = p.script.story.scenes.iter().map(|v| v.id.clone()).collect();
    let id_map: HashMap<_, _> = p.jobs.iter().map(|j| (j.id.clone(), id())).collect();
    if id_map.len() != p.jobs.len() {
        return Err("归档作品编号重复。".into());
    }
    let project_id = id();
    let stage = tempfile::tempdir_in(&s.home).map_err(err)?;
    let profiles = crate::projects::portable_profiles::plan(s, &p.connections, stage.path())?;
    for j in &mut p.jobs {
        if let Some(id) = profiles.get(&j.profile_id) {
            j.profile_id = id.clone()
        }
        let link = j
            .shot
            .as_mut()
            .filter(|l| l.script_id == p.script.id && scenes.contains(&l.scene_id))
            .ok_or("作品镜头关联无效。")?;
        link.script_id = project_id.clone();
        j.id = id_map[&j.id].clone();
        if let Some(a) = &j.mask {
            stage_asset(a, tmp.path(), stage.path())?
        }
        j.source_job = j.source_job.as_ref().and_then(|v| id_map.get(v)).cloned();
        j.candidate_ids = j
            .candidate_ids
            .iter()
            .filter_map(|v| id_map.get(v).cloned())
            .collect();
        for a in &j.assets {
            stage_asset(a, tmp.path(), stage.path())?
        }
        if let Some(o) = &j.site_options {
            for a in &o.assets {
                stage_asset(a, tmp.path(), stage.path())?
            }
        }
        if let Some(path) = &j.reference {
            stage_asset(
                &Asset {
                    path: path.clone(),
                    ..Default::default()
                },
                tmp.path(),
                stage.path(),
            )?
        }
        if let Some(name) = &j.file_name {
            copy_blob(name, tmp.path(), stage.path(), "作品")?;
        }
        j.cloud = None;
        j.relay = None;
        j.result_url = None;
        j.stopped_during = None;
        j.retry_at = None;
        j.status = if j.file_name.is_some() {
            "done"
        } else {
            "archived"
        }
        .into();
        j.detail = "项目备份中的历史记录。".into();
        json_file(stage.path(), "tasks", &j.id, j)?;
    }
    for (scene, media) in &mut p.script.finals {
        if !scenes.contains(scene) {
            return Err("定稿镜头无效。".into());
        }
        for orig in media.values_mut() {
            *orig = id_map.get(orig).ok_or("归档未包含所选定稿。")?.clone();
        }
    }
    for d in &mut p.drafts {
        if !matches!(d.draft.kind.as_str(), "image" | "video")
            || !scenes.contains(&d.draft.shot.scene_id)
        {
            return Err("草稿镜号或类型无效。".into());
        }
        let mut tokens = HashMap::new();
        let mut inputs = HashMap::new();
        for (token, asset) in d.inputs.drain() {
            stage_asset(&asset, tmp.path(), stage.path())?;
            let n = id();
            tokens.insert(token, n.clone());
            inputs.insert(n, asset);
        }
        replace_tokens(&mut d.draft.editor, &tokens);
        crate::projects::portable_profiles::draft(&mut d.draft.editor, &profiles, &id_map);
        d.inputs = inputs;
        d.draft.shot.script_id = project_id.clone();
        json_file(
            stage.path(),
            "分镜草稿",
            &format!("{}-{}-{}", project_id, d.draft.shot.scene_id, d.draft.kind),
            d,
        )?;
    }
    for c in &mut p.comparisons {
        c.id = id();
        for v in &mut c.job_ids {
            *v = id_map.get(v).ok_or("对比组引用无效。")?.clone()
        }
        c.selected = c.selected.as_ref().and_then(|v| id_map.get(v)).cloned();
        json_file(stage.path(), "模型对比", &c.id, c)?;
    }
    let report = json!({"title":p.script.story.title,"scenes":p.script.story.scenes.iter().map(|s|&s.heading).collect::<Vec<_>>(),
        "jobs":p.jobs.len(),"drafts":p.drafts.len(),"missing":p.missing,"conflicts":same,"id":if commit{Some(&project_id)}else{None}});
    if commit {
        p.script.id = project_id.clone();
        if same > 0 {
            p.script.story.title = format!("{}（导入 {}）", p.script.story.title, &project_id[..6]);
        }
        json_file(stage.path(), "剧本", &project_id, &p.script)?;
        fs::write(stage.path().join("ready"), []).map_err(err)?;
        let _guard = s.gate.lock().unwrap();
        preflight(s, stage.path())?;
        let pending = s.home.join("项目导入");
        fs::create_dir_all(&pending).map_err(err)?;
        let pending = pending.join(project_id);
        fs::rename(stage.path(), &pending).map_err(err)?;
        install(s, &pending)?;
        fs::remove_dir_all(pending).map_err(err)?;
    }
    Ok(report)
}
#[tauri::command]
pub async fn export_project(s: Core<'_>, id: String) -> Result<String> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = s.store.home.join("项目备份");
        fs::create_dir_all(&dir).map_err(err)?;
        let dest = dir.join(format!(
            "项目-{}-{}.mobius",
            &id.chars().take(8).collect::<String>(),
            crate::domain::id()
        ));
        export(&s.store, &id, &dest)?;
        Ok(dest.display().to_string())
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn pick_project(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("莫比环项目", &["mobius"])
            .blocking_pick_file()
            .map(|p| p.into_path().map(|p| p.display().to_string()).map_err(err))
            .transpose()
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn import_project(s: Core<'_>, path: String, commit: bool) -> Result<Value> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = import(&s.store, Path::new(&path), commit)?;
        if commit {
            s.changed()
        }
        Ok(r)
    })
    .await
    .map_err(err)?
}
