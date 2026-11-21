use crate::{
    catalog::{Lookup, Source},
    jobs::Studio,
    model::{id, Job},
    preferences::{StorageTarget, WriterInput},
    store::Store,
};
use axum::{
    body::{to_bytes, Body},
    extract::Request,
    response::Response,
    Router,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[tokio::test]
async fn model_directory_uses_the_configured_prefix_and_scoped_credentials() {
    let legacy_hits = Arc::new(AtomicUsize::new(0));
    let seen = legacy_hits.clone();
    let router = Router::new().fallback(move |request: Request| {
        let seen = seen.clone();
        async move {
            assert_eq!(request.method(), "GET");
            let headers = request.headers();
            let bearer = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let (status, body) = match request.uri().path() {
                "/v1/models" if bearer == "Bearer unversioned" => (404, Value::Null),
                "/v1/models" if bearer == "Bearer spa" => {
                    return Response::new(Body::from("<html>service home</html>"));
                }
                "/v1/models" if bearer == "Bearer invalid-key" => {
                    (401, json!({"error":{"message":"invalid-key rejected"}}))
                }
                "/v1/models" if bearer == "Bearer writer-key" => (
                    200,
                    json!({"data":[{"id":" z "},{"id":"a"},"a",{"id":" "},{}]}),
                ),
                "/models" => {
                    seen.fetch_add(1, Ordering::SeqCst);
                    (200, json!(["legacy"]))
                }
                "/tenant/api/v3/models"
                    if headers.get("x-api-key").is_some_and(|v| v == "media-key") =>
                {
                    (200, json!({"models":[{"id":"media"}]}))
                }
                "/tenant/api/v3/models"
                    if bearer.is_empty() && !headers.contains_key("x-api-key") =>
                {
                    (200, json!({"data":[]}))
                }
                _ => (403, Value::Null),
            };
            Response::builder()
                .status(status)
                .body(Body::from(body.to_string()))
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let versioned = format!("{origin}/v1");
    let tenant = format!("{origin}/tenant/api/v3");
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    let studio = Studio::new(Store::new(home.path().into()).unwrap(), || {}).unwrap();
    studio
        .store
        .save_writer(WriterInput {
            base: origin.clone(),
            model: "a".into(),
            key: "writer-key".into(),
        })
        .unwrap();
    let media = studio.store.edit(serde_json::from_value(json!({
        "name":"media", "protocol":"openai-image", "base":tenant, "model":"media","key":"media-key","sessionOnly":true
    })).unwrap()).unwrap();
    let writer = |base: &str, key: &str| Lookup {
        source: Source::Writer,
        base: base.into(),
        key: key.into(),
    };
    let media_query = |base: &str| Lookup {
        source: Source::Connection {
            id: Some(media.clone()),
            auth: Some("x-api-key".into()),
        },
        base: base.into(),
        key: String::new(),
    };

    let result = studio
        .discover_models(writer(&format!("{origin}/"), ""))
        .await
        .unwrap();
    assert_eq!(result.models, ["a", "z"]);
    assert_eq!(result.base, versioned);
    let explicit = studio
        .discover_models(writer(&format!("{versioned}/"), "writer-key"))
        .await
        .unwrap();
    assert_eq!(explicit.models, result.models);
    let custom = studio.discover_models(media_query(&tenant)).await.unwrap();
    assert_eq!(custom.models, ["media"]);
    assert_eq!(custom.base, tenant);
    let full = studio
        .discover_models(media_query(&format!("{tenant}/models/")))
        .await
        .unwrap();
    assert_eq!(full.base, tenant);
    assert_eq!(full.models, custom.models);
    assert!(studio
        .discover_models(writer(&tenant, ""))
        .await
        .unwrap()
        .models
        .is_empty());
    assert!(studio.discover_models(media_query(&origin)).await.is_err());

    let legacy = studio
        .discover_models(writer(&origin, "unversioned"))
        .await
        .unwrap();
    assert_eq!(legacy.base, origin);
    assert_eq!(legacy.models, ["legacy"]);
    assert_eq!(
        studio
            .discover_models(writer(&origin, "spa"))
            .await
            .unwrap()
            .models,
        ["legacy"]
    );
    assert_eq!(
        studio
            .discover_models(writer(&format!("{origin}/models"), "invalid-key"))
            .await
            .unwrap()
            .models,
        ["legacy"]
    );
    let rejected = studio
        .discover_models(writer(&origin, "invalid-key"))
        .await
        .err()
        .unwrap();
    assert!(rejected.contains("401") && !rejected.contains("invalid-key"));
    assert_eq!(legacy_hits.load(Ordering::SeqCst), 3);
    studio
        .store
        .save_writer(WriterInput {
            base: tenant,
            model: "a".into(),
            key: String::new(),
        })
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn screenplay_json_is_editable_and_scoped_to_the_writer() {
    let scene = json!({"heading":"码头 · 清晨","action":"船离岸","dialogue":"",
        "imagePrompt":"薄雾中的船","videoPrompt":"镜头跟随离岸的小船"});
    let app = Router::new().fallback(move |request: Request| {
        let scene = scene.clone();
        async move {
            assert_eq!(request.uri().path(), "/v1/chat/completions");
            assert_eq!(request.headers()["authorization"], "Bearer writer-fixture");
            let body = to_bytes(request.into_body(), 65536).await.unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["model"], "deepseek-v4-pro");
            assert_eq!(body["response_format"]["type"], "json_object");
            let reply = json!({"title":"离岸","scenes":[scene]});
            json!({"choices":[{"message":{"content":reply.to_string()},"finish_reason":"stop"}]})
                .to_string()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let studio = Studio::new(Store::new(temp.path().into()).unwrap(), || {}).unwrap();
    let input = |base: &str, key: &str| WriterInput {
        base: base.into(),
        model: "deepseek-v4-pro".into(),
        key: key.into(),
    };
    studio
        .store
        .save_writer(input(&base, "writer-fixture"))
        .unwrap();
    let script = studio.generate_script("离开小岛".into(), 1).await.unwrap();
    let mut story = script.story;
    story.title = "晨渡".into();
    studio.store.edit_script(&script.id, story).unwrap();
    assert!(studio
        .generate_script("分镜数量异常".into(), 2)
        .await
        .is_err());
    assert_eq!(studio.store.scripts().unwrap().len(), 1);
    assert_eq!(studio.store.scripts().unwrap()[0].story.title, "晨渡");
    assert!(!std::fs::read_to_string(temp.path().join("settings.json"))
        .unwrap()
        .contains("writer-fixture"));
    studio
        .store
        .save_writer(input("https://another.example", ""))
        .unwrap();
    assert_eq!(
        studio.store.settings_view().unwrap()["writer"]["hasKey"],
        false
    );
    server.abort();
}

#[tokio::test]
async fn s3_upload_retries_the_original_under_the_same_key() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let app = Router::new().fallback(move |request: Request| {
        let count = count.clone();
        async move {
            assert_eq!(request.method(), "PUT");
            assert!(request.uri().path().starts_with("/pictures/story/"));
            assert!(request.uri().path().ends_with(".png"));
            assert!(request.uri().query().unwrap().contains("X-Amz-Signature="));
            assert_eq!(request.headers()["content-type"], "image/png");
            let bytes = to_bytes(request.into_body(), 1024).await.unwrap();
            assert_eq!(bytes.as_ref(), b"local-image-fixture");
            let first = count.fetch_add(1, Ordering::SeqCst) == 0;
            Response::builder()
                .status(if first { 503 } else { 200 })
                .body(Body::empty())
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let studio = Studio::new(Store::new(temp.path().into()).unwrap(), || {}).unwrap();
    let mut target = StorageTarget {
        endpoint,
        bucket: "pictures".into(),
        prefix: "story".into(),
        region: "auto".into(),
        access_key: "fixture-id".into(),
        automatic: true,
        virtual_host: false,
    };
    studio
        .store
        .save_storage(target.clone(), "fixture-secret")
        .unwrap();
    let mut j = Job {
        id: id(),
        status: "done".into(),
        protocol_id: "openai-image".into(),
        file_name: Some("old.png".into()),
        ..Default::default()
    };
    std::fs::write(temp.path().join("作品/old.png"), b"local-image-fixture").unwrap();
    studio.plan_image_copy(&mut j);
    studio.store.save_job(&j).unwrap();
    assert!(studio.upload_image(&j.id, true).await.is_err());
    let failed = studio.store.job(&j.id).unwrap();
    assert_eq!(failed.status, "done");
    assert_eq!(failed.cloud.unwrap().status, "failed");
    studio.upload_image(&j.id, false).await.unwrap();
    studio.upload_image(&j.id, false).await.unwrap();
    let copy = studio.store.job(&j.id).unwrap().cloud.unwrap();
    assert_eq!(copy.status, "saved");
    assert_eq!(copy.uri, format!("s3://pictures/story/{}.png", j.id));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(studio.store.media(&j).unwrap().is_file());
    assert!(!std::fs::read_to_string(temp.path().join("settings.json"))
        .unwrap()
        .contains("fixture-secret"));
    target.access_key = "other-account".into();
    target.automatic = false;
    studio.store.save_storage(target, "").unwrap();
    assert_eq!(
        studio.store.settings_view().unwrap()["hasStorageKey"],
        false
    );
    server.abort();
}
