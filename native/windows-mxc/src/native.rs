//! The only dependency on MXC's doc-hidden API. Never use dispatcher/SDK runner
//! selection: those APIs can choose AppContainer or mutate host DACLs.
use super::{frame, Network, Request};
use base64::Engine;
use flatbuffers::FlatBufferBuilder;
use mxc_sdk::mxc_common::logger::{Logger, Mode};
use mxc_sdk::mxc_common::models::{
    BaseProcessUiConfig, ContainerPolicy, ExecutionRequest, FallbackPolicy, NetworkAction,
    NetworkEgressPolicy, NetworkIngressPolicy, UiPolicy,
};
use mxc_sdk::mxc_common::sandbox_process::{SandboxBackend, StdioMode};
use mxc_sdk::mxc_common::ui_policy::resolve_ui_restrictions;
use mxc_sdk::process_container_common::{
    base_container_runner::BaseContainerRunner, job_object::to_job_object_uilimit_mask,
    ProcessSecurityEnvironmentApi, SecurityEnvironmentStartupInfo,
    PROCESS_SECURITY_ENVIRONMENT_FLAG_NONE,
};
use mxc_sdk::process_security_environment_spec::process_security_environment_layout::{
    finish_process_security_environment_buffer, EndpointPolicyT, FilterAction, NetworkPolicyT,
    ProcessSecurityEnvironmentT, SchemaVersionT,
};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    FileCaseSensitiveInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;
#[link(name = "advapi32")]
unsafe extern "system" {}

fn fail() -> io::Error {
    io::Error::other("native restriction or lifecycle check failed")
}

/// Minimal create+startup+close PSEC probe; export presence alone is insufficient.
/// Pattern independently adapted from Codex availability.rs (Apache-2.0).
pub fn probe() -> (bool, bool, bool) {
    let policy = ContainerPolicy::default();
    let mut egress = EndpointPolicyT::default();
    egress.default_action = FilterAction::deny;
    let mut network = NetworkPolicyT::default();
    network.egress = Some(Box::new(egress));
    let mut spec = ProcessSecurityEnvironmentT::default();
    spec.version = SchemaVersionT { major: 1, minor: 0 };
    spec.disallow_win32k_system_calls = policy.ui.disable;
    spec.ui_restrictions = u64::from(to_job_object_uilimit_mask(&resolve_ui_restrictions(
        &policy.ui,
        &policy.base_process_ui,
    )));
    spec.network_policy = Some(Box::new(network));
    let mut builder = FlatBufferBuilder::with_capacity(1024);
    let spec = spec.pack(&mut builder);
    finish_process_security_environment_buffer(&mut builder, spec);
    let native = ProcessSecurityEnvironmentApi::load()
        .and_then(|api| {
            api.create(
                builder.finished_data(),
                PROCESS_SECURITY_ENVIRONMENT_FLAG_NONE,
            )
        })
        .and_then(|environment| {
            let startup =
                SecurityEnvironmentStartupInfo::new(Default::default(), environment.raw(), &[]);
            environment.close();
            startup.map(drop)
        })
        .is_ok();
    (
        native,
        native && BaseContainerRunner::supports_native_denied_paths(),
        native && BaseContainerRunner::supports_ingress_host_loopback_allow(),
    )
}

/// The helper itself enters this non-breakaway job BEFORE MXC creates anything.
/// Children inherit it at creation, including the upstream suspended/assign gap.
/// The job handle is noninheritable (null SECURITY_ATTRIBUTES) and intentionally
/// retained until process exit: dropping it here would also kill this helper.
fn own_helper() -> io::Result<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(fail());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            CloseHandle(job);
            return Err(fail());
        }
        Ok(job)
    }
}

fn valid_path(value: &str) -> io::Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || &bytes[1..3] != b":\\"
        || !value.is_ascii()
    {
        return Err(fail());
    }
    for part in value[3..].split('\\') {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part.chars().any(|c| c < ' ' || "<>:\"/|?*~".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && device.as_bytes()[3].is_ascii_digit())
        {
            return Err(fail());
        }
    }
    Ok(())
}

/// Pin every existing component against deletion/rename until settlement. Reject
/// ALL reparse tags, DOS aliases, case-sensitive directories, and canonical drift.
/// Missing final components (e.g. a configuration deny) pin their nearest parent.
fn pin_path(value: &str, allow_missing: bool, pins: &mut Vec<File>) -> io::Result<()> {
    valid_path(value)?;
    let mut path = std::path::PathBuf::from(&value[..3]);
    // Query/pin the volume root too; an ASCII drive is not proof of a
    // case-insensitive, ordinary local filesystem.
    pin_component(&path, pins)?;
    for part in value[3..].split('\\') {
        path.push(part);
        match pin_component(&path, pins) {
            Ok(()) => (),
            Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn pin_component(path: &Path, pins: &mut Vec<File>) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & 0x400 != 0 {
        return Err(fail());
    }
    if metadata.is_dir() {
        let mut info = FILE_CASE_SENSITIVE_INFO { Flags: 0 };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileCaseSensitiveInfo,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || info.Flags != 0
        {
            return Err(fail());
        }
    }
    let mut buffer = [0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if count == 0 || count >= buffer.len() {
        return Err(fail());
    }
    let canonical = String::from_utf16(&buffer[..count]).map_err(|_| fail())?;
    let canonical = canonical.strip_prefix("\\\\?\\").ok_or_else(fail)?;
    if !canonical.is_ascii()
        || !canonical
            .trim_end_matches('\\')
            .eq_ignore_ascii_case(path.to_str().ok_or_else(fail)?.trim_end_matches('\\'))
    {
        return Err(fail());
    }
    pins.push(file);
    Ok(())
}

fn quote(value: &str) -> io::Result<String> {
    if value.contains('\0') {
        return Err(fail());
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        if character == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(slashes));
        }
        out.push(character);
        slashes = 0;
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    Ok(out)
}
fn pump(
    mut reader: Box<dyn Read + Send>,
    stream: &'static str,
) -> std::thread::JoinHandle<io::Result<()>> {
    std::thread::spawn(move || {
        let mut bytes = [0u8; 16384];
        loop {
            let count = reader.read(&mut bytes)?;
            if count == 0 {
                return Ok(());
            }
            frame(
                serde_json::json!({"type":stream,"data":base64::engine::general_purpose::STANDARD.encode(&bytes[..count])}),
            )?;
        }
    })
}

pub fn run(request: Request, mut reader: impl BufRead + Send + 'static) -> io::Result<()> {
    let outer_job = own_helper()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let watcher = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = reader.read_line(&mut line); // EOF, malformed control, or cancel all stop execution.
        watcher.store(true, Ordering::SeqCst);
    });
    let (native, fs_deny, ingress) = probe();
    if !native || !fs_deny || (matches!(request.network, Network::Allow) && !ingress) {
        return Err(fail());
    }
    let mut pins = Vec::new();
    for path in request
        .readonly_paths
        .iter()
        .chain(&request.readwrite_paths)
        .chain([&request.cwd, &request.executable])
    {
        pin_path(path, false, &mut pins)?;
    }
    for path in &request.denied_paths {
        pin_path(path, true, &mut pins)?;
    }
    for identity in &request.path_identities {
        // Snapshot identities may refer to absent protected paths. Existing
        // ancestors are still pinned and must match their recorded identity.
        let optional = request
            .denied_paths
            .iter()
            .any(|p| p.eq_ignore_ascii_case(&identity.path));
        pin_path(&identity.path, optional, &mut pins)?;
        if !identity.path.eq_ignore_ascii_case(&identity.canonical) {
            return Err(fail());
        }
    }
    if !Path::new(&request.executable).is_file() || !Path::new(&request.cwd).is_dir() {
        return Err(fail());
    }
    let mut seen = std::collections::HashSet::new();
    for (key, value) in &request.environment {
        if !seen.insert(key.to_ascii_uppercase())
            || key.contains(['=', '\0'])
            || value.contains('\0')
        {
            return Err(fail());
        }
    }
    let code = std::iter::once(&request.executable)
        .chain(&request.args)
        .map(|v| quote(v))
        .collect::<io::Result<Vec<_>>>()?
        .join(" ");
    if code.encode_utf16().count() >= 32767 {
        return Err(fail());
    }
    let allowed = matches!(request.network, Network::Allow);
    let action = if allowed {
        NetworkAction::Allow
    } else {
        NetworkAction::Deny
    };
    let request = ExecutionRequest {
        script_code: code,
        working_directory: request.cwd,
        env: Some(
            request
                .environment
                .into_iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect(),
        ),
        inherit_default_env: false,
        policy: ContainerPolicy {
            capabilities: vec!["registryRead".to_owned()],
            readonly_paths: request.readonly_paths,
            readwrite_paths: request.readwrite_paths,
            denied_paths: request.denied_paths,
            fallback: FallbackPolicy {
                allow_dacl_mutation: false,
            },
            network_egress: Some(NetworkEgressPolicy {
                default: action,
                ..Default::default()
            }),
            network_ingress: Some(NetworkIngressPolicy {
                default: action,
                host_loopback: action,
            }),
            network_specified: true,
            network_mode_specified: true,
            ui: UiPolicy {
                disable: false,
                ..Default::default()
            },
            base_process_ui: BaseProcessUiConfig {
                isolation: "desktop".into(),
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };
    if cancelled.load(Ordering::SeqCst) {
        return Err(fail());
    }
    let mut logger = Logger::new(Mode::Buffer);
    let mut child = BaseContainerRunner::new()
        .spawn(&request, &mut logger, StdioMode::Pipes)
        .map_err(|_| fail())?;
    drop(child.take_stdin());
    frame(serde_json::json!({"type":"started","pid":child.id()}))?;
    let stdout = pump(child.take_stdout().ok_or_else(fail)?, "stdout");
    let stderr = pump(child.take_stderr().ok_or_else(fail)?, "stderr");
    loop {
        if cancelled.load(Ordering::SeqCst) {
            child.kill()?;
            break;
        }
        if child.try_wait()?.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let exit = child.wait()?;
    drop(child); // MXC tree drain precedes any settlement claim.
    stdout.join().map_err(|_| fail())??;
    stderr.join().map_err(|_| fail())??;
    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        QueryInformationJobObject(
            outer_job,
            JobObjectBasicAccountingInformation,
            &mut accounting as *mut _ as _,
            std::mem::size_of_val(&accounting) as u32,
            std::ptr::null_mut(),
        )
    } == 0
        || accounting.ActiveProcesses != 1
    {
        return Err(fail());
    }
    frame(
        serde_json::json!({"type":"settled","exitCode":exit,"cancelled":cancelled.load(Ordering::SeqCst)}),
    )?;
    // Pins and PSEC are gone only after all descendants and output have settled.
    drop(pins);
    Ok(()) // OS closes the sole outer job handle at helper exit.
}
