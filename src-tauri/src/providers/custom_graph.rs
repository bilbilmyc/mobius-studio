use crate::{
    app::Core,
    domain::{route, Job, Result},
    providers::provider::{auth, json_response},
    storage::files::{read, save},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub graph: Value,
    pub prompt_node: String,
    pub prompt_field: String,
    pub image_node: Option<String>,
    pub image_field: String,
    pub output_node: String,
}
type Graphs = BTreeMap<String, Graph>;
fn key(id: &str, base: &str, model: &str) -> String {
    format!("{id}|{base}|{model}")
}
fn all(s: &crate::storage::store::Store) -> Result<Graphs> {
    let p = s.home.join("Comfy工作流.json");
    if p.exists() {
        read(&p)
    } else {
        Ok(Default::default())
    }
}
pub(crate) fn snapshot(s: &crate::storage::store::Store, j: &mut Job) -> Result<()> {
    if let Some(g) = all(s)?.get(&key(&j.profile_id, &j.base_url, &j.model)) {
        if g.image_node.is_some() != !j.assets.is_empty() {
            return Err("当前工作流的图片节点与所选创作方式不匹配。".into());
        }
        j.settings.insert(
            "comfyWorkflow".into(),
            json!(serde_json::to_string(g).map_err(|e| e.to_string())?),
        );
    }
    Ok(())
}
pub(crate) fn selected(j: &Job) -> Result<Option<Graph>> {
    j.settings
        .get("comfyWorkflow")
        .and_then(Value::as_str)
        .map(|v| serde_json::from_str(v).map_err(|_| "ComfyUI 工作流快照无效。".into()))
        .transpose()
}
fn verify(g: &Graph, inventory: &Value) -> Result<()> {
    let nodes = g
        .graph
        .as_object()
        .filter(|o| !o.is_empty() && o.len() <= 4096)
        .ok_or("请导入 ComfyUI 导出的 API 格式 JSON。")?;
    for (id, node) in nodes {
        let class = node["class_type"]
            .as_str()
            .ok_or("节点缺少 class_type，请选择 API 格式。")?;
        let definition = inventory
            .get(class)
            .ok_or_else(|| format!("服务端缺少节点 {class}（{id}）。"))?;
        let supplied = node["inputs"].as_object().ok_or("节点缺少 inputs。")?;
        for (param, value) in supplied {
            if matches!(
                param.as_str(),
                "ckpt_name" | "lora_name" | "unet_name" | "vae_name" | "clip_name" | "model_name"
            ) {
                let choices = &definition["input"]["required"][param];
                let allowed = choices[0]
                    .as_array()
                    .or_else(|| choices[1]["options"].as_array());
                if value.is_string() && allowed.is_some_and(|a| !a.contains(value)) {
                    return Err(format!(
                        "节点 {id} 所需的模型 {} 未安装。",
                        value.as_str().unwrap()
                    ));
                }
            }
        }
    }
    if !g.graph[&g.prompt_node]["inputs"][&g.prompt_field].is_string() {
        return Err("提示词绑定需要可写的文本输入。".into());
    }
    if let Some(id) = &g.image_node {
        if !g.graph[id]["inputs"][&g.image_field].is_string() {
            return Err("参考图绑定需要文件名输入。".into());
        }
    }
    let out = nodes.get(&g.output_node).ok_or("请选择结果节点。")?;
    if out["class_type"] != "SaveImage"
        && inventory[out["class_type"].as_str().unwrap()]["output_node"] != true
    {
        return Err("所选节点不会输出图片文件。".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn configure_graph(
    s: Core<'_>,
    profile_id: String,
    model: String,
    graph: Option<Graph>,
) -> Result<()> {
    let p = s.store.resolve(&profile_id, "image")?;
    if p.protocol_id != "comfy-image" || (p.model != model && !p.models.contains(&model)) {
        return Err("请选择已配置的 ComfyUI 模型。".into());
    }
    if let Some(g) = &graph {
        if serde_json::to_vec(g).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
            return Err("工作流超过 2 MiB。".into());
        }
        let token = s.store.vault.get(&p, &p.base_url)?;
        let info = json_response(
            auth(
                s.http
                    .get(route(&p.base_url, "object_info")?)
                    .timeout(std::time::Duration::from_secs(25)),
                "bearer",
                &token,
            ),
            &token,
        )
        .await
        .map_err(|e| e.message)?;
        verify(g, &info)?;
    }
    let _lock = s.store.gate.lock().unwrap();
    let mut configs = all(&s.store)?;
    let key = key(&p.id, &p.base_url, &model);
    if let Some(g) = graph {
        configs.insert(key, g);
    } else {
        configs.remove(&key);
    }
    save(&s.store.home.join("Comfy工作流.json"), &configs)
}
#[tauri::command]
pub fn get_graph(s: Core, profile_id: String, model: String) -> Result<Option<Graph>> {
    let p = s.store.resolve(&profile_id, "image")?;
    Ok(all(&s.store)?.remove(&key(&p.id, &p.base_url, &model)))
}

pub(crate) fn actual_parameters(j: &mut Job, g: &Graph) -> Result<()> {
    for name in [
        "seed",
        "steps",
        "cfg",
        "negative",
        "denoise",
        "ratio",
        "resolution",
    ] {
        j.settings.remove(name);
    }
    let nodes = g.graph.as_object().ok_or("工作流无效。")?;
    let mut sizes = std::collections::BTreeSet::new();
    for node in nodes.values() {
        let args = &node["inputs"];
        if let (Some(w), Some(h)) = (args["width"].as_u64(), args["height"].as_u64()) {
            sizes.insert(format!("{w}x{h}"));
        }
    }
    j.size = if sizes.len() == 1 {
        sizes.into_iter().next().unwrap()
    } else {
        "由工作流确定".into()
    };
    let mut samplers = nodes
        .values()
        .filter(|node| node["class_type"] == "KSampler");
    if let Some(node) = samplers.next().filter(|_| samplers.next().is_none()) {
        for name in ["seed", "steps", "cfg", "denoise"] {
            if let Some(n) = node["inputs"].get(name).filter(|v| v.is_number()) {
                j.settings.insert(name.into(), n.clone());
            }
        }
    }
    Ok(())
}
