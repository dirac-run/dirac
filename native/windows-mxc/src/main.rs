use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::sync::Mutex;

const PROTOCOL: u32 = 1;
const VERSION: &str = "1.0.0";
const REVISION: &str = "fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2";
const MAX_REQUEST: usize = 1024 * 1024;
static OUTPUT: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: u32,
    executable: String,
    args: Vec<String>,
    cwd: String,
    environment: std::collections::BTreeMap<String, String>,
    readonly_paths: Vec<String>,
    readwrite_paths: Vec<String>,
    denied_paths: Vec<String>,
    network: Network,
    #[serde(default)]
    path_identities: Vec<PathIdentity>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathIdentity {
    path: String,
    canonical: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Network {
    Allow,
    Deny,
}

fn frame(value: serde_json::Value) -> io::Result<()> {
    let _guard = OUTPUT
        .lock()
        .map_err(|_| io::Error::other("control lock"))?;
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}
fn request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut bytes = Vec::new();
    std::io::Read::take(&mut *reader, (MAX_REQUEST + 1) as u64).read_until(b'\n', &mut bytes)?;
    if bytes.len() > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        return Err(io::Error::other("request size or framing"));
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("invalid request"))?;
    if request.protocol != PROTOCOL {
        return Err(io::Error::other("protocol version"));
    }
    Ok(request)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    protocol: u32,
    version: &'static str,
    revision: &'static str,
    native: bool,
    fs_deny: bool,
    network_ingress: bool,
    features: [&'static str; 4],
}

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--probe"] {
        #[cfg(windows)]
        let (native, fs_deny, network_ingress) = native::probe();
        #[cfg(not(windows))]
        let (native, fs_deny, network_ingress) = (false, false, false);
        frame(serde_json::to_value(Probe {
            protocol: PROTOCOL,
            version: VERSION,
            revision: REVISION,
            native,
            fs_deny,
            network_ingress,
            features: ["native-psec", "fs-deny", "self-job", "framed-output"],
        })?)?;
        return Ok(());
    }
    if args != ["--run"] {
        return Err(io::Error::other("unknown operation"));
    }
    let mut reader = io::BufReader::new(io::stdin());
    let request = request(&mut reader)?;
    #[cfg(windows)]
    {
        native::run(request, reader)
    }
    #[cfg(not(windows))]
    {
        let _ = (request, reader);
        Err(io::Error::other("Windows required"))
    }
}
fn main() {
    if run().is_err() {
        // No SDK logs, serde excerpts, command text, environment, or filesystem
        // values are exposed by trusted diagnostics.
        let _ = frame(serde_json::json!({"type":"failure", "code":"native-helper-failed"}));
        std::process::exit(1);
    }
}
#[cfg(windows)]
mod native;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_rejects_unknown_fields_and_versions() {
        let value = r#"{"protocol":1,"executable":"C:\\x.exe","args":[],"cwd":"C:\\work","environment":{},"readonlyPaths":[],"readwritePaths":[],"deniedPaths":[],"network":"deny"}"#;
        assert!(request(&mut io::Cursor::new(format!("{value}\n"))).is_ok());
        assert!(request(&mut io::Cursor::new(format!(
            "{}\n",
            value.replace("\"protocol\":1", "\"protocol\":2")
        )))
        .is_err());
        assert!(request(&mut io::Cursor::new(format!(
            "{}\n",
            value.replace("\"protocol\":1", "\"unexpected\":true,\"protocol\":1")
        )))
        .is_err());
        assert!(request(&mut io::Cursor::new(value)).is_err());
        assert!(request(&mut io::Cursor::new(vec![b'x'; MAX_REQUEST + 1])).is_err());
    }
}
