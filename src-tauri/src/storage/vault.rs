use crate::domain::{Profile, Result};
#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::HashMap;
use std::sync::Mutex;

pub struct Vault {
    session: Mutex<HashMap<(String, String), String>>,
}
impl Vault {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(HashMap::new()),
        }
    }
    pub fn note() -> &'static str {
        if cfg!(windows) {
            "Key 使用当前 Windows 用户的 DPAPI 加密。"
        } else if cfg!(target_os = "macos") {
            "Key 保存在本机 macOS 钥匙串。"
        } else {
            "Key 优先保存到 Linux 密钥环。密钥环不可用时仅在本次会话中使用。"
        }
    }
    pub fn has(&self, p: &Profile, base: &str) -> bool {
        self.session
            .lock()
            .unwrap()
            .contains_key(&(p.id.clone(), base.into()))
            || p.keys.contains_key(&slot(base))
    }
    pub fn temporary(&self, p: &Profile, key: &str) {
        if !key.trim().is_empty() {
            self.session
                .lock()
                .unwrap()
                .insert((p.id.clone(), p.base_url.clone()), key.trim().into());
        }
    }
    pub fn put(&self, p: &mut Profile, key: &str) -> Result<()> {
        if key.trim().is_empty() {
            return Ok(());
        }
        let base = &p.base_url;
        #[cfg(not(target_os = "linux"))]
        self.session
            .lock()
            .unwrap()
            .remove(&(p.id.clone(), base.clone()));
        #[cfg(windows)]
        {
            p.keys.insert(
                slot(base),
                STANDARD.encode(dpapi(key.trim().as_bytes(), true)?),
            );
        }
        #[cfg(target_os = "macos")]
        {
            let account = format!("{}@{}", p.id, base);
            security_framework::passwords::set_generic_password(
                "com.mobius.creative.studio",
                &account,
                key.trim().as_bytes(),
            )
            .map_err(|_| "无法写入 macOS 钥匙串")?;
            p.keys.insert(slot(base), account);
        }
        #[cfg(target_os = "linux")]
        {
            let account = format!("{}@{}", p.id, base);
            if secret(
                &[
                    "store",
                    "--label=莫比环",
                    "application",
                    "com.mobius.creative.studio",
                    "account",
                    &account,
                ],
                Some(key.trim()),
            )
            .is_ok()
            {
                p.keys.insert(slot(base), account);
                self.session
                    .lock()
                    .unwrap()
                    .remove(&(p.id.clone(), base.clone()));
            } else {
                self.session
                    .lock()
                    .unwrap()
                    .insert((p.id.clone(), base.clone()), key.trim().into());
            }
        }
        Ok(())
    }
    pub fn get(&self, p: &Profile, base: &str) -> Result<String> {
        if let Some(value) = self
            .session
            .lock()
            .unwrap()
            .get(&(p.id.clone(), base.into()))
        {
            return Ok(value.clone());
        }
        let Some(saved) = p.keys.get(&slot(base)) else {
            return Ok(String::new());
        };
        #[cfg(windows)]
        {
            let bytes = STANDARD
                .decode(saved)
                .map_err(|_| "密钥格式无效，请在连接中重新填写。")?;
            String::from_utf8(dpapi(&bytes, false)?).map_err(|_| "请重新填写连接的 Key。".into())
        }
        #[cfg(target_os = "macos")]
        {
            let bytes = security_framework::passwords::get_generic_password(
                "com.mobius.creative.studio",
                saved,
            )
            .map_err(|_| "钥匙串未找到此 Key，请重新填写。")?;
            String::from_utf8(bytes).map_err(|_| "密钥格式无效".into())
        }
        #[cfg(target_os = "linux")]
        {
            secret(
                &[
                    "lookup",
                    "application",
                    "com.mobius.creative.studio",
                    "account",
                    saved,
                ],
                None,
            )
            .map_err(|_| "无法读取此 Linux 密钥环条目，请重新填写 Key。".into())
        }
    }
    pub fn forget(&self, p: &Profile) {
        self.session
            .lock()
            .unwrap()
            .retain(|(id, _), _| id != &p.id);
        #[cfg(target_os = "macos")]
        for (k, v) in &p.keys {
            if k.starts_with("macos:") {
                let _ = security_framework::passwords::delete_generic_password(
                    "com.mobius.creative.studio",
                    v,
                );
            }
        }
        #[cfg(target_os = "linux")]
        for (k, v) in &p.keys {
            if k.starts_with("linux:") {
                let _ = secret(
                    &[
                        "clear",
                        "application",
                        "com.mobius.creative.studio",
                        "account",
                        v,
                    ],
                    None,
                );
            }
        }
    }
}
fn slot(base: &str) -> String {
    if cfg!(windows) {
        base.into()
    } else {
        format!("{}:{base}", std::env::consts::OS)
    }
}
#[cfg(windows)]
fn dpapi(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let data = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &data,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &data,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err("当前 Windows 用户无法读取或保存这条 Key，请在连接中重新填写。".into());
        }
        let copy = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData.cast());
        Ok(copy)
    }
}
#[cfg(target_os = "linux")]
fn secret(args: &[&str], input: Option<&str>) -> Result<String> {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("secret-tool")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无系统密钥环")?;
    if let Some(key) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(key.as_bytes())
            .map_err(|_| "密钥环写入失败")?;
    } else {
        drop(child.stdin.take());
    }
    let reply = child.wait_with_output().map_err(|_| "密钥环不可用")?;
    if !reply.status.success() {
        return Err("密钥环不可用".into());
    }
    Ok(String::from_utf8_lossy(&reply.stdout)
        .trim_end_matches(['\r', '\n'])
        .into())
}
