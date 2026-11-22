use crate::{
    domain::ShotLink,
    domain::{id, Job, Profile, ServiceGroup},
    generation::jobs::Studio,
    projects::project_archive,
    projects::shot_drafts::ShotDraft,
    storage::files::save,
    storage::store::Store,
};
use serde_json::json;
use std::{fs, sync::Arc};
fn source(home: &std::path::Path) -> (Store, String, String, String) {
    let s = Store::new(home.into()).unwrap();
    let scene = |n: &str| json!({"heading":n,"action":"灯亮了","dialogue":"出发","imagePrompt":"灯塔","videoPrompt":"推近"});
    let script = s
        .create_script(
            serde_json::from_value(json!({"title":"海岸","scenes":[scene("港口"),scene("灯室")]}))
                .unwrap(),
        )
        .unwrap();
    let shot = ShotLink {
        script_id: script.id.clone(),
        scene_id: script.story.scenes[0].id.clone(),
        label: "海岸 · 第 1 镜".into(),
    };
    let p = Profile {
        id: id(),
        name: "绘图".into(),
        service_group: ServiceGroup::Direct,
        model: "paint".into(),
        protocol_id: "openai-image".into(),
        base_url: "https://example.invalid/v1".into(),
        keys: std::collections::HashMap::from([(
            "secret".into(),
            "private-credential-sentinel".into(),
        )]),
        ..Default::default()
    };
    save(&s.home.join("connections.json"), &[&p]).unwrap();
    let original = s.home.join("作品/image.png");
    image::RgbImage::from_pixel(20, 30, image::Rgb([15, 40, 85]))
        .save(&original)
        .unwrap();
    let j = Job {
        id: id(),
        file_name: Some("image.png".into()),
        shot: Some(shot.clone()),
        model: p.model.clone(),
        base_url: p.base_url.clone(),
        profile_id: p.id.clone(),
        protocol_id: p.protocol_id.clone(),
        status: "done".into(),
        result_url: Some("https://example.invalid/image?signature=private-url-sentinel".into()),
        ..Default::default()
    };
    s.save_job(&j).unwrap();
    s.set_final(&script.id, &shot.scene_id, "image", Some(&j.id))
        .unwrap();
    let preparing = Job {
        id: id(),
        file_name: None,
        status: "preparing".into(),
        ..j.clone()
    };
    s.save_job(&preparing).unwrap();
    let picked = s.register("image", original, None).unwrap();
    let key = serde_json::to_string(&[&p.id, "image", &p.base_url, &p.model]).unwrap();
    let editor = json!({"service":p.id,"models":{(&p.id):p.model},"templates":{},"compare":"","prompt":"保留底图","variants":{(key):{"sourceJob":j.id,"count":4,"size":"1024x1024","config":{"mode":"i2i"},"priority":0,"byMode":{"i2i":[picked]}}}});
    s.save_shot_draft(
        ShotDraft {
            shot,
            kind: "image".into(),
            editor,
            updated: 100,
        },
        vec![picked],
    )
    .unwrap();
    (s, script.id, j.id, p.id)
}
#[test]
fn project_restores_assets_connections_provenance_and_never_restarts_paid_work() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let archive = tempfile::tempdir().unwrap();
    let pack = archive.path().join("coast.mobius");
    let (s, script, old_job, old_profile) = source(from.path());
    project_archive::export(&s, &script, &pack).unwrap();
    let bytes = fs::read(&pack).unwrap();
    let dump = String::from_utf8_lossy(&bytes);
    assert!(
        !dump.contains("private-url-sentinel") && !dump.contains("private-credential-sentinel")
    );
    drop(s);
    drop(from);
    let target = Store::new(to.path().into()).unwrap();
    let preview = project_archive::import(&target, &pack, false).unwrap();
    assert_eq!(preview["conflicts"], 0);
    assert!(target.jobs().unwrap().is_empty() && target.profiles().unwrap().is_empty());
    let a = project_archive::import(&target, &pack, true).unwrap();
    let b = project_archive::import(&target, &pack, true).unwrap();
    assert_ne!(a["id"], b["id"]);
    let drafts = target.shot_drafts().unwrap();
    let d = drafts.iter().find(|d| a["id"] == d.shot.script_id).unwrap();
    let profile = d.editor["service"].as_str().unwrap();
    assert_ne!(profile, old_profile);
    let p = target.resolve(profile, "image").unwrap();
    assert_eq!(p.model, "paint");
    assert_eq!(p.service_group, ServiceGroup::Direct);
    assert!(p.keys.is_empty());
    let key = serde_json::to_string(&[profile, "image", &p.base_url, "paint"]).unwrap();
    let variant = &d.editor["variants"][key];
    let source = variant["sourceJob"].as_str().unwrap();
    assert_ne!(source, old_job);
    let kept = target.job(source).unwrap();
    assert_eq!(kept.shot.as_ref().unwrap().script_id, d.shot.script_id);
    assert_eq!(
        image::image_dimensions(target.original(&kept).unwrap()).unwrap(),
        (20, 30)
    );
    let picks: Vec<crate::domain::Picked> =
        serde_json::from_value(variant["byMode"]["i2i"].clone()).unwrap();
    let assets = target.assets(&picks).unwrap();
    assert!(target.input(&assets[0].path).unwrap().is_file());
    let jobs = target.jobs().unwrap();
    assert!(jobs
        .iter()
        .all(|j| matches!(j.status.as_str(), "done" | "archived")));
    assert_eq!(jobs.len(), 4);
    let core = Arc::new(Studio::new(target, |_| {}).unwrap());
    core.recover().unwrap();
    assert_eq!(core.store.jobs().unwrap().len(), 4);
}
#[test]
fn archive_detects_tampering_and_import_conflict_does_not_poison_startup() {
    let temp = tempfile::tempdir().unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let (s, script, _, _) = source(temp.path());
    let pack = temp.path().join("coast.mobius");
    project_archive::export(&s, &script, &pack).unwrap();
    let target = Store::new(target_dir.path().into()).unwrap();
    project_archive::import(&target, &pack, true).unwrap();
    let j = target
        .jobs()
        .unwrap()
        .into_iter()
        .find(|j| j.status == "done")
        .unwrap();
    fs::write(target.original(&j).unwrap(), b"conflict").unwrap();
    assert!(project_archive::import(&target, &pack, true).is_err());
    project_archive::recover(&target).unwrap();
    assert_eq!(target.scripts().unwrap().len(), 1);
    let mut body = fs::read(&pack).unwrap();
    let n = body
        .windows(8)
        .position(|s| s == b"\x89PNG\r\n\x1a\n")
        .unwrap();
    body[n] ^= 1;
    fs::write(&pack, body).unwrap();
    assert!(project_archive::import(&target, &pack, false)
        .unwrap_err()
        .contains("校验失败"));
}
