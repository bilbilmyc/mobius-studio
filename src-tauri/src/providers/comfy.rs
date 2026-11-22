use crate::{
    connections::catalog::Catalog,
    domain::{route, Job, Result},
    generation::creation::dimensions,
    providers::inputs::Input,
    providers::provider::{auth, json_response, protect_text, Fault, Output, Reply},
};
use reqwest::{multipart::Form, Client};
use serde_json::{json, Value};
use std::time::Duration;

pub async fn models(h: &Client, base: &str, key: &str) -> Reply<Catalog> {
    let result = json_response(
        auth(
            h.get(route(base, "object_info/CheckpointLoaderSimple")?),
            "bearer",
            key,
        )
        .timeout(Duration::from_secs(20)),
        key,
    )
    .await?;
    let field = &result["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"];
    let list = field[0]
        .as_array()
        .or_else(|| field[1]["options"].as_array())
        .ok_or_else(|| Fault::known("此地址未返回 ComfyUI 的 checkpoint 列表。"))?;
    let mut models: Vec<_> = list
        .iter()
        .filter_map(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .collect();
    models.sort();
    models.dedup();
    Ok(Catalog {
        base: base.into(),
        models,
    })
}

pub(crate) fn random_seed() -> u64 {
    (uuid::Uuid::new_v4().as_u128() as u64) & ((1_u64 << 53) - 1)
}
pub fn prepare(job: &mut Job) -> Result<()> {
    let (w, h) = dimensions(&job.size).ok_or("ComfyUI 需要像素尺寸。")?;
    if w % 8 != 0 || h % 8 != 0 {
        return Err("ComfyUI 的宽、高需为 8 的倍数。".into());
    }
    if job
        .assets
        .iter()
        .any(|a| crate::generation::creation::remote(&a.path))
    {
        return Err("ComfyUI 图生图需要本地参考图。".into());
    }
    let seed = job
        .settings
        .entry("seed")
        .or_insert(json!(-1))
        .as_i64()
        .ok_or("随机种子须为整数。")?;
    if !(-1..=9_007_199_254_740_991).contains(&seed) {
        return Err("随机种子超出范围。".into());
    }
    if seed == -1 {
        job.settings.insert("seed".into(), json!(random_seed()));
    }
    if !job
        .settings
        .entry("steps")
        .or_insert(json!(20))
        .as_u64()
        .is_some_and(|v| (1..=150).contains(&v))
        || !job
            .settings
            .entry("cfg")
            .or_insert(json!(7.0))
            .as_f64()
            .is_some_and(|v| (0.0..=30.0).contains(&v))
        || !job
            .settings
            .entry("denoise")
            .or_insert(json!(0.65))
            .as_f64()
            .is_some_and(|v| (0.0..=1.0).contains(&v))
        || !job
            .settings
            .entry("negative")
            .or_insert(json!(""))
            .is_string()
    {
        return Err("请检查采样步数、引导强度、重绘强度和反向提示词。".into());
    }
    Ok(())
}

pub async fn submit(client: &Client, job: &Job, key: &str, inputs: &[Input]) -> Reply<Output> {
    let imported = crate::providers::custom_graph::selected(job)?;
    let (w, h) = match (dimensions(&job.size), imported.is_some()) {
        (Some(size), _) => size,
        (None, true) => (0, 0),
        _ => return Err(Fault::known("ComfyUI 尺寸无效。")),
    };
    let s = &job.settings;
    let mut graph = if let Some(g) = &imported {
        let mut graph = g.graph.clone();
        graph[&g.prompt_node]["inputs"][&g.prompt_field] = json!(job.prompt);
        graph
    } else {
        json!({
            "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":job.model}},
            "2":{"class_type":"CLIPTextEncode","inputs":{"text":job.prompt,"clip":["1",1]}},
            "3":{"class_type":"CLIPTextEncode","inputs":{"text":s["negative"],"clip":["1",1]}},
            "4":{"class_type":"EmptyLatentImage","inputs":{"width":w,"height":h,"batch_size":1}},
            "5":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],
                "latent_image":["4",0],"seed":s["seed"],"steps":s["steps"],"cfg":s["cfg"],"sampler_name":"euler","scheduler":"normal","denoise":1.0}},
            "6":{"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
            "7":{"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":"Mobius"}}
        })
    };
    if let Some(image) = inputs.first() {
        let form = Form::new()
            .part("image", image.part().await?)
            .text("type", "input")
            .text("subfolder", "mobius");
        let reply = json_response(
            auth(
                client.post(route(&job.base_url, "upload/image")?),
                "bearer",
                key,
            )
            .multipart(form),
            key,
        )
        .await?;
        let name = reply["name"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Fault::known("ComfyUI 没有返回上传的图片名称。"))?;
        let folder = reply["subfolder"].as_str().unwrap_or("").trim_matches('/');
        if let Some(g) = &imported {
            let id = g
                .image_node
                .as_ref()
                .ok_or_else(|| Fault::known("工作流没有参考图绑定。"))?;
            graph[id]["inputs"][&g.image_field] = json!(if folder.is_empty() {
                name.to_owned()
            } else {
                format!("{folder}/{name}")
            });
        } else {
            graph["8"] = json!({"class_type":"LoadImage","inputs":{"image":if folder.is_empty() { name.to_owned() } else { format!("{folder}/{name}") }}});
            graph["9"] = json!({"class_type":"ImageScale","inputs":{"image":["8",0],"upscale_method":"lanczos","width":w,"height":h,"crop":"center"}});
            graph["4"] =
                json!({"class_type":"VAEEncode","inputs":{"pixels":["9",0],"vae":["1",2]}});
            graph["5"]["inputs"]["denoise"] = s["denoise"].clone();
        }
    }
    let reply = json_response(
        auth(client.post(route(&job.base_url, "prompt")?), "bearer", key)
            .json(&json!({"prompt":graph,"client_id":job.id})),
        key,
    )
    .await?;
    reply["prompt_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Output::Ticket(s.into()))
        .ok_or_else(|| Fault::uncertain("ComfyUI 未返回任务编号，请核对本地队列。"))
}

fn result(job: &Job, history: &Value, key: &str) -> Reply<Output> {
    let status = &history["status"];
    if let Some(messages) = status["messages"].as_array() {
        for msg in messages {
            if matches!(
                msg[0].as_str(),
                Some("execution_error" | "execution_interrupted")
            ) {
                return Ok(Output::Failed(protect_text(
                    msg[1]["exception_message"]
                        .as_str()
                        .unwrap_or("ComfyUI 任务已中止。"),
                    key,
                )));
            }
        }
    }
    if status["status_str"] == "error" {
        return Ok(Output::Failed("ComfyUI 工作流执行失败。".into()));
    }
    let node = crate::providers::custom_graph::selected(job)?
        .map(|g| g.output_node)
        .unwrap_or_else(|| "7".into());
    let image = history["outputs"][&node]["images"]
        .as_array()
        .and_then(|a| a.iter().find(|i| i["type"] == "output"));
    if let Some(image) = image {
        let name = image["filename"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Fault::known("ComfyUI 缺少输出文件名。"))?;
        let mut url = route(&job.base_url, "view")?;
        url.query_pairs_mut()
            .append_pair("filename", name)
            .append_pair("subfolder", image["subfolder"].as_str().unwrap_or(""))
            .append_pair("type", "output");
        return Ok(Output::Url(url.into()));
    }
    if status["completed"] == true {
        return Ok(Output::Failed(
            "ComfyUI 已完成，但 SaveImage 没有返回图片。".into(),
        ));
    }
    Ok(Output::Pending("正在等待 ComfyUI 返回工作流结果。".into()))
}

pub async fn query(h: &Client, job: &Job, key: &str, encoded_id: &str) -> Reply<Output> {
    let id = job
        .remote_id
        .as_deref()
        .ok_or_else(|| Fault::known("缺少 ComfyUI 任务编号。"))?;
    let history = route(&job.base_url, &format!("history/{encoded_id}"))?;
    let get = |url| {
        json_response(
            auth(h.get(url), "bearer", key).timeout(crate::providers::provider::POLL_TIMEOUT),
            key,
        )
    };
    let first = get(history.clone()).await?;
    if let Some(record) = first.get(id) {
        return result(job, record, key);
    }
    let queue = get(route(&job.base_url, "queue")?).await?;
    let in_queue = |k: &str| {
        queue[k]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row[1] == id))
    };
    if in_queue("queue_running") {
        return Ok(Output::Pending("ComfyUI 正在执行工作流。".into()));
    }
    if in_queue("queue_pending") {
        return Ok(Output::Pending("ComfyUI 已接收，正在排队。".into()));
    }
    // A job can leave the queue between our history and queue reads.
    let latest = get(history).await?;
    match latest.get(id) {
        Some(record) => result(job, record, key),
        None => Err(Fault::known(
            "ComfyUI 队列和历史中均无此编号，请核对本地服务后恢复任务。",
        )),
    }
}
