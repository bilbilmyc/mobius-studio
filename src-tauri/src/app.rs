use crate::{
    commands, connections,
    generation::{self, jobs::Studio},
    library, media, projects, providers,
    storage::store,
    writer,
};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

pub(crate) type Core<'a> = State<'a, Arc<Studio>>;
pub fn run() {
    let context = tauri::generate_context!();
    crate::diagnostics::init(&context.config().identifier);
    let mut builder = tauri::Builder::default();
    #[cfg(feature = "render-benchmark")]
    if std::env::var_os("MOBIUS_RENDER_BENCHMARK").is_some()
        && std::env::var_os("MOBIUS_HOME").is_some()
    {
        builder = builder.on_page_load(|webview, page| {
            if page.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(include_str!("../../tests/render-probe.js"));
            }
        });
    }
    if std::env::var_os("MOBIUS_HOME").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = crate::desktop_window::restore(app);
        }));
    }
    let app = builder
        .manage(crate::desktop_window::WindowState::default())
        .manage(crate::updates::Updates::default())
        .on_window_event(crate::desktop_window::on_window_event)
        .manage(writer::tool_calls::Runs::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            crate::diagnostics::entry(
                "INFO",
                "startup",
                concat!("莫比环 ", env!("CARGO_PKG_VERSION"), " 启动"),
            );
            #[cfg(target_os = "linux")]
            if let Ok(server) = media::preview::Preview::start() {
                app.manage(server);
            }
            let env = std::env::var_os("MOBIUS_HOME");
            let home = if cfg!(feature = "installed") && env.is_none() {
                app.path().app_data_dir()?.join("Data")
            } else {
                store::portable_path(&std::env::current_exe()?)
            };
            let store = match store::Store::new(home.clone()) {
                Ok(s) => s,
                Err(_) if env.is_none() && !home.exists() => {
                    store::Store::new(app.path().app_data_dir()?.join("Data"))
                        .map_err(std::io::Error::other)?
                }
                Err(e) => return Err(std::io::Error::other(e).into()),
            };
            let guard = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(store.home.join(".studio.lock"))?;
            guard
                .try_lock()
                .map_err(|_| std::io::Error::other("此数据目录已在另一个莫比环窗口中打开。"))?;
            app.manage(guard);
            #[cfg(feature = "render-benchmark")]
            if std::env::var_os("MOBIUS_RENDER_BENCHMARK").is_some()
                && store.home.join(".render-fixture").is_file()
            {
                use tauri::Listener;
                let output = store.home.join("render-result.json");
                app.listen("mobius-render-benchmark", move |event| {
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                        let _ = crate::storage::files::save(&output, &result);
                    }
                });
            }
            let handle = app.handle().clone();
            crate::developer::enable(
                store
                    .preferences()
                    .map(|p| p.developer_mode)
                    .unwrap_or(false),
            );
            let core = Arc::new(
                Studio::new(store, move |id| {
                    let _ = handle.emit("jobs-changed", id);
                })
                .map_err(std::io::Error::other)?,
            );
            app.manage(core.clone());
            app.manage(media::video_export::VideoFiles::default());
            core.recover().map_err(std::io::Error::other)?;
            if let Err(e) = crate::desktop_window::install(app.handle()) {
                crate::diagnostics::failure("tray-init", &e.to_string());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::desktop_window::runtime_info,
            crate::updates::check_app_update,
            crate::updates::skip_app_update,
            crate::updates::get_app_update,
            crate::updates::install_app_update,
            crate::updates::open_app_releases,
            crate::desktop_window::request_quit,
            crate::desktop_window::finish_window_close,
            crate::diagnostics::open_log_folder,
            crate::diagnostics::report_runtime_issue,
            crate::developer::set_developer_mode,
            crate::developer::request_history,
            crate::developer::request_example,
            crate::developer::clear_request_history,
            crate::developer::copy_request_example,
            commands::connections::discover_models,
            commands::connections::edit_profile,
            commands::connections::integration_settings,
            commands::connections::list_models,
            commands::connections::performance_mode,
            commands::connections::remove_profile,
            commands::connections::save_performance,
            commands::connections::save_storage,
            commands::generation::changed_jobs,
            commands::generation::copy_task_info,
            commands::generation::resume_job,
            commands::generation::reuse_job,
            commands::generation::select_comparison,
            commands::generation::start_comparison,
            commands::generation::start_job,
            commands::generation::studio_state,
            commands::library::add_files,
            commands::library::add_link,
            commands::library::asset_preview,
            commands::library::copy_job_image,
            commands::library::job_frame,
            commands::library::open_file,
            commands::library::open_folder,
            commands::library::open_web,
            commands::library::pick_files,
            commands::library::upload_image,
            commands::media::export_input,
            commands::media::export_job,
            commands::media::export_rendered,
            commands::projects::create_script,
            commands::projects::edit_script,
            commands::projects::list_scripts,
            commands::projects::list_shot_drafts,
            commands::projects::save_shot_draft,
            commands::projects::set_final,
            connections::model_features::get_model_features,
            connections::model_features::set_model_features,
            generation::batches::create_batch,
            generation::batches::list_batches,
            generation::batches::run_batch,
            generation::batches::withdraw_job,
            generation::receipts::attach_receipt,
            generation::receipts::check_receipt,
            generation::reconciliation::cancel_remote,
            generation::reconciliation::get_charge,
            generation::reconciliation::mark_reconciled,
            generation::reconciliation::record_charge,
            library::organize::candidate_choice,
            library::organize::choose_candidate,
            library::organize::library_marks,
            library::organize::list_cards,
            library::organize::mark_work,
            library::organize::save_card,
            media::film::deliver_film,
            media::film::extract_frame,
            media::masks::save_captured_frame,
            media::masks::save_mask,
            media::media_tools::choose_media_tools,
            media::media_tools::media_tools,
            media::thumbnails::job_thumbnail,
            media::thumbnails::save_video_poster,
            media::thumbnails::video_poster,
            media::video_export::close_video_io,
            media::video_export::open_video_io,
            media::video_export::read_video_part,
            media::video_export::write_video_part,
            projects::project_archive::export_project,
            projects::project_archive::import_project,
            projects::project_archive::pick_project,
            providers::custom_graph::configure_graph,
            providers::custom_graph::get_graph,
            writer::commands::generate_script,
            writer::commands::start_script_run,
            writer::commands::optimize_prompt,
            writer::commands::prompt_agent_step,
            writer::commands::finish_prompt_run,
            writer::commands::prompt_session,
            writer::commands::prompt_shot_context,
            writer::commands::save_prompt_memory,
            writer::commands::save_writer,
            writer::commands::select_writer,
            writer::commands::remove_writer,
            writer::templates::commands::prompt_templates,
            writer::templates::commands::find_prompt_templates,
            writer::templates::commands::parse_prompt_templates,
            writer::templates::commands::change_prompt_templates,
            writer::templates::commands::export_prompt_templates,
            writer::commands::update_prompt_session,
        ])
        .build(context)
        .unwrap_or_else(|e| {
            crate::diagnostics::failure("startup", &e.to_string());
            panic!("莫比环启动失败：{e}");
        });
    app.run(|_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let _ = crate::desktop_window::restore(_handle);
        }
        tauri::RunEvent::Exit => crate::diagnostics::entry("INFO", "exit", "应用已退出"),
        _ => {}
    });
}
