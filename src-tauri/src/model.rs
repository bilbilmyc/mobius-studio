use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, sync::OnceLock};
pub type Result<T> = std::result::Result<T, String>;
pub const SITE: &str = "https://queueapi.vylai.com/openapi";
pub const WEBSITE: &str = "https://rh.vylai.com/workbench";
pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn site(proto: &str) -> bool {
    matches!(proto, "rh-image" | "rh-video")
}
pub fn custom(proto: &str) -> bool {
    matches!(proto, "relay-image" | "relay-video")
}
pub fn kind(proto: &str) -> &str {
    if proto.ends_with("-video") {
        "video"
    } else {
        "image"
    }
}
pub fn templates() -> &'static Vec<Value> {
    static LIST: OnceLock<Vec<Value>> = OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/RhTemplates.json"))
            .expect("embedded RH templates")
    })
}
pub fn template(key: &str) -> Option<&'static Value> {
    templates().iter().find(|v| v["Key"] == key)
}
pub fn default_model(media: &str) -> String {
    templates()
        .iter()
        .find(|v| v["Video"] == (media == "video"))
        .unwrap()["Key"]
        .as_str()
        .unwrap()
        .to_string()
}
pub fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn canonical_base(s: &str) -> Result<String> {
    let u = url::Url::parse(s.trim()).map_err(|_| "服务根地址无效")?;
    let local = u.host_str().is_some_and(|h| {
        h == "localhost"
            || h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(u.scheme() == "https" || u.scheme() == "http" && local)
        || !u.has_host()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("请填写 HTTPS 服务根地址，本机调试可使用 HTTP 回环地址。".into());
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}
pub fn route(base: &str, path: &str) -> Result<url::Url> {
    if path.trim().is_empty()
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path.contains("://")
    {
        return Err("接口路径须在服务根地址之下。".into());
    }
    let root =
        url::Url::parse(&format!("{}/", canonical_base(base)?)).map_err(|e| e.to_string())?;
    let dest = root
        .join(path.trim_start_matches('/'))
        .map_err(|e| e.to_string())?;
    if dest.origin() != root.origin() || !dest.path().starts_with(root.path()) {
        return Err("接口路径超出服务根地址。".into());
    }
    Ok(dest)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Relay {
    pub auth: String,
    pub submit: String,
    pub poll: String,
    pub body: String,
    pub id: String,
    pub state: String,
    pub url: String,
    pub base64: String,
    pub error: String,
    pub success: String,
    pub failure: String,
    pub waiting: String,
    pub sizes: Vec<String>,
    pub seconds: Vec<u32>,
    pub encoding: String,
    pub workflows: std::collections::BTreeMap<String, Workflow>,
    pub parameters: Vec<Parameter>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Parameter {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "default")]
    pub initial: Value,
    pub choices: Vec<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}
impl Parameter {
    pub fn accepts(&self, v: &Value) -> bool {
        match self.kind.as_str() {
            "text" => v.is_string(),
            "number" => v.as_f64().is_some_and(|n| {
                self.min.is_none_or(|m| n >= m) && self.max.is_none_or(|m| n <= m)
            }),
            "select" => v
                .as_str()
                .is_some_and(|s| self.choices.iter().any(|k| k == s)),
            "boolean" => v.is_boolean(),
            _ => false,
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Workflow {
    pub submit: String,
    pub body: String,
    pub encoding: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Controls {
    pub sizes: Vec<String>,
    pub seconds: Vec<u32>,
    pub resolutions: Vec<String>,
    pub ratios: Vec<String>,
    pub custom_size: bool,
}
impl Relay {
    pub fn validate(&self, base: &str, video: bool) -> Result<()> {
        route(base, &self.submit)?;
        if !matches!(
            self.auth.as_str(),
            "bearer"
                | "x-api-key"
                | "x-auth-token"
                | "x-goog-api-key"
                | "api-key"
                | "token"
                | "none"
        ) {
            return Err("认证方式无效".into());
        }
        if !self.poll.is_empty() {
            if !self.poll.contains("{id}")
                || self.id.is_empty()
                || self.state.is_empty()
                || self.success.is_empty()
            {
                return Err("异步接口需要 {id} 轮询路径、任务 ID、状态字段和完成状态。".into());
            }
            route(base, &self.poll.replace("{id}", "example"))?;
        }
        let body: Value =
            serde_json::from_str(&self.body).map_err(|e| format!("请求体 JSON 无效：{e}"))?;
        if !body.is_object() || self.url.trim().is_empty() && self.base64.trim().is_empty() {
            return Err("请配置请求对象和结果 URL 或 Base64 字段。".into());
        }
        if self.sizes.is_empty()
            || self.sizes.iter().any(|v| v.trim().is_empty())
            || video && (self.seconds.is_empty() || self.seconds.contains(&0))
        {
            return Err("请填写有效的画幅和时长选项。".into());
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.parameters {
            if p.label.trim().is_empty()
                || p.key.is_empty()
                || !p
                    .key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || !seen.insert(&p.key)
                || !p.accepts(&p.initial)
            {
                return Err("请检查模型参数的名称、唯一字段名、类型和默认值。".into());
            }
            let token = format!("{{{{params.{}}}}}", p.key);
            if !self.body.contains(&token)
                && !self.workflows.values().any(|w| w.body.contains(&token))
            {
                return Err(format!("请求体中缺少参数占位符 {token}"));
            }
        }
        crate::creation::check_workflows(self, base, video)?;
        Ok(())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub protocol_id: String,
    pub base_url: String,
    pub model: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    pub keys: HashMap<String, String>,
    pub relay: Option<Relay>,
    pub controls: Option<Controls>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Asset {
    pub kind: String,
    pub name: String,
    pub path: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct SiteOptions {
    pub config: Map<String, Value>,
    pub priority: u8,
    pub assets: Vec<Asset>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Job {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub protocol_id: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub size: String,
    pub seconds: u32,
    pub reference: Option<String>,
    pub assets: Vec<Asset>,
    pub settings: Map<String, Value>,
    pub site_options: Option<SiteOptions>,
    pub relay: Option<Relay>,
    pub status: String,
    pub detail: String,
    pub remote_id: Option<String>,
    pub result_url: Option<String>,
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<crate::object_storage::CloudCopy>,
    pub created_utc: String,
}
impl Job {
    pub fn time(&self) -> i64 {
        let s = self.created_utc.trim_matches('/');
        if let Some(s) = s.strip_prefix("Date(").and_then(|s| s.strip_suffix(')')) {
            return s
                .split(['+'])
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
        }
        chrono::DateTime::parse_from_rfc3339(&self.created_utc)
            .map(|v| v.timestamp_millis())
            .unwrap_or(0)
    }
    pub fn view(&self, file: Option<&str>) -> Value {
        json!({"id":self.id,"profileId":self.profile_id,"profileName":self.profile_name,"protocol":self.protocol_id,"base":self.base_url,"model":self.model,"prompt":self.prompt,"size":self.size,"seconds":self.seconds,"kind":kind(&self.protocol_id),"status":self.status,"detail":self.detail,"remoteId":self.remote_id,"created":self.time(),"file":file.is_some(),"mediaPath":file,"cloud":self.cloud,"settings":self.settings,"legacyFrame":self.reference.is_some(),"site":self.site_options.as_ref().map(|s|json!({"config":s.config,"priority":s.priority}))})
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub base: String,
    pub model: String,
    pub models: Option<Vec<String>>,
    pub key: String,
    pub relay: Option<Relay>,
    pub controls: Option<Controls>,
    #[serde(default)]
    pub session_only: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Picked {
    pub kind: String,
    pub name: String,
    pub token: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub profile_id: String,
    pub model: Option<String>,
    pub kind: String,
    pub template: String,
    pub prompt: String,
    pub size: String,
    pub seconds: u32,
    pub config: Map<String, Value>,
    pub priority: u8,
    pub assets: Vec<Picked>,
}
pub fn validate_template(t: &Value, o: &SiteOptions, prompt: &str) -> Result<()> {
    if t["Text"]["Required"] == true && prompt.trim().is_empty() {
        return Err("请填写提示词。".into());
    }
    if o.priority > 1 || o.priority == 1 && t["Rate"] == t["FastRate"] {
        return Err("所选队列不可用。".into());
    }
    let fields = t["Fields"].as_array().unwrap();
    if fields.len() != o.config.len() {
        return Err("模板参数数目不匹配。".into());
    }
    for f in fields {
        let k = string(&f["Key"]);
        let v = o.config.get(k).ok_or_else(|| format!("缺少参数 {k}"))?;
        let ok = match string(&f["Type"]) {
            "number" => v.as_i64().is_some_and(|i| {
                i >= f["Min"].as_i64().unwrap()
                    && i <= f["Max"].as_i64().unwrap()
                    && (i - f["Min"].as_i64().unwrap()) % f["Step"].as_i64().unwrap() == 0
            }),
            "boolean" => v.is_boolean(),
            "select" => f["Options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|x| x["Value"] == *v),
            _ => false,
        };
        if !ok {
            return Err(format!("请检查「{}」。", string(&f["Label"])));
        }
    }
    let mode = o.config.get("mode").and_then(Value::as_str).unwrap_or("");
    for k in ["image", "video", "audio"] {
        let n = o.assets.iter().filter(|a| a.kind == k).count() as u64;
        let (min, max) = match mode {
            "t2v" => (0, 0),
            "first_frame" if k == "image" => (1, 1),
            "first_last" if k == "image" => (2, 2),
            "first_frame" | "first_last" => (0, 0),
            _ => t["Slots"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["Kind"] == k)
                .map(|s| (s["Min"].as_u64().unwrap(), s["Max"].as_u64().unwrap()))
                .unwrap_or((0, 0)),
        };
        if n < min || n > max {
            return Err(format!(
                "{}素材需要 {min}–{max} 个。",
                match k {
                    "image" => "图片",
                    "video" => "视频",
                    _ => "音频",
                }
            ));
        }
    }
    if t["AnyReference"] == true && o.assets.is_empty() {
        return Err("请至少添加一个参考素材。".into());
    }
    Ok(())
}
