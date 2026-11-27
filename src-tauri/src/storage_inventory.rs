use crate::config::{read_text_strip_bom, write_json_atomic};
use crate::models::{StorageDeleteResult, StorageNode, StorageScanProgress};
use crate::paths::ManagerPaths;
use crate::storage::{
    delete_project_targets, is_link_or_reparse_point, mtime_ts, resolve_project_storage_root,
    StorageScanSnapshot,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub size_bytes: u64,
    pub file_count: u64,
}

impl StorageUsage {
    fn add(&mut self, other: Self) {
        self.size_bytes = self.size_bytes.saturating_add(other.size_bytes);
        self.file_count = self.file_count.saturating_add(other.file_count);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    pub path: String,
    #[serde(flatten)]
    usage: StorageUsage,
    pub status: &'static str,
    mtime: f64,
    preview: Vec<StorageNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectUsage {
    id: String,
    name: String,
    source: &'static str,
    folders: Vec<ProjectFolder>,
    #[serde(flatten)]
    usage: StorageUsage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInventory {
    pub local: StorageUsage,
    projects: Vec<ProjectUsage>,
    projects_usage: StorageUsage,
    total: StorageUsage,
}

impl StorageInventory {
    pub fn accessible_project_paths(&self) -> HashSet<PathBuf> {
        self.projects
            .iter()
            .flat_map(|project| &project.folders)
            .filter(|folder| folder.status != "unavailable")
            .map(|folder| PathBuf::from(&folder.path))
            .collect()
    }
}

struct Project {
    id: String,
    name: String,
    source: &'static str,
    folders: Vec<PathBuf>,
}

fn path_key(path: &Path) -> String {
    let display = path.to_string_lossy();
    if cfg!(windows) {
        display.replace('/', "\\").to_lowercase()
    } else {
        display.into_owned()
    }
}

pub(crate) fn contains(parent: &Path, child: &Path) -> bool {
    Path::new(&path_key(child)).starts_with(Path::new(&path_key(parent)))
}

fn local_folder(value: &Value) -> Option<PathBuf> {
    let url = Url::parse(value.as_str()?).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    path.is_absolute().then_some(path)
}

fn name_for_path(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn read_project_file(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_text_strip_bom(path).ok()?).ok()
}

fn registered_projects(project_dir: &Path) -> Vec<Project> {
    let Ok(entries) = fs::read_dir(project_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?;
            if path.extension().and_then(|ext| ext.to_str()) != Some("json")
                || id == "outside-of-project"
            {
                return None;
            }
            let data = read_project_file(&path)?;
            let name = data
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            let folders = data
                .pointer("/projectResources/resources")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|resource| {
                    resource
                        .get("folderUri")
                        .or_else(|| resource.pointer("/gitFolder/folderUri"))
                })
                .filter_map(local_folder)
                .collect();
            Some(Project {
                id: format!("agy:{id}"),
                name: name.to_string(),
                source: "antigravity",
                folders,
            })
        })
        .collect()
}

fn ide_workspace_paths(appdata: &Path) -> Vec<PathBuf> {
    let mut folders = Vec::new();
    for app in ["Antigravity", "Antigravity IDE"] {
        let user = appdata.join(app).join("User");
        if let Ok(entries) = fs::read_dir(user.join("workspaceStorage")) {
            for entry in entries.flatten() {
                let data = read_project_file(&entry.path().join("workspace.json"));
                if let Some(path) = data
                    .as_ref()
                    .and_then(|v| v.get("folder"))
                    .and_then(local_folder)
                {
                    folders.push(path);
                }
            }
        }
        let db = user.join("globalStorage").join("state.vscdb");
        if let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let raw = conn.query_row(
                "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
                [],
                |row| row.get::<_, String>(0),
            );
            if let Some(data) = raw
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            {
                folders.extend(
                    data.get("entries")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|entry| entry.get("folderUri"))
                        .filter_map(local_folder),
                );
            }
        }
    }
    folders
}

fn saved_projects_file(paths: &ManagerPaths) -> PathBuf {
    paths.data_dir.join("storage-projects.json")
}

fn load_saved_projects(paths: &ManagerPaths) -> Result<Vec<PathBuf>, String> {
    let file = saved_projects_file(paths);
    if !file.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&read_text_strip_bom(&file)?)
        .map_err(|err| format!("无法读取已添加的项目文件夹：{err}"))
}

pub(crate) struct DiscoveredProjectRoot {
    pub id: String,
    pub name: String,
    pub source: &'static str,
    pub root: PathBuf,
}

pub(crate) fn discover_known_project_roots(paths: &ManagerPaths) -> Vec<DiscoveredProjectRoot> {
    let project_dir = paths.gemini_config_path.with_file_name("projects");
    let saved = load_saved_projects(paths).unwrap_or_default();
    let mut projects = registered_projects(&project_dir);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<DiscoveredProjectRoot> = Vec::new();

    for project in &mut projects {
        for folder in &project.folders {
            let resolved = resolve_project_storage_root(folder).unwrap_or_else(|_| folder.clone());
            let key = path_key(&resolved);
            if seen.insert(key) {
                out.push(DiscoveredProjectRoot {
                    id: project.id.clone(),
                    name: project.name.clone(),
                    source: project.source,
                    root: resolved,
                });
            }
        }
    }

    let mut workspace_folders = ide_workspace_paths(&paths.app_data_dir);
    // Also check session workspace URIs from annotations/db if needed via saved & ide_workspace_paths
    for (source, folders) in [("manual", saved), ("workspace", std::mem::take(&mut workspace_folders))] {
        for folder in folders {
            let resolved = match resolve_project_storage_root(&folder) {
                Ok(p) => p,
                Err(_) if source == "workspace" => continue,
                Err(_) => folder,
            };
            let key = path_key(&resolved);
            if seen.insert(key.clone()) {
                out.push(DiscoveredProjectRoot {
                    id: format!("{source}:{key}"),
                    name: name_for_path(&resolved),
                    source,
                    root: resolved,
                });
            }
        }
    }

    out
}

pub fn update_saved_project(paths: &ManagerPaths, path: &Path, add: bool) -> Result<(), String> {
    let mut folders = load_saved_projects(paths)?;
    let key = path_key(path);
    folders.retain(|folder| path_key(folder) != key);
    if add {
        folders.push(path.to_path_buf());
    }
    write_json_atomic(&saved_projects_file(paths), &folders)
}

pub fn valid_project_root(path: &Path, snapshot: &StorageScanSnapshot) -> Result<PathBuf, String> {
    let path = resolve_project_storage_root(path)?;
    if snapshot
        .roots
        .iter()
        .any(|root| contains(&root.path, &path) || contains(&path, &root.path))
    {
        return Err("项目目录与 AGY 本地数据重叠".to_string());
    }
    Ok(path)
}

pub fn delete_project_folders(
    paths: &ManagerPaths,
    snapshot: &StorageScanSnapshot,
    known_paths: &HashSet<PathBuf>,
    targets: &[String],
    recycle_bin: bool,
) -> Result<StorageDeleteResult, String> {
    if targets.iter().any(|target| !known_paths.contains(Path::new(target))) {
        return Err("所选目录不在当前项目扫描结果中，请重新扫描".to_string());
    }
    let mut saved = load_saved_projects(paths)?;
    let mut result = delete_project_targets(targets, recycle_bin, true, |target| {
        if valid_project_root(target, snapshot)? != target {
            return Err("项目目录已变更，请重新扫描".to_string());
        }
        if contains(target, &paths.data_dir) || contains(&paths.data_dir, target) {
            return Err("项目目录与管理器数据目录重叠".to_string());
        }
        Ok(())
    });
    let previous_count = saved.len();
    saved.retain(|folder| {
        !result.deleted_paths.iter().any(|path| contains(Path::new(path), folder))
    });
    if saved.len() != previous_count {
        if let Err(err) = write_json_atomic(&saved_projects_file(paths), &saved) {
            result.warnings.push(format!("项目目录已删除，但更新手动添加的项目列表失败：{err}"));
        }
    }
    Ok(result)
}

fn project_folder_usage(root: &Path, on_file: &mut impl FnMut(&Path, u64)) -> (StorageUsage, bool) {
    let mut usage = StorageUsage::default();
    let mut partial = false;
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            partial = true;
            continue;
        };
        if is_link_or_reparse_point(&meta) {
            continue;
        }
        if meta.is_dir() {
            match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(_) => partial = true,
                        }
                    }
                }
                Err(_) => partial = true,
            }
        } else if meta.is_file() {
            on_file(&path, meta.len());
            usage.add(StorageUsage {
                size_bytes: meta.len(),
                file_count: 1,
            });
        }
    }
    (usage, partial)
}

fn project_folder_preview(
    root: &Path,
    mut on_file: impl FnMut(&Path, u64),
) -> (StorageUsage, bool, Vec<StorageNode>) {
    let mut usage = StorageUsage::default();
    let mut partial = false;
    let mut children = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return (usage, true, children);
    };
    for entry in entries {
        let Ok(entry) = entry else {
            partial = true;
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            partial = true;
            continue;
        };
        if is_link_or_reparse_point(&meta) || !(meta.is_dir() || meta.is_file()) {
            continue;
        }
        let (size, incomplete) = if meta.is_dir() {
            project_folder_usage(&path, &mut on_file)
        } else {
            on_file(&path, meta.len());
            (
                StorageUsage {
                    size_bytes: meta.len(),
                    file_count: 1,
                },
                false,
            )
        };
        usage.add(size);
        partial |= incomplete;
        let kind = if meta.is_dir() { "dir" } else { "file" };
        let path = path.to_string_lossy().into_owned();
        children.push(StorageNode {
            node_id: format!("project:{kind}:{path}"),
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.into(),
            category: "other".into(),
            path: path.clone(),
            size_bytes: size.size_bytes,
            file_count: size.file_count,
            mtime: mtime_ts(&meta),
            deletability: "caution".into(),
            deletability_label: crate::i18n::tr("清理前确认", "Confirm Before Cleaning").into(),
            delete_targets: vec![path],
            ..Default::default()
        });
    }
    children.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.name.cmp(&b.name))
    });
    // Supply enough first-level tiles for the treemap. Full file trees are loaded on demand.
    children.truncate(16);
    (usage, partial, children)
}

fn usage_without_nested_counts<'a>(
    folders: impl IntoIterator<Item = &'a ProjectFolder>,
) -> StorageUsage {
    let mut folders: Vec<_> = folders
        .into_iter()
        .filter(|folder| folder.status != "unavailable")
        .collect();
    folders.sort_by_key(|folder| folder.path.len());
    let mut counted: Vec<&Path> = Vec::new();
    let mut usage = StorageUsage::default();
    for folder in folders {
        let path = Path::new(&folder.path);
        if !counted.iter().any(|parent| contains(parent, path)) {
            counted.push(path);
            usage.add(folder.usage);
        }
    }
    usage
}

pub fn build_inventory(
    paths: &ManagerPaths,
    snapshot: &StorageScanSnapshot,
    mut progress: impl FnMut(StorageScanProgress),
) -> Result<StorageInventory, String> {
    let project_dir = paths.gemini_config_path.with_file_name("projects");
    let saved = load_saved_projects(paths)?;
    let mut projects = registered_projects(&project_dir);
    for project in &mut projects {
        for folder in &mut project.folders {
            if let Ok(path) = valid_project_root(folder, snapshot) {
                *folder = path;
            }
        }
    }
    let mut seen: HashSet<String> = projects
        .iter()
        .flat_map(|project| &project.folders)
        .map(|folder| path_key(folder))
        .collect();
    let history = snapshot
        .sessions
        .values()
        .flat_map(|session| &session.workspace_uris)
        .filter_map(|uri| Url::parse(uri).ok()?.to_file_path().ok());
    for (source, folders) in [
        ("manual", saved),
        (
            "workspace",
            history
                .chain(ide_workspace_paths(&paths.app_data_dir))
                .collect(),
        ),
    ] {
        for folder in folders {
            let folder = match valid_project_root(&folder, snapshot) {
                Ok(path) => path,
                Err(_) if source == "workspace" => continue,
                Err(_) => folder,
            };
            let key = path_key(&folder);
            if seen.insert(key.clone()) {
                projects.push(Project {
                    id: format!("{source}:{key}"),
                    name: name_for_path(&folder),
                    source,
                    folders: vec![folder],
                });
            }
        }
    }

    let root_count = projects
        .iter()
        .flat_map(|project| &project.folders)
        .map(|folder| path_key(folder))
        .collect::<HashSet<_>>()
        .len();
    let mut by_folder: HashMap<String, ProjectFolder> = HashMap::new();
    let mut rows = Vec::new();
    let mut root_index = 0;
    let mut scanned = StorageUsage::default();
    for project in projects {
        let mut unique = HashSet::new();
        let mut folders = Vec::new();
        for folder in project.folders {
            let key = path_key(&folder);
            if !unique.insert(key.clone()) {
                continue;
            }
            let row = by_folder.entry(key).or_insert_with(|| {
                root_index += 1;
                let shown = folder.to_string_lossy().into_owned();
                let completed_roots = (root_index - 1) as f64;
                let total_roots = root_count.max(1) as f64;
                let mut report = |path: &Path, scanned: StorageUsage, portion: f64| {
                    progress(StorageScanProgress {
                        phase: "projects".into(),
                        root_index,
                        root_count,
                        root_label: project.name.clone(),
                        current_path: path.to_string_lossy().into_owned(),
                        scanned_files: scanned.file_count,
                        scanned_bytes: scanned.size_bytes,
                        fraction: (completed_roots + portion) / total_roots,
                    });
                };
                report(&folder, scanned, 0.0);
                let item = match valid_project_root(&folder, snapshot) {
                    Ok(root) => {
                        let mut files_in_root = 0_u64;
                        let mut last_report = Instant::now();
                        let (usage, partial, preview) =
                            project_folder_preview(&root, |path, bytes| {
                                scanned.add(StorageUsage {
                                    size_bytes: bytes,
                                    file_count: 1,
                                });
                                files_in_root += 1;
                                if files_in_root == 1
                                    || last_report.elapsed() >= Duration::from_millis(100)
                                {
                                    let files = files_in_root as f64;
                                    report(path, scanned, 0.9 * files / (files + 120.0));
                                    last_report = Instant::now();
                                }
                            });
                        ProjectFolder {
                            path: root.to_string_lossy().into_owned(),
                            usage,
                            status: if partial { "partial" } else { "ok" },
                            mtime: fs::metadata(&root)
                                .map(|meta| mtime_ts(&meta))
                                .unwrap_or_default(),
                            preview,
                        }
                    }
                    Err(_) => ProjectFolder {
                        path: shown,
                        usage: StorageUsage::default(),
                        status: "unavailable",
                        mtime: 0.0,
                        preview: Vec::new(),
                    },
                };
                report(&folder, scanned, 1.0);
                item
            });
            folders.push(row.clone());
        }
        let usage = usage_without_nested_counts(&folders);
        rows.push(ProjectUsage {
            id: project.id,
            name: project.name,
            source: project.source,
            folders,
            usage,
        });
    }
    rows.sort_by(|a, b| {
        b.usage
            .size_bytes
            .cmp(&a.usage.size_bytes)
            .then_with(|| a.name.cmp(&b.name))
    });

    let local = StorageUsage {
        size_bytes: snapshot.files.iter().map(|file| file.size_bytes).sum(),
        file_count: snapshot.files.len() as u64,
    };
    let projects_usage = usage_without_nested_counts(by_folder.values());
    let mut total = local;
    total.add(projects_usage);
    Ok(StorageInventory {
        local,
        projects: rows,
        projects_usage,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::RuntimeDirs;
    use crate::storage::scan_project_storage_with_progress;
    use serde_json::json;

    #[test]
    fn deletes_selected_project_folders_and_updates_saved_paths() {
        let tmp = std::env::temp_dir().join(format!("agy-delete-projects-{}", std::process::id()));
        let paths = ManagerPaths::from_runtime_dirs(RuntimeDirs {
            data_dir: tmp.join("manager"),
            assets_dir: tmp.join("manager"),
            is_portable: true,
        });
        let project = tmp.join("项目");
        let nested = project.join("nested");
        let unrelated = tmp.join("unrelated");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(nested.join("main.txt"), b"1234").unwrap();
        let project = resolve_project_storage_root(&project).unwrap();
        let nested = resolve_project_storage_root(&nested).unwrap();
        let unrelated = resolve_project_storage_root(&unrelated).unwrap();
        update_saved_project(&paths, &project, true).unwrap();
        update_saved_project(&paths, &nested, true).unwrap();
        update_saved_project(&paths, &unrelated, true).unwrap();

        let as_target = |path: &Path| path.display().to_string();
        let known = HashSet::from([project.clone(), nested.clone()]);
        let manager_root = resolve_project_storage_root(&paths.data_dir).unwrap();
        let snapshot = scan_project_storage_with_progress(&manager_root, |_| {}).unwrap();
        assert!(delete_project_folders(
            &paths, &snapshot, &known, &[as_target(&project), as_target(&unrelated)], false,
        ).is_err());
        assert!(project.is_dir());

        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(project.join("external-link"))
                .arg(&unrelated)
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
            fs::write(unrelated.join("keep.txt"), b"keep").unwrap();
        }

        let result = delete_project_folders(
            &paths, &snapshot, &known, &[as_target(&nested), as_target(&project)], false,
        ).unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.deleted_paths, [as_target(&project)]);
        assert_eq!(result.freed_bytes, 4);
        assert!(!project.exists());
        assert_eq!(load_saved_projects(&paths).unwrap(), [unrelated.clone()]);
        assert!(unrelated.is_dir());
        #[cfg(windows)]
        assert!(unrelated.join("keep.txt").is_file());
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn inventory_reports_registered_workspaces_and_saved_projects_without_double_counting() {
        let tmp = std::env::temp_dir().join(format!("agy-inventory-{}", std::process::id()));
        let mut paths = ManagerPaths::from_runtime_dirs(RuntimeDirs {
            data_dir: tmp.join("manager"),
            assets_dir: tmp.join("manager"),
            is_portable: true,
        });
        paths.gemini_config_path = tmp.join("gemini").join("config.json");
        paths.app_data_dir = tmp.join("appdata");
        let root_dir = tmp.join("项目目录");
        let nested_dir = root_dir.join("nested");
        let second_dir = tmp.join("手动目录");
        let local_dir = tmp.join("agy-data");
        let project_dir = paths.gemini_config_path.with_file_name("projects");
        let ide_workspace = paths
            .app_data_dir
            .join("Antigravity IDE/User/workspaceStorage/1");
        for directory in [
            &nested_dir,
            &second_dir,
            &local_dir,
            &project_dir,
            &ide_workspace,
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(root_dir.join("root.txt"), b"1234").unwrap();
        fs::write(nested_dir.join("child.txt"), b"567").unwrap();
        fs::write(second_dir.join("manual.txt"), b"8910").unwrap();
        fs::write(local_dir.join("session.txt"), b"11").unwrap();
        let path_uri = |p: &Path| Url::from_directory_path(p).unwrap().to_string();
        write_json_atomic(
            &project_dir.join("main.json"),
            &json!({
                "name": "真实的项目显示名",
                "projectResources": {
                    "resources": [
                        { "folderUri": path_uri(&root_dir) },
                        { "gitFolder": { "folderUri": path_uri(&nested_dir) } },
                    ],
                },
            }),
        )
        .unwrap();
        write_json_atomic(
            &project_dir.join("nested.json"),
            &json!({
                "name": "子项目",
                "projectResources": { "resources": [{ "folderUri": path_uri(&nested_dir) }] },
            }),
        )
        .unwrap();
        write_json_atomic(&project_dir.join("outside-of-project.json"), &json!({})).unwrap();
        write_json_atomic(
            &ide_workspace.join("workspace.json"),
            &json!({
                "folder": path_uri(&root_dir),
            }),
        )
        .unwrap();

        let local_root = resolve_project_storage_root(&local_dir).unwrap();
        let snapshot = scan_project_storage_with_progress(&local_root, |_| {}).unwrap();
        let manual_root = valid_project_root(&second_dir, &snapshot).unwrap();
        assert!(valid_project_root(&tmp, &snapshot).is_err());
        update_saved_project(&paths, &manual_root, true).unwrap();
        assert_eq!(
            load_saved_projects(&paths).unwrap(),
            vec![manual_root.clone()]
        );

        let mut progress = Vec::new();
        let inventory = build_inventory(&paths, &snapshot, |event| progress.push(event)).unwrap();
        assert!(progress
            .windows(2)
            .all(|w| w[0].scanned_files <= w[1].scanned_files
                && w[0].scanned_bytes <= w[1].scanned_bytes
                && w[0].fraction <= w[1].fraction));
        let last = progress.last().unwrap();
        assert_eq!(
            (last.scanned_files, last.scanned_bytes, last.fraction),
            (4, 14, 1.0)
        );
        assert_eq!(inventory.projects.len(), 3);
        let project = &inventory.projects[0];
        assert_eq!(project.name, "真实的项目显示名");
        assert_eq!(project.folders.len(), 2);
        assert_eq!(project.usage.size_bytes, 7);
        let preview = &project.folders[0].preview;
        assert_eq!(preview.len(), 2);
        assert_eq!(preview[0].name, "root.txt");
        assert_eq!(preview[0].size_bytes, 4);
        assert_eq!(preview[1].name, "nested");
        assert_eq!(preview[1].kind, "dir");
        assert_eq!(preview[1].size_bytes, 3);
        assert_eq!(
            inventory
                .projects
                .iter()
                .find(|row| row.name == "子项目")
                .unwrap()
                .usage
                .size_bytes,
            3
        );
        assert_eq!(inventory.local.size_bytes, 2);
        assert_eq!(inventory.projects_usage.size_bytes, 11);
        assert_eq!(inventory.total.size_bytes, 13);
        assert_eq!(inventory.total.file_count, 4);
        assert_eq!(inventory.accessible_project_paths().len(), 3);

        update_saved_project(&paths, &manual_root, false).unwrap();
        assert!(load_saved_projects(&paths).unwrap().is_empty());
        assert!(manual_root.join("manual.txt").exists());
        fs::remove_dir_all(&tmp).unwrap();
    }
}
