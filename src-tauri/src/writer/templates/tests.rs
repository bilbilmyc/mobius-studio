use super::exchange::parse;
use super::*;

fn spec(name: &str, body: &str) -> Template {
    Template {
        name: name.into(),
        medium: Medium::Any,
        body: body.into(),
        author: String::new(),
        source: String::new(),
        description: String::new(),
    }
}

#[test]
fn shared_packs_round_trip_across_libraries_without_overwriting_names() {
    let folder = tempfile::tempdir().unwrap();
    let store = Store::new(folder.path().join("source")).unwrap();
    let view = store
        .change_templates(
            0,
            Change::Import {
                templates: vec![spec("灯光", "暖光"), spec("灯光", "冷光")],
            },
        )
        .unwrap();
    assert_eq!((view.added, view.renamed), (2, 1));
    assert!(store
        .change_templates(
            0,
            Change::Remove {
                id: view.selected.clone().unwrap()
            }
        )
        .is_err());
    let repeat = store
        .change_templates(
            1,
            Change::Import {
                templates: vec![spec("灯光", "冷光")],
            },
        )
        .unwrap();
    assert_eq!(repeat.skipped, 1);
    assert_eq!(repeat.library.revision, 1);
    let ids = repeat
        .library
        .entries
        .iter()
        .filter(|e| !e.id.starts_with("builtin-"))
        .map(|e| e.id.clone())
        .collect();
    let file = store.export_templates(ids, None).unwrap();
    let bytes = std::fs::read_to_string(file).unwrap();
    assert!(!bytes.contains("revision"));
    assert!(!bytes.contains(&view.selected.unwrap()));
    let parsed = parse("作者.json", &bytes).unwrap();
    let another = Store::new(folder.path().join("recipient")).unwrap();
    let imported = another
        .change_templates(
            0,
            Change::Import {
                templates: parsed.templates,
            },
        )
        .unwrap();
    let item = imported.library.entries.last().unwrap();
    assert_eq!(item.spec.name, "灯光 (2)");
    assert_eq!(item.spec.body, "冷光");
    let changed = another
        .change_templates(
            1,
            Change::Edit {
                id: item.id.clone(),
                template: spec("雨后", "霓虹"),
            },
        )
        .unwrap();
    assert_eq!(changed.library.entries.last().unwrap().spec.name, "雨后");
    another
        .change_templates(
            2,
            Change::Remove {
                id: item.id.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        another.template_library().unwrap().entries.len(),
        builtins().len() + 1
    );
}

#[test]
fn community_csv_supports_multiline_quotes_and_reports_invalid_rows() {
    let csv =
        "\u{feff}act,prompt,for_devs\r\n灯光,\"冷光, 暖光\n灯为\"\"蓝\"\"\",false\r\n空白,,true";
    let p = parse("prompts.csv", csv).unwrap();
    assert_eq!(p.skipped, 1);
    assert_eq!(p.templates[0].body, "冷光, 暖光\n灯为\"蓝\"");
    assert!(parse(
        "input.json",
        r#"{"format":"mobius-prompt-templates","version":2,"templates":[]}"#
    )
    .is_err());
    assert!(parse("a.js", "run()").is_err());
    assert_eq!(
        parse("构图.md", "# {{主体}}").unwrap().templates[0].name,
        "构图"
    );
}
