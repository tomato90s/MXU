//! 资源热更新命令
//!
//! 提供脚本资源（interface.json + resource/）的独立更新能力

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::utils::get_exe_directory;

/// 内置 GitHub 加速前缀（与前端 DEFAULT_RESOURCE_UPDATE_MIRROR_PREFIXES 一致）
const DEFAULT_MIRROR_PREFIXES: &[&str] = &[
    "",
    "https://gh-proxy.com/",
];

/// 资源更新检查结果
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUpdateCheckResult {
    pub has_update: bool,
    pub version: Option<String>,
    pub current_version: String,
    pub files_changed: Option<u32>,
    pub release_note: Option<String>,
    pub download_url: Option<String>,
}

/// 远程资源 manifest 结构
#[derive(Deserialize, Debug)]
struct ResourceManifest {
    version: String,
    update_url: String,
    files: serde_json::Value,
}

/// 检查资源更新
///
/// 下载远程 manifest，对比版本号，返回是否需要更新
#[tauri::command]
pub async fn check_resource_update(
    manifest_url: String,
    current_version: String,
    mirror_prefixes: Vec<String>,
) -> Result<ResourceUpdateCheckResult, String> {
    info!(
        "检查资源更新: manifest={}, current={}",
        manifest_url, current_version
    );

    let manifest = fetch_manifest(&manifest_url, &mirror_prefixes).await?;
    let remote_version = manifest.version;

    // 版本号简单字符串对比（资源版本通常不需要 semver 语义化比较）
    if remote_version == current_version {
        info!("资源已是最新版: {}", current_version);
        return Ok(ResourceUpdateCheckResult {
            has_update: false,
            version: Some(remote_version),
            current_version,
            files_changed: None,
            release_note: None,
            download_url: None,
        });
    }

    // 计算文件变更数
    let files_changed = manifest.files.as_object().map(|m| m.len() as u32);

    info!(
        "发现资源更新: {} -> {}, 文件变更: {:?}",
        current_version, remote_version, files_changed
    );

    Ok(ResourceUpdateCheckResult {
        has_update: true,
        version: Some(remote_version),
        current_version,
        files_changed,
        release_note: None,
        download_url: Some(manifest.update_url),
    })
}

/// 应用资源更新
///
/// 下载 zip 资源包，解压覆盖到项目根目录，更新 .manifest.json
#[tauri::command]
pub async fn apply_resource_update(
    download_url: String,
    manifest: serde_json::Value,
    mirror_prefixes: Vec<String>,
) -> Result<(), String> {
    info!("应用资源更新: {}", download_url);

    let root_dir = get_exe_directory()?;
    let cache_dir = root_dir.join("cache").join("resource-update-tmp");
    let zip_path = cache_dir.join("update.zip");

    // 1. 清理旧临时目录
    if cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&cache_dir);
    }
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("无法创建缓存目录: {}", e))?;

    // 2. 下载 zip（支持多镜像）
    download_resource_zip(&download_url, &zip_path, &mirror_prefixes).await?;
    info!("资源包下载完成: {}", zip_path.display());

    // 3. 解压到临时子目录
    let extract_dir = cache_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("无法创建解压目录: {}", e))?;

    super::update::extract_zip(
        zip_path.to_string_lossy().to_string(),
        extract_dir.to_string_lossy().to_string(),
    )?;
    info!("资源包解压完成");

    // 4. 遍历解压后的内容，覆盖到项目根目录
    let entries = std::fs::read_dir(&extract_dir)
        .map_err(|e| format!("读取解压目录失败: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // 跳过临时文件和自身
        if name_str == ".update_tmp" || name_str == "update.zip" || name_str == "extracted" {
            continue;
        }

        let target = root_dir.join(&name);

        // 删除旧文件/目录
        if target.exists() {
            if target.is_dir() {
                let _ = std::fs::remove_dir_all(&target);
            } else {
                let _ = std::fs::remove_file(&target);
            }
        }

        // 移动新文件
        std::fs::rename(entry.path(), &target).map_err(|e| {
            format!(
                "移动文件失败 [{} -> {}]: {}",
                entry.path().display(),
                target.display(),
                e
            )
        })?;
    }
    info!("资源文件覆盖完成");

    // 5. 写入新的 .manifest.json
    let manifest_path = root_dir.join(".manifest.json");
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("序列化 manifest 失败: {}", e))?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("写入 manifest 失败: {}", e))?;
    info!("manifest 已更新: {}", manifest_path.display());

    // 6. 清理临时目录
    let _ = std::fs::remove_dir_all(&cache_dir);

    info!("资源更新完成");
    Ok(())
}

// ------------------------------------------------------------------
// 内部辅助函数
// ------------------------------------------------------------------

fn effective_mirror_prefixes(mirror_prefixes: &[String]) -> Vec<String> {
    if mirror_prefixes.is_empty() {
        return DEFAULT_MIRROR_PREFIXES.iter().map(|s| (*s).to_string()).collect();
    }
    mirror_prefixes.to_vec()
}

/// 从远程获取 manifest（支持多镜像重试）
async fn fetch_manifest(
    manifest_url: &str,
    mirror_prefixes: &[String],
) -> Result<ResourceManifest, String> {
    let prefixes = effective_mirror_prefixes(mirror_prefixes);
    let mut last_error: Option<String> = None;

    for prefix in &prefixes {
        let url = format!("{}{}", prefix, manifest_url);
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                last_error = Some(format!("创建 HTTP 客户端失败: {}", e));
                continue;
            }
        };

        let response = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("manifest 下载失败 ({}): {}", url, e);
                last_error = Some(format!("下载失败: {}", e));
                continue;
            }
        };

        if !response.status().is_success() {
            warn!("manifest 下载失败 ({}): HTTP {}", url, response.status());
            last_error = Some(format!("HTTP 错误: {}", response.status()));
            continue;
        }

        let body = match response.text().await {
            Ok(b) => b,
            Err(e) => {
                warn!("manifest 读取失败 ({}): {}", url, e);
                last_error = Some(format!("读取失败: {}", e));
                continue;
            }
        };

        let manifest: ResourceManifest = match serde_json::from_str(&body) {
            Ok(m) => m,
            Err(e) => {
                warn!("manifest 解析失败 ({}): {}", url, e);
                last_error = Some(format!("解析失败: {}", e));
                continue;
            }
        };

        return Ok(manifest);
    }

    Err(last_error.unwrap_or_else(|| "所有镜像均无法下载 manifest".to_string()))
}

/// 下载资源 zip 包（支持多镜像重试）
async fn download_resource_zip(
    url: &str,
    save_path: &PathBuf,
    mirror_prefixes: &[String],
) -> Result<(), String> {
    let prefixes = effective_mirror_prefixes(mirror_prefixes);
    let mut last_error: Option<String> = None;

    for prefix in &prefixes {
        let mirror_url = format!("{}{}", prefix, url);
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                last_error = Some(format!("创建 HTTP 客户端失败: {}", e));
                continue;
            }
        };

        let response = match client.get(&mirror_url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("zip 下载失败 ({}): {}", mirror_url, e);
                last_error = Some(format!("下载失败: {}", e));
                continue;
            }
        };

        if !response.status().is_success() {
            warn!("zip 下载失败 ({}): HTTP {}", mirror_url, response.status());
            last_error = Some(format!("HTTP 错误: {}", response.status()));
            continue;
        }

        let bytes = match response.bytes().await {
            Ok(b) => b,
            Err(e) => {
                warn!("zip 读取失败 ({}): {}", mirror_url, e);
                last_error = Some(format!("读取失败: {}", e));
                continue;
            }
        };

        std::fs::write(save_path, bytes).map_err(|e| format!("写入 zip 文件失败: {}", e))?;
        return Ok(());
    }

    Err(last_error.unwrap_or_else(|| "所有镜像均无法下载资源包".to_string()))
}
