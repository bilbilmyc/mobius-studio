mod assets;
mod connections;
mod jobs;
mod presets;

pub(crate) use assets::*;
pub(crate) use connections::*;
pub(crate) use jobs::*;
pub(crate) use presets::*;

use serde_json::Value;
pub type Result<T> = std::result::Result<T, String>;
pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
