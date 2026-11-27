use super::{kind, Asset, Picked, Relay};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotLink {
    pub script_id: String,
    pub scene_id: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct CloudCopy {
    pub status: String,
    pub uri: String,
    pub endpoint: String,
    pub detail: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<Asset>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidate_ids: Vec<String>,
    pub native_count: Option<usize>,
    pub received_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_job: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot: Option<ShotLink>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_during: Option<String>,
    pub remote_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    pub result_url: Option<String>,
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gif: Option<crate::media::gif::GifInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudCopy>,
    pub created_utc: String,
}
impl Job {
    pub fn time(&self) -> i64 {
        let s = self.created_utc.trim_matches('/');
        if let Some(s) = s.strip_prefix("Date(").and_then(|s| s.strip_suffix(')')) {
            // The legacy offset is a display hint; the signed millisecond value already uses UTC.
            let end = s
                .char_indices()
                .skip(1)
                .find(|(_, c)| matches!(c, '+' | '-'))
                .map_or(s.len(), |(index, _)| index);
            return s[..end].parse().unwrap_or(0);
        }
        chrono::DateTime::parse_from_rfc3339(&self.created_utc)
            .map(|v| v.timestamp_millis())
            .unwrap_or(0)
    }
    pub fn view(&self, file: Option<&str>) -> Value {
        json!({"id":self.id,"candidateIds":self.candidate_ids,"sourceJob":self.source_job,"shot":self.shot,"profileId":self.profile_id,"profileName":self.profile_name,"protocol":self.protocol_id,"base":self.base_url,"model":self.model,"prompt":self.prompt,"size":self.size,"seconds":self.seconds,"kind":kind(&self.protocol_id),"status":self.status,"detail":self.detail,"remoteId":self.remote_id,"retryAt":self.retry_at,"progressAt":self.progress_at,"stoppedDuring":self.stopped_during,"hasResultUrl":self.result_url.is_some(),"created":self.time(),"file":file.is_some(),"mediaPath":file,"cloud":self.cloud,"settings":self.settings,"legacyFrame":self.reference.is_some(),"site":self.site_options.as_ref().map(|s|json!({"config":s.config,"priority":s.priority}))})
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub mask: Option<Picked>,
    pub count: Option<usize>,
    pub repeat: Option<usize>,
    pub source_job: Option<String>,
    pub shot: Option<ShotLink>,
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
