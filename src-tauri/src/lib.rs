mod app;
mod commands;
mod connections;
mod desktop_window;
mod developer;
mod diagnostics;
mod domain;
mod generation;
mod library;
mod media;
mod projects;
mod providers;
mod storage;
mod updates;
#[cfg(test)]
mod tests;
mod writer;

pub use app::run;
