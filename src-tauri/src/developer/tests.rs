use super::{capture::Example, Log, LIMIT};
use serde_json::{json, Value};

#[test]
fn captured_examples_hide_credentials_and_preserve_request_fields() {
    let key = "private-test-key";
    let request = reqwest::Client::new()
        .post("https://example.test/v1/chat?token=private-query")
        .bearer_auth(key)
        .header("x-custom", "private-header")
        .json(&json!({
            "messages":[{"role":"user","content":"hello '世界'"}], "temperature":0.7,
            "api_key":key, "image":"data:image/png;base64,private-image",
            "reference":"https://blob.test/item?X-Amz-Credential=private-link",
            "options":{"password":1234}, "max_tokens":820,
            "packed":"{\"access_token\":\"private-nested\"}"
        }))
        .build()
        .unwrap();
    let (target, model) = Example::capture(&request, key, None);
    let out = serde_json::to_value(model).unwrap();
    assert_eq!(target, "https://example.test/…");
    assert!(!out.to_string().contains("private-"));
    let pieces = out["body"]["pieces"].as_array().unwrap();
    let document: String = pieces
        .iter()
        .map(|p| p.as_str().unwrap_or("null"))
        .collect();
    let document: Value = serde_json::from_str(&document).unwrap();
    assert_eq!(document["temperature"], 0.7);
    assert_eq!(document["max_tokens"], 820);
    assert_eq!(document["messages"][0]["content"], "hello '世界'");
    let slots = pieces;
    assert!(slots
        .iter()
        .any(|s| s["source"]["prefix"] == "data:image/png;base64,"));
    assert!(slots.iter().any(|s| s["source"]["env"] == "API_KEY"));
    assert!(slots.iter().any(|s| s["source"]["format"] == "json"));
}

#[test]
fn cleared_or_evicted_requests_cannot_return_to_the_log() {
    let mut log = Log::default();
    let request = reqwest::Client::new()
        .get("https://example.test/models")
        .build()
        .unwrap();
    let (target, model) = Example::capture(&request, "", None);
    let add = |log: &mut Log, epoch| log.begin(epoch, "GET".into(), target.clone(), model.clone());
    assert!(add(&mut log, 0).is_none());
    log.enabled = true;
    for _ in 0..=LIMIT {
        add(&mut log, 0).unwrap();
    }
    assert_eq!(log.entries.len(), LIMIT);
    assert_eq!(log.entries.back().unwrap().summary.id, 2);
    log.clear();
    log.finish(2, None, "failed", 100);
    assert!(add(&mut log, 0).is_none());
    assert!(log.entries.is_empty());
    assert!(add(&mut log, 1).is_some());
}

#[test]
fn examples_keep_wire_precision_and_cannot_expand_text_as_code() {
    let req = reqwest::Client::new()
        .post("https://example.test/task")
        .json(
            &json!({"seed":u64::MAX, "prompt":"${API_KEY} {{FILE_1}} `date`", "temperature":false}),
        )
        .build()
        .unwrap();
    let (_, model) = Example::capture(&req, "", None);
    let model = serde_json::to_value(model).unwrap();
    let parts = model["body"]["pieces"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    let wire = parts[0].as_str().unwrap();
    assert!(wire.contains("18446744073709551615"));
    assert!(wire.contains("${API_KEY} {{FILE_1}} `date`"));
}

#[test]
fn large_inline_images_use_file_inputs_without_losing_the_prompt() {
    let image = "a".repeat(4_000_000);
    let req = reqwest::Client::new()
        .post("https://example.test/edit")
        .json(&json!({"prompt":"real prompt","images":[format!("data:image/webp;base64,{image}")]}))
        .build()
        .unwrap();
    let (_, model) = Example::capture(&req, "", None);
    let model: Value = serde_json::to_value(model).unwrap();
    assert!(model.to_string().len() < 1024);
    assert!(model.to_string().contains("real prompt"));
    assert!(model["body"]["pieces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["path"] == json!(["images", 0])));
}
