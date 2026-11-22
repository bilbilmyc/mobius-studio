use crate::{
    domain::{valid_id, Job, Result},
    storage::{
        files::{read, save},
        store::Store,
    },
};
use std::{fs, path::PathBuf};
impl Store {
    pub(crate) fn job_path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err("任务编号无效。".into());
        }
        Ok(self.home.join("tasks").join(format!("{id}.json")))
    }
    pub fn job(&self, id: &str) -> Result<Job> {
        read(&self.job_path(id)?)
    }
    pub fn save_job(&self, j: &Job) -> Result<()> {
        let _lock = self.gate.lock().unwrap();
        save(&self.job_path(&j.id)?, j)
    }
    pub fn jobs(&self) -> Result<Vec<Job>> {
        let mut list = vec![];
        for entry in fs::read_dir(self.home.join("tasks")).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|s| s == "json") {
                list.push(read::<Job>(&path)?);
            }
        }
        list.sort_by_key(|j| std::cmp::Reverse(j.time()));
        Ok(list)
    }
}
