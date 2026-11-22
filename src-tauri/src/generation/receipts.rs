use crate::{
    app::Core,
    domain::{route, site, Job, Result},
    providers::provider,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    number: String,
    model: String,
    created: String,
    status: String,
    has_result: bool,
}

fn eligible(job: &Job, number: &str) -> Result<()> {
    if !site(&job.protocol_id) || job.status != "uncertain" || job.remote_id.is_some() {
        return Err("仅可为未取得回执的官网任务补录编号。".into());
    }
    if number.is_empty() || number.len() > 32 || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入官网显示的数字任务号。".into());
    }
    Ok(())
}
async fn lookup(
    studio: &crate::generation::jobs::Studio,
    job: &Job,
    number: &str,
) -> Result<Receipt> {
    eligible(job, number)?;
    let key = studio.store.key(job)?;
    if key.is_empty() {
        return Err("请先连接提交任务时使用的官网账户。".into());
    }
    let mut page = 1;
    loop {
        let request = studio
            .http
            .get(route(&job.base_url, "alltasks")?)
            .query(&[("page", page), ("page_size", 50)])
            .timeout(std::time::Duration::from_secs(20));
        let raw = provider::json_response(provider::auth(request, "x-auth-token", &key), &key)
            .await
            .map_err(|e| e.message)?;
        let data = provider::envelope(raw, &key).map_err(|e| e.message)?;
        let rows = data["tasks"]
            .as_array()
            .ok_or("官网未返回本账户的任务清单，暂时无法核对归属。")?;
        for row in rows {
            let field = |k: &str| match &row[k] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            if field("task_id") != number {
                continue;
            }
            let model = field("template_key");
            if !model.is_empty() && model != job.model {
                return Err("这个编号对应的官网模板与原记录不同。".into());
            }
            let receipt = Receipt {
                number: number.into(),
                model,
                created: field("created_at"),
                status: field("status"),
                has_result: !field("result_oss_url").is_empty(),
            };
            if receipt.model.is_empty() && receipt.created.is_empty() {
                return Err("官网缺少可核对的模板和提交时间，原记录仍待核实。".into());
            }
            return Ok(receipt);
        }
        let end = rows.len() < 50
            || data["total"]
                .as_u64()
                .is_some_and(|n| n <= (page * 50) as u64);
        if end {
            return Err("在此连接的账户记录中未找到该编号，请核对编号和账户。".into());
        }
        page += 1;
        if page > 1000 {
            return Err("记录量超过本次查询范围，请在官网核对任务。".into());
        }
    }
}

fn available(studio: &crate::generation::jobs::Studio, job: &Job, number: &str) -> Result<()> {
    if studio.store.jobs()?.iter().any(|other| {
        other.id != job.id
            && other.base_url == job.base_url
            && site(&other.protocol_id)
            && other.remote_id.as_deref() == Some(number)
    }) {
        return Err("这个官网编号已经关联其他本地任务。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn check_receipt(s: Core<'_>, id: String, number: String) -> Result<Receipt> {
    let job = s.store.job(&id)?;
    eligible(&job, number.trim())?;
    available(&s, &job, number.trim())?;
    lookup(&s, &job, number.trim()).await
}
#[tauri::command]
pub async fn attach_receipt(s: Core<'_>, id: String, number: String) -> Result<()> {
    let number = number.trim();
    let original = s.store.job(&id)?;
    lookup(&s, &original, number).await?;
    let job = {
        let _lock = s.store.gate.lock().unwrap();
        let mut job = s.store.job(&id)?;
        eligible(&job, number)?;
        available(&s, &job, number)?;
        job.remote_id = Some(number.into());
        job.status = "paused".into();
        job.detail = "已核对官网账户与任务号。".into();
        crate::storage::files::save(&s.store.job_path(&job.id)?, &job)?;
        job
    };
    s.job_changed(&job.id);
    s.inner().launch(job, false)
}
