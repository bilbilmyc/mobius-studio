use crate::{app::Core, domain::Result, generation::jobs::Studio};
use futures_util::StreamExt;
use reqwest::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

const RELEASES: &str = "https://github.com/bilbilmyc/mobius-studio/releases";
const LATEST: &str = "https://api.github.com/repos/bilbilmyc/mobius-studio/releases/latest";
const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
pub(crate) struct Updates {
    download: tokio::sync::Mutex<()>,
    ready: Mutex<Option<Installer>>,
    install_on_exit: std::sync::atomic::AtomicBool,
}

struct Installer {
    version: String,
    path: PathBuf,
    digest: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    digest: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    latest: String,
    available: bool,
    package: Option<String>,
    install: bool,
}

fn package_name(os: &str, arch: &str, installed: bool, version: &Version) -> Option<String> {
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(match (os, installed) {
        ("windows", true) => format!("Mobius-Windows-{arch}-{version}-setup.exe"),
        ("windows", false) => format!("Mobius-Windows-{arch}.zip"),
        ("linux", true) => format!("Mobius-Linux-{arch}-{version}.deb"),
        ("linux", false) => format!("Mobius-Linux-{arch}.tar.gz"),
        ("macos", _) if arch == "arm64" => format!("Mobius-macOS-{arch}-{version}.dmg"),
        _ => return None,
    })
}

impl Release {
    fn info(&self, current: &Version) -> Result<UpdateInfo> {
        let version = self
            .tag_name
            .strip_prefix('v')
            .and_then(|v| Version::parse(v).ok())
            .filter(|v| v.pre.is_empty() && v.build.is_empty() && !self.draft && !self.prerelease)
            .ok_or("发布服务未返回有效的稳定版本。")?;
        let name = package_name(
            std::env::consts::OS,
            std::env::consts::ARCH,
            cfg!(feature = "installed"),
            &version,
        );
        let package = name.filter(|n| self.assets.iter().any(|a| a.name == *n));
        Ok(UpdateInfo {
            available: version > *current,
            latest: version.to_string(),
            package,
            install: cfg!(all(windows, feature = "installed")),
        })
    }
}

fn release_client() -> Result<Client> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("Mobius-Studio/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

async fn latest(http: &Client) -> Result<(Release, UpdateInfo)> {
    let response = http
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-cache")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络后重试。")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub 暂时无法提供版本信息（HTTP {}）。",
            response.status().as_u16()
        ));
    }
    let release: Release = response
        .json()
        .await
        .map_err(|_| "无法读取 GitHub 发布信息。")?;
    let info = release.info(&Version::parse(CURRENT).expect("Cargo package version"))?;
    Ok((release, info))
}

#[tauri::command]
pub(crate) async fn check_app_update() -> Result<UpdateInfo> {
    Ok(latest(&release_client()?).await?.1)
}

async fn download(http: &Client, url: &str, asset: &Asset, directory: &Path) -> Result<PathBuf> {
    let expected = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("此安装包缺少 SHA-256 校验值，请查看发布页。")?;
    let error = |e: std::io::Error| format!("无法保存更新包：{e}");
    tokio::fs::create_dir_all(directory).await.map_err(error)?;
    let temp = tempfile::NamedTempFile::new_in(directory).map_err(error)?;
    let mut file = tokio::fs::File::from_std(temp.reopen().map_err(error)?);
    let response = http
        .get(url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| "更新包下载失败，请重试或打开发布页。")?;
    let mut stream = response.bytes_stream();
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "更新包下载中断，请重试。")?;
        bytes += chunk.len() as u64;
        if bytes > asset.size {
            return Err("下载大小与发布记录不符。".into());
        }
        file.write_all(&chunk).await.map_err(error)?;
        digest.update(&chunk);
    }
    if bytes == 0
        || bytes != asset.size
        || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected)
    {
        return Err("更新包校验失败，请重新下载。".into());
    }
    file.sync_all().await.map_err(error)?;
    drop(file);
    let path = directory.join(&asset.name);
    temp.persist(&path).map_err(|e| error(e.error))?;
    Ok(path)
}

#[tauri::command]
pub(crate) async fn get_app_update(
    app: AppHandle,
    updates: State<'_, Updates>,
    version: String,
) -> Result<()> {
    let _guard = updates.download.try_lock().map_err(|_| "正在下载更新。")?;
    let http = release_client()?;
    let (release, info) = latest(&http).await?;
    if !info.available || info.latest != version {
        return Err("版本信息已变化，请重新检查更新。".into());
    }
    let asset = release
        .assets
        .iter()
        .find(|a| Some(&a.name) == info.package.as_ref())
        .ok_or("此版本还没有适合本机的更新包。")?;
    // Only download a filename selected from our platform table, under this project's release.
    let url = format!("{RELEASES}/download/{}/{}", release.tag_name, asset.name);
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates")
        .join(&release.tag_name);
    let path = download(&http, &url, asset, &directory).await?;
    if info.install {
        *updates.ready.lock().unwrap() = Some(Installer {
            version,
            path,
            digest: asset.digest.clone().ok_or("缺少更新包校验值。")?,
        });
    } else if cfg!(target_os = "macos") || cfg!(all(target_os = "linux", feature = "installed")) {
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| e.to_string())?;
    } else {
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_idle(studio: &Studio) -> Result<()> {
    if studio.generating() {
        return Err("还有生成任务在运行，请等任务完成后再安装。".into());
    }
    Ok(())
}

pub(crate) fn discard_install(app: &AppHandle) {
    app.state::<Updates>()
        .install_on_exit
        .store(false, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub(crate) fn install_app_update(
    app: AppHandle,
    s: Core<'_>,
    updates: State<'_, Updates>,
    version: String,
) -> Result<()> {
    ensure_idle(&s)?;
    if !updates
        .ready
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|i| i.version == version)
    {
        return Err("请先下载此版本的安装包。".into());
    }
    updates
        .install_on_exit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Err(e) = crate::desktop_window::request_quit(app.clone()) {
        discard_install(&app);
        return Err(e);
    }
    Ok(())
}

pub(crate) fn launch_pending(app: &AppHandle) -> Result<()> {
    let updates = app.state::<Updates>();
    if updates
        .install_on_exit
        .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        ensure_idle(&app.state::<Arc<Studio>>())?;
        let ready = updates.ready.lock().unwrap();
        let installer = ready.as_ref().ok_or("请重新下载更新包。")?;
        let mut file = std::fs::File::open(&installer.path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash).map_err(|e| e.to_string())?;
        if !format!("sha256:{:x}", hash.finalize()).eq_ignore_ascii_case(&installer.digest) {
            return Err("更新包已发生变化，请重新下载。".into());
        }
        std::process::Command::new(&installer.path)
            .spawn()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn open_app_releases(app: AppHandle) -> Result<()> {
    app.opener()
        .open_url(RELEASES, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_asset_matches_the_build_and_versions_compare_numerically() {
        let v = Version::parse("2.14.10").unwrap();
        for (os, arch, installed, expected) in [
            (
                "windows",
                "aarch64",
                true,
                "Mobius-Windows-arm64-2.14.10-setup.exe",
            ),
            ("windows", "x86_64", false, "Mobius-Windows-x64.zip"),
            ("linux", "x86_64", true, "Mobius-Linux-x64-2.14.10.deb"),
            ("linux", "aarch64", false, "Mobius-Linux-arm64.tar.gz"),
            ("macos", "aarch64", true, "Mobius-macOS-arm64-2.14.10.dmg"),
        ] {
            assert_eq!(
                package_name(os, arch, installed, &v).as_deref(),
                Some(expected)
            );
        }
        assert!(package_name("macos", "x86_64", true, &v).is_none());
        let mut release = Release {
            tag_name: "v2.14.10".into(),
            draft: false,
            prerelease: false,
            assets: vec![],
        };
        let info = release.info(&Version::parse("2.14.9").unwrap()).unwrap();
        assert!(info.available && info.package.is_none());
        assert!(!release.info(&v).unwrap().available);
        assert!(
            !release
                .info(&Version::parse("2.15.0").unwrap())
                .unwrap()
                .available
        );
        release.prerelease = true;
        assert!(release.info(&v).is_err());
        release.prerelease = false;
        release.tag_name = "v2.15.0/other".into();
        assert!(release.info(&v).is_err());
    }

    #[tokio::test]
    async fn only_complete_verified_downloads_replace_the_package() {
        use axum::{routing::get, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/installer", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let router = Router::new().route("/installer", get(|| async { "package" }));
            axum::serve(listener, router).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let http = Client::new();
        let mut asset = Asset {
            name: "setup.exe".into(),
            size: 7,
            digest: Some(format!("sha256:{:x}", Sha256::digest(b"package"))),
        };
        let path = download(&http, &url, &asset, dir.path()).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"package");
        std::fs::write(&path, b"existing").unwrap();
        asset.size = 6;
        assert!(download(&http, &url, &asset, dir.path()).await.is_err());
        asset.size = 7;
        asset.digest = Some(format!("sha256:{}", "0".repeat(64)));
        assert!(download(&http, &url, &asset, dir.path()).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"existing");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        server.abort();
    }
}
