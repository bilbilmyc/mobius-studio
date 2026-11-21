use crate::{
    jobs::{freeze_asset, Studio},
    model::*,
    store::{read, save},
    Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

#[derive(Serialize, Deserialize)]
pub struct Batch {
    id: String,
    created: i64,
    running: bool,
    #[serde(default)]
    sealed: bool,
    limit: usize,
    budget: Option<f64>,
    jobs: Vec<Job>,
}
fn path(s: &Studio, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err("批次编号无效。".into());
    }
    Ok(s.store.home.join("批次").join(format!("{id}.json")))
}
fn batches(s: &Studio) -> Result<Vec<Batch>> {
    let dir = s.store.home.join("批次");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result: Vec<Batch> = vec![];
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = item.map_err(|e| e.to_string())?.path();
        if p.extension().is_some_and(|v| v == "json") {
            result.push(read(&p)?);
        }
    }
    result.sort_by_key(|b| b.created);
    Ok(result)
}
pub(crate) fn estimate(job: &Job) -> Option<f64> {
    if job.protocol_id == "comfy-image"
        && url::Url::parse(&job.base_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .is_some_and(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "[::1]"))
    {
        return Some(0.);
    }
    let t = template(&job.model)?;
    let options = job.site_options.as_ref()?;
    let mut value = t[if options.priority == 0 {
        "Rate"
    } else {
        "FastRate"
    }]
    .as_f64()?;
    for f in t["Fields"].as_array()? {
        if let Some(choice) = f["Options"].as_array().and_then(|a| {
            a.iter()
                .find(|o| options.config.get(f["Key"].as_str().unwrap_or("")) == Some(&o["Value"]))
        }) {
            value *= choice["Factor"].as_f64().unwrap_or(1.);
        }
    }
    if t["PerSecond"] == true {
        value *= options.config.get("duration")?.as_f64()?
    }
    Some(value)
}
fn freeze(s: &Studio, job: &mut Job) -> Result<()> {
    if let Some(a) = &mut job.mask {
        a.path = freeze_asset(&s.store.home, &s.store.input(&a.path)?)?;
    }
    let assets = match &mut job.site_options {
        Some(o) => &mut o.assets,
        None => &mut job.assets,
    };
    for asset in assets {
        if !crate::creation::remote(&asset.path) {
            asset.path = freeze_asset(&s.store.home, &s.store.input(&asset.path)?)?;
        }
    }
    Ok(())
}
fn materialize(s: &Studio, b: &mut Batch) -> Result<()> {
    if b.sealed || b.running {
        return Ok(());
    }
    for j in &b.jobs {
        if !s.store.job_path(&j.id)?.exists() {
            s.store.save_job(j)?;
        }
    }
    b.sealed = true;
    save(&path(s, &b.id)?, b)
}
fn independent_candidates(seed: &mut Job, count: usize, random: bool) -> Vec<Job> {
    seed.candidate_ids = std::iter::once(seed.id.clone())
        .chain((1..count).map(|_| id()))
        .collect();
    seed.candidate_ids
        .iter()
        .map(|id| {
            let mut j = seed.clone();
            j.id = id.clone();
            if random && j.protocol_id == "comfy-image" && !j.settings.contains_key("comfyWorkflow")
            {
                j.settings
                    .insert("seed".into(), json!(crate::comfy::random_seed()));
            }
            j
        })
        .collect()
}
impl Studio {
    pub(crate) fn start_repeats(self: &Arc<Self>, input: Start, n: usize) -> Result<String> {
        if ![2, 4].contains(&n) || input.kind != "image" || input.count.unwrap_or(1) != 1 {
            return Err("图片重复候选仅支持 2 或 4 项。".into());
        }
        let random = input
            .config
            .get("seed")
            .and_then(Value::as_i64)
            .unwrap_or(-1)
            == -1;
        let mut seed = self.build_job(input)?;
        freeze(self, &mut seed)?;
        seed.status = "queued".into();
        seed.detail = "候选待发送。".into();
        let mut b = Batch {
            id: id(),
            created: chrono::Utc::now().timestamp_millis(),
            running: false,
            sealed: false,
            limit: 1,
            budget: None,
            jobs: independent_candidates(&mut seed, n, random),
        };
        {
            let _guard = self.batch_gate.lock().unwrap();
            fs::create_dir_all(self.store.home.join("批次")).map_err(|e| e.to_string())?;
            save(&path(self, &b.id)?, &b)?;
            materialize(self, &mut b)?;
            b.running = true;
            save(&path(self, &b.id)?, &b)?;
            self.has_batches
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.changed();
        self.dispatch()?;
        Ok(seed.id)
    }
    pub(crate) fn submit_new(self: &Arc<Self>, mut j: Job) -> Result<()> {
        if !self.has_batches.load(std::sync::atomic::Ordering::Relaxed) {
            return self.launch(j, true);
        }
        {
            let _guard = self.batch_gate.lock().unwrap();
            let mut cap = None;
            for b in batches(self)?.into_iter().filter(|b| b.running) {
                if b.jobs
                    .iter()
                    .filter(|s| s.profile_id == j.profile_id)
                    .any(|q| {
                        self.store.job(&q.id).is_ok_and(|v| {
                            matches!(
                                v.status.as_str(),
                                "queued" | "preparing" | "submitting" | "waiting" | "downloading"
                            )
                        })
                    })
                {
                    cap = Some(cap.unwrap_or(8usize).min(b.limit));
                }
            }
            let Some(limit) = cap else {
                return self.launch(j, true);
            };
            freeze(self, &mut j)?;
            j.status = "queued".into();
            j.detail = "等待此连接的并发位置。".into();
            let b = Batch {
                id: id(),
                created: chrono::Utc::now().timestamp_millis(),
                running: true,
                sealed: true,
                limit,
                budget: None,
                jobs: vec![j.clone()],
            };
            save(&path(self, &b.id)?, &b)?;
            self.store.save_job(&j)?;
            self.job_changed(&j.id);
        }
        self.dispatch()
    }
    pub(crate) fn dispatch(self: &Arc<Self>) -> Result<()> {
        let _guard = self.batch_gate.lock().unwrap();
        let mut all = batches(self)?;
        if all.is_empty() {
            return Ok(());
        }
        for batch in &mut all {
            materialize(self, batch)?;
        }
        let jobs = self.store.jobs()?;
        let by_id: HashMap<_, _> = jobs.iter().map(|j| (j.id.as_str(), j)).collect();
        let mut busy: HashMap<String, usize> = HashMap::new();
        let mut limits: HashMap<String, usize> = HashMap::new();
        for job in &jobs {
            if matches!(
                job.status.as_str(),
                "preparing" | "submitting" | "waiting" | "downloading"
            ) {
                *busy.entry(job.profile_id.clone()).or_default() += 1;
            }
        }
        for batch in all.iter().filter(|b| b.running) {
            for seed in &batch.jobs {
                if by_id.get(seed.id.as_str()).is_some_and(|j| {
                    matches!(
                        j.status.as_str(),
                        "queued" | "preparing" | "submitting" | "waiting" | "downloading"
                    )
                }) {
                    let n = limits.entry(seed.profile_id.clone()).or_insert(batch.limit);
                    *n = (*n).min(batch.limit);
                }
            }
        }
        for batch in all.iter().filter(|b| b.running) {
            for seed in &batch.jobs {
                let Some(&job) = by_id.get(seed.id.as_str()) else {
                    continue;
                };
                if job.status != "queued" {
                    continue;
                }
                let active = busy.entry(job.profile_id.clone()).or_default();
                if *active >= limits[&job.profile_id] {
                    continue;
                }
                let mut job = job.clone();
                job.status = "preparing".into();
                job.detail = "已从待发队列取出。".into();
                self.store.save_job(&job)?;
                self.launch(job, true)?;
                *active += 1;
            }
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn create_batch(
    s: Core<'_>,
    inputs: Vec<Start>,
    limit: usize,
    budget: Option<f64>,
    allow_unknown: bool,
) -> Result<String> {
    let s = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !(1..=8).contains(&limit) || inputs.is_empty() || inputs.len() > 256 {
            return Err("请选择 1–256 项任务和 1–8 个连接并发位。".into());
        }
        let mut jobs = Vec::new();
        let mut known = 0.;
        for input in inputs {
            let random = input
                .config
                .get("seed")
                .and_then(Value::as_i64)
                .unwrap_or(-1)
                == -1;
            let repeats = input.repeat.unwrap_or(1);
            if ![1, 2, 4].contains(&repeats)
                || repeats > 1 && (input.count.unwrap_or(1) > 1 || input.kind != "image")
                || jobs.len() + repeats > 256
            {
                return Err("每批最多 256 次提交，候选数为 1、2 或 4。".into());
            }
            let mut j = s.build_job(input)?;
            if let Some(cost) = estimate(&j) {
                known += cost * repeats as f64
            } else if !allow_unknown {
                return Err("请确认价格未知的任务。".into());
            }
            freeze(&s, &mut j)?;
            j.status = "queued".into();
            j.detail = "待发送，可撤回。".into();
            if repeats == 1 {
                jobs.push(j)
            } else {
                jobs.extend(independent_candidates(&mut j, repeats, random));
            }
        }
        if budget.is_some_and(|n| !n.is_finite() || n < 0. || known > n + 0.00001) {
            return Err("已知预估超出预算，请调整镜头或模型。".into());
        }
        let mut batch = Batch {
            id: id(),
            created: chrono::Utc::now().timestamp_millis(),
            running: false,
            sealed: false,
            limit,
            budget,
            jobs,
        };
        let _guard = s.batch_gate.lock().unwrap();
        fs::create_dir_all(s.store.home.join("批次")).map_err(|e| e.to_string())?;
        save(&path(&s, &batch.id)?, &batch)?;
        s.has_batches
            .store(true, std::sync::atomic::Ordering::Relaxed);
        materialize(&s, &mut batch)?;
        s.changed();
        Ok(batch.id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn list_batches(s: Core) -> Result<Vec<Value>> {
    let all = s.store.jobs()?;
    let by_id: HashMap<_, _> = all.iter().map(|j| (&j.id, j)).collect();
    Ok(batches(&s)?.into_iter().rev().map(|b|json!({"id":b.id,"running":b.running,"limit":b.limit,"budget":b.budget,
        "jobs":b.jobs.iter().map(|j|json!({"id":j.id,"shot":j.shot,"model":j.model,"profile":j.profile_name,"estimate":estimate(j),
        "priority":j.site_options.as_ref().map(|o|o.priority),"status":by_id.get(&j.id).map_or("missing",|v|v.status.as_str())})).collect::<Vec<_>>() })).collect())
}
#[tauri::command]
pub fn run_batch(s: Core, id: String) -> Result<()> {
    {
        let _guard = s.batch_gate.lock().unwrap();
        let p = path(&s, &id)?;
        let mut b: Batch = read(&p)?;
        materialize(&s, &mut b)?;
        b.running = true;
        save(&p, &b)?;
    }
    s.inner().dispatch()?;
    s.changed();
    Ok(())
}
#[tauri::command]
pub fn withdraw_job(s: Core, id: String) -> Result<()> {
    let _guard = s.batch_gate.lock().unwrap();
    let mut j = s.store.job(&id)?;
    if j.status != "queued" {
        return Err("该任务已离开待发队列。".into());
    }
    j.status = "withdrawn".into();
    j.detail = "已在发送前撤回。".into();
    s.store.save_job(&j)?;
    s.job_changed(&id);
    Ok(())
}
