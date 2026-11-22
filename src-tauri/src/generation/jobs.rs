use crate::{
    domain::*,
    media::formats::{media_format, mime},
    providers::provider::{self, Fault, Output},
    storage::store::Store,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn retry_deadline(delay: Duration) -> i64 {
    let ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
    Utc::now().timestamp_millis().saturating_add(ms)
}

pub struct Studio {
    pub store: Store,
    pub http: reqwest::Client,
    pub(crate) cloud_transfer: tokio::sync::Mutex<()>,
    active: Mutex<HashSet<String>>,
    pub(crate) batch_gate: Mutex<()>,
    pub(crate) has_batches: std::sync::atomic::AtomicBool,
    notify: Box<dyn Fn(Option<&str>) + Send + Sync>,
    pub poll: Duration,
}
impl Studio {
    pub fn new(
        store: Store,
        notify: impl Fn(Option<&str>) + Send + Sync + 'static,
    ) -> Result<Self> {
        Ok(Self {
            has_batches: std::sync::atomic::AtomicBool::new(store.home.join("批次").is_dir()),
            batch_gate: Default::default(),
            store,
            http: provider::client()?,
            cloud_transfer: Default::default(),
            active: Default::default(),
            notify: Box::new(notify),
            poll: Duration::from_secs(5),
        })
    }
    pub fn changed(&self) {
        (self.notify)(None)
    }
    pub(crate) fn job_changed(&self, id: &str) {
        (self.notify)(Some(id));
    }
    fn update(&self, j: &mut Job, status: &str, detail: &str) -> Result<()> {
        if status != j.status || detail != j.detail {
            j.progress_at = Some(Utc::now().timestamp_millis());
        }
        if matches!(status, "paused" | "failed" | "uncertain") {
            if matches!(
                j.status.as_str(),
                "preparing" | "submitting" | "waiting" | "downloading"
            ) {
                j.stopped_during = Some(j.status.clone());
            }
        } else {
            j.stopped_during = None;
        }
        j.status = status.into();
        j.detail = detail.into();
        self.store.save_job(j)?;
        self.job_changed(&j.id);
        Ok(())
    }
    pub fn prepare(&self, i: Start) -> Result<Job> {
        let j = self.build_job(i)?;
        self.store.save_job(&j)?;
        self.job_changed(&j.id);
        Ok(j)
    }
    pub(crate) fn build_job(&self, i: Start) -> Result<Job> {
        if !matches!(i.kind.as_str(), "image" | "video") {
            return Err("媒体类型无效".into());
        }
        let mut p = self.store.resolve(&i.profile_id, &i.kind)?;
        if kind(&p.protocol_id) != i.kind {
            return Err("连接与媒体类型不匹配".into());
        }
        if !site(&p.protocol_id) {
            if let Some(model) = i.model {
                if model != p.model && !p.models.contains(&model) {
                    return Err("当前连接未配置这个模型，请重新选择。".into());
                }
                p.model = model;
            }
        }
        let key = self.store.vault.get(&p, &p.base_url)?;
        if site(&p.protocol_id) && key.is_empty() {
            return Err("请先连接此官网的 OpenAPI Key。".into());
        }
        let features = self.store.features(&p, &p.model)?;
        let mask = i
            .mask
            .map(|m| {
                self.store
                    .assets(&[m])
                    .and_then(|mut a| a.pop().ok_or("遮罩素材已丢失。".into()))
            })
            .transpose()?;
        let count = i.count.unwrap_or(1);
        if ![1, 2, 4].contains(&count) {
            return Err("候选数量仅支持 1、2、4。".into());
        }
        if site(&p.protocol_id) && (count != 1 || mask.is_some()) {
            return Err("此官网模板每次接受一个结果，未提供遮罩。".into());
        }
        let source = i
            .source_job
            .map(|id| self.store.job(&id).map(|j| j.id))
            .transpose()?;
        let assets = self.store.assets(&i.assets)?;
        let mut j = Job {
            shot: i
                .shot
                .map(|link| self.store.resolve_shot(link))
                .transpose()?,
            id: id(),
            mask,
            source_job: source,
            profile_id: p.id,
            profile_name: p.name,
            protocol_id: p.protocol_id,
            base_url: p.base_url,
            model: p.model,
            prompt: i.prompt,
            size: i.size,
            seconds: i.seconds,
            relay: p.relay,
            created_utc: format!("/Date({})/", Utc::now().timestamp_millis()),
            ..Default::default()
        };
        if site(&j.protocol_id) {
            let t = template(&i.template).ok_or("官网模板不存在")?;
            if t["Video"] != (i.kind == "video") {
                return Err("模板类型错误".into());
            }
            let s = SiteOptions {
                config: i.config,
                priority: i.priority,
                assets,
            };
            validate_template(t, &s, &j.prompt)?;
            if t["Text"].is_null() {
                j.prompt.clear()
            }
            j.model = i.template;
            j.size = ["aspect", "ratio", "resolution"]
                .iter()
                .find_map(|k| s.config.get(*k)?.as_str())
                .unwrap_or("")
                .into();
            j.seconds = s
                .config
                .get("duration")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            j.site_options = Some(s);
        } else {
            j.settings = i.config;
            j.settings.remove("comfyWorkflow");
            j.assets = assets;
            if j.protocol_id == "comfy-image" {
                crate::providers::custom_graph::snapshot(&self.store, &mut j)?;
            }
            if count > 1 {
                j.native_count = Some(count);
                j.candidate_ids.push(j.id.clone());
                j.candidate_ids.extend((1..count).map(|_| id()));
            }
            crate::connections::model_features::check(features.as_ref(), &j)?;
            let mut controls = p.controls.unwrap_or_default();
            if let Some(f) = &features {
                if !f.sizes.is_empty() {
                    controls.sizes = f.sizes.clone();
                    if let Some(r) = &mut j.relay {
                        r.sizes = f.sizes.clone()
                    }
                }
            }
            crate::generation::creation::prepare_with_limit(
                &mut j,
                Some(&controls),
                &self.store,
                features.as_ref().and_then(|f| f.max_images),
            )?;
            if let Some(mask) = &j.mask {
                crate::media::masks::validate(&self.store, &j.assets, mask)?;
            }
        }
        let prep = !j.assets.is_empty()
            || j.reference.is_some()
            || j.site_options
                .as_ref()
                .is_some_and(|s| !s.assets.is_empty());
        j.status = if prep { "preparing" } else { "submitting" }.into();
        j.detail = if prep {
            "正在准备本地素材。"
        } else {
            "正在向所选服务提交。"
        }
        .into();
        Ok(j)
    }
    pub fn launch(self: &Arc<Self>, mut j: Job, submit: bool) -> Result<()> {
        {
            let mut active = self.active.lock().unwrap();
            if !active.insert(j.id.clone()) {
                return Ok(());
            }
            if j.status == "paused" && !submit {
                let status = if j.result_url.is_some() {
                    "downloading"
                } else {
                    "waiting"
                };
                if let Err(e) = self.update(&mut j, status, "正在恢复已提交的任务。") {
                    active.remove(&j.id);
                    return Err(e);
                }
            }
        }
        let s = self.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = s.run(&mut j, submit).await;
            // Publish the paused status and release ownership under the same lock as resume.
            let mut active = s.active.lock().unwrap();
            if s.store
                .home
                .join("远端撤回")
                .join(format!("{}.json", j.id))
                .is_file()
                && j.status != "done"
            {
                let _ = s.update(&mut j, "cancelled", "服务端已受理针对该编号的取消。");
            } else if let Err(err) = outcome {
                let status = if j.remote_id.is_some()
                    || j.result_url.is_some()
                    || s.group_file(&j.id).is_file()
                {
                    "paused"
                } else if err.definite || j.status == "preparing" {
                    "failed"
                } else {
                    "uncertain"
                };
                let _ = s.update(&mut j, status, &err.message);
            }
            active.remove(&j.id);
            drop(active);
            if s.has_batches.load(std::sync::atomic::Ordering::Relaxed) {
                if let Err(e) = s.dispatch() {
                    eprintln!("批次调度失败：{e}");
                }
            }
        });
        Ok(())
    }
    fn stem(&self, j: &Job) -> String {
        format!(
            "{}-{}",
            DateTime::from_timestamp_millis(j.time())
                .unwrap_or_default()
                .format("%Y%m%d-%H%M%S"),
            j.id
        )
    }
    pub fn recover(self: &Arc<Self>) -> Result<()> {
        crate::projects::project_archive::recover(&self.store)?;
        self.store.recover_comparisons()?;
        for mut j in self.store.jobs()? {
            if j.candidate_ids
                .first()
                .is_some_and(|parent| self.group_file(parent).is_file())
            {
                if j.candidate_ids.first() == Some(&j.id) {
                    self.launch(j, false)?;
                }
                continue;
            }
            if j.status == "done" {
                if let Some(copy) = j
                    .cloud
                    .as_mut()
                    .filter(|c| matches!(c.status.as_str(), "uploading" | "pending"))
                {
                    copy.status = "failed".into();
                    copy.detail = "上次上传中断，可在作品里重试。".into();
                    self.store.save_job(&j)?;
                }
                continue;
            }
            if !matches!(
                j.status.as_str(),
                "preparing" | "submitting" | "waiting" | "paused" | "downloading"
            ) {
                continue;
            }
            let stem = self.stem(&j);
            let options = if kind(&j.protocol_id) == "video" {
                vec!["mp4", "webm"]
            } else {
                vec!["png", "jpg", "webp", "gif"]
            };
            if let Some(name) = options
                .into_iter()
                .map(|e| format!("{stem}.{e}"))
                .find(|f| self.store.home.join("作品").join(f).is_file())
            {
                j.file_name = Some(name);
                j.result_url = None;
                self.plan_image_copy(&mut j);
                self.update(&mut j, "done", "已保存原文件。")?;
                if j.cloud.as_ref().is_some_and(|c| c.status == "pending") {
                    let studio = self.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = studio.upload_image(&j.id, true).await;
                    });
                }
                continue;
            }
            match j.status.as_str() {
                "preparing" => self.launch(j, true)?,
                "paused" => (),
                _ if j.remote_id.is_some() || j.result_url.is_some() => self.launch(j, false)?,
                _ => self.update(
                    &mut j,
                    "uncertain",
                    "提交中断且尚未收到编号，请先核对服务商记录。",
                )?,
            }
        }
        self.dispatch()
    }
    pub async fn run(&self, j: &mut Job, submit: bool) -> std::result::Result<(), Fault> {
        let key = if site(&j.protocol_id) && !submit {
            String::new()
        } else {
            self.store.key(j)?
        };
        if !submit && self.group_file(&j.id).is_file() {
            let outputs = crate::storage::files::read(&self.group_file(&j.id))?;
            return self.finish_group(j, outputs, &key).await;
        }
        if !submit {
            if let Some(url) = j.result_url.clone() {
                match self.finish(j, Output::Url(url), &key).await {
                    Ok(()) => return Ok(()),
                    Err(e) if j.remote_id.is_none() => return Err(e),
                    _ => (),
                }
            }
        }
        let submitted = if submit {
            let mut uploaded = json!({});
            if let Some(options) = j.site_options.as_mut() {
                for a in &mut options.assets {
                    if crate::generation::creation::remote(&a.path) {
                        continue;
                    }
                    a.path = keep(
                        self.store.home.clone(),
                        self.store.input(&a.path)?,
                        "参考素材",
                    )
                    .await?
                }
            }
            for a in &mut j.assets {
                if !crate::generation::creation::remote(&a.path) {
                    a.path = keep(
                        self.store.home.clone(),
                        self.store.input(&a.path)?,
                        "参考素材",
                    )
                    .await?;
                }
            }
            if let Some(reference) = j.reference.clone() {
                j.reference = Some(
                    keep(
                        self.store.home.clone(),
                        self.store.input(&reference)?,
                        "首帧",
                    )
                    .await?,
                )
            }
            self.store.save_job(j)?;
            if let Some(s) = &j.site_options {
                for a in &s.assets {
                    let path = if crate::generation::creation::remote(&a.path) {
                        a.path.clone()
                    } else {
                        provider::upload(&self.http, j, &key, a, &self.store.input(&a.path)?)
                            .await?
                    };
                    let list = uploaded
                        .as_object_mut()
                        .unwrap()
                        .entry(&a.kind)
                        .or_insert_with(|| json!([]));
                    list.as_array_mut().unwrap().push(json!(path));
                }
            }
            let mut inputs = Vec::new();
            for a in &j.assets {
                inputs.push(crate::providers::inputs::Input::from_asset(&self.store, a)?);
            }
            if let Some(mask) = &mut j.mask {
                mask.path = freeze_asset(&self.store.home, &self.store.input(&mask.path)?)?;
                let mut input = crate::providers::inputs::Input::from_asset(&self.store, mask)?;
                input.kind = "mask".into();
                inputs.push(input);
            }
            if let Some(path) = &j.reference {
                let p = self.store.input(path)?;
                inputs.push(crate::providers::inputs::Input::local(
                    "image",
                    p.file_name().unwrap_or_default().to_string_lossy().into(),
                    p,
                ));
            }
            self.update(j, "submitting", "正在向所选服务提交。")?;
            let result = provider::submit(&self.http, j, &key, uploaded, &inputs).await?;
            if let Output::Ticket(id) = &result {
                j.remote_id = Some(id.clone());
                self.store.save_job(j)?
            }
            Some(result)
        } else {
            None
        };
        let result = if j.remote_id.is_some() {
            self.poll_result(j, &key).await?
        } else {
            submitted.ok_or_else(|| Fault::known("缺少可恢复的任务编号或结果地址。"))?
        };
        if let Output::Many(items) = result {
            let path = self.group_file(&j.id);
            fs::create_dir_all(path.parent().unwrap()).map_err(Fault::known)?;
            crate::storage::files::save(&path, &items)?;
            return self.finish_group(j, items, &key).await;
        }
        if let Output::Failed(msg) = result {
            self.update(j, "failed", &msg)?;
            return Ok(());
        }
        self.finish(j, result, &key).await
    }
    pub(crate) fn group_file(&self, id: &str) -> PathBuf {
        self.store.home.join("候选回执").join(format!("{id}.json"))
    }
    async fn finish_group(
        &self,
        j: &mut Job,
        items: Vec<Output>,
        key: &str,
    ) -> provider::Reply<()> {
        let count = j.candidate_ids.len();
        if items.is_empty() || items.len() > count {
            return Err(Fault::known("服务商返回的候选数与请求不符，请核对记录。"));
        }
        let received = items.len();
        j.received_count = Some(received);
        for (idx, item) in items.into_iter().enumerate().rev() {
            let id = j.candidate_ids[idx].clone();
            let mut child = if idx == 0 {
                j.clone()
            } else {
                self.store.job(&id).unwrap_or_else(|_| {
                    let mut c = j.clone();
                    c.id = id;
                    c.remote_id = None;
                    c.result_url = None;
                    c.file_name = None;
                    c
                })
            };
            if child.status == "done" && self.store.media(&child).is_some() {
                continue;
            }
            self.finish(&mut child, item, key).await?;
            if idx == 0 {
                *j = child;
            }
        }
        if received < count {
            for id in &j.candidate_ids[received..] {
                let mut absent = j.clone();
                absent.id = id.clone();
                absent.remote_id = None;
                absent.file_name = None;
                absent.cloud = None;
                self.update(&mut absent, "failed", "服务商未返回这张候选。")?;
            }
        }
        fs::remove_file(self.group_file(&j.id)).map_err(Fault::known)?;
        Ok(())
    }
    async fn poll_result(&self, j: &mut Job, key: &str) -> provider::Reply<Output> {
        const RETRIES: u32 = 3;
        if j.retry_at.is_none() && j.status != "waiting" {
            self.update(j, "waiting", "已取得任务编号，正在查询进度。")?;
        } else if j.status != "waiting" {
            self.update(j, "waiting", "已保留原任务，将在等待期结束后继续查询。")?;
        }
        let mut failures = 0;
        loop {
            // A restart during a provider cooldown must not cause an early request.
            let recovering = j.retry_at.is_some();
            if let Some(at) = j.retry_at.take() {
                loop {
                    let remaining = at.saturating_sub(Utc::now().timestamp_millis());
                    if remaining <= 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(remaining.min(60_000) as u64)).await;
                }
            }
            if self
                .store
                .home
                .join("远端撤回")
                .join(format!("{}.json", j.id))
                .is_file()
            {
                return Err(Fault::known("服务端已受理取消。"));
            }
            match provider::query(&self.http, j, key).await {
                Ok(Output::Pending(detail)) => {
                    failures = 0;
                    if recovering || j.detail != detail {
                        self.update(j, "waiting", &detail)?;
                    }
                    tokio::time::sleep(self.poll).await;
                }
                Ok(result) => return Ok(result),
                Err(error) => {
                    let Some(minimum) = error.poll_retry_after else {
                        return Err(error);
                    };
                    if failures == RETRIES {
                        if !minimum.is_zero() {
                            j.retry_at = Some(retry_deadline(minimum));
                        }
                        return Err(Fault::known(format!(
                            "进度查询已重试 {RETRIES} 次。可恢复原任务继续查询。{}",
                            error.message.trim()
                        )));
                    }
                    let delay = minimum.max(self.poll * (1 << failures));
                    failures += 1;
                    j.retry_at = Some(retry_deadline(delay));
                    self.update(
                        j,
                        "waiting",
                        &format!(
                            "进度查询暂时中断，将自动重试（{failures}/{RETRIES}）。{}",
                            error.message
                        ),
                    )?;
                }
            }
        }
    }
    async fn finish(
        &self,
        j: &mut Job,
        result: Output,
        key: &str,
    ) -> std::result::Result<(), Fault> {
        if let Output::Url(u) = &result {
            j.result_url = Some(u.clone())
        }
        self.update(j, "downloading", "正在保存原文件。")?;
        let dir = self.store.home.join("作品");
        let stage = tempfile::NamedTempFile::new_in(&dir).map_err(Fault::known)?;
        let mut file = tokio::fs::File::from_std(stage.reopen().map_err(Fault::known)?);
        match result {
            Output::Url(u) => {
                let response = provider::download(&self.http, j, &u, key).await?;
                let expected = response.content_length();
                let mut n = 0u64;
                let mut chunks = response.bytes_stream();
                while let Some(chunk) = chunks.next().await {
                    let b = chunk.map_err(|e| Fault::known(e.without_url()))?;
                    n += b.len() as u64;
                    file.write_all(&b).await.map_err(Fault::known)?
                }
                if expected.is_some_and(|len| len != n) {
                    return Err(Fault::known("文件未完整下载。"));
                }
            }
            Output::Inline(s) => {
                let raw = if s.starts_with("data:") {
                    s.split_once(',')
                        .map(|x| x.1)
                        .ok_or_else(|| Fault::known("Base64 地址无效"))?
                } else {
                    &s
                };
                let bytes = STANDARD.decode(raw).map_err(Fault::known)?;
                file.write_all(&bytes).await.map_err(Fault::known)?
            }
            _ => return Err(Fault::uncertain("响应中缺少媒体。")),
        }
        file.sync_all().await.map_err(Fault::known)?;
        drop(file);
        let mut header = [0; 16];
        let n = tokio::fs::File::open(stage.path())
            .await
            .map_err(Fault::known)?
            .read(&mut header)
            .await
            .map_err(Fault::known)?;
        let ext = media_format(&header[..n], kind(&j.protocol_id) == "video")?;
        let name = format!("{}.{}", self.stem(j), ext);
        let destination = dir.join(&name);
        tokio::task::spawn_blocking(move || crate::storage::files::persist(stage, &destination))
            .await
            .map_err(Fault::known)??;
        j.file_name = Some(name);
        j.result_url = None;
        self.plan_image_copy(j);
        self.update(j, "done", "已保存到作品目录。")?;
        if j.cloud.as_ref().is_some_and(|c| c.status == "pending") {
            let _ = self.upload_image(&j.id, true).await;
        }
        Ok(())
    }
}
async fn keep(home: PathBuf, path: PathBuf, folder: &'static str) -> Result<String> {
    tokio::task::spawn_blocking(move || keep_asset(&home, &path, folder))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn keep_asset(home: &Path, path: &Path, folder: &str) -> Result<String> {
    keep_checked(home, path, folder, false)
}
pub(crate) fn freeze_asset(home: &Path, path: &Path) -> Result<String> {
    keep_checked(home, path, "参考素材", true)
}
fn keep_checked(home: &Path, path: &Path, folder: &str, snapshot: bool) -> Result<String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if mime(&path).is_none() {
        return Err("素材文件类型无效".into());
    }
    if let Ok(rel) = path.strip_prefix(home) {
        if !snapshot
            && rel.components().count() == 2
            && (rel.starts_with("作品") || rel.starts_with(folder))
        {
            return Ok(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    let dir = home.join(folder);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut from = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 131072];
    loop {
        let n = from.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        tmp.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    let name = format!(
        "{:x}.{}",
        hash.finalize(),
        path.extension().unwrap().to_string_lossy().to_lowercase()
    );
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    if let Err(e) = tmp.persist_noclobber(dir.join(&name)) {
        if e.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(e.to_string());
        }
    }
    Ok(format!("{folder}/{name}"))
}
