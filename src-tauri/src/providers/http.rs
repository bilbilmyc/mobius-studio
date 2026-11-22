use crate::domain::{string, Result};
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use std::time::Duration;
#[derive(Debug)]
pub struct Fault {
    pub message: String,
    pub definite: bool,
    // Only read-only status queries use this. Zero allows the client's normal backoff.
    pub poll_retry_after: Option<Duration>,
}
impl Fault {
    pub fn uncertain(s: impl ToString) -> Self {
        Self {
            message: s.to_string(),
            definite: false,
            poll_retry_after: None,
        }
    }
    pub fn known(s: impl ToString) -> Self {
        Self {
            message: s.to_string(),
            definite: true,
            poll_retry_after: None,
        }
    }
    pub(crate) fn transport(error: reqwest::Error) -> Self {
        let transient =
            error.is_timeout() || error.is_connect() || error.is_body() || error.is_request();
        let reason = if error.is_timeout() {
            "等待服务响应超时"
        } else if error.is_connect() {
            "无法连接服务"
        } else {
            "服务连接中断"
        };
        Self {
            poll_retry_after: transient.then_some(Duration::ZERO),
            ..Self::uncertain(format!("{reason}。{}", error.without_url()))
        }
    }
}
impl From<String> for Fault {
    fn from(v: String) -> Self {
        Self::known(v)
    }
}
pub type Reply<T> = std::result::Result<T, Fault>;
pub(crate) const POLL_TIMEOUT: Duration = Duration::from_secs(30);

fn poll_retry_after(status: i64, hint: Option<&str>) -> Option<Duration> {
    if !matches!(status, 408 | 429 | 500 | 502 | 503 | 504) {
        return None;
    }
    let delay = hint.and_then(|value| {
        let value = value.trim();
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(Duration::from_secs(seconds));
        }
        let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        Some(
            (at.to_utc() - chrono::Utc::now())
                .to_std()
                .unwrap_or_default(),
        )
    });
    Some(delay.unwrap_or_default())
}
pub fn client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| e.to_string())
}
pub fn protect_text(s: &str, key: &str) -> String {
    let text = if key.is_empty() {
        s.to_owned()
    } else {
        s.replace(key, "[Key 已隐藏]")
    };
    text.split_whitespace()
        .map(|w| if w.contains("://") { "[地址]" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}
pub(super) fn field<'a>(data: &'a Value, path: &str) -> Option<&'a Value> {
    if path.trim().is_empty() {
        return None;
    }
    path.trim()
        .trim_start_matches("$.")
        .split('.')
        .try_fold(data, |v, k| {
            if v.is_array() {
                v.get(k.parse::<usize>().ok()?)
            } else {
                v.get(k)
            }
        })
}
pub(super) fn text(data: &Value, path: &str) -> Option<String> {
    match field(data, path)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
pub(crate) fn auth(r: RequestBuilder, scheme: &str, key: &str) -> RequestBuilder {
    if key.is_empty() {
        return r;
    }
    match scheme {
        "x-auth-token" => r.header("X-Auth-Token", key),
        "x-api-key" => r.header("X-API-Key", key),
        "x-goog-api-key" => r.header("x-goog-api-key", key),
        "api-key" => r.header("api-key", key),
        "token" => r.header("Authorization", format!("Token {key}")),
        "none" => r,
        _ => r.bearer_auth(key),
    }
}
pub(crate) async fn json_response(request: RequestBuilder, key: &str) -> Reply<Value> {
    let reply = request.send().await.map_err(Fault::transport)?;
    response_json(reply, key)
        .await?
        .ok_or_else(|| Fault::uncertain("服务返回的内容不是 JSON，请核对地址和协议。"))
}
pub(crate) async fn response_json(reply: reqwest::Response, key: &str) -> Reply<Option<Value>> {
    let status = reply.status();
    let retry = poll_retry_after(
        i64::from(status.as_u16()),
        reply
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
    );
    let body = reply.bytes().await;
    if !status.is_success() {
        let v = body
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let msg = text(&v, "error.message")
            .or_else(|| text(&v, "message"))
            .or_else(|| text(&v, "msg"))
            .unwrap_or_default();
        let code = text(&v, "error.code")
            .or_else(|| text(&v, "code"))
            .or_else(|| text(&v, "error.type"))
            .unwrap_or_default();
        let detail = protect_text(&format!("{code} {msg}"), key);
        let billing = matches!(
            code.to_ascii_lowercase().as_str(),
            "insufficient_quota" | "insufficient_balance" | "billing_hard_limit_reached"
        );
        return Err(Fault {
            message: format!("HTTP {} {detail}", status.as_u16()),
            definite: status.is_client_error() && !matches!(status.as_u16(), 408 | 409 | 499),
            poll_retry_after: if billing { None } else { retry },
        });
    }
    Ok(serde_json::from_slice(&body.map_err(Fault::transport)?).ok())
}
pub(crate) fn envelope(v: Value, key: &str) -> Reply<Value> {
    let code = text(&v, "code")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(-1);
    if code == 200 || code == 0 {
        Ok(v["data"].clone())
    } else {
        Err(Fault {
            message: format!("官网返回 {code} {}", protect_text(string(&v["msg"]), key)),
            definite: (400..500).contains(&code) && !matches!(code, 408 | 409 | 499),
            poll_retry_after: poll_retry_after(code, None),
        })
    }
}
