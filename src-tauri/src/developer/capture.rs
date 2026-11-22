use super::json_body::{self, JsonPiece};
use reqwest::Request;
use serde::Serialize;
use serde_json::Value;
use url::Url;

pub(super) const TEXT_LIMIT: usize = 48 * 1024;
pub(super) const RECORD_LIMIT: usize = 160 * 1024;

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum Argument {
    Literal(String),
    Variable {
        env: String,
        format: &'static str,
        prefix: String,
    },
}
impl Argument {
    fn variable(env: &str, format: &'static str, prefix: &str) -> Self {
        Self::Variable {
            env: env.into(),
            format,
            prefix: prefix.into(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Field {
    Text {
        name: String,
        value: Argument,
    },
    File {
        name: String,
        file: Argument,
        filename: Argument,
        mime: String,
    },
}
impl Field {
    pub fn name(&self) -> &str {
        match self {
            Self::Text { name, .. } | Self::File { name, .. } => name,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Body {
    Empty,
    Json { pieces: Vec<JsonPiece> },
    Form { fields: Vec<Field> },
    File,
}
#[derive(Clone, Serialize)]
pub(crate) struct Example {
    url: Argument,
    method: String,
    headers: Vec<(String, Argument)>,
    body: Body,
    timeout: u64,
}

fn normalized(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
pub(super) fn sensitive(name: &str) -> bool {
    let n = normalized(name);
    n.starts_with("secret")
        || matches!(
            n.as_str(),
            "key"
                | "auth"
                | "authorization"
                | "cookie"
                | "setcookie"
                | "sig"
                | "pwd"
                | "policy"
                | "credential"
                | "credentials"
                | "reasoningcontent"
                | "thoughtsignature"
                | "jwt"
                | "passphrase"
        )
        || [
            "apikey",
            "secret",
            "password",
            "token",
            "signature",
            "credential",
            "accesskeyid",
            "accesskey",
            "privatekey",
        ]
        .iter()
        .any(|k| n.ends_with(k))
}
fn private_url(url: &Url) -> bool {
    !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query_pairs().any(|(k, _)| {
            !matches!(
                k.as_ref(),
                "filename"
                    | "subfolder"
                    | "type"
                    | "page"
                    | "limit"
                    | "offset"
                    | "size"
                    | "model"
                    | "api-version"
                    | "lang"
            )
        })
}
pub(super) struct Scrubber<'a> {
    key: &'a str,
    next: usize,
}
impl<'a> Scrubber<'a> {
    pub fn new(key: &'a str) -> Self {
        Self { key, next: 0 }
    }
    pub fn binding(&mut self, stem: &str, format: &'static str, prefix: &str) -> Argument {
        self.next += 1;
        Argument::variable(&format!("{stem}_{}", self.next), format, prefix)
    }
    fn has_key(&self, text: &str) -> bool {
        !self.key.is_empty() && text.contains(self.key)
    }
    pub fn safe_name(&self, name: &str) -> bool {
        name.len() <= 512
            && !name.chars().any(char::is_control)
            && !self.has_key(name)
            && !name.contains("://")
    }
    fn url(&self, url: &Url) -> (String, Argument) {
        let display = format!("{}{}", url.origin().ascii_serialization(), url.path());
        if self.has_key(url.as_str()) || private_url(url) || url.as_str().len() > 4096 {
            let origin = url.origin().ascii_serialization();
            let target = if self.has_key(&origin) {
                "请求地址".into()
            } else {
                format!("{origin}/…")
            };
            (target, Argument::variable("REQUEST_URL", "text", ""))
        } else {
            (display, Argument::Literal(url.to_string()))
        }
    }
    pub fn text(&mut self, field: &str, value: &str) -> Argument {
        if !self.key.is_empty() && value == self.key {
            return Argument::variable("API_KEY", "text", "");
        }
        if sensitive(field) || self.has_key(value) {
            return self.binding("VALUE", "text", "");
        }
        if let Some((kind, _)) = value
            .strip_prefix("data:")
            .and_then(|v| v.split_once(";base64,"))
        {
            if kind.len() < 100
                && kind
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/.+-".contains(&b))
            {
                return self.binding("FILE", "base64", &format!("data:{kind};base64,"));
            }
        }
        let likely_base64 = value.len() >= 64
            && (field.to_ascii_lowercase().contains("base64")
                || value.starts_with("iVBORw0KGgo")
                || value.starts_with("/9j/")
                || value.len() > 1024)
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b));
        if likely_base64 {
            return self.binding("FILE", "base64", "");
        }
        if value.len() > TEXT_LIMIT {
            return self.binding("VALUE", "text", "");
        }
        let lower = value.to_ascii_lowercase();
        // Tool results and custom form values may wrap credentials or signed links in serialized text.
        let restricted = value
            .split([' ', '\n', '\r', '\t', '"', '\'', '<', '>'])
            .filter_map(|s| Url::parse(s).ok())
            .any(|u| matches!(u.scheme(), "http" | "https") && private_url(&u));
        if restricted
            || [
                "bearer ",
                "x-amz-signature=",
                "x-goog-signature=",
                "signature=",
                "token=",
                "api_key=",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
            || lower
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                .any(|word| word.len() >= 18 && word.starts_with("sk-"))
            || (value.trim_start().starts_with(['{', '['])
                && serde_json::from_str::<Value>(value).is_ok_and(|v| contains_sensitive_name(&v)))
        {
            return self.binding("VALUE", "text", "");
        }
        Argument::Literal(value.into())
    }
    pub fn metadata(&mut self, name: &str, value: &str) -> Argument {
        match self.text(name, value) {
            Argument::Variable {
                format: "base64", ..
            } => self.binding("VALUE", "text", ""),
            other => other,
        }
    }
    fn header(&mut self, name: &str, value: &str) -> Argument {
        if name == "authorization" {
            if let Some((scheme, _)) = value.split_once(' ') {
                if ["bearer", "token", "basic"].contains(&scheme.to_ascii_lowercase().as_str()) {
                    return Argument::variable(
                        if scheme.eq_ignore_ascii_case("basic") {
                            "BASIC_CREDENTIALS"
                        } else {
                            "API_KEY"
                        },
                        "text",
                        &format!("{scheme} "),
                    );
                }
            }
            return Argument::variable("AUTHORIZATION", "text", "");
        }
        if matches!(
            name,
            "x-api-key" | "api-key" | "x-goog-api-key" | "x-auth-token"
        ) {
            return Argument::variable("API_KEY", "text", "");
        }
        if matches!(
            name,
            "content-type"
                | "accept"
                | "host"
                | "x-dashscope-async"
                | "user-agent"
                | "content-encoding"
        ) {
            return self.metadata(name, value);
        }
        self.binding("HEADER", "text", "")
    }
}
fn contains_sensitive_name(value: &Value) -> bool {
    match value {
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| sensitive(k) || contains_sensitive_name(v)),
        Value::Array(a) => a.iter().any(contains_sensitive_name),
        _ => false,
    }
}
impl Example {
    pub(super) fn capture(
        request: &Request,
        key: &str,
        form: Option<Vec<Field>>,
    ) -> (String, Self) {
        let mut scrub = Scrubber::new(key);
        let (target, url) = scrub.url(request.url());
        let body = if let Some(fields) = form {
            if serde_json::to_vec(&fields).is_ok_and(|s| s.len() <= RECORD_LIMIT) {
                Body::Form { fields }
            } else {
                Body::File
            }
        } else if let Some(body) = request.body() {
            let json = request
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| s.contains("json"));
            if json {
                body.as_bytes()
                    .and_then(|b| json_body::capture(b, &mut scrub))
                    .map(|pieces| Body::Json { pieces })
                    .unwrap_or(Body::File)
            } else {
                Body::File
            }
        } else {
            Body::Empty
        };
        let mut headers = vec![];
        for (k, v) in request.headers() {
            let name = k.as_str();
            if name == "content-length"
                || (name == "content-type" && matches!(&body, Body::Form { .. }))
            {
                continue;
            }
            headers.push((name.into(), scrub.header(name, v.to_str().unwrap_or(""))));
        }
        (
            target,
            Self {
                url,
                method: request.method().to_string(),
                headers,
                body,
                timeout: request.timeout().map(|d| d.as_secs()).unwrap_or(15 * 60),
            },
        )
    }
}
