use super::{
    optimizer::Medium,
    sessions::{Scope, Source, Turn},
};
use crate::{projects::screenplay::ShotLink, storage::store::Store};
use serde_json::json;

fn turn() -> Turn {
    Turn {
        user: "加一点雾".into(),
        original: "侧影".into(),
        reply: "保留动作，加入薄雾。".into(),
        prompt: Some("薄雾中的侧影".into()),
        model: "writer".into(),
        sources: vec![Source::ReadShot],
    }
}

#[test]
fn conversations_are_scoped_and_memory_survives_clear_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let project = || {
        serde_json::from_value(json!({"title":"码头","scenes":[
        {"heading":"第一镜","action":"进门","dialogue":"","imagePrompt":"门","videoPrompt":"推镜"},
        {"heading":"第二镜","action":"靠岸","dialogue":"","imagePrompt":"船","videoPrompt":"横移"}]})).unwrap()
    };
    let a = store.create_script(project()).unwrap();
    let b = store.create_script(project()).unwrap();
    let scope = |id: &str, scene: &str, kind| Scope {
        kind,
        shot: Some(ShotLink {
            script_id: id.into(),
            scene_id: scene.into(),
            label: String::new(),
        }),
    };
    let first = scope(&a.id, &a.story.scenes[0].id, Medium::Image);
    let second = scope(&a.id, &a.story.scenes[1].id, Medium::Video);
    let other = scope(&b.id, &b.story.scenes[0].id, Medium::Image);
    store.save_prompt_memory(&first, "", "沿用黑白").unwrap();
    assert!(store.save_prompt_memory(&second, "", "旧窗口").is_err());
    store
        .update_prompt_session(&first, 0, Some(turn()))
        .unwrap();
    assert!(store.update_prompt_session(&first, 0, None).is_err());
    let store = Store::new(temp.path().into()).unwrap();
    assert_eq!(
        store.prompt_session(&first).unwrap().turns[0].user,
        "加一点雾"
    );
    let next = store.prompt_session(&second).unwrap();
    assert_eq!(next.memory, "沿用黑白");
    assert!(next.turns.is_empty());
    assert!(store.prompt_session(&other).unwrap().memory.is_empty());
    let details = store
        .prompt_shot_context(first.shot.clone().unwrap())
        .unwrap();
    assert_eq!(details["nextHeading"], "第二镜");
    assert_eq!(details["current"]["action"], "进门");
    assert!(store
        .prompt_session(&scope("../", "bad", Medium::Image))
        .is_err());
    let clean = store.update_prompt_session(&first, 1, None).unwrap();
    assert_eq!(clean.revision, 2);
    assert!(clean.turns.is_empty());
    assert_eq!(clean.memory, "沿用黑白");
    assert!(store
        .update_prompt_session(&first, 1, Some(turn()))
        .is_err());
    store.save_prompt_memory(&second, "沿用黑白", "").unwrap();
    assert!(store.prompt_session(&first).unwrap().memory.is_empty());
}
