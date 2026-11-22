use crate::{
    connections::catalog::{Lookup, Source},
    domain::{id, Job},
    generation::jobs::Studio,
    storage::preferences::{StorageTarget, WriterInput},
    storage::store::Store,
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

#[test]
fn legacy_writer_keeps_credentials_and_multiple_accounts_stay_independent() {
    use crate::domain::Profile;
    use crate::storage::files::save;
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let base = "https://relay.example/v1";
    let mut legacy = Profile {
        id: id(),
        base_url: base.into(),
        model: "shared".into(),
        ..Default::default()
    };
    store.vault.put(&mut legacy, "old-writer-key").unwrap();
    save(
        &store.home.join("settings.json"),
        &json!({"writer":{
            "Id":legacy.id,"BaseUrl":base,"Model":"shared","Keys":legacy.keys
        }}),
    )
    .unwrap();
    let initial = store.preferences().unwrap().writer;
    assert_eq!(initial.profile.id, legacy.id);
    assert_eq!(
        store.vault.get(&initial.profile, base).unwrap(),
        "old-writer-key"
    );
    assert_eq!(
        store.settings_view().unwrap()["writers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let edit = |id: &str, key: &str| WriterInput {
        id: Some(id.into()),
        base: base.into(),
        model: "shared".into(),
        key: key.into(),
        models: Some(vec!["second".into(), "shared".into()]),
        ..Default::default()
    };
    store.save_writer(edit("@new", "other-writer-key")).unwrap();
    let stored = store.preferences().unwrap();
    let other = stored.other_writers[0].id.clone();
    assert_eq!(stored.writer.id, initial.id);
    assert!(store.select_writer(&other, "missing").is_err());
    assert_eq!(store.preferences().unwrap().writer.id, initial.id);
    store.select_writer(&other, "second").unwrap();
    let selected = store.preferences().unwrap().writer;
    assert_eq!(selected.profile.model, "second");
    assert_eq!(
        store.vault.get(&selected.profile, base).unwrap(),
        "other-writer-key"
    );
    store
        .save_writer(edit(&other, "rotated-writer-key"))
        .unwrap();
    assert_eq!(store.preferences().unwrap().writer.id, other);
    let moved = WriterInput {
        base: "https://another.example/v1".into(),
        ..edit(&other, "")
    };
    store.save_writer(moved).unwrap();
    assert_eq!(store.settings_view().unwrap()["writer"]["hasKey"], false);
    assert!(store.save_writer(edit("removed-id", "ignored")).is_err());
    store.remove_writer(&other).unwrap();
    let current = store.preferences().unwrap().writer;
    assert_eq!(current.id, initial.id);
    assert_eq!(
        store.vault.get(&current.profile, base).unwrap(),
        "old-writer-key"
    );
    store.remove_writer(&initial.id).unwrap();
    let reset = store.settings_view().unwrap();
    assert_eq!(reset["writer"]["hasKey"], false);
    assert_eq!(reset["writer"]["base"], "https://api.deepseek.com");
    assert_ne!(reset["writer"]["id"], initial.id);
}

#[test]
fn thumbnail_reuses_cache_and_detects_replaced_originals() {
    use image::{ImageBuffer, Luma, Rgb, RgbImage};
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let job = Job {
        id: id(),
        protocol_id: "rh-image".into(),
        status: "done".into(),
        file_name: Some("art.png".into()),
        ..Default::default()
    };
    let original = store.home.join("作品/art.png");
    RgbImage::from_pixel(900, 450, Rgb([5, 100, 200]))
        .save(&original)
        .unwrap();
    store.save_job(&job).unwrap();
    let cached = store.thumbnail(&job.id).unwrap();
    assert_eq!(image::image_dimensions(&cached).unwrap(), (384, 192));
    assert_eq!(store.thumbnail(&job.id).unwrap(), cached);
    assert!(crate::media::export::gpu_input(&original).is_ok());
    ImageBuffer::from_pixel(9, 3, Luma([4000u16]))
        .save(&original)
        .unwrap();
    let second = store.thumbnail(&job.id).unwrap();
    assert_ne!(cached, second);
    assert_eq!(image::image_dimensions(second).unwrap(), (9, 3));
    assert!(crate::media::export::gpu_input(&original).is_err());
    std::fs::write(original, b"unreadable image").unwrap();
    assert!(store.thumbnail(&job.id).is_err());
}

#[test]
fn legacy_scene_links_survive_edits_and_reject_unrelated_jobs() {
    use crate::domain::ShotLink;
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let script_id = id();
    let scene =
        json!({"heading":"外景","action":"船离岸","imagePrompt":"小船","videoPrompt":"跟随小船"});
    let story = json!({"title":"晨渡","scenes":[scene.clone(),scene]});
    let mut disk = story.clone();
    disk["id"] = json!(script_id);
    disk["created"] = json!(1);
    disk["brief"] = json!("小船");
    disk["model"] = json!("writer");
    std::fs::create_dir(store.home.join("剧本")).unwrap();
    std::fs::write(
        store.home.join("剧本").join(format!("{script_id}.json")),
        serde_json::to_vec(&disk).unwrap(),
    )
    .unwrap();
    let read = || serde_json::to_value(&store.scripts().unwrap()[0]).unwrap();
    let scenes = read()["scenes"].clone();
    let first = scenes[0]["id"].as_str().unwrap();
    let second = scenes[1]["id"].as_str().unwrap();
    assert_ne!(first, second);
    assert_eq!(scenes, read()["scenes"]);
    store
        .edit_script(&script_id, serde_json::from_value(story.clone()).unwrap())
        .unwrap();
    assert_eq!(scenes, read()["scenes"]);
    let link = store
        .resolve_shot(ShotLink {
            script_id: script_id.clone(),
            scene_id: first.into(),
            label: String::new(),
        })
        .unwrap();
    let job = Job {
        id: id(),
        status: "done".into(),
        protocol_id: "rh-image".into(),
        shot: Some(link),
        file_name: Some("frame.png".into()),
        ..Default::default()
    };
    store.save_job(&job).unwrap();
    assert!(store
        .set_final(&script_id, first, "image", Some(&job.id))
        .is_err());
    std::fs::write(store.home.join("作品/frame.png"), b"available original").unwrap();
    store
        .set_final(&script_id, first, "image", Some(&job.id))
        .unwrap();
    assert!(store
        .set_final(&script_id, second, "image", Some(&job.id))
        .is_err());
    assert!(store
        .set_final(&script_id, first, "video", Some(&job.id))
        .is_err());
    let mut edit = story;
    edit["scenes"] = scenes.clone();
    edit["scenes"][0]["id"] = json!(second);
    assert!(store
        .edit_script(&script_id, serde_json::from_value(edit.clone()).unwrap())
        .is_err());
    edit["scenes"] = json!([scenes[1], scenes[0]]);
    store
        .edit_script(&script_id, serde_json::from_value(edit).unwrap())
        .unwrap();
    assert_eq!(read()["finals"][first]["image"], job.id);
    assert_eq!(read()["scenes"][1]["id"], first);
}

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
    let studio = Studio::new(Store::new(home.path().into()).unwrap(), |_| {}).unwrap();
    studio
        .store
        .save_writer(WriterInput {
            base: origin.clone(),
            model: "a".into(),
            key: "writer-key".into(),
            ..Default::default()
        })
        .unwrap();
    let media = studio.store.edit(serde_json::from_value(json!({
        "name":"media", "protocol":"openai-image", "base":tenant, "model":"media","key":"media-key","sessionOnly":true
    })).unwrap()).unwrap();
    let writer = |base: &str, key: &str| Lookup {
        source: Source::Writer { id: None },
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
            ..Default::default()
        })
        .unwrap();
    server.abort();
}

#[test]
fn upgrading_preserves_legacy_storage_credentials_and_isolates_the_next_provider() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let mut target = StorageTarget {
        endpoint: "https://photos.example.org".into(),
        bucket: "photos".into(),
        region: "auto".into(),
        access_key: "account".into(),
        automatic: true,
        ..Default::default()
    };
    store
        .save_storage(target.clone(), "legacy-fixture-secret")
        .unwrap();
    let path = temp.path().join("settings.json");
    let mut disk: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let previous = disk["storage"].as_object_mut().unwrap();
    previous.remove("provider");
    previous.remove("customDomain");
    std::fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
    let migrated = store.settings_view().unwrap();
    assert_eq!(migrated["storage"]["provider"], "s3");
    assert_eq!(migrated["hasStorageKey"], true);
    target.provider = crate::storage::preferences::StorageProvider::Aliyun;
    target.region = "cn-hangzhou".into();
    target.custom_domain = target.endpoint.clone();
    assert!(store.save_storage(target, "").is_err());
    assert_eq!(store.settings_view().unwrap()["hasStorageKey"], true);
    assert_eq!(store.settings_view().unwrap()["storage"]["provider"], "s3");
    let p = store.preferences().unwrap();
    store.vault.forget(&p.storage_key);
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
    let studio = Studio::new(Store::new(temp.path().into()).unwrap(), |_| {}).unwrap();
    let input = |base: &str, key: &str| WriterInput {
        base: base.into(),
        model: "deepseek-v4-pro".into(),
        key: key.into(),
        ..Default::default()
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
    // A crash after saving the script but before updating its task must recover the same work.
    let receipt = temp.path().join("剧本任务").join(format!("{}.json", script.id));
    let text = std::fs::read_to_string(&receipt).unwrap();
    assert!(!text.contains("writer-fixture"));
    let mut pending: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(pending["status"], "done");
    pending["status"] = json!("writing");
    pending["title"] = json!("");
    crate::storage::files::save(&receipt, &pending).unwrap();
    let reopened = crate::writer::script_runs::ScriptRuns::load(&studio.store).unwrap().list();
    let recovered = reopened.iter().find(|r| r.id == script.id).unwrap();
    assert!(matches!(recovered.status, crate::writer::script_runs::RunStatus::Done));
    assert_eq!(recovered.title, "晨渡");
    assert_eq!(reopened.len(), 2);
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
    let studio = Studio::new(Store::new(temp.path().into()).unwrap(), |_| {}).unwrap();
    let mut target = StorageTarget {
        endpoint,
        bucket: "pictures".into(),
        prefix: "story".into(),
        region: "auto".into(),
        access_key: "fixture-id".into(),
        automatic: true,
        virtual_host: false,
        ..Default::default()
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
