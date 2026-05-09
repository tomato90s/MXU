# MXU 资源热更新设计文档

## 1. 概述

在 MXU 中新增**资源热更新**功能，允许用户在不更新 MXU 应用程序本身的情况下，只更新脚本资源（`interface.json` + `resource/` 目录）。

资源更新源为 GitHub Release，复用项目已有的 `resource-manifest.json` + `resource-update-{version}.zip` 发布流程。

## 2. 用户需求

1. **UI 位置**：资源更新入口放在 TabBar 中控台视图按钮（`LayoutGrid`）的左侧
2. **版本号显示**：显示当前 `interface.json` 中的 `version` 字段（脚本版本号）
3. **New 标记**：当检测到有新版本时，在版本号或更新按钮右上角显示红点/New 角标
4. **自动检查**：MXU 启动时自动检测资源更新（可开关）
5. **更新后行为**：更新完成后自动重新加载 `interface.json`；如果 MXU 本身需要重启，则提示用户重启应用

## 3. UI/UX 设计

### 3.1 TabBar 入口

在 TabBar 右侧按钮组中，中控台按钮（`LayoutGrid`）的左侧新增资源更新区域：

```
[标签页列表 ...]                           [脚本版本 v1.2.0] [更新按钮🔴] [中控台] [主题] [设置]
```

- **无更新时**：显示灰色版本号文本（如 `v1.2.0`），更新按钮隐藏或置灰
- **有新版本时**：版本号变为高亮（如 `v1.2.0 → v1.3.0`），更新按钮显示并在右上角显示红色角标（`🔴`）
- **检查中**：版本号旁显示小 loading 图标
- **更新中**：显示进度条弹窗

### 3.2 更新确认弹窗

点击更新按钮后弹出：

- 标题："发现新版本 v1.3.0"
- 内容：显示文件变更数、更新说明（取 GitHub Release body）
- 按钮："立即更新" / "稍后再说"
- 底部：显示代理设置（复用现有 proxyService）

### 3.3 进度弹窗

- 标题："正在更新资源..."
- 进度条：显示下载百分比和速度
- 状态文本："下载中..." → "解压中..." → "更新完成"

### 3.4 更新完成

- 弹窗提示："资源更新完成，已重新加载"
- 如果检测到 MXU 本体也有更新，追加提示："MXU 有新版本，建议重启应用"

## 4. 前端架构

### 4.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/services/resourceUpdateService.ts` | 资源更新服务层：检查更新、下载、调用 Rust 安装 |
| `src/components/ResourceUpdateButton.tsx` | TabBar 中的资源更新按钮+版本号展示 |
| `src/components/ResourceUpdateModal.tsx` | 更新确认/进度弹窗 |

### 4.2 状态管理（appStore 扩展）

```ts
interface AppState {
  // ... 现有字段
  resourceVersion: string | null;           // 当前 interface.json 中的 version
  resourceUpdateStatus: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'completed' | 'error';
  resourceUpdateInfo: {
    version: string;
    currentVersion: string;
    filesChanged: number;
    releaseNote?: string;
  } | null;
  resourceUpdateProgress: DownloadProgress | null;
  resourceUpdateError: string | null;
  autoCheckResourceUpdate: boolean;         // 启动时自动检查（默认 true）
}
```

### 4.3 服务层 API

```ts
// src/services/resourceUpdateService.ts

/** 检查资源更新 */
export async function checkResourceUpdate(
  manifestUrl: string,
  currentVersion: string,
): Promise<{
  hasUpdate: boolean;
  version?: string;
  filesChanged?: number;
  releaseNote?: string;
  downloadUrl?: string;
}>;

/** 下载并应用资源更新 */
export async function applyResourceUpdate(
  downloadUrl: string,
  manifest: object,
  onProgress: (progress: DownloadProgress) => void,
): Promise<{ success: boolean; error?: string }>;

/** 从 interface.json 的 github 字段生成 manifest URL */
export function buildManifestUrl(githubUrl: string): string;
```

## 5. Rust 后端架构

### 5.1 新增文件

`src-tauri/src/commands/resource_update.rs`

### 5.2 指令

| 指令 | 签名 | 功能 |
|------|------|------|
| `check_resource_update` | `(manifestUrl: String, currentVersion: String) -> ResourceUpdateCheckResult` | 下载 manifest，对比版本，返回是否需要更新 |
| `apply_resource_update` | `(downloadUrl: String, manifest: Value) -> Result<(), String>` | 下载 zip，解压覆盖，更新本地 manifest |

### 5.3 覆盖逻辑

```rust
fn apply_resource_update(download_url: String, manifest: Value) -> Result<(), String> {
    let root_dir = get_exe_directory()?;
    let cache_dir = get_cache_dir()?.join("resource-update-tmp");
    let zip_path = cache_dir.join("update.zip");

    // 1. 清理旧临时目录
    if cache_dir.exists() { fs::remove_dir_all(&cache_dir)?; }
    fs::create_dir_all(&cache_dir)?;

    // 2. 下载 zip
    download_file(&download_url, &zip_path)?;

    // 3. 解压到临时目录
    extract_zip(&zip_path, &cache_dir)?;

    // 4. 遍历临时目录，覆盖到项目根目录
    for entry in fs::read_dir(&cache_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".update_tmp" || name == "update.zip" { continue; }

        let target = root_dir.join(&name);
        if target.exists() {
            if target.is_dir() { fs::remove_dir_all(&target)?; }
            else { fs::remove_file(&target)?; }
        }
        fs::rename(entry.path(), target)?;
    }

    // 5. 写入新的 .manifest.json
    let manifest_path = root_dir.join(".manifest.json");
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)?;

    // 6. 清理
    fs::remove_dir_all(&cache_dir)?;

    Ok(())
}
```

### 5.4 错误处理

| 场景 | 处理 |
|------|------|
| 网络失败 | 重试 3 次（换 gh-proxy 镜像），失败后返回错误 |
| 下载中断 | 保留临时 zip，下次尝试断点续传（可选） |
| 解压失败 | 清理临时目录，回滚不执行，返回错误 |
| 文件被占用 | 延迟替换：写入 `.update_pending` 标记，下次启动时应用 |

## 6. 数据流

```
MXU 启动
  → App.tsx useEffect 中调用 autoCheckResourceUpdate()
    → resourceUpdateService.checkResourceUpdate(manifestUrl, currentVersion)
      → invoke('check_resource_update')
        → Rust 下载 manifest 对比
      ← 返回 { hasUpdate: true, version, filesChanged, releaseNote }
    → 更新 appStore：resourceUpdateStatus = 'available'
    → TabBar 显示版本号 + 红点角标

用户点击更新按钮
  → 打开 ResourceUpdateModal（确认弹窗）
    → 用户点击"立即更新"
      → resourceUpdateService.applyResourceUpdate(downloadUrl, manifest, onProgress)
        → invoke('apply_resource_update')
          → Rust 下载 zip → 解压 → 覆盖 → 更新 manifest
        ← 返回 success
      → 更新 appStore：resourceUpdateStatus = 'completed'
      → 调用 loadInterface() 重新加载 interface.json
      → 弹窗提示"更新完成"
```

## 7. 启动时自动检查

在 `App.tsx` 的初始化 `useEffect` 中，加载完 `interface.json` 后：

```ts
// 在 loadInterface() 成功之后
if (appStore.autoCheckResourceUpdate) {
  const githubUrl = result.interface.github;
  if (githubUrl) {
    const manifestUrl = buildManifestUrl(githubUrl);
    checkResourceUpdate(manifestUrl, result.interface.version);
  }
}
```

- 自动检查是**非阻塞的**，不影响界面加载
- 如果检测到有更新，在 TabBar 上显示红点，不弹窗打扰
- 用户可开关：SettingsPage 中新增"启动时自动检查资源更新"

## 8. 更新后自动刷新

更新完成后：

1. 调用 `loadInterface()` 重新读取 `interface.json`
2. 重新设置 `projectInterface`、`basePath`、`translations`
3. 如果 `interface.json` 的 `version` 字段变化，更新 `resourceVersion`
4. 如果 MXU 本体也有待更新（`downloadStatus === 'completed'`），在弹窗中追加提示

## 9. 设置项扩展

在 SettingsPage 中新增区域：

```
[资源更新]
☑ 启动时自动检查资源更新
  当前版本：v1.2.0
  [检查更新]  ← 手动检查按钮
```

## 10. WebUI 兼容

WebUI 模式下通过 HTTP API 调用：

- `GET /api/resource-update/check?manifestUrl=...&currentVersion=...`
- `POST /api/resource-update/apply` （body: `{ downloadUrl, manifest }`）

Web 服务器端复用 Rust 相同的 resource_update 逻辑。

## 11. 国际化

新增 i18n 键：

```json
{
  "resourceUpdate": {
    "currentVersion": "脚本版本 {{version}}",
    "check": "检查更新",
    "newVersionAvailable": "发现新版本 {{version}}",
    "updateNow": "立即更新",
    "later": "稍后再说",
    "downloading": "正在下载资源...",
    "installing": "正在安装...",
    "completed": "资源更新完成",
    "error": "更新失败：{{message}}",
    "autoCheck": "启动时自动检查资源更新"
  }
}
```
