use serde::{Deserialize, Serialize};
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Asset {
    pub kind: String,
    pub name: String,
    pub path: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Picked {
    pub kind: String,
    pub name: String,
    pub token: String,
}
