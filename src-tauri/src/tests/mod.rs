mod polling;
mod projects;
mod workspace;

use crate::{
    domain::*, generation::jobs::Studio, media::formats::media_format, storage::store::Store,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn profile(base: &str, protocol: &str) -> Edit {
    Edit {
        id: None,
        add_to: None,
        name: "本机测试".into(),
        service_group: None,
        protocol: protocol.into(),
        base: base.into(),
        model: "test-model".into(),
        models: None,
        key: String::new(),
        relay: None,
        controls: None,
        session_only: false,
    }
}

#[test]
fn all_site_template_defaults_and_media_limits() {
    assert_eq!(templates().len(), 12);
    assert_eq!(templates().iter().filter(|t| t["Video"] == true).count(), 9);
    for t in templates() {
        let mut o = SiteOptions::default();
        for f in t["Fields"].as_array().unwrap() {
            o.config
                .insert(string(&f["Key"]).into(), f["Default"].clone());
        }
        for slot in t["Slots"].as_array().unwrap() {
            let n = slot["Min"].as_u64().unwrap();
            for _ in 0..n {
                o.assets.push(Asset {
                    kind: string(&slot["Kind"]).into(),
                    ..Default::default()
                });
            }
        }
        if t["AnyReference"] == true && o.assets.is_empty() {
            o.assets.push(Asset {
                kind: "image".into(),
                ..Default::default()
            });
        }
        validate_template(t, &o, "镜头向左").unwrap();
        o.config.insert("unknown".into(), Value::Null);
        assert!(validate_template(t, &o, "镜头向左").is_err());
    }
    let t = templates()
        .iter()
        .find(|t| {
            t["Key"]
                .as_str()
                .unwrap()
                .starts_with("rh-seedance-2-5-flash")
        })
        .unwrap();
    let mut o = SiteOptions::default();
    for f in t["Fields"].as_array().unwrap() {
        o.config
            .insert(string(&f["Key"]).into(), f["Default"].clone());
    }
    o.config.insert("mode".into(), json!("first_last"));
    assert!(validate_template(t, &o, "镜头").is_err());
    o.assets = vec![
        Asset {
            kind: "image".into(),
            ..Default::default()
        };
        2
    ];
    validate_template(t, &o, "镜头").unwrap();
    o.config.insert("mode".into(), json!("t2v"));
    assert!(validate_template(t, &o, "镜头").is_err());
}

#[test]
fn official_default_and_credentials_are_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let base = "http://127.0.0.1:17140/v1";
    let mut edit = profile(base, "openai-image");
    edit.key = "dummy-test-value".into();
    let relay = store.edit(edit).unwrap();
    let p = store.resolve(&relay, "image").unwrap();
    assert_eq!(store.vault.get(&p, base).unwrap(), "dummy-test-value");
    assert_eq!(store.vault.get(&p, SITE).unwrap(), "");
    assert!(!serde_json::to_string(&store.profile_view(&p))
        .unwrap()
        .contains("dummy-test-value"));
    assert!(
        !std::fs::read_to_string(store.home.join("connections.json"))
            .unwrap()
            .contains("dummy-test-value")
    );
    let mut official = profile(base, "openai-image");
    official.id = Some("@site".into());
    official.key = "dummy-official".into();
    store.edit(official).unwrap();
    for k in ["image", "video"] {
        let official = store.resolve("@site", k).unwrap();
        assert_eq!(official.base_url, SITE);
        assert_eq!(official.protocol_id, format!("rh-{k}"));
        assert_eq!(store.vault.get(&official, SITE).unwrap(), "dummy-official");
    }
    let mut change = profile("http://127.0.0.1:17141/v1", "openai-image");
    change.id = Some(relay.clone());
    store.edit(change).unwrap();
    let changed = store.resolve(&relay, "image").unwrap();
    assert_eq!(store.vault.get(&changed, &changed.base_url).unwrap(), "");
    store.remove(&relay).unwrap();
    store
        .remove(&store.resolve("@site", "image").unwrap().id)
        .unwrap();
}

#[test]
fn connection_models_stay_scoped_and_jobs_keep_the_selected_model() {
    let temp = tempfile::tempdir().unwrap();
    let studio = Studio::new(Store::new(temp.path().into()).unwrap(), |_| {}).unwrap();
    let mut edit = profile("https://one.example/v1", "openai-image");
    edit.models = Some(vec![
        " alternate ".into(),
        "alternate".into(),
        "test-model".into(),
    ]);
    let first = studio.store.edit(edit).unwrap();
    let second = studio
        .store
        .edit(profile("https://two.example/v1", "openai-image"))
        .unwrap();
    let start = |id: &str, model: Option<&str>| {
        serde_json::from_value(json!({
            "profileId":id, "kind":"image", "template":"", "prompt":"test", "size":"1024x1024",
            "seconds":0,"config":{"mode":"t2i"},"priority":0,"assets":[],"model":model
        }))
        .unwrap()
    };
    assert_eq!(
        studio.store.resolve(&first, "image").unwrap().models,
        ["alternate"]
    );
    let job = studio.prepare(start(&first, Some("alternate"))).unwrap();
    assert_eq!(job.model, "alternate");
    assert_eq!(job.base_url, "https://one.example/v1");
    assert_eq!(
        studio.prepare(start(&first, None)).unwrap().model,
        "test-model"
    );
    assert!(studio.prepare(start(&second, Some("alternate"))).is_err());
    let mut edit = profile("https://one.example/v1", "openai-image");
    edit.id = Some(first.clone());
    edit.model = "new-default".into();
    studio.store.edit(edit).unwrap();
    assert_eq!(studio.store.job(&job.id).unwrap().model, "alternate");
}

#[test]
fn high_resolution_sizes_follow_model_and_connection_limits() {
    let mut profile = Profile {
        protocol_id: "openai-image".into(),
        ..Default::default()
    };
    let sizes = profile.image_size_presets("gpt-image-2").unwrap();
    assert_eq!(sizes[0], "1024x1024");
    assert!(sizes.iter().any(|s| s == "auto"));
    assert!(sizes.iter().any(|s| s == "2160x3840"));
    assert!(profile.image_size_presets("gpt-image-1").is_none());
    profile.controls = Some(Controls {
        sizes: vec!["1024x1024".into()],
        ..Default::default()
    });
    assert!(profile.image_size_presets("gpt-image-2").is_none());

    profile.protocol_id = "relay-image".into();
    let legacy = ["1024x1024", "1536x1024", "1024x1536"]
        .map(str::to_owned)
        .to_vec();
    profile.relay = Some(Relay {
        sizes: legacy.clone(),
        ..Default::default()
    });
    let sizes = profile.image_size_presets("gpt-image-2-azure").unwrap();
    assert!(sizes.starts_with(&legacy));
    assert!(!sizes.iter().any(|s| s == "auto"));
    assert!(sizes.iter().any(|s| s == "3840x2160"));
    profile.relay.as_mut().unwrap().sizes.truncate(1);
    assert!(profile.image_size_presets("gpt-image-2-azure").is_none());
}

#[test]
fn validates_routes_and_legacy_files() {
    let base = "https://relay.example/v1";
    assert_eq!(
        route(base, "/images/generations").unwrap().as_str(),
        "https://relay.example/v1/images/generations"
    );
    assert!(route(base, "../v2/models").is_err());
    assert!(route(base, "//second.example/test").is_err());
    assert!(canonical_base("http://relay.example/v1").is_err());
    assert!(canonical_base("http://localhost:7777/v1").is_ok());
    let j:Job=serde_json::from_value(json!({"CreatedUtc":"/Date(1780000000000)/","ProtocolId":"rh-image","Reference":null,"ResultUrl":null})).unwrap();
    assert_eq!(j.time(), 1780000000000);
    for (stamp, expected) in [
        ("/Date(1780000000000-0700)/", 1780000000000),
        ("/Date(-1000+0800)/", -1000),
    ] {
        assert_eq!(
            Job {
                created_utc: stamp.into(),
                ..Default::default()
            }
            .time(),
            expected
        );
    }
    assert_eq!(j.view(None)["kind"], "image");
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    assert_eq!(
        store.input("参考素材\\old.png").unwrap(),
        store.home.join("参考素材").join("old.png")
    );
    assert!(media_format(b"not media", false).is_err());
    assert!(media_format(b"\x89PNG\r\n\x1a\n", true).is_err());
}

#[test]
fn restart_preserves_uncertain_submissions_without_posting() {
    let temp = tempfile::tempdir().unwrap();
    let studio = Arc::new(Studio::new(Store::new(temp.path().into()).unwrap(), |_| {}).unwrap());
    let job = Job {
        id: id(),
        status: "submitting".into(),
        protocol_id: "openai-image".into(),
        ..Default::default()
    };
    studio.store.save_job(&job).unwrap();
    studio.recover().unwrap();
    assert_eq!(studio.store.job(&job.id).unwrap().status, "uncertain");
    studio.recover().unwrap();
    assert_eq!(studio.store.job(&job.id).unwrap().status, "uncertain");
}

#[test]
fn session_key_stays_in_memory_and_is_scoped_to_one_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().to_owned()).unwrap();
    let mut e = profile("https://relay.example/v1", "openai-image");
    e.key = "session-only-test".into();
    e.session_only = true;
    let id = store.edit(e).unwrap();
    let p = store.resolve(&id, "image").unwrap();
    assert_eq!(
        store.vault.get(&p, &p.base_url).unwrap(),
        "session-only-test"
    );
    assert_eq!(store.vault.get(&p, SITE).unwrap(), "");
    assert!(p.keys.is_empty());
    drop(store);
    let s = Store::new(tmp.path().to_owned()).unwrap();
    let p = s.resolve(&id, "image").unwrap();
    assert!(!s.vault.has(&p, &p.base_url));
}

#[test]
fn linked_media_routes_share_only_their_own_service_credentials() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().to_owned()).unwrap();
    let base = "https://relay.example/v1";
    let mut image = profile(base, "openai-image");
    image.session_only = true;
    image.key = "session-one".into();
    let image_id = store.edit(image).unwrap();
    let unrelated = store.edit(profile(base, "openai-image")).unwrap();
    let add = |base, model: &str| {
        let mut video = profile(base, "openai-video");
        video.add_to = Some(image_id.clone());
        video.model = model.into();
        store.edit(video)
    };
    assert!(add("https://other.example/v1", "invalid").is_err());
    let video_id = add(base, "movie").unwrap();
    assert_eq!(video_id, add(base, "second").unwrap());
    assert_eq!(video_id, add(base, "second").unwrap());
    let video = store.resolve(&video_id, "video").unwrap();
    assert_eq!(video.models, ["second"]);
    assert!(video.keys.is_empty());
    assert_eq!(store.vault.get(&video, base).unwrap(), "session-one");
    let mut rotate = profile(base, "openai-video");
    rotate.id = Some(video_id.clone());
    rotate.model = "movie".into();
    rotate.key = "session-two".into();
    rotate.session_only = true;
    store.edit(rotate).unwrap();
    let image = store.resolve(&image_id, "image").unwrap();
    assert_eq!(store.vault.get(&image, base).unwrap(), "session-two");
    assert!(!store
        .vault
        .has(&store.resolve(&unrelated, "image").unwrap(), base));
    store.remove(&image_id).unwrap();
    assert_eq!(store.vault.get(&video, base).unwrap(), "session-two");
    let reopened = Store::new(tmp.path().to_owned()).unwrap();
    assert!(!reopened
        .vault
        .has(&reopened.resolve(&video_id, "video").unwrap(), base));
    store.remove(&video_id).unwrap();
    assert!(!store.vault.has(&video, base));
}

#[test]
fn dimensions_roles_and_parameter_constraints() {
    use crate::generation::creation::*;
    assert_eq!(dimensions("1344x768"), Some((1344, 768)));
    assert_eq!(ratio("1344x768"), "7:4");
    assert!(dimensions("0x512").is_none());
    assert!(public_source("https://me:pass@media.example/a.png").is_err());
    let f = workflow_spec();
    for (mut r, expected) in [(f.clone(), true), (f.clone(), false)] {
        if !expected {
            r.workflows.get_mut("first_last").unwrap().body = r#"{"from":"{{first_frame}}"}"#.into()
        }
        assert_eq!(
            r.validate("https://relay.example/v1", true).is_ok(),
            expected
        );
    }
    let mut r = f;
    r.parameters = vec![serde_json::from_value(
        json!({"key":"seed","type":"number","label":"种子","default":2,"min":1,"max":7}),
    )
    .unwrap()];
    assert!(r.validate("https://relay.example/v1", true).is_err());
    r.body = r#"{"seed":"{{params.seed}}"}"#.into();
    r.validate("https://relay.example/v1", true).unwrap();
    assert!(r.parameters[0].accepts(&json!(6)));
    assert!(!r.parameters[0].accepts(&json!("6")));
    assert!(!r.parameters[0].accepts(&json!(8)));
}
fn workflow_spec() -> Relay {
    serde_json::from_value(json!({"auth":"x-goog-api-key","submit":"generate","body":"{}","url":"data.url","sizes":["1344x768"],"seconds":[7],"workflows":{"first_last":{"submit":"models/{model}/frames","encoding":"multipart","body":"{\"from\":\"{{first_frame}}\",\"to\":\"{{last_frame}}\"}"}}})).unwrap()
}

#[test]
fn exports_exact_dimensions_and_preserves_the_original() {
    use crate::media::export::{write_copy, Resize};
    let tmp = tempfile::tempdir().unwrap();
    let from = tmp.path().join("original.png");
    image::RgbImage::from_pixel(12, 8, image::Rgb([17, 120, 190]))
        .save(&from)
        .unwrap();
    let original = std::fs::read(&from).unwrap();
    for fit in ["crop", "contain"] {
        let dest = tmp.path().join(format!("{fit}.png"));
        let spec = Resize {
            width: 16,
            height: 9,
            fit: fit.into(),
            format: Default::default(),
        };
        write_copy(&from, &dest, Some(&spec)).unwrap();
        let im = image::open(dest).unwrap().to_rgb8();
        assert_eq!(im.dimensions(), (16, 9));
        assert_eq!(im.get_pixel(8, 4).0, [17, 120, 190]);
        assert_eq!(
            im.get_pixel(0, 0).0,
            if fit == "crop" {
                [17, 120, 190]
            } else {
                [0, 0, 0]
            }
        );
        assert!(write_copy(&from, &from, Some(&spec)).is_err());
    }
    assert_eq!(std::fs::read(&from).unwrap(), original);
    assert!(Resize {
        width: 50_000,
        height: 30_000,
        fit: "crop".into(),
        format: Default::default(),
    }
    .validate()
    .is_err());
}

#[test]
fn contain_export_composites_every_pixel_onto_opaque_black() {
    use crate::media::export::{write_copy, Resize};
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.png");
    let target = tmp.path().join("output.png");
    image::RgbaImage::from_raw(1, 3, vec![200, 0, 0, 128, 91, 52, 13, 0, 0, 0, 240, 255])
        .unwrap()
        .save(&source)
        .unwrap();
    let spec = Resize {
        width: 3,
        height: 3,
        fit: "contain".into(),
        format: Default::default(),
    };
    write_copy(&source, &target, Some(&spec)).unwrap();
    let pixels = image::open(target).unwrap().to_rgba8();
    assert_eq!(pixels.get_pixel(1, 0).0, [100, 0, 0, 255]);
    assert_eq!(pixels.get_pixel(1, 1).0, [0, 0, 0, 255]);
    assert_eq!(pixels.get_pixel(1, 2).0, [0, 0, 240, 255]);
    assert_eq!(pixels.get_pixel(0, 0).0, [0, 0, 0, 255]);
}
#[test]
fn support_copy_contains_task_identifiers_and_error_code_only() {
    let mut j = crate::domain::Job {
        id: "local-record".into(),
        remote_id: Some("upstream-ticket".into()),
        prompt: "private creative text".into(),
        base_url: "https://private.invalid".into(),
        result_url: Some("https://private.invalid/asset?secret=key".into()),
        detail: "HTTP 403 error detail with private text".into(),
        ..Default::default()
    };
    let summary = crate::commands::generation::task_info(&j);
    assert!(
        summary.contains("local-record")
            && summary.contains("upstream-ticket")
            && summary.contains("HTTP 403")
    );
    assert!(!summary.contains("private") && !summary.contains("secret="));
    j.remote_id = j.result_url.take();
    assert!(!crate::commands::generation::task_info(&j).contains("private"));
}
