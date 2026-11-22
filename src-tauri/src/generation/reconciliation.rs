use crate::{
    app::Core,
    domain::{route, Result},
    providers,
    storage::files::{read, save},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
pub struct Charge {
    amount: f64,
    unit: String,
    receipt: String,
}
#[tauri::command]
pub fn get_charge(s: Core, id: String) -> Result<Option<Charge>> {
    s.store.job(&id)?;
    let p = s.store.home.join("用量凭据").join(format!("{id}.json"));
    if p.exists() {
        read(&p).map(Some)
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub fn record_charge(s: Core, id: String, charge: Charge) -> Result<()> {
    s.store.job(&id)?;
    if !charge.amount.is_finite()
        || charge.amount < 0.
        || !matches!(charge.unit.as_str(), "CNY" | "USD" | "积分")
        || charge.receipt.trim().is_empty()
        || charge.receipt.chars().count() > 300
    {
        return Err("请填写账单实扣、单位和凭据编号。".into());
    }
    let dir = s.store.home.join("用量凭据");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    save(&dir.join(format!("{id}.json")), &charge)
}
#[tauri::command]
pub fn mark_reconciled(s: Core, id: String, outcome: String) -> Result<()> {
    let _guard = s.store.gate.lock().unwrap();
    let mut j = s.store.job(&id)?;
    if j.status != "uncertain"
        || !matches!(outcome.as_str(), "服务商确认未受理" | "已在官网人工取回")
    {
        return Err("这条记录不适用人工核对。".into());
    }
    j.status = "reviewed".into();
    j.detail = outcome;
    save(&s.store.job_path(&id)?, &j)?;
    s.job_changed(&id);
    Ok(())
}
#[tauri::command]
pub async fn cancel_remote(s: Core<'_>, id: String) -> Result<String> {
    let j = s.store.job(&id)?;
    if j.protocol_id != "comfy-image" || !matches!(j.status.as_str(), "waiting" | "paused") {
        return Err("此任务没有可用的远端取消接口。".into());
    }
    let remote = j
        .remote_id
        .as_deref()
        .filter(|v| {
            v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .ok_or("缺少有效的远端任务号。")?;
    let url = route(&j.base_url, &format!("api/jobs/{remote}/cancel"))?;
    let key = s.store.key(&j)?;
    let value = providers::json_response(
        providers::auth(
            s.http.post(url).timeout(std::time::Duration::from_secs(20)),
            "bearer",
            &key,
        ),
        &key,
    )
    .await
    .map_err(|e| e.message)?;
    if value["cancelled"] == Value::Bool(true) {
        let dir = s.store.home.join("远端撤回");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        save(&dir.join(format!("{id}.json")), &true)?;
        let _lock = s.store.gate.lock().unwrap();
        let mut current = s.store.job(&id)?;
        if matches!(current.status.as_str(), "waiting" | "paused") {
            current.status = "cancelled".into();
            current.detail = "服务端已受理针对该编号的取消。".into();
            save(&s.store.job_path(&id)?, &current)?;
        }
        s.job_changed(&id);
        Ok("服务端已受理本任务的取消。".into())
    } else if value["cancelled"] == Value::Bool(false) {
        Ok("服务端未取消，任务可能已结束。".into())
    } else {
        Err("服务端未确认取消。".into())
    }
}
