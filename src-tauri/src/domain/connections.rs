use super::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
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
    pub fn workflow(&self, mode: &str) -> (&str, &str, &str) {
        if let Some(w) = self.workflows.get(mode) {
            (&w.submit, &w.body, &w.encoding)
        } else {
            (&self.submit, &self.body, &self.encoding)
        }
    }
    fn check_workflows(&self, base: &str, video: bool) -> Result<()> {
        let valid = |s: &str| matches!(s, "" | "json" | "multipart");
        if !valid(&self.encoding) {
            return Err("请求格式无效。".into());
        }
        for (mode, w) in &self.workflows {
            if !(if video {
                matches!(mode.as_str(), "first_frame" | "first_last" | "reference")
            } else {
                mode == "i2i"
            }) || !valid(&w.encoding)
            {
                return Err("接口的创作方式或格式无效。".into());
            }
            route(base, &w.submit)?;
            let body: Value = serde_json::from_str(&w.body)
                .map_err(|e| format!("带素材请求体 JSON 无效：{e}"))?;
            if !body.is_object() {
                return Err("请求体必须是 JSON 对象。".into());
            }
            let has = |key: &str| w.body.contains(&format!("{{{{{key}}}}}"));
            let images = has("images") || has("images_base64");
            let first = has("first_frame") || has("first_frame_base64") || has("image");
            let last = has("last_frame") || has("last_frame_base64");
            if !match mode.as_str() {
                "first_last" => images || (first && last),
                "reference" => images || has("videos") || has("audios"),
                _ => images || first,
            } {
                return Err(format!("「{mode}」请求体缺少对应的素材占位符。"));
            }
        }
        Ok(())
    }

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
        self.check_workflows(base, video)?;
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceGroup {
    #[default]
    Auto,
    Direct,
    Relay,
    SelfHosted,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub service_group: ServiceGroup,
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
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: Option<String>,
    pub name: String,
    pub service_group: Option<ServiceGroup>,
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
