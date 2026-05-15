//! 资源热更新命令
//!
//! 提供脚本资源（interface.json + resource/）的独立更新能力

use futures_util::StreamExt;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

use super::utils::get_exe_directory;

/// 内置 GitHub 加速前缀（与前端 DEFAULT_RESOURCE_UPDATE_MIRROR_PREFIXES 一致）
const DEFAULT_MIRROR_PREFIXES: &[&str] = &["", "https://gh-proxy.com/"];

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

/// 资源下载进度事件
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUpdateProgressEvent {
    pub url: String,
    pub downloaded_size: u64,
    pub total_size: u64,
    pub speed: u64,
    pub progress: f64,
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
    app: tauri::AppHandle,
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
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("无法创建缓存目录: {}", e))?;

    // 2. 下载 zip（支持多镜像 + 进度上报）
    download_resource_zip(&app, &download_url, &zip_path, &mirror_prefixes).await?;
    info!("资源包下载完成: {}", zip_path.display());

    // 3. 解压到临时子目录
    let extract_dir = cache_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("无法创建解压目录: {}", e))?;

    super::update::extract_zip(
        zip_path.to_string_lossy().to_string(),
        extract_dir.to_string_lossy().to_string(),
    )?;
    info!("资源包解压完成");

    // 4. 遍历解压后的内容，覆盖到项目根目录
    let entries =
        std::fs::read_dir(&extract_dir).map_err(|e| format!("读取解压目录失败: {}", e))?;

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
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest 失败: {}", e))?;
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
        return DEFAULT_MIRROR_PREFIXES
            .iter()
            .map(|s| (*s).to_string())
            .collect();
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

/// 下载资源 zip 包（支持多镜像重试 + 流式进度上报）
async fn download_resource_zip(
    app: &tauri::AppHandle,
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

        let total = response.content_length().unwrap_or(0);
        let downloaded_shared = Arc::new(AtomicU64::new(0));
        let downloaded_clone = downloaded_shared.clone();

        // 进度上报定时器
        let app_clone = app.clone();
        let url_for_progress = mirror_url.clone();
        let progress_handle = tokio::spawn(async move {
            let mut last_downloaded: u64 = 0;
            let mut last_instant = tokio::time::Instant::now();
            let mut smoothed_speed: f64 = 0.0;
            const EMA_ALPHA: f64 = 0.3;

            let mut interval = tokio::time::interval(Duration::from_millis(300));
            loop {
                interval.tick().await;
                let now = tokio::time::Instant::now();
                let downloaded = downloaded_clone.load(Ordering::Relaxed);

                let elapsed = now - last_instant;
                if elapsed.as_millis() < 100 {
                    continue;
                }

                let bytes_in_interval = downloaded.saturating_sub(last_downloaded);
                let instant_speed = if elapsed.as_secs_f64() > 0.0 {
                    bytes_in_interval as f64 / elapsed.as_secs_f64()
                } else {
                    0.0
                };

                smoothed_speed = if smoothed_speed == 0.0 {
                    instant_speed
                } else {
                    EMA_ALPHA * instant_speed + (1.0 - EMA_ALPHA) * smoothed_speed
                };

                let progress = if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0).min(100.0)
                } else {
                    0.0
                };

                let _ = app_clone.emit(
                    "resource-update-progress",
                    ResourceUpdateProgressEvent {
                        url: url_for_progress.clone(),
                        downloaded_size: downloaded,
                        total_size: total,
                        speed: smoothed_speed as u64,
                        progress,
                    },
                );

                last_downloaded = downloaded;
                last_instant = now;
            }
        });

        // 流式下载
        let mut stream = response.bytes_stream();
        let mut file =
            std::fs::File::create(save_path).map_err(|e| format!("创建 zip 文件失败: {}", e))?;
        let mut downloaded: u64 = 0;
        let mut download_err: Option<String> = None;

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    download_err = Some(format!("下载数据失败: {}", e));
                    break;
                }
            };

            use std::io::Write;
            if let Err(e) = file.write_all(&chunk) {
                download_err = Some(format!("写入数据失败: {}", e));
                break;
            }
            downloaded += chunk.len() as u64;
            downloaded_shared.store(downloaded, Ordering::Relaxed);
        }

        // 停止进度上报
        progress_handle.abort();

        if let Some(err) = download_err {
            let _ = std::fs::remove_file(save_path);
            last_error = Some(err);
            continue;
        }

        // 发送最终进度 100%
        let _ = app.emit(
            "resource-update-progress",
            ResourceUpdateProgressEvent {
                url: mirror_url,
                downloaded_size: downloaded,
                total_size: if total > 0 { total } else { downloaded },
                speed: 0,
                progress: 100.0,
            },
        );

        info!(
            "资源包下载完成: {} bytes -> {}",
            downloaded,
            save_path.display()
        );
        return Ok(());
    }

    Err(last_error.unwrap_or_else(|| "所有镜像均无法下载资源包".to_string()))
}
