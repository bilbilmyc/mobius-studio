use crate::{
    jobs::Studio,
    model::{id, valid_id, Job, Result, Start},
    store::{read, save, Store},
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Arc};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub id: String,
    pub job_ids: [String; 2],
    pub selected: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(flatten)]
    group: Comparison,
    // Journal both validated inputs before either provider can receive a request.
    #[serde(skip_serializing_if = "Option::is_none")]
    prepared: Option<[Job; 2]>,
}

impl Store {
    fn comparison_path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err("对比编号无效。".into());
        }
        Ok(self.home.join("模型对比").join(format!("{id}.json")))
    }

    fn comparison_records(&self) -> Result<Vec<Record>> {
        let dir = self.home.join("模型对比");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|e| e == "json") {
                records.push(read(&path)?);
            }
        }
        Ok(records)
    }
    pub fn comparisons(&self) -> Result<Vec<Comparison>> {
        Ok(self
            .comparison_records()?
            .into_iter()
            .map(|r| r.group)
            .collect())
    }
    fn materialize(&self, record: &mut Record) -> Result<()> {
        if let Some(jobs) = &record.prepared {
            for job in jobs {
                if !self.job_path(&job.id)?.exists() {
                    self.save_job(job)?;
                }
            }
            record.prepared = None;
            save(&self.comparison_path(&record.group.id)?, record)?;
        }
        Ok(())
    }
    pub fn recover_comparisons(&self) -> Result<()> {
        for mut record in self.comparison_records()? {
            self.materialize(&mut record)?;
        }
        Ok(())
    }
    pub fn select_comparison(&self, group_id: &str, job_id: &str) -> Result<()> {
        let path = self.comparison_path(group_id)?;
        let mut record: Record = read(&path)?;
        if !record.group.job_ids.iter().any(|id| id == job_id) {
            return Err("请选择这组对比中的图片。".into());
        }
        let job = self.job(job_id)?;
        if job.status != "done" {
            return Err("请等待图片生成完成。".into());
        }
        self.original(&job)?;
        if let Some(shot) = job.shot.and_then(|shot| self.resolve_shot(shot).ok()) {
            self.set_final(&shot.script_id, &shot.scene_id, "image", Some(job_id))?;
        } else {
            let _lock = self.gate.lock().unwrap();
            record.group.selected = Some(job_id.into());
            save(&path, &record)?;
        }
        Ok(())
    }
}

impl Studio {
    pub fn start_comparison(self: &Arc<Self>, inputs: [Start; 2]) -> Result<Comparison> {
        let [a, b] = inputs;
        let shot = |input: &Start| {
            input
                .shot
                .as_ref()
                .map(|s| (s.script_id.clone(), s.scene_id.clone()))
        };
        if a.kind != "image"
            || b.kind != "image"
            || a.prompt != b.prompt
            || shot(&a) != shot(&b)
            || !a
                .assets
                .iter()
                .map(|p| &p.token)
                .eq(b.assets.iter().map(|p| &p.token))
        {
            return Err("两个图片模型需要使用同一分镜、提示词和参考图。".into());
        }
        let mut jobs = [self.build_job(a)?, self.build_job(b)?];
        if jobs[0].model == jobs[1].model && jobs[0].base_url == jobs[1].base_url {
            return Err("请另选一个图片模型。".into());
        }
        for job in &mut jobs {
            job.status = "preparing".into();
            job.detail = "正在准备模型对比。".into();
        }
        let group = Comparison {
            id: id(),
            job_ids: [jobs[0].id.clone(), jobs[1].id.clone()],
            selected: None,
        };
        let mut record = Record {
            group: group.clone(),
            prepared: Some(jobs.clone()),
        };
        let path = self.store.comparison_path(&group.id)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        save(&path, &record)?;
        self.store.materialize(&mut record)?;
        for job in jobs {
            self.launch(job, true)?;
        }
        self.changed();
        Ok(group)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn invalid_partner_does_not_create_or_send_a_single_task() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().into()).unwrap();
        let profile = store
            .edit(
                serde_json::from_value(json!({"name":"images","protocol":"openai-image",
            "base":"http://127.0.0.1:1/v1","model":"a","models":["b"],"key":""}))
                .unwrap(),
            )
            .unwrap();
        let studio = Arc::new(Studio::new(store, |_| {}).unwrap());
        let input = |model: &str| {
            serde_json::from_value(json!({"profileId":profile,"model":model,
            "template":"","kind":"image","prompt":"street","size":"1024x1024","seconds":0,"config":{"mode":"t2i"},
            "priority":0,"assets":[]})).unwrap()
        };
        for second in ["missing", "a"] {
            assert!(studio
                .start_comparison([input("a"), input(second)])
                .is_err());
            assert!(studio.store.jobs().unwrap().is_empty());
            assert!(studio.store.comparisons().unwrap().is_empty());
        }
    }

    #[test]
    fn interrupted_pair_restores_only_missing_job_and_keeps_standalone_final() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().into()).unwrap();
        let job = || Job {
            id: id(),
            protocol_id: "openai-image".into(),
            status: "preparing".into(),
            ..Job::default()
        };
        let a = job();
        let b = job();
        let group = Comparison {
            id: id(),
            job_ids: [a.id.clone(), b.id.clone()],
            selected: None,
        };
        let path = store.comparison_path(&group.id).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        save(
            &path,
            &Record {
                group: group.clone(),
                prepared: Some([a.clone(), b.clone()]),
            },
        )
        .unwrap();
        let done = Job {
            status: "done".into(),
            file_name: Some("winner.png".into()),
            ..a
        };
        fs::write(store.home.join("作品/winner.png"), b"fixture").unwrap();
        store.save_job(&done).unwrap();
        store.recover_comparisons().unwrap();
        store.recover_comparisons().unwrap();
        assert_eq!(store.jobs().unwrap().len(), 2);
        assert_eq!(store.job(&done.id).unwrap().status, "done");
        assert_eq!(store.job(&b.id).unwrap().status, "preparing");
        assert!(store.select_comparison(&group.id, &b.id).is_err());
        store.select_comparison(&group.id, &done.id).unwrap();
        drop(store);
        let reopened = Store::new(temp.path().into()).unwrap();
        assert_eq!(
            reopened.comparisons().unwrap()[0].selected.as_deref(),
            Some(done.id.as_str())
        );
    }
}
